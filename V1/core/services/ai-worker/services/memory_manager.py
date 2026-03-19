"""Memory Manager - Custom memory system (25 msgs + summary + RAG)"""
import json
from services.vector_db_service import VectorDBService
from services.openai_service import OpenAIService
from utils.postgres_client import PostgresClient
from utils.logger import logger
from typing import List, Dict, Optional, Any
from datetime import datetime


class MemoryManager:
    """
    Manages conversation memory with:
    - Last 25 messages from current attendance
    - Summary of messages 50-75 (when > 75 messages)
    - RAG context from last 5 finished attendances
    """
    
    def __init__(
        self,
        vector_db: VectorDBService,
        pg_client: PostgresClient,
        openai_service: OpenAIService
    ):
        self.vector_db = vector_db
        self.pg_client = pg_client
        self.openai_service = openai_service
    
    async def build_context_string(
        self,
        attendance_id: str,
        client_phone: str
    ) -> str:
        """
        Build complete context string for prompt (optimized for speed)
        
        Args:
            attendance_id: Current attendance UUID
            client_phone: Client phone number
            
        Returns:
            Formatted context string
        """
        context_parts = []
        
        # Optimized: Only get summary if attendance has many messages (> 50)
        # Check message count first to avoid unnecessary query
        msg_count = await self.pg_client.fetchval("""
            SELECT COUNT(*) FROM messages WHERE attendance_id = $1
        """, attendance_id)
        
        # Only get summary if there are many messages (skip for speed if < 50)
        if msg_count and msg_count > 50:
            summary = await self.get_conversation_summary(attendance_id)
            if summary:
                context_parts.append(
                    f"<resumo_conversas_anteriores>\n{summary}\n</resumo_conversas_anteriores>"
                )
        
        # Optimized: Only get RAG context if client has previous attendances
        # Limit to last 3 attendances instead of 5 for faster queries
        rag_context = await self.get_rag_context(client_phone, limit=3)
        if rag_context:
            context_parts.append(
                f"<historico_cliente>\n{rag_context}\n</historico_cliente>"
            )
        
        return "\n\n".join(context_parts) if context_parts else ""
    
    async def get_recent_chat_history(
        self,
        attendance_id: str,
        limit: int = 25
    ) -> str:
        """
        Get recent chat history formatted as string
        
        Args:
            attendance_id: Attendance UUID
            limit: Number of messages to retrieve
            
        Returns:
            Formatted chat history
        """
        try:
            messages = await self.pg_client.fetch("""
                SELECT origin, content, metadata, sent_at
                FROM messages
                WHERE attendance_id = $1
                ORDER BY sent_at DESC
                LIMIT $2
            """, attendance_id, limit)
            
            if not messages:
                return ""
            
            # Format messages in chronological order
            formatted = []
            for msg in reversed(messages):
                role = "Cliente" if msg['origin'] == 'CLIENT' else "Assistente"
                # Ensure metadata is a dict
                metadata = msg['metadata'] if isinstance(msg['metadata'], dict) else {}
                msg_dict = {
                    'content': msg['content'],
                    'metadata': metadata
                }
                content = self.format_message_content(msg_dict)
                formatted.append(f"{role}: {content}")
            
            return "\n".join(formatted)
            
        except Exception as e:
            logger.error(f"Error getting chat history: {e}", exc_info=True)
            return ""

    def _safe_parse_metadata(self, metadata: Any) -> Dict[str, Any]:
        if isinstance(metadata, dict):
            return metadata
        if isinstance(metadata, str) and metadata:
            try:
                return json.loads(metadata)
            except Exception:
                return {}
        return {}

    def _compact_text(self, text: str, max_len: int = 220) -> str:
        if not text:
            return ""
        t = " ".join(str(text).split())
        if len(t) <= max_len:
            return t
        return t[: max_len - 1].rstrip() + "…"

    def _strip_simple_tags(self, text: str) -> str:
        """
        Remove tags simples (<Text>, <texto>, <Audio>, <Image>, etc.) para o router
        enxergar o conteúdo sem ruído, sem tentar fazer parsing completo de HTML/XML.
        """
        if not text:
            return ""
        t = str(text)
        for tag in ("Text", "texto", "Audio", "audio", "Image", "imagem"):
            t = t.replace(f"<{tag}>", "").replace(f"</{tag}>", "")
        return t.strip()

    async def build_router_context(
        self,
        attendance_id: str,
        current_client_whatsapp_message_id: Optional[str],
        current_client_content: str,
        previous_messages_count: int = 15,
    ) -> Dict[str, str]:
        """
        Monta contexto específico para o Router:
        - Últimas N mensagens ANTERIORES (cliente + IA) em formato compacto (tipo "resumo")
        - Última mensagem da IA (antes da msg atual do cliente)
        - Última mensagem do cliente (a atual)
        """
        try:
            # Pegue uma janela razoável para achar a mensagem atual e as anteriores
            rows = await self.pg_client.fetch(
                """
                SELECT origin, content, metadata, sent_at
                FROM messages
                WHERE attendance_id = $1
                ORDER BY sent_at ASC
                LIMIT 80
                """,
                attendance_id,
            )
            messages = [dict(r) for r in rows] if rows else []
            if not messages:
                return {
                    "chat_history": "",
                    "last_ai_message": "",
                    "last_client_message": self._strip_simple_tags(current_client_content),
                }

            # Localizar a mensagem atual do cliente dentro da lista (por whatsappMessageId/messageId)
            current_idx: Optional[int] = None
            needle = (current_client_whatsapp_message_id or "").strip()
            if needle:
                for i in range(len(messages) - 1, -1, -1):
                    m = messages[i]
                    if m.get("origin") != "CLIENT":
                        continue
                    md = self._safe_parse_metadata(m.get("metadata"))
                    if md.get("whatsappMessageId") == needle or md.get("messageId") == needle:
                        current_idx = i
                        break

            # Fallback: tentar casar por conteúdo (última msg CLIENT com mesmo texto)
            if current_idx is None:
                current_plain = self._strip_simple_tags(current_client_content)
                for i in range(len(messages) - 1, -1, -1):
                    m = messages[i]
                    if m.get("origin") != "CLIENT":
                        continue
                    if self._strip_simple_tags(m.get("content") or "") == current_plain and current_plain:
                        current_idx = i
                        break

            # Se ainda não achou, assume que a mensagem atual é a última CLIENT (se existir)
            if current_idx is None:
                for i in range(len(messages) - 1, -1, -1):
                    if messages[i].get("origin") == "CLIENT":
                        current_idx = i
                        break

            if current_idx is None:
                # Não há mensagens CLIENT no histórico (raro)
                return {
                    "chat_history": "",
                    "last_ai_message": "",
                    "last_client_message": self._strip_simple_tags(current_client_content),
                }

            previous_msgs = messages[:current_idx]
            previous_15 = previous_msgs[-previous_messages_count:] if previous_msgs else []

            # Última msg da IA antes da atual
            last_ai = ""
            for m in reversed(previous_msgs):
                if m.get("origin") == "AI":
                    last_ai = self._strip_simple_tags(m.get("content") or "")
                    break

            # "Resumo" compacto: lista das 15 anteriores com papéis
            summary_lines: List[str] = []
            for m in previous_15:
                origin = (m.get("origin") or "").upper()
                role = "CLIENTE" if origin == "CLIENT" else ("IA" if origin == "AI" else origin or "OUTRO")
                content = self._strip_simple_tags(m.get("content") or "")
                summary_lines.append(f"- {role}: {self._compact_text(content)}")

            chat_history = (
                "RESUMO (15 mensagens anteriores):\n"
                + ("\n".join(summary_lines) if summary_lines else "(nenhuma)")
                + "\n\n"
                + "ÚLTIMA MENSAGEM DA IA:\n"
                + (self._compact_text(last_ai, 500) if last_ai else "(nenhuma)")
            )

            return {
                "chat_history": chat_history.strip(),
                "last_ai_message": last_ai,
                "last_client_message": self._strip_simple_tags(current_client_content),
            }
        except Exception as e:
            logger.error(f"Error building router context: {e}", exc_info=True)
            return {
                "chat_history": "",
                "last_ai_message": "",
                "last_client_message": self._strip_simple_tags(current_client_content),
            }
    
    async def get_recent_messages_list(
        self,
        attendance_id: str,
        limit: int = 25
    ) -> List[Dict]:
        """
        Get recent messages as list of dicts
        
        Args:
            attendance_id: Attendance UUID
            limit: Number of messages
            
        Returns:
            List of message dicts
        """
        try:
            messages = await self.pg_client.fetch("""
                SELECT id, origin, content, metadata, sent_at
                FROM messages
                WHERE attendance_id = $1
                ORDER BY sent_at DESC
                LIMIT $2
            """, attendance_id, limit)
            
            return [dict(msg) for msg in reversed(messages)]
            
        except Exception as e:
            logger.error(f"Error getting messages list: {e}", exc_info=True)
            return []
    
    async def get_conversation_summary(self, attendance_id: str) -> Optional[str]:
        """
        Get conversation summary from aiContext or create if needed
        
        Args:
            attendance_id: Attendance UUID
            
        Returns:
            Summary text or None
        """
        try:
            # Check if summary exists in attendance aiContext
            attendance = await self.pg_client.fetchrow("""
                SELECT ai_context
                FROM attendances
                WHERE id = $1
            """, attendance_id)
            
            if attendance and attendance['ai_context']:
                ai_context = attendance['ai_context']
                # Parse JSON if it's a string
                if isinstance(ai_context, str):
                    import json
                    try:
                        ai_context = json.loads(ai_context)
                    except:
                        logger.error(f"Error parsing ai_context as JSON: {ai_context[:100]}")
                        return None
                
                if isinstance(ai_context, dict) and 'conversationSummary' in ai_context:
                    return ai_context['conversationSummary']
            
            # Check if we need to create summary (> 75 messages)
            message_count = await self.pg_client.fetchrow("""
                SELECT COUNT(*) as count
                FROM messages
                WHERE attendance_id = $1
            """, attendance_id)
            
            if message_count and message_count['count'] > 75:
                # Create summary
                summary = await self.create_summary(attendance_id)
                return summary
            
            return None
            
        except Exception as e:
            logger.error(f"Error getting conversation summary: {e}", exc_info=True)
            return None
    
    async def create_summary(self, attendance_id: str) -> str:
        """
        Create summary of messages 50-75
        
        Args:
            attendance_id: Attendance UUID
            
        Returns:
            Summary text
        """
        try:
            logger.info(f"Creating summary for attendance {attendance_id}")
            
            # Get messages 50-75
            messages = await self.pg_client.fetch("""
                SELECT content, origin, sent_at
                FROM messages
                WHERE attendance_id = $1
                ORDER BY sent_at
                OFFSET 50 LIMIT 25
            """, attendance_id)
            
            if not messages:
                return ""
            
            # Format messages for summarization
            messages_text = "\n".join([
                f"{msg['origin']}: {msg['content']}"
                for msg in messages
            ])
            
            # Create summary using LLM
            summary_prompt = f"""
Resuma as seguintes conversas de forma concisa, mantendo:
- Intenção do cliente
- Dados coletados (marca, modelo, ano, peça)
- Status do atendimento
- Decisões importantes

Conversas:
{messages_text}

Forneça um resumo em português, objetivo e direto.
"""
            
            response = await self.openai_service.chat_completion([
                {"role": "system", "content": "Você é um assistente que resume conversas de atendimento."},
                {"role": "user", "content": summary_prompt}
            ])
            
            summary = response.choices[0].message.content
            
            # Save summary to database and vector DB
            await self.save_summary(attendance_id, summary)
            
            logger.info(f"Summary created for attendance {attendance_id}")
            return summary
            
        except Exception as e:
            logger.error(f"Error creating summary: {e}", exc_info=True)
            return ""
    
    async def create_final_summary_on_close(self, attendance_id: str) -> str:
        """
        Gera resumo final ao fechar atendimento: últimas N mensagens + resumo intermediário, via LLM.
        Grava em ai_context.conversationSummary e envia para o Vector DB (RAG futuro).
        """
        try:
            logger.info(f"Creating final summary on close for attendance {attendance_id}")
            existing_summary = await self.get_conversation_summary(attendance_id)
            messages = await self.pg_client.fetch("""
                SELECT content, origin, sent_at
                FROM messages
                WHERE attendance_id = $1
                ORDER BY sent_at DESC
                LIMIT 30
            """, attendance_id)
            messages = list(reversed(messages)) if messages else []
            messages_text = "\n".join([
                f"{m['origin']}: {m['content']}"
                for m in messages
            ])
            prompt = f"""Resumo intermediário da conversa (quando existir):
{existing_summary or '(nenhum)'}

Últimas mensagens:
{messages_text or '(nenhuma)'}

Gere um resumo final em português, objetivo e direto, com: intenção do cliente, dados coletados, status e decisões. Use o resumo intermediário e as últimas mensagens."""
            response = await self.openai_service.chat_completion([
                {"role": "system", "content": "Você é um assistente que resume conversas de atendimento ao fechamento."},
                {"role": "user", "content": prompt}
            ])
            summary = (response.choices[0].message.content or "").strip()
            if summary:
                await self.save_summary(attendance_id, summary)
                logger.info(f"Final summary on close saved for attendance {attendance_id}")
            return summary
        except Exception as e:
            logger.error(f"Error creating final summary on close: {e}", exc_info=True)
            return ""

    async def save_summary(self, attendance_id: str, summary: str):
        """Save summary to database and vector DB"""
        try:
            # Update attendance aiContext
            await self.pg_client.execute("""
                UPDATE attendances
                SET ai_context = COALESCE(ai_context, '{}'::jsonb) || 
                    jsonb_build_object('conversationSummary', $2::text)
                WHERE id = $1
            """, attendance_id, summary)
            
            # Create embedding and store in Vector DB
            embedding = await self.openai_service.create_embedding(summary)
            
            # Get attendance metadata
            attendance = await self.pg_client.fetchrow("""
                SELECT client_phone, vehicle_brand, created_at
                FROM attendances
                WHERE id = $1
            """, attendance_id)
            
            if attendance:
                await self.vector_db.store_attendance_summary(
                    attendance_id=attendance_id,
                    summary_text=summary,
                    embedding=embedding,
                    metadata={
                        'client_phone': attendance['client_phone'],
                        'vehicle_brand': attendance['vehicle_brand'],
                        'timestamp': attendance['created_at'].isoformat()
                    }
                )
            
        except Exception as e:
            logger.error(f"Error saving summary: {e}", exc_info=True)
    
    async def has_previous_attendances(self, client_phone: str) -> bool:
        """
        Check if client has previous finished attendances (optimization)
        
        Args:
            client_phone: Client phone number
            
        Returns:
            True if client has previous attendances, False otherwise
        """
        try:
            count = await self.pg_client.fetchval("""
                SELECT COUNT(*) 
                FROM attendances
                WHERE client_phone = $1 
                AND state = 'FINISHED'
                LIMIT 1
            """, client_phone)
            return count and count > 0
        except Exception as e:
            logger.error(f"Error checking previous attendances: {e}", exc_info=True)
            return False
    
    async def get_message_count(self, attendance_id: str) -> int:
        """
        Get message count for attendance (optimization)
        
        Args:
            attendance_id: Attendance UUID
            
        Returns:
            Message count
        """
        try:
            count = await self.pg_client.fetchval("""
                SELECT COUNT(*) FROM messages WHERE attendance_id = $1
            """, attendance_id)
            return count or 0
        except Exception as e:
            logger.error(f"Error getting message count: {e}", exc_info=True)
            return 0
    
    async def get_last_routed_specialist(self, attendance_id: str) -> Optional[str]:
        """
        Retorna o nome do último agente especialista para o qual o cliente foi roteado neste atendimento.
        Usado pelo roteador para manter continuidade quando a mensagem não explicita novo destino.
        """
        try:
            row = await self.pg_client.fetchrow("""
                SELECT specialist_name FROM attendance_last_routed_specialist
                WHERE attendance_id = $1
            """, attendance_id)
            return row['specialist_name'] if row and row.get('specialist_name') else None
        except Exception as e:
            logger.debug(f"Could not get last routed specialist for {attendance_id}: {e}")
            return None
    
    async def set_last_routed_specialist(self, attendance_id: str, specialist_name: str) -> None:
        """
        Registra o agente especialista para o qual o cliente foi roteado nesta mensagem.
        """
        try:
            await self.pg_client.execute("""
                INSERT INTO attendance_last_routed_specialist (attendance_id, specialist_name, updated_at)
                VALUES ($1, $2, now())
                ON CONFLICT (attendance_id) DO UPDATE SET specialist_name = $2, updated_at = now()
            """, attendance_id, specialist_name)
        except Exception as e:
            logger.warning(f"Could not set last routed specialist for {attendance_id}: {e}")
    
    async def get_rag_context(self, client_phone: str, limit: int = 100, search_query: str = "") -> str:
        """
        Get RAG context from past attendances - busca em até 100 atendimentos anteriores
        
        Args:
            client_phone: Client phone number
            limit: Number of attendances to retrieve (default 100 - longo prazo)
            search_query: Query to search for relevant context (opcional)
            
        Returns:
            Formatted RAG context string
        """
        try:
            # Get last N finished attendances (até 100 para busca profunda)
            past_attendances = await self.pg_client.fetch("""
                SELECT id, vehicle_brand, created_at, finalized_at, ai_context
                FROM attendances
                WHERE client_phone = $1 
                AND state = 'FINISHED'
                ORDER BY finalized_at DESC
                LIMIT $2
            """, client_phone, limit)
            
            if not past_attendances:
                return ""
            
            contexts = []
            for attendance in past_attendances:
                # OPTIMIZATION: Try to get summary from aiContext first
                # Only do embedding search if summary is NOT in aiContext
                summary_text = None
                
                # Check aiContext first (most common case)
                ai_ctx = attendance.get('ai_context')
                if ai_ctx:
                    # Parse JSON if it's a string
                    if isinstance(ai_ctx, str):
                        import json
                        try:
                            ai_ctx = json.loads(ai_ctx)
                        except:
                            ai_ctx = None
                    
                    if isinstance(ai_ctx, dict):
                        summary_text = ai_ctx.get('conversationSummary')
                
                # OPTIMIZATION: Only do embedding search if summary is really missing
                # This avoids unnecessary OpenAI embedding calls
                if not summary_text:
                    # Try to get from Vector DB using direct ID lookup (no embedding needed)
                    try:
                        summary_point = await self.vector_db.get_attendance_summary_by_id(str(attendance['id']))
                        if summary_point and summary_point.get('payload'):
                            summary_text = summary_point['payload'].get('text')
                    except Exception as vector_error:
                        logger.debug(f"Vector DB lookup failed for attendance {attendance['id']}: {vector_error}")
                    
                    # If still not found, skip this attendance (don't create embedding - too expensive)
                    if not summary_text:
                        logger.debug(f"Summary not found for attendance {attendance['id']}, skipping")
                        continue
                
                if summary_text:
                    contexts.append({
                        "date": attendance['finalized_at'].strftime('%d/%m/%Y') if attendance.get('finalized_at') else 'N/A',
                        "brand": attendance['vehicle_brand'] or 'N/A',
                        "summary": summary_text
                    })
            
            if not contexts:
                return ""
            
            # Format RAG context
            rag_text = "Histórico de atendimentos anteriores deste cliente:\n\n"
            for ctx in contexts:
                rag_text += f"- {ctx['date']} (Marca: {ctx['brand']}): {ctx['summary']}\n"
            
            return rag_text
            
        except Exception as e:
            logger.error(f"Error getting RAG context: {e}", exc_info=True)
            return ""
    
    def format_message_content(self, msg: Dict) -> str:
        """
        Format message content with appropriate tags
        
        Args:
            msg: Message dict
            
        Returns:
            Formatted content string
        """
        metadata = msg.get('metadata', {})
        
        if metadata.get('transcription'):
            return f"<audio>{metadata['transcription']}</audio>"
        elif metadata.get('description'):
            return f"<imagem>{metadata['description']}</imagem>"
        else:
            content = msg.get('content', '')
            return f"<texto>{content}</texto>"
    
    async def check_and_create_summary_if_needed(self, attendance_id: str):
        """
        Check if attendance has > 75 messages and create summary if needed
        
        Args:
            attendance_id: Attendance UUID
        """
        try:
            message_count = await self.pg_client.fetchrow("""
                SELECT COUNT(*) as count
                FROM messages
                WHERE attendance_id = $1
            """, attendance_id)
            
            if message_count and message_count['count'] > 75:
                # Check if summary already exists
                attendance = await self.pg_client.fetchrow("""
                    SELECT ai_context
                    FROM attendances
                    WHERE id = $1
                """, attendance_id)
                
                # Parse ai_context if it's a string
                ai_context = attendance.get('ai_context') if attendance else None
                if ai_context and isinstance(ai_context, str):
                    import json
                    try:
                        ai_context = json.loads(ai_context)
                    except:
                        ai_context = {}
                elif not isinstance(ai_context, dict):
                    ai_context = {}
                
                if not ai_context.get('conversationSummary'):
                    await self.create_summary(attendance_id)
                    
        except Exception as e:
            logger.error(f"Error checking summary: {e}")
    
    async def get_attendance_context(self, attendance_id: str) -> Dict:
        """
        Get complete attendance context including Purchase, Warranty, and related attendances
        
        Args:
            attendance_id: Current attendance UUID
            
        Returns:
            Dict with attendance, purchase, warranty, related_attendances, messages, summary
        """
        try:
            # Get current attendance
            attendance = await self.pg_client.fetchrow("""
                SELECT 
                    id, client_phone, operational_state, attendance_type, 
                    purchase_origin, purchase_date, related_attendance_id,
                    vehicle_brand, seller_id, supervisor_id, is_finalized,
                    created_at, updated_at
                FROM attendances
                WHERE id = $1
            """, attendance_id)
            
            if not attendance:
                return {}
            
            context = {
                "attendance": dict(attendance) if attendance else None,
                "purchase": None,
                "warranty": None,
                "related_attendances": [],
                "messages": [],
                "summary": None,
            }
            
            # Get Purchase if exists
            purchase = await self.pg_client.fetchrow("""
                SELECT 
                    id, seller_id, items, total_amount, payment_method,
                    delivery_method, payment_link, status, purchase_origin,
                    purchase_date, created_at
                FROM purchases
                WHERE attendance_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            """, attendance_id)
            
            if purchase:
                context["purchase"] = dict(purchase)
                
                # Get Warranty for this purchase
                warranty = await self.pg_client.fetchrow("""
                    SELECT 
                        id, start_date, end_date, is_active, claims_count
                    FROM warranties
                    WHERE purchase_id = $1
                """, purchase['id'])
                
                if warranty:
                    context["warranty"] = dict(warranty)
            
            # Get related attendances (if related_attendance_id exists)
            if attendance.get('related_attendance_id'):
                related = await self.pg_client.fetchrow("""
                    SELECT 
                        id, attendance_type, purchase_date, created_at
                    FROM attendances
                    WHERE id = $1
                """, attendance['related_attendance_id'])
                
                if related:
                    context["related_attendances"].append(dict(related))
            
            # Get recent messages
            messages = await self.get_recent_messages_list(attendance_id, limit=25)
            context["messages"] = messages
            
            # Get summary if exists
            summary = await self.get_conversation_summary(attendance_id)
            if summary:
                context["summary"] = summary
            
            return context
            
        except Exception as e:
            logger.error(f"Error getting attendance context: {e}", exc_info=True)
            return {}
    
    async def add_message(
        self,
        attendance_id: str,
        message,
        origin: str = "AI"
    ):
        """
        Save message to database immediately for shared memory between agents
        
        Args:
            attendance_id: Attendance UUID
            message: LangChain message (HumanMessage or AIMessage)
            origin: Message origin ('CLIENT', 'AI', 'SYSTEM', 'SELLER')
        """
        try:
            from langchain_core.messages import HumanMessage, AIMessage
            
            # Determine origin if not provided
            if origin == "AI" and isinstance(message, HumanMessage):
                origin = "CLIENT"
            elif origin == "CLIENT" and isinstance(message, AIMessage):
                origin = "AI"
            
            # Extract content
            content = message.content if hasattr(message, 'content') else str(message)
            
            # Extract metadata
            metadata = {}
            if hasattr(message, 'additional_kwargs') and message.additional_kwargs:
                metadata = message.additional_kwargs.copy()
            
            # Check if message already exists (by messageId for CLIENT messages, or by content+timestamp for AI)
            message_id = metadata.get('messageId') if metadata else None
            if message_id and origin == "CLIENT":
                existing = await self.pg_client.fetchval("""
                    SELECT id FROM messages 
                    WHERE metadata->>'messageId' = $1 AND attendance_id = $2
                """, message_id, attendance_id)
                if existing:
                    logger.debug(f"Message already exists in database (messageId: {message_id}), skipping save")
                    return
            
            # For AI messages, check if a similar message was just saved (within last 5 seconds)
            # This prevents duplicates when multiple agents process the same response
            if origin == "AI":
                recent_ai = await self.pg_client.fetchval("""
                    SELECT id FROM messages 
                    WHERE attendance_id = $1 
                    AND origin = 'AI' 
                    AND content = $2
                    AND sent_at > NOW() - INTERVAL '5 seconds'
                    LIMIT 1
                """, attendance_id, content)
                if recent_ai:
                    logger.debug(f"Similar AI message already saved recently, skipping duplicate")
                    return
            
            # Save to database (metadata as JSON string for JSONB; asyncpg can expect str in some setups)
            metadata_json = json.dumps(metadata) if isinstance(metadata, dict) else (metadata or "null")
            await self.pg_client.execute("""
                INSERT INTO messages (attendance_id, origin, content, metadata, sent_at)
                VALUES ($1, $2, $3, $4::jsonb, NOW())
            """, attendance_id, origin, content, metadata_json)
            
            logger.debug(f"✅ Message saved to database for attendance {attendance_id} (origin: {origin})")
            
        except Exception as e:
            logger.error(f"Error saving message to database: {e}", exc_info=True)
    
    async def get_recent_client_messages_with_ai_responses(
        self,
        attendance_id: str,
        limit: int = 10
    ) -> str:
        """
        Get last N client messages + AI responses between them
        
        REGRA NOVA: Todas as mensagens que aconteceram DEPOIS da 10ª mensagem mais antiga do cliente
        - Conta apenas mensagens CLIENT para determinar o corte
        - Inclui TODAS as mensagens (CLIENT + AI) depois desse ponto
        
        Args:
            attendance_id: Attendance UUID
            limit: Number of CLIENT messages to count backwards (default: 10)
            
        Returns:
            Formatted chat history with all messages after the Nth oldest client message
        """
        try:
            # Get all messages ordered by time
            all_messages = await self.pg_client.fetch("""
                SELECT origin, content, metadata, sent_at
                FROM messages
                WHERE attendance_id = $1
                ORDER BY sent_at ASC
            """, attendance_id)
            
            if not all_messages:
                return ""
            
            # Find all CLIENT messages in chronological order
            client_messages = [msg for msg in all_messages if msg['origin'] == 'CLIENT']
            
            if not client_messages:
                return ""
            
            # Se temos menos mensagens do cliente do que o limit, incluir tudo
            if len(client_messages) <= limit:
                # Incluir todas as mensagens
                oldest_client_time = client_messages[0]['sent_at']
            else:
                # Pegar a 10ª mensagem mais antiga do cliente (contando do início)
                # Se limit=10 e temos 25 msgs do cliente, pegamos client_messages[-10] (a 16ª mensagem)
                # Isso significa: tudo DEPOIS da 10ª mensagem mais antiga = últimas 15 msgs do cliente + respostas
                nth_oldest_index = len(client_messages) - limit
                oldest_client_time = client_messages[nth_oldest_index]['sent_at']
            
            # Now get all messages from that point forward (including AI responses)
            recent_messages = [
                msg for msg in all_messages
                if msg['sent_at'] >= oldest_client_time
            ]
            
            logger.info(f"📝 Recentes: {len(client_messages)} msgs cliente total, incluindo últimas {min(len(client_messages), limit)} + respostas = {len(recent_messages)} msgs totais")
            
            # Format messages
            formatted = []
            for msg in recent_messages:
                role = "Cliente" if msg['origin'] == 'CLIENT' else "Assistente"
                metadata = msg['metadata'] if isinstance(msg['metadata'], dict) else {}
                msg_dict = {
                    'content': msg['content'],
                    'metadata': metadata
                }
                content = self.format_message_content(msg_dict)
                formatted.append(f"{role}: {content}")
            
            return "\n".join(formatted)
            
        except Exception as e:
            logger.error(f"Error getting recent client messages with AI responses: {e}", exc_info=True)
            return ""
    
    async def get_intermediate_summary(
        self,
        attendance_id: str,
        summary_limit: int = 30,
        current_message: str = ""
    ) -> str:
        """
        Get summary of intermediate messages (30 messages before the recent 10 client messages)
        
        Creates summary only when:
        1. Every 10 client messages (10, 20, 30, etc.)
        2. OR when current message mentions something not in existing summary
        
        Uses cached summary from ai_context if still valid.
        
        Args:
            attendance_id: Attendance UUID
            summary_limit: Number of messages to summarize (default: 30)
            current_message: Current message content (to check if summary needs update)
            
        Returns:
            Summary text or empty string
        """
        try:
            # Get all messages ordered by time
            all_messages = await self.pg_client.fetch("""
                SELECT origin, content, metadata, sent_at
                FROM messages
                WHERE attendance_id = $1
                ORDER BY sent_at ASC
            """, attendance_id)
            
            if not all_messages:
                return ""
            
            # Count total CLIENT messages
            total_client_messages = sum(1 for msg in all_messages if msg['origin'] == 'CLIENT')
            
            # Find the last 10 CLIENT messages
            client_messages = []
            for msg in reversed(all_messages):
                if msg['origin'] == 'CLIENT':
                    client_messages.append(msg)
                    if len(client_messages) >= 10:
                        break
            
            if not client_messages or total_client_messages < 11:
                # Not enough messages to create intermediate summary
                return ""
            
            # Get the timestamp of the oldest client message in recent window
            oldest_recent_time = client_messages[-1]['sent_at']
            
            # Get messages before that point (for summary)
            messages_before_recent = [
                msg for msg in all_messages
                if msg['sent_at'] < oldest_recent_time
            ]
            
            if not messages_before_recent:
                return ""
            
            # Count CLIENT messages before recent window
            client_messages_before_recent = sum(1 for msg in messages_before_recent if msg['origin'] == 'CLIENT')
            
            # Check if intermediate summary already exists in ai_context
            attendance = await self.pg_client.fetchrow("""
                SELECT ai_context
                FROM attendances
                WHERE id = $1
            """, attendance_id)
            
            existing_summary = None
            last_summarized_count = 0
            
            if attendance and attendance['ai_context']:
                ai_context = attendance['ai_context']
                if isinstance(ai_context, str):
                    import json
                    try:
                        ai_context = json.loads(ai_context)
                    except:
                        pass
                
                if isinstance(ai_context, dict):
                    existing_summary = ai_context.get('intermediateSummary')
                    last_summarized_count = ai_context.get('lastSummarizedClientCount', 0)
            
            # Decide if we need to create/update summary
            should_create_summary = False
            reason = ""
            
            # Rule 1: Create summary every 10 client messages (or whenever there are messages before recent and no summary yet)
            # Isso evita lacuna de contexto: com 11–20 msgs do cliente, "recentes" = últimas 10; as primeiras 1–10 ficavam sem resumo.
            if client_messages_before_recent >= 10:
                # Calculate which "decade" we're in (10, 20, 30, etc.)
                current_decade = (client_messages_before_recent // 10) * 10
                last_summarized_decade = (last_summarized_count // 10) * 10
                
                if current_decade > last_summarized_decade:
                    should_create_summary = True
                    reason = f"crossed decade boundary ({current_decade} client messages)"
                elif not existing_summary:
                    should_create_summary = True
                    reason = "no existing summary"
            elif not existing_summary and client_messages_before_recent >= 1:
                # Mensagens antes da janela recente mas menos de 10: criar resumo mesmo assim para não perder contexto
                should_create_summary = True
                reason = f"messages before recent window ({client_messages_before_recent} client msgs, no summary yet)"
            
            # Rule 2: Check if current message mentions something not in summary
            if not should_create_summary and existing_summary and current_message:
                # Simple check: if message is asking about something specific
                # and summary doesn't contain relevant keywords
                current_lower = current_message.lower()
                summary_lower = existing_summary.lower()
                
                # Keywords that suggest the message might reference old context
                reference_keywords = [
                    'antes', 'anterior', 'última vez', 'outra vez', 'mesmo', 'igual',
                    'pedido', 'compra', 'problema', 'reclamação', 'garantia'
                ]
                
                has_reference_keyword = any(kw in current_lower for kw in reference_keywords)
                
                if has_reference_keyword:
                    # Check if summary contains any of the key terms from current message
                    # Extract key terms (simple: words longer than 4 chars)
                    key_terms = [w for w in current_lower.split() if len(w) > 4]
                    summary_has_terms = any(term in summary_lower for term in key_terms)
                    
                    if not summary_has_terms and len(key_terms) > 0:
                        should_create_summary = True
                        reason = f"current message references context not in summary"
            
            # Use existing summary if still valid
            if existing_summary and not should_create_summary:
                logger.debug(f"✅ Using cached intermediate summary for attendance {attendance_id} (covers {last_summarized_count} client messages)")
                return existing_summary
            
            # Create new summary
            if should_create_summary:
                # Take last summary_limit messages before the recent window
                messages_to_summarize = messages_before_recent[-summary_limit:]
                
                if not messages_to_summarize:
                    return ""
                
                messages_text = "\n".join([
                    f"{'Cliente' if msg['origin'] == 'CLIENT' else 'Assistente'}: {msg['content']}"
                    for msg in messages_to_summarize
                ])
                
                summary_prompt = f"""
Resuma as seguintes conversas de forma concisa, mantendo:
- Assunto principal
- Decisões tomadas
- Dados importantes (produto, valores, prazos, problemas, etc.)
- Emoção ou intenção do cliente (ex: irritado, com dúvida, querendo comprar)

Conversas:
{messages_text}

Forneça um resumo em português, objetivo e direto.
"""
                
                try:
                    response = await self.openai_service.chat_completion([
                        {"role": "system", "content": "Você é um assistente que resume conversas de atendimento."},
                        {"role": "user", "content": summary_prompt}
                    ])
                    
                    summary = response.choices[0].message.content
                    
                    # Save summary to ai_context with metadata
                    await self.pg_client.execute("""
                        UPDATE attendances
                        SET ai_context = COALESCE(ai_context, '{}'::jsonb) || 
                            jsonb_build_object(
                                'intermediateSummary', $2::text,
                                'lastSummarizedClientCount', $3::int
                            )
                        WHERE id = $1
                    """, attendance_id, summary, client_messages_before_recent)
                    
                    logger.info(f"✅ Created intermediate summary for attendance {attendance_id} ({len(messages_to_summarize)} messages, {client_messages_before_recent} client msgs) - Reason: {reason}")
                    return summary
                except Exception as e:
                    logger.error(f"Error creating intermediate summary: {e}", exc_info=True)
                    return ""
            
            return existing_summary or ""
            
        except Exception as e:
            logger.error(f"Error getting intermediate summary: {e}", exc_info=True)
            return ""
    
    async def get_open_cases(self, attendance_id: str) -> List[Dict]:
        """
        Get open cases for an attendance (status not in resolvido, cancelado).

        Caso = situação criada por function call (ex.: pedidoorcamento, garantia, pos_venda),
        que o vendedor/supervisor precisam responder para a IA seguir. Não inclui "Não Atribuídos"
        nem triagem — apenas registros de attendance_cases. Ver docs/CASOS_E_ATENDIMENTOS_MODELO.md.
        
        Args:
            attendance_id: Attendance UUID
            
        Returns:
            List of dicts with id, type_key, type_label, status, title
        """
        try:
            rows = await self.pg_client.fetch("""
                SELECT ac.id, ac.status, ac.title, ct.key AS type_key, ct.label AS type_label
                FROM attendance_cases ac
                JOIN case_types ct ON ct.id = ac.case_type_id
                WHERE ac.attendance_id = $1
                AND ac.status NOT IN ('resolvido', 'cancelado')
                ORDER BY ac.created_at DESC
            """, attendance_id)
            return [dict(r) for r in rows]
        except Exception as e:
            logger.debug(f"Error getting open cases for attendance {attendance_id}: {e}")
            return []
    
    async def build_context_with_new_rules(
        self,
        attendance_id: str,
        client_phone: str,
        current_message: str
    ) -> Dict[str, str]:
        """
        Build context following the new rules:
        1. Last 10 CLIENT messages + AI responses between them
        2. Summary of 30 previous messages
        3. RAG only if needed (when info not in recent messages or summary)
        
        Args:
            attendance_id: Attendance UUID
            client_phone: Client phone number
            current_message: Current message content (to check if RAG is needed)
            
        Returns:
            Dict with keys: 'recent_messages', 'intermediate_summary', 'rag_context'
        """
        try:
            # 1. Get recent messages (last 15 CLIENT + AI responses) — janela maior evita perder contexto no meio da conversa
            recent_messages = await self.get_recent_client_messages_with_ai_responses(
                attendance_id=attendance_id,
                limit=15
            )
            
            # 2. Get intermediate summary (30 messages before recent window)
            # Pass current_message to check if summary needs update
            intermediate_summary = await self.get_intermediate_summary(
                attendance_id=attendance_id,
                summary_limit=30,
                current_message=current_message
            )
            
            # 3. Check if RAG is needed (LAST RESORT - only after checking recent messages and summary)
            # RAG is needed ONLY if:
            # - Current message mentions something specific
            # - AND that info is NOT in recent_messages
            # - AND that info is NOT in intermediate_summary
            # - THEN use RAG to search deep memory
            rag_context = ""
            
            # Check if client has previous attendances
            has_previous_attendances = await self.has_previous_attendances(client_phone)
            
            if has_previous_attendances and current_message:
                current_message_lower = current_message.lower()
                
                # Keywords that suggest need for deep memory search
                rag_keywords = [
                    'pedido', 'ordem', 'compra anterior', 'última vez', 'antes', 'anteriormente',
                    'outra vez', 'mesmo', 'igual', 'parecido', 'similar', 'problema', 'reclamação',
                    'garantia', 'devolução', 'troca', 'reembolso'
                ]
                
                has_reference_keyword = any(keyword in current_message_lower for keyword in rag_keywords)
                
                # Only use RAG if:
                # 1. Message has reference keywords (suggests old context)
                # 2. AND information is NOT in recent messages
                # 3. AND information is NOT in intermediate summary
                if has_reference_keyword:
                    # Check if info is in recent messages
                    recent_lower = recent_messages.lower() if recent_messages else ""
                    info_in_recent = False
                    
                    # Extract key terms from current message (words longer than 4 chars)
                    key_terms = [w for w in current_message_lower.split() if len(w) > 4]
                    
                    if recent_lower and key_terms:
                        # Check if any key term appears in recent messages
                        info_in_recent = any(term in recent_lower for term in key_terms)
                    
                    # Check if info is in intermediate summary
                    summary_lower = intermediate_summary.lower() if intermediate_summary else ""
                    info_in_summary = False
                    
                    if summary_lower and key_terms:
                        # Check if any key term appears in summary
                        info_in_summary = any(term in summary_lower for term in key_terms)
                    
                    # Use RAG only if info is NOT in recent messages AND NOT in summary
                    # Busca em até 100 atendimentos anteriores (longo prazo)
                    if not info_in_recent and not info_in_summary:
                        rag_context = await self.get_rag_context(client_phone, limit=100, search_query=current_message)
                        logger.info(f"✅ RAG context included for attendance {attendance_id} (busca em até 100 atendimentos - info not found in recent messages or summary)")
                    else:
                        if info_in_recent:
                            logger.debug(f"⏭️ RAG skipped for attendance {attendance_id} (info found in recent messages)")
                        elif info_in_summary:
                            logger.debug(f"⏭️ RAG skipped for attendance {attendance_id} (info found in intermediate summary)")
                else:
                    logger.debug(f"⏭️ RAG skipped for attendance {attendance_id} (no reference keywords detected)")
            
            # 4. Get open cases for this attendance
            open_cases = await self.get_open_cases(attendance_id)
            
            return {
                'recent_messages': recent_messages,
                'intermediate_summary': intermediate_summary,
                'rag_context': rag_context or "",
                'open_cases': open_cases
            }
            
        except Exception as e:
            logger.error(f"Error building context with new rules: {e}", exc_info=True)
            return {
                'recent_messages': "",
                'intermediate_summary': "",
                'rag_context': "",
                'open_cases': []
            }

    async def get_dados_para_orcamento_xml(self, attendance_id: str) -> str:
        """
        Monta a seção <DadosParaOrcamento> do system prompt com variáveis dinâmicas.
        Só inclui quando a FC pedido-orcamento está configurada e ativa (evita contexto
        de autopeças em negócios que não usam orçamento de peças).
        """
        try:
            # 0. Só incluir se a FC pedido-orcamento existir e estiver ativa
            fc_row = await self.pg_client.fetchrow(
                """
                SELECT required_fields, optional_fields
                FROM agent_function_calls
                WHERE (name = $1 OR name = $2) AND is_active = true
                LIMIT 1
                """,
                "pedidoorcamento",
                "pedido-orcamento",
            )
            if not fc_row:
                return ""

            # 1. Buscar último QuoteRequest do atendimento (vehicle_info ou custom)
            last_quote = await self.pg_client.fetchrow(
                """
                SELECT vehicle_info
                FROM quote_requests
                WHERE attendance_id = $1
                ORDER BY created_at DESC
                LIMIT 1
                """,
                attendance_id,
            )
            vehicle_info = (last_quote.get("vehicle_info") or {}) if last_quote else {}
            if not isinstance(vehicle_info, dict):
                vehicle_info = {}

            def _val(k: str) -> str:
                v = vehicle_info.get(k)
                if v is None or (isinstance(v, str) and not v.strip()):
                    return "[não informado]"
                return str(v).strip()

            # Campos dinâmicos a partir do schema da FC
            req = fc_row.get("required_fields") or []
            opt = fc_row.get("optional_fields") or []
            if isinstance(req, str):
                req = [x.strip() for x in str(req).split(",") if x.strip()]
            if isinstance(opt, str):
                opt = [x.strip() for x in str(opt).split(",") if x.strip()]
            all_fields = list(dict.fromkeys(req + opt)) or ["marca", "modelo", "ano", "peca", "placa"]
            obrigatorios = ",".join(req) if req else "marca,modelo,ano,peca"
            opcional_recomendado = ",".join(opt) if opt else "placa"

            capturados = {f: _val(f) for f in all_fields}

            # 2. Montar XML com campos dinâmicos
            capturados_lines = [f"    <{f}>{capturados.get(f, '[não informado]')}</{f}>" for f in all_fields]
            lines = [
                "",
                "<DadosParaOrcamento>",
                f"  <Obrigatorios>{obrigatorios}</Obrigatorios>",
                f"  <OpcionalRecomendado>{opcional_recomendado}</OpcionalRecomendado>",
                "  <Capturados>",
                *capturados_lines,
                "  </Capturados>",
                "  <UltimoEnviado>",
                *capturados_lines,
                "  </UltimoEnviado>",
                "</DadosParaOrcamento>",
            ]
            return "\n".join(lines)
        except Exception as e:
            logger.debug(f"Error building DadosParaOrcamento XML: {e}")
            return ""

    async def build_context_after_switch(
        self,
        active_attendance_id: str,
        previous_attendance_id: str,
        client_phone: str,
        current_message: str
    ) -> Dict[str, Any]:
        """
        Monta contexto após troca de atendimento ativo: resumo do ativo, últimas 10 do ativo,
        últimas 10 do anterior (somente referência), RAG se necessário.
        Usado quando a IA chama trocar_atendimento_ativo e o worker precisa responder no novo contexto.
        """
        try:
            recent_active = await self.get_recent_client_messages_with_ai_responses(
                attendance_id=active_attendance_id, limit=10
            )
            summary_active = await self.get_intermediate_summary(
                attendance_id=active_attendance_id,
                summary_limit=30,
                current_message=current_message
            )
            previous_recent = await self.get_recent_client_messages_with_ai_responses(
                attendance_id=previous_attendance_id, limit=10
            )
            open_cases = await self.get_open_cases(active_attendance_id)
            rag_context = ""
            has_previous = await self.has_previous_attendances(client_phone)
            if has_previous and current_message:
                rag_context = await self.get_rag_context(client_phone, limit=3)
            return {
                'recent_messages': recent_active,
                'intermediate_summary': summary_active,
                'previous_recent_messages': previous_recent or "",
                'rag_context': rag_context or "",
                'open_cases': open_cases
            }
        except Exception as e:
            logger.error(f"Error building context after switch: {e}", exc_info=True)
            return {
                'recent_messages': "",
                'intermediate_summary': "",
                'previous_recent_messages': "",
                'rag_context': "",
                'open_cases': []
            }
    
    async def get_client_triagem_context(
        self,
        client_phone: str,
        whatsapp_number_id: str,
        current_attendance_id: str
    ) -> Dict[str, Any]:
        """
        Busca histórico completo do cliente quando ele chega em triagem.
        
        Retorna informações sobre:
        - Atendimentos anteriores (fechados)
        - Últimos 3 atendimentos com casos abertos
        - Atendimentos em aberto (não fechados)
        - Se parou no meio de algum processo
        
        Args:
            client_phone: Número do cliente
            whatsapp_number_id: ID do número WhatsApp
            current_attendance_id: ID do atendimento atual (para excluir da busca)
            
        Returns:
            Dict com informações estruturadas sobre histórico do cliente
        """
        try:
            # 1. Buscar atendimentos anteriores (fechados)
            closed_attendances = await self.pg_client.fetch("""
                SELECT id, operational_state, created_at, updated_at, ai_context
                FROM attendances
                WHERE client_phone = $1
                AND whatsapp_number_id = $2
                AND id != $3
                AND operational_state = 'FECHADO_OPERACIONAL'
                ORDER BY updated_at DESC
                LIMIT 10
            """, client_phone, whatsapp_number_id, current_attendance_id)
            
            closed_attendances_list = []
            for att in closed_attendances:
                summary = ""
                if att.get('ai_context'):
                    ai_context = att['ai_context']
                    if isinstance(ai_context, str):
                        try:
                            ai_context = json.loads(ai_context)
                        except:
                            pass
                    if isinstance(ai_context, dict) and 'conversationSummary' in ai_context:
                        summary = ai_context['conversationSummary']
                
                closed_attendances_list.append({
                    'id': str(att['id']),
                    'created_at': att['created_at'].isoformat() if att['created_at'] else None,
                    'updated_at': att['updated_at'].isoformat() if att['updated_at'] else None,
                    'summary': summary
                })
            
            # 2. Buscar últimos 3 atendimentos (fechados ou não) com casos abertos
            recent_attendances_with_cases = await self.pg_client.fetch("""
                SELECT DISTINCT a.id, a.operational_state, a.created_at, a.updated_at,
                       COUNT(ac.id) as open_cases_count
                FROM attendances a
                LEFT JOIN attendance_cases ac ON ac.attendance_id = a.id
                    AND ac.status NOT IN ('resolvido', 'cancelado')
                WHERE a.client_phone = $1
                AND a.whatsapp_number_id = $2
                AND a.id != $3
                GROUP BY a.id, a.operational_state, a.created_at, a.updated_at
                HAVING COUNT(ac.id) > 0
                ORDER BY a.updated_at DESC
                LIMIT 3
            """, client_phone, whatsapp_number_id, current_attendance_id)
            
            recent_with_cases = []
            for att in recent_attendances_with_cases:
                # Buscar casos abertos deste atendimento
                cases = await self.pg_client.fetch("""
                    SELECT ac.id, ac.status, ac.title, ct.key AS type_key, ct.label AS type_label
                    FROM attendance_cases ac
                    JOIN case_types ct ON ct.id = ac.case_type_id
                    WHERE ac.attendance_id = $1
                    AND ac.status NOT IN ('resolvido', 'cancelado')
                    ORDER BY ac.created_at DESC
                """, att['id'])
                
                cases_list = [{
                    'type_key': c['type_key'],
                    'type_label': c['type_label'],
                    'status': c['status'],
                    'title': c['title'] or 'Sem título'
                } for c in cases]
                
                recent_with_cases.append({
                    'id': str(att['id']),
                    'operational_state': att['operational_state'],
                    'created_at': att['created_at'].isoformat() if att['created_at'] else None,
                    'updated_at': att['updated_at'].isoformat() if att['updated_at'] else None,
                    'open_cases': cases_list
                })
            
            # 3. Buscar atendimentos em aberto (não fechados) - apenas um deve existir
            open_attendances = await self.pg_client.fetch("""
                SELECT id, operational_state, created_at, updated_at
                FROM attendances
                WHERE client_phone = $1
                AND whatsapp_number_id = $2
                AND id != $3
                AND operational_state NOT IN ('FECHADO_OPERACIONAL')
                ORDER BY updated_at DESC
            """, client_phone, whatsapp_number_id, current_attendance_id)
            
            open_attendances_list = []
            for att in open_attendances:
                # Buscar casos abertos deste atendimento
                cases = await self.pg_client.fetch("""
                    SELECT ac.id, ac.status, ac.title, ct.key AS type_key, ct.label AS type_label
                    FROM attendance_cases ac
                    JOIN case_types ct ON ct.id = ac.case_type_id
                    WHERE ac.attendance_id = $1
                    AND ac.status NOT IN ('resolvido', 'cancelado')
                    ORDER BY ac.created_at DESC
                """, att['id'])
                
                cases_list = [{
                    'type_key': c['type_key'],
                    'type_label': c['type_label'],
                    'status': c['status'],
                    'title': c['title'] or 'Sem título'
                } for c in cases]
                
                # Verificar se parou no meio de algum processo
                # Processo incompleto = atendimento em AGUARDANDO_CLIENTE ou AGUARDANDO_VENDEDOR há mais de 1 hora
                incomplete_process = False
                if att['operational_state'] in ('AGUARDANDO_CLIENTE', 'AGUARDANDO_VENDEDOR'):
                    if att['updated_at']:
                        from datetime import datetime, timedelta
                        one_hour_ago = datetime.utcnow() - timedelta(hours=1)
                        if att['updated_at'] < one_hour_ago:
                            incomplete_process = True
                
                open_attendances_list.append({
                    'id': str(att['id']),
                    'operational_state': att['operational_state'],
                    'created_at': att['created_at'].isoformat() if att['created_at'] else None,
                    'updated_at': att['updated_at'].isoformat() if att['updated_at'] else None,
                    'open_cases': cases_list,
                    'incomplete_process': incomplete_process
                })
            
            # 4. Verificar se nos últimos 3 atendimentos há casos abertos ou processos incompletos
            last_3_has_open_cases = len(recent_with_cases) > 0
            last_3_has_incomplete = any(att.get('incomplete_process', False) for att in open_attendances_list[:3])
            
            return {
                'has_previous_attendances': len(closed_attendances_list) > 0,
                'closed_attendances': closed_attendances_list,
                'recent_with_open_cases': recent_with_cases,
                'open_attendances': open_attendances_list,
                'last_3_has_open_cases': last_3_has_open_cases,
                'last_3_has_incomplete': last_3_has_incomplete,
                'has_open_attendances': len(open_attendances_list) > 0
            }
            
        except Exception as e:
            logger.error(f"Error getting client triagem context: {e}", exc_info=True)
            return {
                'has_previous_attendances': False,
                'closed_attendances': [],
                'recent_with_open_cases': [],
                'open_attendances': [],
                'last_3_has_open_cases': False,
                'last_3_has_incomplete': False,
                'has_open_attendances': False
            }
