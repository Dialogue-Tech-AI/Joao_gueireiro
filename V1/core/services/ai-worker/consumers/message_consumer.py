"""Message Consumer (RabbitMQ or SQS when USE_SQS=true)."""
import json
import asyncio
import time
import httpx
from aio_pika import connect_robust, IncomingMessage, Message as AioPikaMessage
from langchain_core.messages import HumanMessage, AIMessage
from agent.langchain_agent import AlteseAgent
from agent.langgraph_flow import AlteseAttendanceFlow, AttendanceState
from services.memory_manager import MemoryManager
from services.cost_reporter import report_ai_cost
from services.attendance_decision import run_decision as run_attendance_decision
from config.settings import settings
from utils.logger import logger
from datetime import datetime


class MessageConsumer:
    """
    RabbitMQ consumer for AI messages
    Processes messages using LangGraph flow.
    When AI is disabled (ai_enabled=False), pauses consuming; messages stay in queue.
    """
    
    def __init__(
        self,
        agent: AlteseAgent,
        flow: AlteseAttendanceFlow,
        memory_manager: MemoryManager,
        agent_config_service=None,
    ):
        self.agent = agent
        self.flow = flow
        self.memory_manager = memory_manager
        self.agent_config_service = agent_config_service
        self.connection = None
        self.channel = None
        self.ai_queue = None
        self.consumer_tag = None
        self.running = False
        self.node_api_url = settings.node_api_url
        self.internal_api_key = settings.internal_api_key
    
    async def start(self):
        """Start consuming messages (SQS or RabbitMQ)."""
        try:
            self.running = True

            if settings.use_sqs and settings.sqs_queue_ai_messages_url:
                logger.info("Using SQS for ai-messages (USE_SQS=true)")
                await self._run_sqs_consumer_loop()
                return

            logger.info(f"Connecting to RabbitMQ: {settings.rabbitmq_url}")
            self.connection = await connect_robust(
                settings.rabbitmq_url,
                heartbeat=60
            )
            self.channel = await self.connection.channel()
            await self.channel.set_qos(prefetch_count=1)
            ai_queue = await self.channel.declare_queue('ai-messages', durable=True)
            response_queue = await self.channel.declare_queue('ai-responses', durable=True)
            logger.info(f"Queues declared: ai-messages={ai_queue.name}, ai-responses={response_queue.name}")
            self.ai_queue = ai_queue
            logger.info("✅ AI Worker started - listening on 'ai-messages' (RabbitMQ)")
            
            try:
                while self.running:
                    # When AI disabled via Super Admin, pause consuming (do not call get())
                    if self.agent_config_service and not self.agent_config_service.is_ai_enabled():
                        await asyncio.sleep(2)
                        continue
                    try:
                        message = await ai_queue.get(timeout=1.0, fail=False)
                        if message:
                            logger.info(f"📥 Message received from queue")
                            await self.process_message(message)
                        else:
                            await asyncio.sleep(0.5)
                    except asyncio.TimeoutError:
                        continue
                    except Exception as e:
                        logger.error(f"Error in message polling: {e}", exc_info=True)
                        await asyncio.sleep(1)
            except asyncio.CancelledError:
                logger.info("Consumer cancelled")
                        
        except Exception as e:
            logger.error(f"Error starting consumer: {e}", exc_info=True)
            raise
    
    async def process_message(self, message: IncomingMessage):
        """
        Process incoming message from RabbitMQ (with message.process() ack).
        """
        async with message.process():
            try:
                data = json.loads(message.body.decode())
                await self.process_message_body(data)
            except Exception as e:
                logger.error(f"❌ Error processing message: {e}", exc_info=True)
                try:
                    data = json.loads(message.body.decode())
                    await self._send_typing_indicator(
                        whatsapp_number_id=data.get('whatsappNumberId'),
                        client_phone=data.get('clientPhone'),
                        is_typing=False,
                    )
                except Exception:
                    pass
                raise

    async def process_message_body(self, data: dict):
        """
        Process a single message payload (dict). Used by both RabbitMQ and SQS.
        """
        try:
            import os
            worker_pid = os.getpid()
            logger.info(f"📨 Processing message {data.get('messageId')} for attendance {data.get('attendanceId')} [Worker PID: {worker_pid}]")

            # Modo "decide_attendance": IA decide reabrir vs novo; backend cria/vincula atendimento e republica payload normal
            if data.get('mode') == 'decide_attendance':
                await self._handle_decide_attendance(data)
                return
            # Modo "close_summary": gerar resumo final ao fechar e enviar para Vector DB (RAG)
            if data.get('mode') == 'close_summary':
                attendance_id_close = data.get('attendanceId')
                if attendance_id_close:
                    await self.memory_manager.create_final_summary_on_close(attendance_id_close)
                return

            # Modo "quote_explanation": IA processa conteúdo do orçamento e adiciona explicação
            if data.get('mode') == 'quote_explanation':
                await self._handle_quote_explanation(data)
                return

            # Check if attendance is handled by HUMAN - if so, don't process but continue storing context
            attendance_id = data.get('attendanceId')
            intervention_type_for_router = None  # Canal/identificador para o router (ex.: encaminhados-balcao)
            if attendance_id:
                # Fetch attendance to check handledBy - use a direct endpoint or messages endpoint
                # Add a small delay to ensure database consistency after state changes
                await asyncio.sleep(0.1)  # 100ms delay to ensure DB consistency

                async with httpx.AsyncClient(timeout=5.0) as client:
                    try:
                        base = (self.node_api_url or "").rstrip("/")
                        url = f"{base}/api/internal/attendance/{attendance_id}/status"
                        response = await client.get(
                            url,
                            headers={
                                "X-Internal-Auth": self.internal_api_key,
                                "Cache-Control": "no-cache",
                            },
                        )
                        if response.status_code == 200:
                            response_data = response.json()
                            handled_by = response_data.get("handledBy", "AI")

                            # Check if AI is disabled for this attendance
                            ai_disabled = response_data.get("aiDisabled", False)
                            if ai_disabled:
                                ai_disabled_until = response_data.get("aiDisabledUntil")
                                logger.info(f"⏸️ AI is disabled for attendance {attendance_id} until {ai_disabled_until} - skipping AI response but storing context")

                                # Still store message in memory for context continuity
                                await self.memory_manager.add_message(
                                    attendance_id=attendance_id,
                                    message=HumanMessage(
                                        content=data.get('content', ''),
                                        additional_kwargs={
                                            "mediaType": data.get('mediaType', 'text'),
                                            "mediaUrl": data.get('mediaUrl'),
                                            "messageId": data.get('messageId')
                                        }
                                    )
                                )

                                # Stop typing indicator
                                await self._send_typing_indicator(
                                    whatsapp_number_id=data.get('whatsappNumberId'),
                                    client_phone=data.get('clientPhone'),
                                    is_typing=False
                                )

                                # Message processed (context stored), but no AI response sent
                                logger.info(f"✅ Context stored for attendance {attendance_id}, no AI response sent (AI disabled)")
                                return

                            # Normalize handledBy value (handle both string and enum cases)
                            # Convert to string and uppercase for comparison
                            handled_by_str = str(handled_by).upper().strip() if handled_by else 'AI'

                            logger.info(f"🔍 Checking attendance {attendance_id} handledBy: '{handled_by_str}' (original: '{handled_by}', type: {type(handled_by).__name__})")

                            # Check if handled by HUMAN (case-insensitive)
                            if handled_by_str == 'HUMAN':
                                logger.info(f"⏸️ Attendance {attendance_id} is being handled by HUMAN - skipping AI response but storing context")

                                # Still store message in memory for context continuity
                                await self.memory_manager.add_message(
                                    attendance_id=attendance_id,
                                    message=HumanMessage(
                                        content=data.get('content', ''),
                                        additional_kwargs={
                                            "mediaType": data.get('mediaType', 'text'),
                                            "mediaUrl": data.get('mediaUrl'),
                                            "messageId": data.get('messageId')
                                        }
                                    )
                                )

                                # Stop typing indicator
                                await self._send_typing_indicator(
                                    whatsapp_number_id=data.get('whatsappNumberId'),
                                    client_phone=data.get('clientPhone'),
                                    is_typing=False
                                )

                                # Message processed (context stored), but no AI response sent
                                logger.info(f"✅ Context stored for attendance {attendance_id}, no AI response sent (HUMAN handling)")
                                return
                            else:
                                logger.info(f"✅ Attendance {attendance_id} is handled by '{handled_by_str}' (not HUMAN) - proceeding with AI response")
                                intervention_type_for_router = response_data.get('interventionType')
                                if intervention_type_for_router:
                                    logger.info(f"📌 Identificador de canal para o router: intervention_type={intervention_type_for_router} (ex.: encaminhados-balcao → Não atribuídos + telefone fixo + info básicas)")
                        else:
                            logger.warning(f"Failed to fetch attendance status: HTTP {response.status_code}, body: {response.text[:200]} - proceeding with AI response")
                    except httpx.TimeoutException:
                        logger.warning(f"Timeout checking attendance handledBy status for {attendance_id} - proceeding with AI response")
                    except Exception as e:
                        logger.warning(f"Could not check attendance handledBy status: {e} - proceeding with AI response", exc_info=True)

            # Send typing indicator when starting to process
            await self._send_typing_indicator(
                whatsapp_number_id=data.get('whatsappNumberId'),
                client_phone=data.get('clientPhone'),
                is_typing=True
            )

            # Prepare initial state for LangGraph
            client_message = HumanMessage(
                content=data.get('content', ''),
                additional_kwargs={
                    "mediaType": data.get('mediaType', 'text'),
                    "mediaUrl": data.get('mediaUrl'),
                    "messageId": data.get('messageId')
                }
            )

            initial_state: AttendanceState = {
                "messages": [client_message],
                "attendance_id": data['attendanceId'],
                "client_phone": data['clientPhone'],
                "whatsapp_number_id": data['whatsappNumberId'],
                "current_step": "start",
                "collected_data": {},
                "should_route": False,
                "routing_completed": False,
                "pending_created": False,
                "error": None,
                "cost_accumulator": {},
                "last_attendance_summary": data.get('lastAttendanceSummary') or '',
                "intervention_type": intervention_type_for_router,
                "operational_state": data.get('operationalState') or None,
                "attendance_context": data.get('attendanceContext') or None,
            }

            # IMPORTANT: Backend Node.js already saves the message before publishing to ai-messages.
            # We should NOT save it again to avoid duplication.
            # The backend saves with metadata.whatsappMessageId = data.messageId
            # We only verify it exists for logging/debugging purposes.
            try:
                message_id = data.get('messageId')
                if message_id:
                    # Backend saves as whatsappMessageId in metadata, not messageId
                    existing = await self.memory_manager.pg_client.fetchval("""
                        SELECT id FROM messages 
                        WHERE (metadata->>'whatsappMessageId' = $1 OR metadata->>'messageId' = $1) 
                        AND attendance_id = $2
                    """, message_id, data['attendanceId'])

                    if existing:
                        logger.debug(f"✅ Client message already exists in database (messageId: {message_id}, db_id: {existing})")
                    else:
                        # Message not found - this should be rare as backend saves before publishing
                        # Log warning but don't save to avoid duplication
                        logger.warning(f"⚠️ Client message not found in database (messageId: {message_id}) - backend should have saved it. Skipping save to avoid duplication.")
            except Exception as e:
                logger.warning(f"Could not verify client message existence: {e} - continuing anyway")

            # Execute LangGraph flow
            final_state = await self.flow.run(initial_state)

            # Send response
            await self.send_response(data, final_state)

            # Report AI cost to Node for Super Admin custos tab
            acc = final_state.get("cost_accumulator") or {}
            tt = acc.get("total_tokens") or 0
            if tt <= 0:
                logger.info(
                    "Cost report skipped: total_tokens=0 (usage not captured). attendance=%s",
                    data.get("attendanceId"),
                )
            else:
                try:
                    await report_ai_cost(
                        self.node_api_url,
                        self.internal_api_key,
                        attendance_id=acc.get("attendance_id") or data["attendanceId"],
                        message_id=acc.get("message_id"),
                        client_phone=acc.get("client_phone") or data.get("clientPhone", ""),
                        scenario=acc.get("scenario") or "text",
                        model=acc.get("model") or "gpt-4o-mini",
                        prompt_tokens=acc.get("prompt_tokens") or 0,
                        completion_tokens=acc.get("completion_tokens") or 0,
                        total_tokens=acc.get("total_tokens") or 0,
                        whisper_minutes=acc.get("whisper_minutes"),
                        usd_cost=acc.get("usd_cost") or 0,
                        brl_cost=acc.get("brl_cost") or 0,
                        router_model=acc.get("router_model"),
                        router_prompt_tokens=acc.get("router_prompt_tokens"),
                        router_completion_tokens=acc.get("router_completion_tokens"),
                        router_total_tokens=acc.get("router_total_tokens"),
                        router_usd_cost=acc.get("router_usd_cost"),
                        router_brl_cost=acc.get("router_brl_cost"),
                        specialist_name=acc.get("specialist_name"),
                        specialist_model=acc.get("specialist_model"),
                        specialist_prompt_tokens=acc.get("specialist_prompt_tokens"),
                        specialist_completion_tokens=acc.get("specialist_completion_tokens"),
                        specialist_total_tokens=acc.get("specialist_total_tokens"),
                        specialist_usd_cost=acc.get("specialist_usd_cost"),
                        specialist_brl_cost=acc.get("specialist_brl_cost"),
                        execution_log=acc.get("execution_log"),
                    )
                except Exception as cost_err:
                    logger.warning("Failed to report AI cost: %s", cost_err)

            # Stop typing indicator after processing is complete
            await self._send_typing_indicator(
                whatsapp_number_id=data.get('whatsappNumberId'),
                client_phone=data.get('clientPhone'),
                is_typing=False
            )

            # NOTE: Summary creation is now handled BEFORE processing in langchain_agent.py
            # This ensures summary is available for context building
            # We still check here as a backup for edge cases
            await self.memory_manager.check_and_create_summary_if_needed(
                data['attendanceId']
            )

            logger.info(f"✅ Message {data.get('messageId')} processed successfully")

        except Exception as e:
            logger.error(f"❌ Error processing message: {e}", exc_info=True)
            try:
                await self._send_typing_indicator(
                    whatsapp_number_id=data.get('whatsappNumberId'),
                    client_phone=data.get('clientPhone'),
                    is_typing=False,
                )
            except Exception:
                pass
            raise
    
    async def _handle_decide_attendance(self, data: dict):
        """Fluxo decide_attendance: IA decide reabrir vs novo; chama API Node que aplica e republica payload normal."""
        try:
            await self._send_typing_indicator(
                whatsapp_number_id=data.get('whatsappNumberId'),
                client_phone=data.get('clientPhone'),
                is_typing=True,
            )
            decision = await run_attendance_decision(
                last_attendance_summary=data.get('lastAttendanceSummary') or '',
                content=data.get('content') or '',
                recent_attendance_ids=data.get('recentAttendanceIds') or [],
            )
            body = {
                "clientPhone": data.get('clientPhone'),
                "whatsappNumberId": data.get('whatsappNumberId'),
                "messageId": data.get('whatsappMessageId'),
                "content": data.get('content') or '[Mensagem de mídia]',
                "decision": {
                    "action": decision.get("action") or "new",
                    "attendanceId": decision.get("attendanceId"),
                },
                "timestamp": data.get('timestamp'),
                "pushName": data.get('pushName'),
                "fromJid": data.get('fromJid'),
                "participantJid": data.get('participantJid'),
                "mediaUrl": data.get('mediaUrl'),
                "mediaType": data.get('mediaType') or 'text',
            }
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{self.node_api_url}/api/internal/attendance/decide",
                    json=body,
                    headers={
                        "X-Internal-Auth": self.internal_api_key,
                        "Content-Type": "application/json",
                    },
                )
                resp.raise_for_status()
            logger.info(
                "Decide attendance applied: action=%s attendanceId=%s",
                decision.get("action"),
                decision.get("attendanceId"),
            )
        finally:
            await self._send_typing_indicator(
                whatsapp_number_id=data.get('whatsappNumberId'),
                client_phone=data.get('clientPhone'),
                is_typing=False,
            )

    async def _handle_quote_explanation(self, data: dict):
        """Processa conteúdo do orçamento e adiciona explicação antes de enviar ao cliente."""
        try:
            attendance_id = data.get('attendanceId')
            quote_content = data.get('quoteContent', '')
            
            if not attendance_id or not quote_content:
                logger.warning("quote_explanation mode missing required fields", data)
                return
            
            await self._send_typing_indicator(
                whatsapp_number_id=data.get('whatsappNumberId'),
                client_phone=data.get('clientPhone'),
                is_typing=True,
            )
            
            # Buscar contexto do atendimento para a IA gerar explicação contextualizada
            recent_messages = await self.memory_manager.get_recent_client_messages_with_ai_responses(
                attendance_id, limit=10
            )
            
            # Construir prompt para a IA gerar explicação
            system_prompt = """Você é um assistente de vendas. Um vendedor acabou de enviar um orçamento para o cliente.

Sua tarefa é:
1. Ler o conteúdo do orçamento enviado pelo vendedor
2. Gerar uma explicação clara, amigável e profissional sobre o orçamento
3. A explicação deve ser colocada ABAIXO do conteúdo do orçamento

Formato da resposta:
[Conteúdo completo do orçamento enviado pelo vendedor]

---

[Explicação amigável e profissional sobre o orçamento, destacando benefícios, condições, prazos, formas de pagamento, etc.]

IMPORTANTE:
- Mantenha o conteúdo original do orçamento intacto
- A explicação deve ser em português brasileiro
- Seja claro, objetivo e amigável
- Destaque informações importantes como prazos, formas de pagamento, garantias, etc.
- Use emojis com moderação apenas se apropriado"""
            
            user_prompt = f"""Conteúdo do orçamento enviado pelo vendedor:

{quote_content}

Gere uma mensagem completa com o conteúdo do orçamento seguido de uma explicação amigável e profissional."""
            
            # Usar o agente para gerar a explicação
            try:
                from langchain_core.messages import SystemMessage, HumanMessage
                messages = [
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=user_prompt)
                ]
                
                # Usar o modelo diretamente (sem tools, apenas geração de texto)
                llm = self.agent.llm
                response = await llm.ainvoke(messages)
                explanation_text = response.content if hasattr(response, 'content') else str(response)
                
            except Exception as e:
                logger.error(f"Error generating quote explanation: {e}", exc_info=True)
                # Fallback: usar conteúdo original + explicação simples
                explanation_text = f"""{quote_content}

---

Olá! Acabei de enviar o orçamento solicitado. Por favor, confira os detalhes acima e me avise se tiver alguma dúvida ou se desejar fazer alguma alteração. Estou à disposição para ajudar! 😊"""
            
            # Enviar mensagem formatada ao cliente via endpoint interno
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(
                    f"{self.node_api_url}/api/internal/send-tool-response",
                    json={
                        "attendanceId": attendance_id,
                        "content": explanation_text,
                        "senderName": "Altese AI",
                    },
                    headers={
                        "X-Internal-Auth": self.internal_api_key,
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                logger.info(f"Quote explanation sent to client for attendance {attendance_id}")
            
        except Exception as e:
            logger.error(f"Error handling quote explanation: {e}", exc_info=True)
        finally:
            await self._send_typing_indicator(
                whatsapp_number_id=data.get('whatsappNumberId'),
                client_phone=data.get('clientPhone'),
                is_typing=False,
            )
    
    async def _send_typing_indicator(self, whatsapp_number_id: str, client_phone: str, is_typing: bool):
        """
        Send typing indicator to WhatsApp via Node.js internal API
        
        Args:
            whatsapp_number_id: WhatsApp number ID
            client_phone: Client phone number
            is_typing: True to show typing, False to stop
        """
        if not self.node_api_url or not self.internal_api_key:
            logger.debug("Node.js API URL or internal API key not configured - skipping typing indicator")
            return
        
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(
                    f"{self.node_api_url}/api/internal/typing",
                    json={
                        "whatsappNumberId": whatsapp_number_id,
                        "clientPhone": client_phone,
                        "isTyping": is_typing,
                    },
                    headers={
                        "X-Internal-Auth": self.internal_api_key,
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                logger.debug(f"Typing indicator sent: {is_typing} for {client_phone}")
        except Exception as e:
            logger.debug(f"Failed to send typing indicator: {e}")
            # Don't raise - typing indicator failure shouldn't break message processing
    
    async def send_response(self, original_data: dict, final_state: AttendanceState):
        """
        Publish response to ai-responses queue
        
        Args:
            original_data: Original message data
            final_state: Final state after LangGraph execution
        """
        try:
            # Get last AI message from state
            ai_messages = [
                msg for msg in final_state["messages"]
                if isinstance(msg, AIMessage)
            ]
            
            if not ai_messages:
                logger.warning("No AI messages to send - skipping response")
                # Não envia mensagem de erro - deixa a IA responder naturalmente
                return
            
            # Get the last AI message (the actual response to send)
            last_ai_message = ai_messages[-1].content
            
            # Get fragments from structured output (if available)
            fragments = final_state["collected_data"].get("fragments")
            response_metadata = final_state["collected_data"].get("response_metadata", {})
            
            # Prepare response message (convert UUIDs to strings)
            routing_data = None
            if final_state.get("routing_completed"):
                routing_data = {
                    "vehicleBrand": final_state["collected_data"].get("vehicle_brand"),
                    "sellerId": str(final_state["collected_data"].get("seller_id")) if final_state["collected_data"].get("seller_id") else None,
                    "supervisorId": str(final_state["collected_data"].get("supervisor_id")) if final_state["collected_data"].get("supervisor_id") else None
                }
            
            client_message_id = original_data.get('messageId')
            response_data = {
                "attendanceId": original_data['attendanceId'],
                "whatsappNumberId": original_data['whatsappNumberId'],
                "clientPhone": original_data['clientPhone'],
                "content": last_ai_message,
                "mediaType": "text",
                "origin": "AI",
                "actionTaken": "routed" if final_state.get("routing_completed") else "none",
                "routingData": routing_data,
                "timestamp": datetime.utcnow().isoformat(),
                # Include structured output data
                "fragments": fragments if fragments else None,
                "responseMetadata": response_metadata if response_metadata else None,
                # Include client messageId to prevent false deduplication
                "clientMessageId": client_message_id
            }
            
            # Log detalhado do conteúdo sendo enviado
            logger.info(f"📤 ENVIANDO PARA FILA ai-responses - attendance {original_data['attendanceId']}")
            logger.info(f"   📝 Conteúdo completo (primeiros 500 chars): {last_ai_message[:500]}")
            logger.info(f"   📦 Fragmentos ({len(fragments) if fragments else 0}): {fragments if fragments else 'Nenhum'}")
            logger.info(f"   🔑 clientMessageId: {client_message_id} (presente: {client_message_id is not None})")
            
            # Publish to ai-responses queue (RabbitMQ or SQS)
            await self._publish_ai_response(response_data)
            
            logger.info(f"📤 Response sent to ai-responses queue for attendance {original_data['attendanceId']}")
            
        except Exception as e:
            logger.error(f"Error sending response: {e}", exc_info=True)

    async def _publish_ai_response(self, response_data: dict):
        """Publish response to ai-responses queue (SQS or RabbitMQ)."""
        if settings.use_sqs and settings.sqs_queue_ai_responses_url:
            from services.sqs_client import send_message
            send_message(settings.sqs_queue_ai_responses_url, response_data)
        else:
            if self.channel:
                await self.channel.default_exchange.publish(
                    AioPikaMessage(
                        body=json.dumps(response_data).encode(),
                        delivery_mode=2,
                    ),
                    routing_key='ai-responses',
                )

    async def _run_sqs_consumer_loop(self):
        """Long-poll SQS ai-messages and process each message."""
        from services.sqs_client import receive_messages, delete_message
        url = settings.sqs_queue_ai_messages_url
        while self.running:
            if self.agent_config_service and not self.agent_config_service.is_ai_enabled():
                await asyncio.sleep(2)
                continue
            try:
                messages = await asyncio.to_thread(
                    receive_messages,
                    url,
                    max_messages=10,
                    wait_time_seconds=20,
                    visibility_timeout=120,
                )
                for body, receipt_handle in messages:
                    try:
                        await self.process_message_body(body)
                        await asyncio.to_thread(delete_message, url, receipt_handle)
                    except Exception as e:
                        logger.error(f"Error processing SQS message: {e}", exc_info=True)
                        # Message will become visible again after visibility timeout
            except Exception as e:
                logger.error(f"SQS receive error: {e}", exc_info=True)
                await asyncio.sleep(1)
    
    async def stop(self):
        """Stop consumer gracefully"""
        try:
            self.running = False
            
            if self.channel:
                await self.channel.close()
            
            if self.connection:
                await self.connection.close()
            
            logger.info("Consumer stopped successfully")
            
        except Exception as e:
            logger.error(f"Error stopping consumer: {e}")
