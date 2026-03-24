import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import config from '../../../../config/app.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { Message } from '../../domain/entities/message.entity';
import { WhatsAppNumber } from '../../../whatsapp/domain/entities/whatsapp-number.entity';
import { FunctionCallConfig } from '../../../ai/domain/entities/function-call-config.entity';
import { MessageOrigin, AttendanceState, AttendanceType, OperationalState, UUID } from '../../../../shared/types/common.types';
import { WhatsAppMessage } from '../../../whatsapp/domain/interfaces/whatsapp-adapter.interface';
import { logger } from '../../../../shared/utils/logger';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { InfrastructureFactory } from '../../../../shared/infrastructure/factories/infrastructure.factory';
import { aiConfigService } from '../../../ai/application/services/ai-config.service';
import { Not, In, LessThan, MoreThanOrEqual } from 'typeorm';
import { MediaService } from './media.service';
import { messageBufferService } from './message-buffer.service';
import { mediaProcessorService } from './media-processor.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';

const FC_NAME_FECHA_BALCAO = 'fechaatendimentobalcao';
const DEFAULT_TEMPO_FECHAMENTO_BALCAO_MIN = 30;
const AUTO_REOPEN_HOURS = 8;
const AUTO_REOPEN_TIMEOUT_MINUTES = AUTO_REOPEN_HOURS * 60;

/**
 * Message Processor Service
 * 
 * Processes incoming WhatsApp messages and creates/updates attendances
 */
export class MessageProcessorService {
  /**
   * Process incoming WhatsApp message
   * Creates or updates attendance and saves message
   */
  async processIncomingMessage(whatsappMessage: WhatsAppMessage): Promise<void> {
    try {
      const phone = whatsappMessage.phoneNumber;
      const isFromMe = !!whatsappMessage.fromMe;

      const isBlacklisted = await aiConfigService.isPhoneBlacklisted(phone);
      if (isBlacklisted) {
        logger.info('Ignoring message from blacklisted number', {
          messageId: whatsappMessage.id,
          from: phone,
          whatsappNumberId: whatsappMessage.whatsappNumberId,
        });
        return;
      }

      logger.info('Processing incoming WhatsApp message', {
        messageId: whatsappMessage.id,
        from: phone,
        whatsappNumberId: whatsappMessage.whatsappNumberId,
        fromMe: isFromMe,
      });

      // Mensagem do dono enviada do celular (fora da plataforma)
      if (isFromMe) {
        await this.processOwnerMessageFromPhone(whatsappMessage);
        return;
      }

      // Find or create attendance for this client phone number
      // Note: IA decide criar/reutilizar via function call decidir_atendimento
      // Por enquanto, buscamos attendances em TRIAGEM ou ABERTO (não finalizados operacionalmente)
      // IMPORTANTE: NUNCA reutilizar atendimentos FECHADOS - sempre criar novo ou usar decide_attendance
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      let attendance = await attendanceRepo.findOne({
        where: [
          {
            clientPhone: whatsappMessage.phoneNumber,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            operationalState: OperationalState.AGUARDANDO_PRIMEIRA_MSG,
          },
          {
            clientPhone: whatsappMessage.phoneNumber,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            operationalState: OperationalState.TRIAGEM,
          },
          {
            clientPhone: whatsappMessage.phoneNumber,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            operationalState: OperationalState.ABERTO,
          },
          {
            clientPhone: whatsappMessage.phoneNumber,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            operationalState: OperationalState.EM_ATENDIMENTO,
          },
          {
            clientPhone: whatsappMessage.phoneNumber,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            operationalState: OperationalState.AGUARDANDO_CLIENTE,
          },
        ],
        order: { updatedAt: 'DESC' }, // Get most recent
      });

      // Verificação de segurança: se encontramos um atendimento, garantir que não está fechado
      if (attendance && attendance.operationalState === OperationalState.FECHADO_OPERACIONAL) {
        logger.error('CRITICAL: Found closed attendance in active query! This should NEVER happen. Forcing new attendance creation.', {
          closedAttendanceId: attendance.id,
          clientPhone: whatsappMessage.phoneNumber,
          operationalState: attendance.operationalState,
          finalizedAt: attendance.finalizedAt,
        });
        attendance = null; // Forçar criação de novo atendimento
      }
      
      // Verificação adicional: garantir que o atendimento realmente não está fechado
      if (attendance) {
        // Recarregar do banco para garantir estado atualizado
        const reloaded = await attendanceRepo.findOne({
          where: { id: attendance.id },
        });
        
        if (reloaded && reloaded.operationalState === OperationalState.FECHADO_OPERACIONAL) {
          logger.error('CRITICAL: Attendance was closed between query and processing! Forcing new attendance creation.', {
            closedAttendanceId: reloaded.id,
            clientPhone: whatsappMessage.phoneNumber,
            operationalState: reloaded.operationalState,
            finalizedAt: reloaded.finalizedAt,
          });
          attendance = null; // Forçar criação de novo atendimento
        } else if (reloaded) {
          attendance = reloaded; // Usar versão recarregada
        }
      }

      let isNewAttendance = false;
      let wasAutoReopened = false;
      // If no open attendance exists: check for recently closed attendance to auto-reopen
      if (!attendance) {
        const clientPhone = whatsappMessage.phoneNumber;
        const whatsappNumberId = whatsappMessage.whatsappNumberId as UUID;

        // Verify WhatsApp number exists
        const whatsappNumberRepo = AppDataSource.getRepository(WhatsAppNumber);
        const whatsappNumber = await whatsappNumberRepo.findOne({
          where: { id: whatsappNumberId },
        });

        if (!whatsappNumber) {
          logger.error('WhatsApp number not found', {
            whatsappNumberId: whatsappMessage.whatsappNumberId,
          });
          return;
        }

        // IMPORTANTE: Garantir que apenas um atendimento ativo por cliente
        // Fechar outros atendimentos ativos antes de criar/reabrir
        const otherActiveAttendances = await attendanceRepo.find({
          where: {
            clientPhone,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
          },
        });

        if (otherActiveAttendances.length > 0) {
          logger.info('Closing other active attendances to maintain single active attendance per client', {
            clientPhone,
            closingCount: otherActiveAttendances.length,
            closingIds: otherActiveAttendances.map(a => a.id),
          });

          // Fechar todos os outros atendimentos ativos
          await attendanceRepo.update(
            { id: In(otherActiveAttendances.map(a => a.id)) },
            {
              operationalState: OperationalState.FECHADO_OPERACIONAL,
              finalizedAt: new Date(),
            }
          );
        }

        // Regra de negócio: reabrir automaticamente em até 8 horas após fechamento.
        const cutoffTime = new Date(Date.now() - AUTO_REOPEN_TIMEOUT_MINUTES * 60 * 1000);

        const recentlyClosedAttendance = await attendanceRepo.findOne({
          where: {
            clientPhone,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            operationalState: OperationalState.FECHADO_OPERACIONAL,
            finalizedAt: MoreThanOrEqual(cutoffTime), // Fechado após o cutoffTime (dentro do período)
          },
          order: { finalizedAt: 'DESC' }, // Pegar o mais recente
          relations: ['seller', 'supervisor'],
        });

        if (recentlyClosedAttendance && recentlyClosedAttendance.finalizedAt) {
          const timeSinceClosed = Date.now() - new Date(recentlyClosedAttendance.finalizedAt).getTime();
          const minutesSinceClosed = Math.floor(timeSinceClosed / (60 * 1000));

          if (minutesSinceClosed <= AUTO_REOPEN_TIMEOUT_MINUTES) {
            // Reabrir o atendimento fechado
            logger.info('Auto-reopening recently closed attendance', {
              attendanceId: recentlyClosedAttendance.id,
              clientPhone,
              minutesSinceClosed,
              autoReopenTimeoutMinutes: AUTO_REOPEN_TIMEOUT_MINUTES,
              finalizedAt: recentlyClosedAttendance.finalizedAt,
            });

            // Restaurar estado anterior do aiContext se disponível (inclui handledBy e assumedAt para preservar timer da IA)
            const aiContext = recentlyClosedAttendance.aiContext as Record<string, unknown> | undefined;
            const wasClosedManually = Boolean(aiContext?.closedManually);
            const previousState = aiContext?.previousStateBeforeClosing as {
              interventionType?: string;
              sellerSubdivision?: string;
              operationalState?: OperationalState;
              handledBy?: AttendanceType;
              assumedAt?: string;
            } | undefined;

            // Restaurar campos se disponíveis
            let restoredInterventionType: string | null = null;
            let restoredSellerSubdivision: string | null = null;
            let restoredHandledBy: AttendanceType | null = null;
            let newOperationalState: OperationalState = OperationalState.TRIAGEM;

            if (previousState) {
              restoredInterventionType = previousState.interventionType || null;
              restoredSellerSubdivision = previousState.sellerSubdivision || null;
              restoredHandledBy = previousState.handledBy || null;
              // assumedAt será restaurado em updateData se presente
              
              if (previousState.operationalState && previousState.operationalState !== OperationalState.FECHADO_OPERACIONAL) {
                newOperationalState = previousState.operationalState;
              } else if (recentlyClosedAttendance.sellerId) {
                newOperationalState = OperationalState.EM_ATENDIMENTO;
              } else if (restoredInterventionType) {
                newOperationalState = OperationalState.ABERTO;
              } else {
                newOperationalState = OperationalState.TRIAGEM;
              }
            } else {
              // Inferir estado se não há estado anterior salvo
              if (recentlyClosedAttendance.sellerId) {
                newOperationalState = OperationalState.EM_ATENDIMENTO;
              } else {
                newOperationalState = OperationalState.TRIAGEM;
              }
            }

            // CORREÇÃO CRÍTICA: Garantir que handledBy seja preservado ou definido como AI por padrão
            // Se não foi restaurado do estado anterior, usar o valor atual ou AI por padrão
            if (!restoredHandledBy) {
              restoredHandledBy = recentlyClosedAttendance.handledBy || AttendanceType.AI;
            }
            if (wasClosedManually) {
              // Regra: atendimento fechado manualmente não deve reativar follow-up ao reabrir automaticamente.
              restoredHandledBy = AttendanceType.AI;
            }

            // Reabrir o atendimento
            const now = new Date();
            const updateData: any = {
              operationalState: newOperationalState,
              finalizedAt: null,
              updatedAt: now,
              lastClientMessageAt: now,
              balcaoClosingAt: null,
              ecommerceClosingAt: null,
              handledBy: restoredHandledBy, // CORREÇÃO: Sempre preservar/definir handledBy
              aiContext: {
                ...(aiContext ?? {}),
                followUpState: {
                  lastClientMessageAt: now.toISOString(),
                },
              },
            };

            if (restoredInterventionType) {
              updateData.interventionType = restoredInterventionType;
            }
            if (restoredSellerSubdivision) {
              updateData.sellerSubdivision = restoredSellerSubdivision;
            }
            // Preservar assumedAt - não resetar o timer da IA na reabertura
            if (wasClosedManually) {
              updateData.assumedAt = null;
            } else if (previousState?.assumedAt) {
              updateData.assumedAt = new Date(previousState.assumedAt);
            } else if (recentlyClosedAttendance.assumedAt) {
              updateData.assumedAt = recentlyClosedAttendance.assumedAt;
            }
            await attendanceRepo.update(
              { id: recentlyClosedAttendance.id },
              updateData
            );

            // Recarregar o atendimento reaberto
            attendance = await attendanceRepo.findOne({
              where: { id: recentlyClosedAttendance.id },
              relations: ['seller', 'supervisor'],
            });

            if (attendance) {
              isNewAttendance = false; // Não é novo, foi reaberto
            wasAutoReopened = true;
              logger.info('Attendance auto-reopened successfully', {
                attendanceId: attendance.id,
                clientPhone,
                newOperationalState,
                restoredInterventionType,
                restoredSellerSubdivision,
                handledBy: attendance.handledBy,
                assumedAt: attendance.assumedAt,
                operationalState: attendance.operationalState,
              });

              // Emitir eventos Socket.IO para atualizar o frontend
              try {
                const eventData = {
                  attendanceId: attendance.id,
                  previousState: OperationalState.FECHADO_OPERACIONAL,
                  newState: newOperationalState,
                  interventionType: attendance.interventionType,
                  sellerId: attendance.sellerId,
                  sellerSubdivision: attendance.sellerSubdivision,
                  reopenedAt: now.toISOString(),
                  reason: 'auto_reopen',
                };

                socketService.emitToRoom('supervisors', 'attendance:removed-from-fechados', eventData);
                
                if (attendance.sellerId) {
                  socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance:reopened', eventData);
                } else {
                  socketService.emitToRoom('supervisors', 'attendance:reopened', eventData);
                }

                invalidateSubdivisionCountsCache();
                socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

                logger.info('Socket.IO events emitted for auto-reopened attendance', {
                  attendanceId: attendance.id,
                });
              } catch (e: any) {
                logger.warn('Failed to emit Socket.IO events for auto-reopened attendance', {
                  error: e?.message,
                  attendanceId: attendance.id,
                });
              }
            } else {
              logger.error('Failed to reload auto-reopened attendance', {
                attendanceId: recentlyClosedAttendance.id,
              });
              // Se falhou ao recarregar, criar novo atendimento
              attendance = null;
            }
          }
        }

        // Se não encontrou atendimento fechado recente ou falhou ao reabrir, criar novo
        if (!attendance) {
          attendance = attendanceRepo.create({
            clientPhone,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            state: AttendanceState.OPEN,
            operationalState: OperationalState.TRIAGEM,
            handledBy: AttendanceType.AI,
            sellerId: null,
            supervisorId: null,
            vehicleBrand: null,
            isFinalized: false,
            isAttributed: true,
            lastClientMessageAt: whatsappMessage.timestamp,
          });
          attendance = await attendanceRepo.save(attendance);
          isNewAttendance = true;
          logger.info('Created new attendance', { attendanceId: attendance.id, clientPhone });
        }
      } else {
        // IMPORTANTE: Se o atendimento encontrado está FECHADO, não reutilizar - criar novo
        if (attendance.operationalState === OperationalState.FECHADO_OPERACIONAL) {
          logger.info('Found attendance is closed, creating new attendance instead', {
            closedAttendanceId: attendance.id,
            clientPhone: whatsappMessage.phoneNumber,
            operationalState: attendance.operationalState,
          });

          // IMPORTANTE: Quando encontramos atendimento FECHADO, SEMPRE criar novo em TRIAGEM
          // A IA na triagem já tem o contexto histórico e vai perguntar ao cliente se quer reabrir ou iniciar novo
          // NÃO usar decide_attendance - sempre criar novo em triagem

          // Se não há atendimentos fechados anteriores, criar novo normalmente
          const clientPhone = whatsappMessage.phoneNumber;
          const whatsappNumberId = whatsappMessage.whatsappNumberId as UUID;

          // Verificar WhatsApp number existe
          const whatsappNumberRepo = AppDataSource.getRepository(WhatsAppNumber);
          const whatsappNumber = await whatsappNumberRepo.findOne({
            where: { id: whatsappNumberId },
          });

          if (!whatsappNumber) {
            logger.error('WhatsApp number not found', {
              whatsappNumberId: whatsappMessage.whatsappNumberId,
            });
            return;
          }

          // Fechar outros atendimentos ativos antes de criar novo
          const otherActiveAttendances = await attendanceRepo.find({
            where: {
              clientPhone,
              whatsappNumberId,
              operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
            },
          });

          if (otherActiveAttendances.length > 0) {
            logger.info('Closing other active attendances to maintain single active attendance per client', {
              clientPhone,
              closingCount: otherActiveAttendances.length,
              closingIds: otherActiveAttendances.map(a => a.id),
            });

            await attendanceRepo.update(
              { id: In(otherActiveAttendances.map(a => a.id)) },
              {
                operationalState: OperationalState.FECHADO_OPERACIONAL,
                finalizedAt: new Date(),
              }
            );
          }

          attendance = attendanceRepo.create({
            clientPhone,
            whatsappNumberId,
            state: AttendanceState.OPEN,
            operationalState: OperationalState.TRIAGEM,
            handledBy: AttendanceType.AI,
            sellerId: null,
            supervisorId: null,
            vehicleBrand: null,
            isFinalized: false,
            isAttributed: true,
            lastClientMessageAt: whatsappMessage.timestamp,
          });
          attendance = await attendanceRepo.save(attendance);
          isNewAttendance = true;
          logger.info('Created new attendance (previous was closed)', { attendanceId: attendance.id, clientPhone });
          // Continuar o fluxo normalmente após criar novo atendimento (não entrar no bloco de update)
        } else {
          // IMPORTANTE: Garantir que apenas um atendimento ativo por cliente
          // Se encontramos um atendimento existente ATIVO, fechar outros atendimentos ativos (exceto o atual)
          const otherActiveAttendances = await attendanceRepo.find({
            where: {
              clientPhone: whatsappMessage.phoneNumber,
              whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
              operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
              id: Not(attendance.id),
            },
          });

          if (otherActiveAttendances.length > 0) {
            logger.info('Closing other active attendances to maintain single active attendance per client', {
              clientPhone: whatsappMessage.phoneNumber,
              currentAttendanceId: attendance.id,
              closingCount: otherActiveAttendances.length,
              closingIds: otherActiveAttendances.map(a => a.id),
            });

            // Fechar todos os outros atendimentos ativos
            await attendanceRepo.update(
              { id: In(otherActiveAttendances.map(a => a.id)) },
              {
                operationalState: OperationalState.FECHADO_OPERACIONAL,
                finalizedAt: new Date(),
              }
            );
          }

          // Update existing attendance - usar update() ao invés de save() para não sobrescrever campos setados por outros processos
          const updateData: any = {
            updatedAt: new Date(),
            lastClientMessageAt: whatsappMessage.timestamp,
            aiContext: {
              ...((attendance.aiContext as Record<string, unknown>) ?? {}),
              followUpState: {
                lastClientMessageAt: whatsappMessage.timestamp.toISOString(),
              },
            },
          };
        
          // Se estava aguardando cliente, voltar para EM_ATENDIMENTO
          if (attendance.operationalState === OperationalState.AGUARDANDO_CLIENTE) {
            updateData.operationalState = OperationalState.EM_ATENDIMENTO;
          }

          // Reset timer de fechamento do balcão se cliente em encaminhados-balcao envia nova msg
          if (attendance.interventionType === 'encaminhados-balcao' && attendance.balcaoClosingAt) {
            // Recalcular balcaoClosingAt usando o mesmo tempo (buscar da config ou usar padrão)
            const tempoFechamentoMinutos = await this.getTempoFechamentoBalcao();
            updateData.balcaoClosingAt = new Date(Date.now() + tempoFechamentoMinutos * 60 * 1000);
            logger.info('Balcão timer reset due to client message', {
              attendanceId: attendance.id,
              newBalcaoClosingAt: updateData.balcaoClosingAt.toISOString(),
            });
          }

          // Reset timer de fechamento do e-commerce se cliente envia nova msg (qualquer atendimento com timer ativo)
          if (attendance.ecommerceClosingAt) {
            // Buscar tempo de fechamento da config da FC enviaecommerce
            let tempoFechamentoMinutos = 30; // padrão
            try {
              const fcConfigRepo = AppDataSource.getRepository(FunctionCallConfig);
              const fcConfig = await fcConfigRepo.findOne({ where: { functionCallName: 'enviaecommerce' } });
              if (fcConfig) {
                const customAttrs = fcConfig.customAttributes as Record<string, unknown> | undefined;
                const metadata = fcConfig.metadata as Record<string, unknown> | undefined;
                const tempoRaw = customAttrs?.tempo_fechamento_ecommerce ?? metadata?.tempo_fechamento_ecommerce;
                if (tempoRaw !== undefined && tempoRaw !== null) {
                  const tempoNum = Number(tempoRaw);
                  if (!isNaN(tempoNum) && tempoNum >= 1 && tempoNum <= 60) {
                    tempoFechamentoMinutos = tempoNum;
                  }
                }
              }
            } catch (e: any) {
              logger.warn('Erro ao buscar tempo de fechamento e-commerce, usando padrão 30min', { error: e?.message });
            }
            updateData.ecommerceClosingAt = new Date(Date.now() + tempoFechamentoMinutos * 60 * 1000);
            logger.info('E-commerce timer reset due to client message', {
              attendanceId: attendance.id,
              newEcommerceClosingAt: updateData.ecommerceClosingAt.toISOString(),
            });
          }
        
          await attendanceRepo.update({ id: attendance.id }, updateData);

          // IMPORTANTE: Recarregar do banco para pegar dados atualizados (ex.: sellerId setado por identificamarca)
          const reloadedAttendance = await attendanceRepo.findOne({ 
            where: { id: attendance.id },
            relations: ['seller', 'supervisor']
          });
        
          if (reloadedAttendance) {
            attendance = reloadedAttendance;
          }

          logger.info('Updated existing attendance', {
            attendanceId: attendance.id,
            clientPhone: whatsappMessage.phoneNumber,
            operationalState: attendance.operationalState,
            sellerId: attendance.sellerId, // Log sellerId para debug
          });
        }
      }

      // CORREÇÃO: Buscar resumo do último atendimento fechado quando:
      // 1. Atendimento é novo (isNewAttendance = true)
      // 2. Atendimento foi reaberto (isNewAttendance = false mas foi reaberto recentemente)
      // Isso garante que a IA tenha contexto histórico mesmo após reabertura
      let lastAttendanceSummary: string | undefined;
      
      // Se é novo atendimento, buscar resumo do último fechado
      if (isNewAttendance) {
        const lastClosed = await attendanceRepo.findOne({
          where: {
            clientPhone: attendance.clientPhone,
            whatsappNumberId: attendance.whatsappNumberId,
            operationalState: OperationalState.FECHADO_OPERACIONAL,
          },
          order: { finalizedAt: 'DESC' },
        });
        const ac = lastClosed?.aiContext as Record<string, unknown> | undefined;
        lastAttendanceSummary = (ac?.conversationSummary as string) || undefined;
      } else {
        // CORREÇÃO: Se foi reaberto, buscar resumo do próprio atendimento reaberto
        // (ele foi fechado antes, então deve ter um resumo)
        const ac = attendance.aiContext as Record<string, unknown> | undefined;
        lastAttendanceSummary = (ac?.conversationSummary as string) || undefined;
        
        // Se não encontrou no próprio atendimento, buscar do último fechado (fallback)
        if (!lastAttendanceSummary) {
          const lastClosed = await attendanceRepo.findOne({
            where: {
              clientPhone: attendance.clientPhone,
              whatsappNumberId: attendance.whatsappNumberId,
              operationalState: OperationalState.FECHADO_OPERACIONAL,
              id: Not(attendance.id), // Excluir o próprio atendimento reaberto
            },
            order: { finalizedAt: 'DESC' },
          });
          const lastAc = lastClosed?.aiContext as Record<string, unknown> | undefined;
          lastAttendanceSummary = (lastAc?.conversationSummary as string) || undefined;
        }
      }
      
      const attendanceContext = isNewAttendance ? 'novo' : wasAutoReopened ? 'reaberto' : 'em_andamento';
      const operationalStateStr = attendance.operationalState ?? 'TRIAGEM';

      logger.info('lastAttendanceSummary resolved', {
        attendanceId: attendance.id,
        isNewAttendance,
        wasAutoReopened,
        attendanceContext,
        operationalState: operationalStateStr,
        hasLastAttendanceSummary: !!lastAttendanceSummary,
        summaryLength: lastAttendanceSummary?.length || 0,
      });

      // Save message to database
      const messageRepo = AppDataSource.getRepository(Message);
      // Ensure timestamp is a valid Date object - use original WhatsApp timestamp
      const messageTimestamp = whatsappMessage.timestamp instanceof Date 
        ? whatsappMessage.timestamp 
        : new Date(whatsappMessage.timestamp);
      
      // Validate timestamp
      if (isNaN(messageTimestamp.getTime())) {
        logger.error('Invalid timestamp received from WhatsApp, using current time', {
          originalTimestamp: whatsappMessage.timestamp,
          messageId: whatsappMessage.id,
        });
        // Fallback to current time if timestamp is invalid
        messageTimestamp.setTime(Date.now());
      }
      
      // Para imagem/áudio, nunca usar placeholder de processamento no conteúdo exibido no chat
      const mediaTypeForContent = whatsappMessage.mediaType || 'text';
      const displayContent =
        mediaTypeForContent === 'image'
          ? (whatsappMessage.text && whatsappMessage.text !== '[Processando imagem...]' ? whatsappMessage.text : '[Imagem]')
          : mediaTypeForContent === 'audio'
            ? (whatsappMessage.text && whatsappMessage.text !== '[Processando áudio...]' ? whatsappMessage.text : '[Áudio]')
            : (whatsappMessage.text || '[Mensagem de mídia]');
      const message = messageRepo.create({
        attendanceId: attendance.id,
        origin: MessageOrigin.CLIENT,
        content: displayContent,
        metadata: {
          whatsappMessageId: whatsappMessage.id,
          fromJid: whatsappMessage.from,
          pushName: whatsappMessage.pushName,
          participantJid: whatsappMessage.participantJid,
          mediaUrl: whatsappMessage.mediaUrl,
          mediaType: whatsappMessage.mediaType,
          // Store original timestamp in metadata for reference
          originalTimestamp: messageTimestamp.toISOString(),
        },
        sentAt: messageTimestamp,
      });

      await messageRepo.save(message);
      
      logger.debug('Message saved with timestamp', {
        messageId: message.id,
        sentAt: message.sentAt.toISOString(),
        mediaType: whatsappMessage.mediaType,
        originalTimestamp: whatsappMessage.timestamp,
      });

      logger.info('Message saved successfully', {
        messageId: message.id,
        attendanceId: attendance.id,
      });

      // Emit Socket.IO event for real-time updates
      try {
        // Não emitir new_unassigned_message apenas para Demanda telefone fixo (Intervenção humana).
        // Encaminhados E-commerce/Balcão continuam em "Não atribuídos" e recebem new_unassigned_message.
        const isIntervention = attendance.interventionType === 'demanda-telefone-fixo';
        
        // LOG: Diagnóstico completo
        logger.info('📊 Socket.IO evento - diagnóstico completo', {
          attendanceId: attendance.id,
          sellerId: attendance.sellerId,
          interventionType: attendance.interventionType,
          isIntervention,
          hasVendedor: !!attendance.sellerId,
          willEmitUnassigned: !attendance.sellerId && !isIntervention,
        });
        
        if (!attendance.sellerId && !isIntervention) {
          const unassignedFilter =
            attendance.interventionType === 'encaminhados-ecommerce'
              ? 'encaminhados-ecommerce'
              : attendance.interventionType === 'encaminhados-balcao'
                ? 'encaminhados-balcao'
                : 'triagem';
          socketService.emitToRoom('supervisors', 'new_unassigned_message', {
            attendanceId: attendance.id,
            messageId: message.id,
            clientPhone: attendance.clientPhone,
            clientName: whatsappMessage.pushName || whatsappMessage.phoneNumber,
            lastMessage: message.content,
            lastMessageTime: message.sentAt.toISOString(),
            lastMessageMediaType: message.metadata?.mediaType,
            createdAt: attendance.createdAt.toISOString(),
            updatedAt: attendance.updatedAt.toISOString(),
            unassignedFilter,
          });

          invalidateSubdivisionCountsCache();
          socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

          logger.info('✅ Socket.IO: new_unassigned_message emitido com sucesso', {
            attendanceId: attendance.id,
            isIntervention: false,
            room: 'supervisors',
          });
        } else if (attendance.sellerId) {
          // NÃO emitir new_message - message_received já é emitido abaixo
          // Isso evita duplicação de eventos no frontend
          logger.info('Socket.IO event emitted for assigned message', {
            attendanceId: attendance.id,
            sellerId: attendance.sellerId,
          });
        } else if (isIntervention) {
          // Conversa já roteada para intervenção humana (ex.: demanda-telefone-fixo)
          // Não emitir new_unassigned_message nem new_message
          logger.info('⚠️ Socket.IO: Mensagem de intervenção (NÃO emitindo new_unassigned_message)', {
            attendanceId: attendance.id,
            interventionType: attendance.interventionType,
          });
        }
        // Se intervention (ex. demanda-telefone-fixo): não new_unassigned_message nem new_message

        const handledBy = (attendance.handledBy as string) || 'AI';
        const basePayload = {
          attendanceId: attendance.id,
          messageId: message.id,
          clientPhone: attendance.clientPhone,
          isUnassigned: !attendance.sellerId,
          handledBy,
          ...(attendance.sellerId && { sellerId: attendance.sellerId }),
          ...(attendance.sellerId && attendance.sellerSubdivision && { sellerSubdivision: attendance.sellerSubdivision }),
          message: {
            id: message.id,
            content: message.content,
            origin: message.origin,
            sentAt: message.sentAt.toISOString(),
            metadata: {
              ...message.metadata,
              sentAt: message.sentAt.toISOString(),
              createdAt: message.sentAt.toISOString(),
            },
          },
        };

        // Emit to specific room(s)
        if (!attendance.sellerId) {
          // Unassigned: emit only to supervisors
          socketService.emitToRoom('supervisors', 'message_received', basePayload);
        } else {
          // Assigned: emit to both seller and supervisors (so supervisors can see updates)
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_received', basePayload);
          socketService.emitToRoom('supervisors', 'message_received', basePayload);
        }
      } catch (socketError: any) {
        // Don't fail message processing if Socket.IO fails
        logger.warn('Failed to emit Socket.IO event', {
          error: socketError.message,
          attendanceId: attendance.id,
        });
      }

      // Process message with buffer if attendance is handled by AI and not closed operationally
      const aiBlockedUntil = attendance.aiDisabledUntil ? new Date(attendance.aiDisabledUntil) : null;
      const isAiTemporarilyBlocked = !!(aiBlockedUntil && aiBlockedUntil.getTime() > Date.now());
      const shouldProcess = attendance.handledBy === AttendanceType.AI &&
                           attendance.operationalState !== OperationalState.FECHADO_OPERACIONAL &&
                           !isAiTemporarilyBlocked;
      
      logger.info('Checking if should process message for AI', {
        attendanceId: attendance.id,
        handledBy: attendance.handledBy,
        aiDisabledUntil: attendance.aiDisabledUntil,
        isAiTemporarilyBlocked,
        operationalState: attendance.operationalState,
        sellerId: attendance.sellerId,
        shouldProcess,
        isNewAttendance, // CORREÇÃO: Log adicional para debug de reabertura
        messageId: message.id,
        wasAutoReopened: !isNewAttendance && attendance.updatedAt.getTime() > new Date(Date.now() - 60000).getTime(), // Reaberto nos últimos 60 segundos
      });
      
      // Quando não deve processar: NUNCA alterar handledBy de HUMAN para AI - humano assumiu de propósito
      if (!shouldProcess) {
        if (attendance.handledBy === AttendanceType.HUMAN) {
          logger.info('⏸️ Attendance is handled by HUMAN - skipping AI processing (human has assumed)', {
            attendanceId: attendance.id,
            messageId: message.id,
          });
          return;
        }
        if (attendance.operationalState === OperationalState.FECHADO_OPERACIONAL) {
          logger.info('⏸️ Attendance is closed - skipping AI processing', {
            attendanceId: attendance.id,
            messageId: message.id,
          });
          return;
        }
        if (isAiTemporarilyBlocked) {
          logger.info('⏸️ AI temporarily disabled for this attendance - skipping AI processing', {
            attendanceId: attendance.id,
            messageId: message.id,
            aiDisabledUntil: aiBlockedUntil?.toISOString(),
          });
          return;
        }
        logger.warn('⚠️ Message will NOT be processed for AI', {
          attendanceId: attendance.id,
          messageId: message.id,
          handledBy: attendance.handledBy,
          operationalState: attendance.operationalState,
        });
        return;
      }
      
      if (shouldProcess) {
        const mediaType = whatsappMessage.mediaType || 'text';
        const needsProcessing = mediaType === 'audio' || mediaType === 'image';

        // For audio/image: add to buffer immediately with isProcessing flag, then process in background
        // For text/video/document: fire-and-forget to not block (faster response)
        if (needsProcessing) {
          const mediaAlreadyStored = !!whatsappMessage.mediaUrl;
          logger.info('🔄 Adding media to buffer', {
            mediaType,
            messageId: message.id,
            mediaAlreadyStored,
          });

          void (async () => {
            try {
              let mediaUrlForBuffer: string | undefined;
              let isProcessing = true;
              let transcription: string | undefined;
              let description: string | undefined;
              let contentForBuffer = mediaType === 'audio' ? '[Processando áudio...]' : '[Processando imagem...]';

              if (whatsappMessage.mediaUrl) {
                const mediaService = new MediaService();
                const presignedUrl = await mediaService.getMediaUrl(whatsappMessage.mediaUrl, 3600);
                mediaUrlForBuffer = presignedUrl;
                isProcessing = false;
                // Transcrever/descrever no Node (acessa MinIO localmente); assim a IA recebe o texto sem o worker precisar baixar a URL
                if (mediaType === 'audio') {
                  transcription = await mediaProcessorService.processAudio(presignedUrl);
                  contentForBuffer = transcription;
                  logger.info('✅ Audio transcribed in Node before buffer', { messageId: message.id, length: transcription?.length });
                } else if (mediaType === 'image') {
                  description = await mediaProcessorService.processImage(presignedUrl);
                  contentForBuffer = description;
                  logger.info('✅ Image described in Node before buffer', { messageId: message.id, length: description?.length });
                }
              } else {
                // Sem mediaUrl (ex.: download da Meta falhou com 401) — não deixar isProcessing true para sempre
                isProcessing = false;
                contentForBuffer =
                  mediaType === 'audio'
                    ? '[Não foi possível acessar o áudio. Se usar API oficial, verifique o token de acesso da Meta.]'
                    : '[Não foi possível acessar a imagem. Se usar API oficial, verifique o token de acesso da Meta.]';
                logger.warn('Audio/image without mediaUrl - adding fallback content so buffer can flush', {
                  messageId: message.id,
                  mediaType,
                });
              }

              await messageBufferService.addMessage({
                messageId: message.id,
                attendanceId: attendance.id,
                clientPhone: whatsappMessage.phoneNumber,
                whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
                content: contentForBuffer,
                mediaType,
                mediaUrl: mediaUrlForBuffer,
                ...(transcription != null && { transcription }),
                ...(description != null && { description }),
                metadata: {
                  pushName: whatsappMessage.pushName,
                  fromJid: whatsappMessage.from,
                  participantJid: whatsappMessage.participantJid,
                },
                timestamp: messageTimestamp,
                isProcessing,
                ...(lastAttendanceSummary != null && { lastAttendanceSummary }),
                operationalState: operationalStateStr,
                attendanceContext,
              });
              logger.info(mediaUrlForBuffer ? '✅ Audio/Image added to buffer with transcription/description (official API)' : '✅ Audio/Image added to buffer with isProcessing=true (waiting for update-media)',
                { messageId: message.id, mediaType });
            } catch (error: any) {
              logger.error('❌ Error adding media to buffer', { error: error.message, messageId: message.id });
            }
          })();
        } else {
          // For text/video/document: fire-and-forget (no processing needed)
          logger.info('⚡ Processing message asynchronously (text/video/document)', {
            mediaType,
            messageId: message.id,
          });

          const payload = {
            messageId: message.id,
            attendanceId: attendance.id,
            clientPhone: whatsappMessage.phoneNumber,
            whatsappNumberId: whatsappMessage.whatsappNumberId as UUID,
            content: whatsappMessage.text || '[Mensagem de mídia]',
            mediaType,
            mediaUrl: undefined as string | undefined,
            metadata: {
              pushName: whatsappMessage.pushName,
              fromJid: whatsappMessage.from,
              participantJid: whatsappMessage.participantJid,
            },
            timestamp: messageTimestamp,
            ...(lastAttendanceSummary != null && { lastAttendanceSummary }),
            operationalState: operationalStateStr,
            attendanceContext,
          };

          void (async () => {
            try {
              logger.info('📤 Preparing to send message to AI queue (text/video/document)', {
                attendanceId: attendance.id,
                messageId: message.id,
                isNewAttendance,
                wasAutoReopened: !isNewAttendance,
                hasLastAttendanceSummary: !!lastAttendanceSummary,
                mediaType,
              });
              
              if (whatsappMessage.mediaUrl && mediaType !== 'text') {
                const mediaService = new MediaService();
                payload.mediaUrl = await mediaService.getMediaUrl(whatsappMessage.mediaUrl!, 3600);

                // For video/document, just add reference (no processing)
                const processed = await mediaProcessorService.routeMediaProcessing(
                  mediaType,
                  payload.mediaUrl
                );
                payload.content = processed.content;

                logger.info('📎 Media referenced (not processed)', {
                  mediaType,
                  reference: processed.content,
                });
              }

              logger.info('📤 Adding message to buffer (will be sent to AI queue)', {
                attendanceId: attendance.id,
                messageId: message.id,
                isNewAttendance,
                wasAutoReopened: !isNewAttendance,
                hasLastAttendanceSummary: !!lastAttendanceSummary,
                mediaType,
                contentPreview: payload.content?.substring(0, 100),
              });
              
              await messageBufferService.addMessage(payload);
              
              logger.info('✅ Message added to buffer successfully', {
                messageId: message.id,
                attendanceId: attendance.id,
                mediaType,
                wasAutoReopened: !isNewAttendance,
              });
            } catch (error: any) {
              logger.error('❌ Error adding message to buffer', {
                error: error.message,
                stack: error.stack,
                messageId: message.id,
                attendanceId: attendance.id,
                wasAutoReopened: !isNewAttendance,
              });
            }
          })();
        }
      } else {
        // CORREÇÃO: Log quando mensagem NÃO será processada
        logger.warn('⚠️ Message will NOT be processed by AI', {
          attendanceId: attendance.id,
          messageId: message.id,
          handledBy: attendance.handledBy,
          operationalState: attendance.operationalState,
          isNewAttendance,
          wasAutoReopened: !isNewAttendance,
          reason: attendance.handledBy !== AttendanceType.AI 
            ? 'handledBy is not AI' 
            : attendance.operationalState === OperationalState.FECHADO_OPERACIONAL
            ? 'operationalState is FECHADO_OPERACIONAL'
            : 'unknown',
        });
      }
    } catch (error: any) {
      logger.error('Error processing incoming message', {
        error: error.message,
        stack: error.stack,
        whatsappMessage,
      });
      throw error;
    }
  }

  /**
   * Processa mensagem enviada pelo dono do número direto do celular (fora da plataforma).
   * Exibe na plataforma com o nome do dono acima do push name.
   */
  private async processOwnerMessageFromPhone(whatsappMessage: WhatsAppMessage): Promise<void> {
    const attendanceRepo = AppDataSource.getRepository(Attendance);
    const messageRepo = AppDataSource.getRepository(Message);

    const attendance = await attendanceRepo.findOne({
      where: [
        { clientPhone: whatsappMessage.phoneNumber, whatsappNumberId: whatsappMessage.whatsappNumberId as UUID, operationalState: OperationalState.AGUARDANDO_PRIMEIRA_MSG },
        { clientPhone: whatsappMessage.phoneNumber, whatsappNumberId: whatsappMessage.whatsappNumberId as UUID, operationalState: OperationalState.TRIAGEM },
        { clientPhone: whatsappMessage.phoneNumber, whatsappNumberId: whatsappMessage.whatsappNumberId as UUID, operationalState: OperationalState.ABERTO },
        { clientPhone: whatsappMessage.phoneNumber, whatsappNumberId: whatsappMessage.whatsappNumberId as UUID, operationalState: OperationalState.EM_ATENDIMENTO },
        { clientPhone: whatsappMessage.phoneNumber, whatsappNumberId: whatsappMessage.whatsappNumberId as UUID, operationalState: OperationalState.AGUARDANDO_CLIENTE },
      ],
      order: { updatedAt: 'DESC' },
      relations: ['seller'],
    });

    if (!attendance) {
      logger.info('Owner message from phone: no active attendance found, skipping', {
        clientPhone: whatsappMessage.phoneNumber,
        messageId: whatsappMessage.id,
      });
      return;
    }

    const messageTimestamp = whatsappMessage.timestamp instanceof Date ? whatsappMessage.timestamp : new Date(whatsappMessage.timestamp);
    const mediaTypeForContent = whatsappMessage.mediaType || 'text';
    const displayContent =
      mediaTypeForContent === 'image' ? (whatsappMessage.text && whatsappMessage.text !== '[Processando imagem...]' ? whatsappMessage.text : '[Imagem]')
      : mediaTypeForContent === 'audio' ? (whatsappMessage.text && whatsappMessage.text !== '[Processando áudio...]' ? whatsappMessage.text : '[Áudio]')
      : (whatsappMessage.text || '[Mensagem de mídia]');

    const message = messageRepo.create({
      attendanceId: attendance.id,
      origin: MessageOrigin.SELLER,
      content: displayContent,
      metadata: {
        whatsappMessageId: whatsappMessage.id,
        fromMe: true,
        ownerPushName: whatsappMessage.ownerPushName || 'Dono',
        fromJid: whatsappMessage.from,
        mediaUrl: whatsappMessage.mediaUrl,
        mediaType: whatsappMessage.mediaType,
        originalTimestamp: messageTimestamp.toISOString(),
      },
      sentAt: messageTimestamp,
    });

    await messageRepo.save(message);

    // Ativar/atualizar timer de 1 hora desligada: handledBy = HUMAN, assumedAt = now
    // Cada nova msg fromMe reseta o timer para mais 1 hora
    const now = new Date();
    attendance.handledBy = AttendanceType.HUMAN;
    attendance.assumedAt = now;
    attendance.updatedAt = now;
    await attendanceRepo.save(attendance);

    const ownerName = whatsappMessage.ownerPushName || 'Dono';
    const basePayload = {
      attendanceId: attendance.id,
      messageId: message.id,
      clientPhone: attendance.clientPhone,
      isUnassigned: !attendance.sellerId,
      handledBy: 'HUMAN',
      sender: ownerName,
      fromMe: true,
      assumedAt: now.toISOString(),
      ...(attendance.sellerId && { sellerId: attendance.sellerId }),
      ...(attendance.sellerId && attendance.sellerSubdivision && { sellerSubdivision: attendance.sellerSubdivision }),
      message: {
        id: message.id,
        content: message.content,
        origin: message.origin,
        sentAt: message.sentAt.toISOString(),
        metadata: { ...message.metadata, sentAt: message.sentAt.toISOString(), createdAt: message.sentAt.toISOString() },
      },
    };

    if (!attendance.sellerId) {
      socketService.emitToRoom('supervisors', 'message_received', basePayload);
    } else {
      socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_received', basePayload);
      socketService.emitToRoom('supervisors', 'message_received', basePayload);
    }

    // Emitir attendance_assumed para ativar/atualizar timer de 1h no frontend
    try {
      const eventData = {
        attendanceId: attendance.id,
        handledBy: 'HUMAN',
        assumedBy: ownerName,
        assumedAt: now.toISOString(),
      };
      if (attendance.sellerId) {
        socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance_assumed', eventData);
      }
      socketService.emitToRoom('supervisors', 'attendance_assumed', eventData);
    } catch (e: any) {
      logger.warn('Failed to emit attendance_assumed for fromMe message', { error: e?.message, attendanceId: attendance.id });
    }

    logger.info('Owner message from phone saved and emitted', {
      messageId: message.id,
      attendanceId: attendance.id,
      ownerName,
    });
  }

  /**
   * Obtém o tempo de fechamento do balcão da config da FC.
   */
  private async getTempoFechamentoBalcao(): Promise<number> {
    try {
      const fcConfigRepo = AppDataSource.getRepository(FunctionCallConfig);
      const fcConfig = await fcConfigRepo.findOne({ where: { functionCallName: FC_NAME_FECHA_BALCAO } });
      if (fcConfig) {
        const customAttrs = fcConfig.customAttributes as Record<string, unknown> | undefined;
        const metadata = fcConfig.metadata as Record<string, unknown> | undefined;
        const tempoRaw = customAttrs?.tempo_fechamento_balcao ?? metadata?.tempo_fechamento_balcao;
        if (tempoRaw !== undefined && tempoRaw !== null) {
          const tempoNum = Number(tempoRaw);
          if (!isNaN(tempoNum) && tempoNum >= 1 && tempoNum <= 60) {
            return tempoNum;
          }
        }
      }
    } catch (e: any) {
      logger.warn('getTempoFechamentoBalcao: erro ao buscar config', { error: e?.message });
    }
    return DEFAULT_TEMPO_FECHAMENTO_BALCAO_MIN;
  }
}

// Singleton instance
export const messageProcessorService = new MessageProcessorService();