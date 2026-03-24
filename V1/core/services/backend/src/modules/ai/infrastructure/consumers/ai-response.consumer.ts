import { IQueue } from '../../../../shared/infrastructure/queue/queue.interface';
import { InfrastructureFactory } from '../../../../shared/infrastructure/factories/infrastructure.factory';
import { whatsappManagerService } from '../../../whatsapp/application/services/whatsapp-manager.service';
import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Message } from '../../../message/domain/entities/message.entity';
import { MessageRead } from '../../../message/domain/entities/message-read.entity';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { MessageOrigin, MessageStatus, UUID, OperationalState } from '../../../../shared/types/common.types';
import { Not } from 'typeorm';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { logger } from '../../../../shared/utils/logger';
import crypto from 'crypto';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';

interface AIResponse {
  attendanceId: UUID;
  whatsappNumberId: UUID;
  clientPhone: string;
  content: string;
  mediaType: string;
  origin: string;
  actionTaken: string;
  routingData?: {
    vehicleBrand: string;
    sellerId: UUID;
    supervisorId: UUID;
  };
  timestamp: string;
  fragments?: string[] | null;
  responseMetadata?: Record<string, any> | null;
  clientMessageId?: string; // MessageId of the client message that triggered this response
}

export class AIResponseConsumer {
  private queueService: IQueue;

  constructor() {
    this.queueService = InfrastructureFactory.createQueue();
  }

  async start(): Promise<void> {
    logger.info('Starting AI Response Consumer...');

    try {
      await this.queueService.consume('ai-responses', async (message: unknown) => {
        // CORREÇÃO: Log quando mensagem é recebida da fila
        const responseData = message as AIResponse;
        logger.info('📨 Message received from ai-responses queue', {
          attendanceId: responseData.attendanceId,
          whatsappNumberId: responseData.whatsappNumberId,
          clientPhone: responseData.clientPhone,
          hasFragments: !!(responseData.fragments && responseData.fragments.length > 0),
          fragmentCount: responseData.fragments?.length || 0,
        });
        
        try {
          await this.processResponse(responseData);
        } catch (processError: any) {
          logger.error('❌ Error processing AI response from queue', {
            error: processError?.message,
            stack: processError?.stack,
            attendanceId: responseData.attendanceId,
            whatsappNumberId: responseData.whatsappNumberId,
          });
          // Re-throw para que a fila possa fazer retry se configurado
          throw processError;
        }
      });

      logger.info('✅ AI Response Consumer started successfully');
    } catch (error) {
      logger.error('❌ Error starting AI Response Consumer', { error });
      throw error;
    }
  }

  private async processResponse(data: AIResponse): Promise<void> {
    try {
      logger.info('Processing AI response', {
        attendanceId: data.attendanceId,
        whatsappNumberId: data.whatsappNumberId, // CORREÇÃO: Log do whatsappNumberId
        clientPhone: data.clientPhone,
        actionTaken: data.actionTaken,
        hasFragments: !!(data.fragments && data.fragments.length > 0),
        fragmentCount: data.fragments?.length || 0,
        contentPreview: data.content?.substring(0, 100),
      });

      // CORREÇÃO: Verificar se whatsappNumberId está presente
      if (!data.whatsappNumberId) {
        logger.error('⚠️ whatsappNumberId missing in AI response payload!', {
          attendanceId: data.attendanceId,
          clientPhone: data.clientPhone,
          payloadKeys: Object.keys(data),
        });
        return;
      }

      // Get Baileys adapter
      const adapter = whatsappManagerService.getAdapter(data.whatsappNumberId);

      if (!adapter) {
        logger.error('⚠️ No Baileys adapter found for whatsappNumberId', {
          whatsappNumberId: data.whatsappNumberId,
          attendanceId: data.attendanceId,
          clientPhone: data.clientPhone,
        });
        return;
      }

      // CORREÇÃO: Verificar se o adapter está conectado
      if (!adapter.isConnected()) {
        logger.error('⚠️ Baileys adapter is not connected', {
          whatsappNumberId: data.whatsappNumberId,
          attendanceId: data.attendanceId,
          clientPhone: data.clientPhone,
        });
        return;
      }

      logger.info('✅ Adapter found and connected, proceeding to send message', {
        whatsappNumberId: data.whatsappNumberId,
        attendanceId: data.attendanceId,
      });

      // Start typing indicator
      try {
        await adapter.sendTyping(data.clientPhone, true);
        logger.debug('Typing indicator started', {
          attendanceId: data.attendanceId,
          clientPhone: data.clientPhone,
        });
      } catch (typingError) {
        logger.warn('Failed to start typing indicator', {
          error: typingError,
          attendanceId: data.attendanceId,
        });
        // Continue even if typing fails
      }

      // Get attendance to emit to correct rooms
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      let attendance = await attendanceRepo.findOne({
        where: { id: data.attendanceId },
        relations: ['seller'],
      });

      // IMPORTANTE: Se o atendimento foi fechado (ex: após merge do recuperaratendimento),
      // verificar se há um atendimento reaberto para o mesmo cliente e usar ele
      if (!attendance || attendance.operationalState === OperationalState.FECHADO_OPERACIONAL) {
        logger.warn('Attendance not found or closed, checking for reopened attendance', {
          originalAttendanceId: data.attendanceId,
          clientPhone: data.clientPhone,
        });

        // Buscar atendimento ativo para o mesmo cliente
        // IMPORTANTE: Buscar o mais recente que não seja o fechado original
        // Ordenar por updatedAt DESC para pegar o que foi atualizado mais recentemente (provavelmente o reaberto)
        const reopenedAttendance = await attendanceRepo.findOne({
          where: {
            clientPhone: data.clientPhone,
            whatsappNumberId: data.whatsappNumberId,
            operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
            id: Not(data.attendanceId), // Excluir o atendimento fechado original
          },
          order: { 
            updatedAt: 'DESC', // Mais recentemente atualizado (provavelmente reaberto)
            lastClientMessageAt: 'DESC' // Fallback: mais recente mensagem do cliente
          },
          relations: ['seller'],
        });

        // Se não encontrou excluindo o ID original, tentar sem essa restrição
        // (pode ser que o ID original já tenha sido deletado)
        if (!reopenedAttendance) {
          const anyActiveAttendance = await attendanceRepo.findOne({
            where: {
              clientPhone: data.clientPhone,
              whatsappNumberId: data.whatsappNumberId,
              operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
            },
            order: { updatedAt: 'DESC', lastClientMessageAt: 'DESC' },
            relations: ['seller'],
          });

          if (anyActiveAttendance) {
            logger.info('Found active attendance without ID exclusion (original may have been deleted)', {
              originalAttendanceId: data.attendanceId,
              foundAttendanceId: anyActiveAttendance.id,
              clientPhone: data.clientPhone,
            });
            attendance = anyActiveAttendance;
            data.attendanceId = anyActiveAttendance.id;
          }
        }

        if (reopenedAttendance && !attendance) {
          logger.info('Found reopened attendance, redirecting AI response to it', {
            originalAttendanceId: data.attendanceId,
            reopenedAttendanceId: reopenedAttendance.id,
            clientPhone: data.clientPhone,
          });
          attendance = reopenedAttendance;
          // Atualizar o attendanceId nos dados para usar o atendimento reaberto
          data.attendanceId = reopenedAttendance.id;
        } else if (!attendance && !reopenedAttendance) {
          logger.error('No active attendance found for client after merge', {
            originalAttendanceId: data.attendanceId,
            clientPhone: data.clientPhone,
          });
          // Se não encontrou atendimento ativo, não pode salvar a mensagem
          return;
        }
      }

      // Após resposta da IA, o atendimento deve ficar aguardando retorno do cliente.
      // Sem isso, o job de follow-up não processa o atendimento.
      if (attendance.operationalState !== OperationalState.AGUARDANDO_CLIENTE) {
        await attendanceRepo.update(
          { id: attendance.id },
          {
            operationalState: OperationalState.AGUARDANDO_CLIENTE,
            updatedAt: new Date(),
          }
        );
        attendance.operationalState = OperationalState.AGUARDANDO_CLIENTE;
      }

      const messageRepo = AppDataSource.getRepository(Message);
      
      // Get last message to check if sender changed (for AI name display logic)
      // Usar o attendanceId atualizado (pode ter sido redirecionado após merge)
      const lastMessage = await messageRepo.findOne({
        where: { attendanceId: attendance.id },
        order: { sentAt: 'DESC' },
      });

      // --- Deduplicação forte ---
      // Em alguns cenários (reentrega de fila / retries / duplicação upstream) a mesma resposta da IA
      // pode chegar mais de uma vez ao consumer, criando uma "mensagem gigante" extra no painel.
      // No WhatsApp isso pode não aparecer (falha ao enviar), mas no painel fica salvo no DB.
      // Para evitar isso: gerar um hash determinístico do payload e ignorar se já foi processado.
      // IMPORTANTE: Incluir clientMessageId no hash para evitar que respostas idênticas para mensagens
      // diferentes do cliente sejam consideradas duplicatas (ex: mesma resposta para "Oi" e "Legal").
      const fragmentsNorm = (data.fragments && Array.isArray(data.fragments)) ? data.fragments.map((f) => (f || '').trim()).filter(Boolean) : [];
      const clientMessageId = data.clientMessageId || null;
      
      // Log detalhado para debug
      if (!clientMessageId) {
        logger.warn('⚠️ clientMessageId missing in AI response payload - this may cause false deduplication!', {
          attendanceId: attendance.id,
          payloadKeys: Object.keys(data),
          contentPreview: (data.content || '').substring(0, 100),
        });
      }
      
      logger.info('AI response deduplication check', {
        attendanceId: attendance.id,
        clientMessageId,
        hasClientMessageId: !!clientMessageId,
        contentPreview: (data.content || '').substring(0, 100),
        fragmentCount: fragmentsNorm.length,
      });
      
      // IMPORTANTE: O clientMessageId DEVE estar presente no hash para diferenciar respostas idênticas
      // para mensagens diferentes do cliente. Se não estiver presente, isso indica um bug que precisa ser corrigido.
      // Por enquanto, incluímos null explicitamente no hash para garantir que seja sempre considerado.
      const dedupePayload = JSON.stringify({
        attendanceId: attendance.id, // Usar o attendanceId atualizado
        clientPhone: data.clientPhone,
        clientMessageId: clientMessageId, // SEMPRE incluir messageId da mensagem do cliente (pode ser null se não enviado)
        content: (data.content || '').trim(),
        fragments: fragmentsNorm,
        actionTaken: data.actionTaken,
      });
      const aiResponseHash = crypto.createHash('sha1').update(dedupePayload).digest('hex');
      
      logger.debug('Deduplication hash generated', {
        attendanceId: attendance.id,
        clientMessageId: clientMessageId || 'NULL',
        hash: aiResponseHash.substring(0, 8) + '...',
      });

      try {
        const existing = await messageRepo
          .createQueryBuilder('message')
          .where('message.attendanceId = :attendanceId', { attendanceId: attendance.id }) // Usar o attendanceId atualizado
          .andWhere('message.origin = :origin', { origin: MessageOrigin.AI })
          .andWhere(`message.metadata ->> 'aiResponseHash' = :hash`, { hash: aiResponseHash })
          .orderBy('message.sentAt', 'DESC')
          .getOne();

        if (existing) {
          logger.warn('Skipping duplicated AI response (aiResponseHash match)', {
            attendanceId: attendance.id,
            aiResponseHash,
            clientMessageId,
            existingMessageId: existing.id,
            existingClientMessageId: existing.metadata?.clientMessageId,
            contentPreview: (data.content || '').substring(0, 100),
          });
          return;
        }
      } catch (dedupeErr: any) {
        // Não falhar o fluxo por erro de dedupe; apenas logar e continuar
        logger.warn('AI response dedupe check failed, continuing', {
          attendanceId: attendance.id,
          error: dedupeErr?.message,
        });
      }
      
      // Check if we should include sender name (only if sender changed or no previous message)
      const lastSenderName = lastMessage?.metadata?.senderName;
      const aiSenderName = 'Altese AI';
      const shouldIncludeName = !lastMessage || lastSenderName !== aiSenderName;
      
      logger.info('AI sender name logic', {
        attendanceId: attendance.id,
        hasLastMessage: !!lastMessage,
        lastSenderName,
        aiSenderName,
        shouldIncludeName,
      });
      
      const baseMetadata = {
        actionTaken: data.actionTaken,
        routingData: data.routingData,
        responseMetadata: data.responseMetadata || null,
        senderName: aiSenderName, // Store sender name in metadata
        aiResponseTimestamp: data.timestamp,
        aiResponseHash,
        clientMessageId: data.clientMessageId || null, // Store client messageId for tracking
      };

      // Garantir que respostas da IA tenham sentAt > mensagem do cliente (evita inversão de ordem
      // quando Meta timestamp ou diferença de clock fazem a msg do cliente "vir depois" no sort)
      let minAiSentAt = new Date();
      if (clientMessageId) {
        const clientMsg = await messageRepo.findOne({
          where: { id: clientMessageId, attendanceId: attendance.id },
        });
        if (clientMsg?.sentAt) {
          const clientSentMs = new Date(clientMsg.sentAt).getTime();
          minAiSentAt = new Date(clientSentMs + 1); // 1ms após a mensagem do cliente
        }
      }

      // Check if we have fragments to send separately
      const hasFragments = data.fragments && Array.isArray(data.fragments) && data.fragments.length > 0;

      if (hasFragments) {
        // Send fragments separately
        logger.info('Sending fragmented response', {
          attendanceId: attendance.id,
          fragmentCount: data.fragments!.length,
        });

        const savedMessages: Message[] = [];
        const fragmentDelay = 1000; // 1 second delay between fragments

        for (let i = 0; i < data.fragments!.length; i++) {
          const fragment = data.fragments![i].trim();
          
          // Skip empty fragments
          if (!fragment) {
            logger.debug(`Skipping empty fragment ${i + 1}/${data.fragments!.length}`);
            continue;
          }

          // Timestamp incremental; garantir que cada fragmento venha APÓS a mensagem do cliente
          const baseNow = Date.now() + i * 10;
          const minMs = minAiSentAt.getTime();
          const fragmentTimestamp = new Date(Math.max(baseNow, minMs + i * 10));
          const fragmentMessage = messageRepo.create({
            attendanceId: attendance.id,
            origin: MessageOrigin.AI,
            content: fragment,
            metadata: {
              ...baseMetadata,
              fragmentIndex: i,
              fragmentTotal: data.fragments!.length,
              isFragment: true,
            },
            status: MessageStatus.PENDING,
            sentAt: fragmentTimestamp,
          });

          await messageRepo.save(fragmentMessage);

          // Send via Baileys
          try {
            // Include sender name only for the first fragment or when sender changed
            const includeName = (i === 0 && shouldIncludeName);
            
            logger.info(`📤 Sending fragment ${i + 1}/${data.fragments!.length} via WhatsApp`, {
              messageId: fragmentMessage.id,
              attendanceId: attendance.id,
              clientPhone: data.clientPhone,
              whatsappNumberId: data.whatsappNumberId,
              fragmentLength: fragment.length,
              includeName,
            });
            
            // Não incluir "Altese AI:" no WhatsApp - apenas usuários (vendedores) têm prefixo
            await adapter.sendMessage(
              data.clientPhone, 
              fragment,
              undefined
            );

            // Update status to SENT
            fragmentMessage.status = MessageStatus.SENT;
            await messageRepo.save(fragmentMessage);

            savedMessages.push(fragmentMessage);

            logger.info(`✅ Fragment ${i + 1}/${data.fragments!.length} sent successfully via WhatsApp`, {
              messageId: fragmentMessage.id,
              attendanceId: attendance.id,
              fragmentLength: fragment.length,
            });

            // Emit Socket.IO event for this fragment
            const fragmentEventData = {
              attendanceId: attendance.id,
              messageId: fragmentMessage.id,
              clientPhone: data.clientPhone,
              isUnassigned: !attendance?.sellerId,
              ...(attendance?.sellerId && { sellerId: attendance.sellerId }),
              ...(attendance?.sellerId && attendance?.sellerSubdivision && { sellerSubdivision: attendance.sellerSubdivision }),
              message: {
                id: fragmentMessage.id,
                content: fragmentMessage.content,
                origin: fragmentMessage.origin,
                status: fragmentMessage.status,
                sentAt: fragmentMessage.sentAt.toISOString(),
                metadata: {
                  ...fragmentMessage.metadata,
                  sentAt: fragmentMessage.sentAt.toISOString(),
                  createdAt: fragmentMessage.sentAt.toISOString(),
                },
              },
            };

        // Emit to specific rooms only (not global to avoid duplication)
        // CORREÇÃO: Remover broadcast global para evitar mistura de mensagens entre chats simultâneos
        if (attendance?.sellerId) {
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_sent', fragmentEventData);
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_received', fragmentEventData);
          // Also emit to supervisors so they can monitor
          socketService.emitToRoom('supervisors', 'message_sent', fragmentEventData);
          socketService.emitToRoom('supervisors', 'message_received', fragmentEventData);
        } else {
          socketService.emitToRoom('supervisors', 'message_sent', fragmentEventData);
          socketService.emitToRoom('supervisors', 'message_received', fragmentEventData);
        }

            // Add delay between fragments (except for the last one)
            if (i < data.fragments!.length - 1) {
              // Keep typing indicator active during delay
              try {
                await adapter.sendTyping(data.clientPhone, true);
              } catch (typingError) {
                logger.debug('Failed to maintain typing indicator during delay', {
                  error: typingError,
                });
              }
              
              await new Promise((resolve) => setTimeout(resolve, fragmentDelay));
            }
          } catch (sendError) {
            logger.error(`Error sending fragment ${i + 1}/${data.fragments!.length}`, {
              error: sendError,
              messageId: fragmentMessage.id,
            });

            // Update status to FAILED
            fragmentMessage.status = MessageStatus.FAILED;
            await messageRepo.save(fragmentMessage);
          }
        }

        logger.info('All fragments sent', {
          attendanceId: attendance.id,
          totalFragments: savedMessages.length,
        });
      } else {
        // Send complete message (no fragments or fragments not available)
        const now = new Date();
        const sentAt = new Date(Math.max(now.getTime(), minAiSentAt.getTime()));
        const savedMessage = messageRepo.create({
          attendanceId: attendance.id,
          origin: MessageOrigin.AI,
          content: data.content,
          metadata: baseMetadata,
          status: MessageStatus.PENDING,
          sentAt,
        });

        await messageRepo.save(savedMessage);

        // Send via Baileys
        try {
          logger.info('📤 Sending complete AI message via WhatsApp', {
            messageId: savedMessage.id,
            attendanceId: attendance.id,
            clientPhone: data.clientPhone,
            whatsappNumberId: data.whatsappNumberId,
            contentLength: data.content.length,
            shouldIncludeName,
          });
          
          // Não incluir "Altese AI:" no WhatsApp - apenas usuários (vendedores) têm prefixo
          await adapter.sendMessage(
            data.clientPhone, 
            data.content,
            undefined
          );

          // Update status to SENT
          savedMessage.status = MessageStatus.SENT;
          await messageRepo.save(savedMessage);

          logger.info('✅ AI message sent successfully via WhatsApp', {
            messageId: savedMessage.id,
            attendanceId: attendance.id,
            clientPhone: data.clientPhone,
          });
        } catch (sendError) {
          logger.error('Error sending AI message via Baileys', {
            error: sendError,
            messageId: savedMessage.id,
          });

          // Update status to FAILED
          savedMessage.status = MessageStatus.FAILED;
          await messageRepo.save(savedMessage);
        }

        // Emit via Socket.IO
        const eventData = {
          attendanceId: attendance.id,
          messageId: savedMessage.id,
          clientPhone: data.clientPhone,
          isUnassigned: !attendance?.sellerId,
          ...(attendance?.sellerId && { sellerId: attendance.sellerId }),
          ...(attendance?.sellerId && attendance?.sellerSubdivision && { sellerSubdivision: attendance.sellerSubdivision }),
          message: {
            id: savedMessage.id,
            content: savedMessage.content,
            origin: savedMessage.origin,
            status: savedMessage.status,
            sentAt: savedMessage.sentAt.toISOString(),
            metadata: {
              ...savedMessage.metadata,
              sentAt: savedMessage.sentAt.toISOString(),
              createdAt: savedMessage.sentAt.toISOString(),
            },
          },
        };

        // Emit to specific rooms only (not global to avoid duplication)
        // CORREÇÃO: Remover broadcast global para evitar mistura de mensagens entre chats simultâneos
        if (attendance?.sellerId) {
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_sent', eventData);
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_received', eventData);
          // Also emit to supervisors so they can monitor
          socketService.emitToRoom('supervisors', 'message_sent', eventData);
          socketService.emitToRoom('supervisors', 'message_received', eventData);
          logger.info('AI message event emitted to seller and supervisors rooms', {
            attendanceId: attendance.id,
            sellerId: attendance.sellerId,
            messageId: savedMessage.id,
          });
        } else {
          socketService.emitToRoom('supervisors', 'message_sent', eventData);
          socketService.emitToRoom('supervisors', 'message_received', eventData);
          logger.info('AI message event emitted to supervisors room', {
            attendanceId: attendance.id,
            messageId: savedMessage.id,
            isUnassigned: true,
          });
        }

        // Stop typing indicator after message is sent
        try {
          await adapter.sendTyping(data.clientPhone, false);
          logger.debug('Typing indicator stopped after message', {
            attendanceId: attendance.id,
          });
        } catch (typingError) {
          logger.debug('Failed to stop typing indicator', {
            error: typingError,
          });
        }
      }

      // Quando a IA envia mensagem e o atendimento está atribuído a um vendedor, marcar conversa como lida para o vendedor
      if (attendance?.sellerId) {
        try {
          const messageReadRepo = AppDataSource.getRepository(MessageRead);
          let messageRead = await messageReadRepo.findOne({
            where: { attendanceId: attendance.id, userId: attendance.sellerId },
          });
          // Usar o maior entre agora e sentAt da última mensagem para lidar com timezone mismatch
          const latestMsgForRead = await AppDataSource.getRepository(Message).findOne({
            where: { attendanceId: attendance.id },
            order: { sentAt: 'DESC' },
            select: ['sentAt'],
          });
          const now = new Date();
          const latestSentAt = latestMsgForRead?.sentAt ? new Date(latestMsgForRead.sentAt) : now;
          const effectiveReadAt = latestSentAt > now ? new Date(latestSentAt.getTime() + 1000) : now;
          if (messageRead) {
            messageRead.lastReadAt = effectiveReadAt;
            await messageReadRepo.save(messageRead);
          } else {
            messageRead = messageReadRepo.create({
              attendanceId: attendance.id,
              userId: attendance.sellerId,
              lastReadAt: effectiveReadAt,
            });
            await messageReadRepo.save(messageRead);
          }
          logger.debug('Conversation marked as read for seller (AI sent message)', {
            attendanceId: attendance.id,
            sellerId: attendance.sellerId,
          });
        } catch (markReadError: any) {
          logger.warn('Failed to mark conversation as read for seller after AI message', {
            attendanceId: attendance.id,
            sellerId: attendance.sellerId,
            error: markReadError?.message,
          });
        }
      }

      // If routing was completed, emit routing event (only once, regardless of fragments)
      if (data.actionTaken === 'routed' && data.routingData) {
        // Usar o attendance já carregado (pode ter sido atualizado após merge)
        socketService.emit('attendance:routed', {
          attendanceId: attendance.id,
          sellerId: data.routingData.sellerId,
          supervisorId: data.routingData.supervisorId,
          vehicleBrand: data.routingData.vehicleBrand,
          routedAt: new Date().toISOString(),
          sellerSubdivision: attendance?.sellerSubdivision || 'pedidos-orcamentos',
        });
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
      }
    } catch (error: any) {
      logger.error('Error processing AI response', {
        error: error?.message || error,
        stack: error?.stack,
        errorString: String(error),
        errorType: error?.constructor?.name,
        attendanceId: data.attendanceId,
        content: data.content,
      });
    }
  }
}
