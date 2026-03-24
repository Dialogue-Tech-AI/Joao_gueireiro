import { In, LessThan, Not, IsNull, MoreThanOrEqual } from 'typeorm';
import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../domain/entities/attendance.entity';
import { AttendanceCase } from '../../domain/entities/attendance-case.entity';
import { Message } from '../../../message/domain/entities/message.entity';
import { FunctionCallConfig } from '../../../ai/domain/entities/function-call-config.entity';
import { OperationalState, AttendanceType, MessageOrigin, CaseStatus, MessageStatus } from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { InfrastructureFactory } from '../../../../shared/infrastructure/factories/infrastructure.factory';
import { aiConfigService } from '../../../ai/application/services/ai-config.service';
import { messageSenderService } from '../../../message/application/services/message-sender.service';
import { invalidateSubdivisionCountsCache } from '../../presentation/controllers/attendance.controller';
import {
  AGENDAMENTO_AUTO_CLOSE_MINUTES,
  clearAgendamentoTimerFields,
  isLikelyOnlyThankYouMessage,
} from '../../domain/utils/agendamento-auto-close.util';
import { canReceiveFollowUp } from '../../domain/utils/follow-up-eligibility.util';

const FC_NAME_FECHA_BALCAO = 'fechaatendimentobalcao';
const DEFAULT_TEMPO_INATIVIDADE_BALCAO_MIN = 30; // 30 minutos padrão

export class AttendanceInactivityService {
  /**
   * Check and send follow-up messages for inactive attendances.
   * - 1º follow-up: conforme config (inatividade após resposta AI/HUMANO)
   * - 2º follow-up: após o intervalo configurado desde o 1º, se o cliente ainda não respondeu
   * - Ao enviar o 2º follow-up: estado operacional → AGUARDANDO_CLIENTE (coluna “Aguardando” no supervisor)
   * - Fechamento automático: tempo configurado em movimentação (após 2º follow-up), contado desde secondSentAt
   */
  async checkAndCloseInactiveAttendances(): Promise<number> {
    try {
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const messageRepo = AppDataSource.getRepository(Message);

      const followUpConfig = await aiConfigService.getFollowUpConfig();
      const movementConfig = await aiConfigService.getFollowUpMovementConfig();
      const firstCutoff = new Date(Date.now() - followUpConfig.firstDelayMinutes * 60 * 1000);

      // Processar atendimentos "abertos" do funil (inclui triagem/aberto/em_atendimento/aguardando_cliente)
      // para permitir a movimentação correta entre as colunas de Follow-up.
      const pendingAttendances = await attendanceRepo.find({
        where: {
          operationalState: In([
            OperationalState.TRIAGEM,
            OperationalState.ABERTO,
            OperationalState.EM_ATENDIMENTO,
            OperationalState.AGUARDANDO_CLIENTE,
          ]),
          isFinalized: false,
        },
      });

      let followUpsSent = 0;
      let autoClosedCount = 0;

      for (const attendance of pendingAttendances) {
        const aiContext = (attendance.aiContext ?? {}) as Record<string, any>;
        if (aiContext.closedManually) {
          continue;
        }
        // Intervenção humana (prótese, outros assuntos, manutenção): não entra no follow-up; encaminhados podem
        if (!canReceiveFollowUp(attendance.interventionType)) {
          continue;
        }
        // Timer pós-FC agendamento_* (30 min): não enviar follow-ups só enquanto o prazo ainda não passou
        const agCloseAt = aiContext.agendamentoAutoCloseAt as string | undefined;
        if (agCloseAt) {
          const deadline = new Date(agCloseAt).getTime();
          if (Number.isFinite(deadline) && deadline > Date.now()) {
            continue;
          }
        }
        const followUpState = (aiContext.followUpState ?? {}) as {
          lastClientMessageAt?: string;
          firstSentAt?: string;
          secondSentAt?: string;
        };

        // Precisa ter mensagem do cliente como base para contagem de inatividade.
        const lastClientMessageAt = attendance.lastClientMessageAt ?? null;
        if (!lastClientMessageAt) {
          continue;
        }

        // Precisa existir resposta (AI/HUMANO) depois da última mensagem do cliente.
        const replyAfterClient = await messageRepo.findOne({
          where: {
            attendanceId: attendance.id,
            origin: In([MessageOrigin.AI, MessageOrigin.SELLER]),
            sentAt: Not(LessThan(lastClientMessageAt)),
          },
          order: { sentAt: 'ASC' },
        });
        if (!replyAfterClient) {
          continue;
        }

        // Se cliente voltou a responder desde o último ciclo, resetar estado do follow-up.
        const lastClientIso = lastClientMessageAt.toISOString();
        const trackedClientIso = followUpState.lastClientMessageAt;
        const isSameClientCycle = trackedClientIso === lastClientIso;
        const normalizedState = isSameClientCycle
          ? followUpState
          : { lastClientMessageAt: lastClientIso };

        // Persistir reset de ciclo quando o cliente respondeu novamente.
        if (!isSameClientCycle && (followUpState.firstSentAt || followUpState.secondSentAt)) {
          attendance.aiContext = {
            ...aiContext,
            followUpState: {
              lastClientMessageAt: lastClientIso,
            },
          };
          await attendanceRepo.save(attendance);
        }

        // Fechamento automático: só após o 2º follow-up (secondSentAt); tempo = moveToFechadosAfterSecondFollowUpMinutes
        // a partir do envio do 2º (estado AGUARDANDO_CLIENTE = fase “Aguardando” antes de Fechados)
        if (normalizedState.secondSentAt) {
          const secondSentAt = new Date(normalizedState.secondSentAt);
          const closeAfterMs = movementConfig.moveToFechadosAfterSecondFollowUpMinutes * 60 * 1000;
          if (Date.now() - secondSentAt.getTime() >= closeAfterMs) {
            await this.moveToFechados(attendance, 'followup_auto_close');
            autoClosedCount++;
            continue;
          }
        }

        // 1º follow-up: tempo configurado sem resposta do cliente (envio da mensagem)
        if (!normalizedState.firstSentAt && lastClientMessageAt < firstCutoff) {
          const sent = await this.sendFollowUpMessage(
            attendance,
            1,
            followUpConfig.firstMessage
          );
          if (sent) {
            followUpsSent++;
            attendance.aiContext = {
              ...aiContext,
              followUpState: {
                ...normalizedState,
                firstSentAt: new Date().toISOString(),
              },
            };
            await attendanceRepo.save(attendance);
          }
          continue;
        }

        // 2º follow-up: tempo configurado após o primeiro follow-up, sem resposta do cliente
        if (normalizedState.firstSentAt && !normalizedState.secondSentAt) {
          const firstSentAt = new Date(normalizedState.firstSentAt);
          const secondCutoff = new Date(firstSentAt.getTime() + followUpConfig.secondDelayMinutes * 60 * 1000);
          if (new Date() >= secondCutoff) {
            const sent = await this.sendFollowUpMessage(
              attendance,
              2,
              followUpConfig.secondMessage
            );
            if (sent) {
              followUpsSent++;
              attendance.aiContext = {
                ...aiContext,
                followUpState: {
                  ...normalizedState,
                  secondSentAt: new Date().toISOString(),
                },
              };
              // Coluna “Aguardando” (inativo-24h): movimentação explícita; o timer de fechamento usa secondSentAt acima
              attendance.operationalState = OperationalState.AGUARDANDO_CLIENTE;
              await attendanceRepo.save(attendance);
            }
          }
        }
      }

      if (followUpsSent > 0 || autoClosedCount > 0) {
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        logger.info('Follow-up inactivity check completed', {
          followUpsSent,
          autoClosedCount,
          totalChecked: pendingAttendances.length,
        });
      }

      return followUpsSent + autoClosedCount;
    } catch (error: any) {
      logger.error('Error checking inactive attendances', {
        error: error.message,
        stack: error.stack,
      });
      return 0;
    }
  }

  private async sendFollowUpMessage(attendance: Attendance, step: 1 | 2, content: string): Promise<boolean> {
    try {
      const messageRepo = AppDataSource.getRepository(Message);
      const message = messageRepo.create({
        attendanceId: attendance.id,
        origin: MessageOrigin.AI,
        content,
        metadata: {
          senderName: 'Altese AI',
          fromFollowUp: true,
          followUpStep: step,
        },
        status: MessageStatus.PENDING,
        sentAt: new Date(),
      });
      await messageRepo.save(message);

      await messageSenderService.sendMessageAsync(
        message.id,
        attendance.id,
        content,
        'Altese AI'
      );

      logger.info('Follow-up message sent', {
        attendanceId: attendance.id,
        messageId: message.id,
        followUpStep: step,
      });
      return true;
    } catch (error: any) {
      logger.error('Failed to send follow-up message', {
        attendanceId: attendance.id,
        followUpStep: step,
        error: error?.message,
      });
      return false;
    }
  }

  /**
   * Check and return to AI attendances assumed by humans but inactive for 1 hour
   * Resets timer when human sends a message
   */
  async checkAndReturnInactiveAssumedAttendances(): Promise<number> {
    try {
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const messageRepo = AppDataSource.getRepository(Message);
      
      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);

      // Find attendances handled by HUMAN that were assumed more than 1 hour ago
      const assumedAttendances = await attendanceRepo.find({
        where: {
          handledBy: AttendanceType.HUMAN,
        },
      });

      let returnedCount = 0;

      for (const attendance of assumedAttendances) {
        // Skip if not assumed yet
        if (!attendance.assumedAt) {
          continue;
        }

        // Pular se IA permanentemente desligada — supervisor controla quando volta
        if (attendance.aiDisabledUntil && new Date(attendance.aiDisabledUntil).getFullYear() > 2100) {
          continue;
        }

        // Regra de negócio:
        // Se já houve function call no atendimento (interventionType definido)
        // e a última mensagem NÃO foi do cliente, não acionar follow-up.
        if (attendance.interventionType) {
          const lastMessage = await messageRepo.findOne({
            where: { attendanceId: attendance.id },
            order: { sentAt: 'DESC' },
          });
          if (lastMessage && lastMessage.origin !== MessageOrigin.CLIENT) {
            continue;
          }
        }

        // Check if assumed more than 1 hour ago
        if (attendance.assumedAt < oneHourAgo) {
          // Check if there were any messages from seller/supervisor in the last hour
          const lastHumanMessage = await messageRepo.findOne({
            where: {
              attendanceId: attendance.id,
              origin: MessageOrigin.SELLER,
            },
            order: { sentAt: 'DESC' },
          });

          // If no human message in the last hour, or last message was before assumption + 1 hour
          const shouldReturn = !lastHumanMessage || 
            (lastHumanMessage.sentAt < oneHourAgo && lastHumanMessage.sentAt < attendance.assumedAt);

          if (shouldReturn) {
            // Return to AI
            attendance.handledBy = AttendanceType.AI;
            attendance.returnedAt = new Date();
            attendance.updatedAt = new Date();
            await attendanceRepo.save(attendance);

            returnedCount++;

            logger.info('Returned inactive assumed attendance to AI', {
              attendanceId: attendance.id,
              assumedAt: attendance.assumedAt,
              lastHumanMessage: lastHumanMessage?.sentAt || null,
            });

            // Emit Socket.IO event to notify about automatic return
            try {
              const eventData = {
                attendanceId: attendance.id,
                handledBy: 'AI',
                returnedBy: 'SYSTEM',
                returnedAt: attendance.returnedAt.toISOString(),
                reason: 'inactivity',
              };

              if (attendance.sellerId) {
                socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance_returned_to_ai', eventData);
              }
              socketService.emitToRoom('supervisors', 'attendance_returned_to_ai', eventData);
            } catch (socketError: any) {
              logger.warn('Failed to emit attendance_returned_to_ai Socket.IO event', {
                error: socketError.message,
                attendanceId: attendance.id,
              });
            }
          }
        }
      }

      if (returnedCount > 0) {
        logger.info('Inactivity check for assumed attendances completed', {
          returnedCount,
          totalChecked: assumedAttendances.length,
        });
      }

      return returnedCount;
    } catch (error: any) {
      logger.error('Error checking inactive assumed attendances', {
        error: error.message,
        stack: error.stack,
      });
      return 0;
    }
  }

  /**
   * Após FCs agendamento_*: em 30 min, fechar se não houver mensagem de humano (plataforma/celular)
   * nem mensagem substantiva do cliente (só agradecimento não cancela).
   */
  async checkAndCloseAgendamentoTimer(): Promise<number> {
    try {
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const messageRepo = AppDataSource.getRepository(Message);
      const now = new Date();

      const candidates = await attendanceRepo
        .createQueryBuilder('a')
        .where('a.operational_state != :closed', { closed: OperationalState.FECHADO_OPERACIONAL })
        .andWhere('a.is_finalized = :fin', { fin: false })
        .andWhere("(a.ai_context->>'agendamentoAutoCloseAt') IS NOT NULL")
        .andWhere("(a.ai_context->>'agendamentoAutoCloseAt')::timestamp <= :now", { now })
        .getMany();

      let closedCount = 0;

      for (const attendance of candidates) {
        const ac = (attendance.aiContext ?? {}) as Record<string, unknown>;
        const startedRaw = ac.agendamentoTimerStartedAt as string | undefined;
        const closeAtRaw = ac.agendamentoAutoCloseAt as string | undefined;
        const startedAt = startedRaw
          ? new Date(startedRaw)
          : closeAtRaw
            ? new Date(new Date(closeAtRaw).getTime() - AGENDAMENTO_AUTO_CLOSE_MINUTES * 60 * 1000)
            : new Date(0);

        const humanMsg = await messageRepo.findOne({
          where: {
            attendanceId: attendance.id,
            origin: MessageOrigin.SELLER,
            sentAt: MoreThanOrEqual(startedAt),
          },
        });
        if (humanMsg) {
          attendance.aiContext = clearAgendamentoTimerFields(ac);
          await attendanceRepo.save(attendance);
          continue;
        }

        const clientAfter = await messageRepo.find({
          where: {
            attendanceId: attendance.id,
            origin: MessageOrigin.CLIENT,
            sentAt: MoreThanOrEqual(startedAt),
          },
          order: { sentAt: 'ASC' },
        });

        let cancelClose = false;
        for (const msg of clientAfter) {
          const meta = (msg.metadata ?? {}) as Record<string, unknown>;
          const mt = (meta.mediaType as string | undefined) || 'text';
          if (mt !== 'text') {
            cancelClose = true;
            break;
          }
          if (!isLikelyOnlyThankYouMessage(msg.content)) {
            cancelClose = true;
            break;
          }
        }

        if (cancelClose) {
          attendance.aiContext = clearAgendamentoTimerFields(ac);
          await attendanceRepo.save(attendance);
          continue;
        }

        await this.moveToFechados(attendance, 'agendamento_timer_30min');
        closedCount++;
      }

      if (closedCount > 0) {
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        logger.info('checkAndCloseAgendamentoTimer completed', { closedCount, checked: candidates.length });
      }

      return closedCount;
    } catch (error: any) {
      logger.error('Error in checkAndCloseAgendamentoTimer', { error: error.message, stack: error.stack });
      return 0;
    }
  }

  /**
   * Publica na fila ai-messages o pedido de resumo final ao fechar (worker gera e vetoriza).
   */
  private async publishCloseSummary(attendanceId: string): Promise<void> {
    try {
      const queue = InfrastructureFactory.createQueue();
      await queue.publish('ai-messages', { mode: 'close_summary', attendanceId });
    } catch (e: any) {
      logger.warn('Failed to publish close_summary for attendance', { attendanceId, error: e?.message });
    }
  }

  /**
   * Fecha atendimentos em que todos os casos estão resolvidos ou cancelados.
   * Chamado por job periódico ou após atualização de caso.
   */
  async tryCloseByCasesResolved(): Promise<number> {
    try {
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const caseRepo = AppDataSource.getRepository(AttendanceCase);
      const openStatuses = [CaseStatus.NOVO, CaseStatus.EM_ANDAMENTO, CaseStatus.AGUARDANDO_VENDEDOR, CaseStatus.AGUARDANDO_CLIENTE];
      const attendances = await attendanceRepo.find({
        where: [
          { operationalState: OperationalState.TRIAGEM },
          { operationalState: OperationalState.ABERTO },
          { operationalState: OperationalState.EM_ATENDIMENTO },
          { operationalState: OperationalState.AGUARDANDO_CLIENTE },
        ],
      });
      let closedCount = 0;
      for (const att of attendances) {
        const totalCases = await caseRepo.count({ where: { attendanceId: att.id } });
        if (totalCases === 0) continue;
        const pendingCases = await caseRepo.count({
          where: { attendanceId: att.id, status: In(openStatuses) },
        });
        if (pendingCases === 0) {
          att.operationalState = OperationalState.FECHADO_OPERACIONAL;
          await attendanceRepo.save(att);
          closedCount++;
          await this.publishCloseSummary(att.id);
          logger.info('Closed attendance by cases resolved', { attendanceId: att.id });
        }
      }
      return closedCount;
    } catch (error: any) {
      logger.error('Error in tryCloseByCasesResolved', { error: error.message });
      return 0;
    }
  }

  /**
   * Fecha atendimentos de balcão cujo timer (balcaoClosingAt) expirou.
   * Acionado pelo job periódico.
   */
  async checkAndCloseBalcaoByTimer(): Promise<number> {
    try {
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const now = new Date();

      // Buscar atendimentos com timer expirado
      const expiredAttendances = await attendanceRepo.find({
        where: {
          balcaoClosingAt: LessThan(now),
        },
      });

      let closedCount = 0;

      for (const attendance of expiredAttendances) {
        await this.moveToFechados(attendance, 'timer_fc');
        closedCount++;
      }

      if (closedCount > 0) {
        logger.info('checkAndCloseBalcaoByTimer completed', { closedCount, totalChecked: expiredAttendances.length });
      }

      return closedCount;
    } catch (error: any) {
      logger.error('Error in checkAndCloseBalcaoByTimer', { error: error.message, stack: error.stack });
      return 0;
    }
  }

  /**
   * Fecha atendimentos na caixa Balcão (interventionType = 'encaminhados-balcao')
   * que estão inativos por um tempo configurável (independente da FC).
   */
  async checkAndCloseBalcaoByInactivity(): Promise<number> {
    try {
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const fcConfigRepo = AppDataSource.getRepository(FunctionCallConfig);

      // Buscar tempo de inatividade da config da FC
      let tempoInatividadeMinutos = DEFAULT_TEMPO_INATIVIDADE_BALCAO_MIN;
      try {
        const fcConfig = await fcConfigRepo.findOne({ where: { functionCallName: FC_NAME_FECHA_BALCAO } });
        if (fcConfig) {
          const customAttrs = fcConfig.customAttributes as Record<string, unknown> | undefined;
          const metadata = fcConfig.metadata as Record<string, unknown> | undefined;
          const tempoRaw = customAttrs?.tempo_inatividade_balcao ?? metadata?.tempo_inatividade_balcao;
          if (tempoRaw !== undefined && tempoRaw !== null) {
            const tempoNum = Number(tempoRaw);
            if (!isNaN(tempoNum) && tempoNum >= 1 && tempoNum <= 60) {
              tempoInatividadeMinutos = tempoNum;
            }
          }
        }
      } catch (e: any) {
        logger.warn(`checkAndCloseBalcaoByInactivity: erro ao buscar config, usando padrão ${DEFAULT_TEMPO_INATIVIDADE_BALCAO_MIN}min`, { error: e?.message });
      }

      const cutoffTime = new Date(Date.now() - tempoInatividadeMinutos * 60 * 1000);

      // Buscar atendimentos em encaminhados-balcao que estão inativos
      const inactiveBalcaoAttendances = await attendanceRepo.find({
        where: {
          interventionType: 'encaminhados-balcao',
          operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
        },
      });

      let closedCount = 0;

      for (const attendance of inactiveBalcaoAttendances) {
        // Pular se já tem timer ativo (será fechado pelo checkAndCloseBalcaoByTimer)
        if (attendance.balcaoClosingAt) {
          continue;
        }

        // Verificar inatividade baseado em lastClientMessageAt ou updatedAt
        const lastActivity = attendance.lastClientMessageAt || attendance.updatedAt;
        if (lastActivity && lastActivity < cutoffTime) {
          await this.moveToFechados(attendance, 'inatividade_balcao');
          closedCount++;
        }
      }

      if (closedCount > 0) {
        logger.info('checkAndCloseBalcaoByInactivity completed', { closedCount, tempoInatividadeMinutos });
      }

      return closedCount;
    } catch (error: any) {
      logger.error('Error in checkAndCloseBalcaoByInactivity', { error: error.message, stack: error.stack });
      return 0;
    }
  }

  /**
   * Fecha atendimentos de e-commerce cujo timer (ecommerceClosingAt) expirou.
   * Acionado pelo job periódico.
   */
  async checkAndCloseEcommerceByTimer(): Promise<number> {
    try {
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const now = new Date();

      // Buscar atendimentos com timer expirado e que ainda não estão fechados
      // IMPORTANTE: Filtrar apenas atendimentos que têm ecommerceClosingAt definido
      // (pode ser de encaminhados-ecommerce ou outros tipos)
      const expiredAttendances = await attendanceRepo.find({
        where: {
          ecommerceClosingAt: LessThan(now),
          operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
        },
        relations: ['seller'],
        order: { ecommerceClosingAt: 'ASC' }, // Processar os mais antigos primeiro
      });

      let closedCount = 0;

      for (const attendance of expiredAttendances) {
        try {
          logger.info('Fechando atendimento e-commerce por timer expirado', {
            attendanceId: attendance.id,
            ecommerceClosingAt: attendance.ecommerceClosingAt,
            now: now.toISOString(),
            interventionType: attendance.interventionType,
          });

          await this.moveToFechados(attendance, 'timer_ecommerce');
          closedCount++;

          logger.info('Atendimento e-commerce fechado com sucesso', {
            attendanceId: attendance.id,
          });
        } catch (attendanceError: any) {
          logger.error('Erro ao fechar atendimento e-commerce individual', {
            attendanceId: attendance.id,
            error: attendanceError.message,
            stack: attendanceError.stack,
          });
          // Continua processando outros atendimentos mesmo se um falhar
        }
      }

      if (closedCount > 0) {
        logger.info('checkAndCloseEcommerceByTimer completed', { 
          closedCount, 
          totalChecked: expiredAttendances.length,
          totalExpired: expiredAttendances.length,
        });
      }

      return closedCount;
    } catch (error: any) {
      logger.error('Error in checkAndCloseEcommerceByTimer', { 
        error: error.message, 
        stack: error.stack 
      });
      return 0;
    }
  }

  /**
   * Move atendimento para Fechados, limpando indicadores e emitindo evento.
   */
  private async moveToFechados(attendance: Attendance, reason: string): Promise<void> {
    const attendanceRepo = AppDataSource.getRepository(Attendance);

    // Salvar estado anterior no aiContext antes de limpar (para poder restaurar depois, incluindo timer da IA)
    const ctxBeforeClose = (attendance.aiContext ?? {}) as Record<string, unknown>;
    const previousState = {
      interventionType: attendance.interventionType,
      /** Foto da subdivisão AI no fechamento (null = não classificados); usada nas estatísticas do supervisor */
      aiSubdivision: (ctxBeforeClose.ai_subdivision as string | undefined) ?? null,
      sellerSubdivision: attendance.sellerSubdivision,
      operationalState: attendance.operationalState,
      handledBy: attendance.handledBy,
      assumedAt: attendance.assumedAt?.toISOString(),
    };
    
    // Atualizar aiContext preservando dados existentes
    attendance.aiContext = {
      ...attendance.aiContext,
      previousStateBeforeClosing: previousState,
      closedAt: new Date().toISOString(),
      closedReason: reason,
    };

    // Limpar indicadores e mover para FECHADO_OPERACIONAL
    attendance.operationalState = OperationalState.FECHADO_OPERACIONAL;
    attendance.interventionType = null as any;
    attendance.sellerSubdivision = null as any;
    attendance.balcaoClosingAt = undefined;
    attendance.ecommerceClosingAt = undefined;
    attendance.finalizedAt = new Date();

    await attendanceRepo.save(attendance);

    logger.info('Attendance moved to Fechados', {
      attendanceId: attendance.id,
      reason,
    });

    // Emitir eventos Socket.IO para atualização em tempo real
    try {
      const eventData = {
        attendanceId: attendance.id,
        reason,
        closedAt: new Date().toISOString(),
        interventionType: previousState.interventionType, // Para o frontend saber de qual subdivisão veio
      };

      // Emitir para supervisores (atualiza lista e contagens)
      socketService.emitToRoom('supervisors', 'attendance:moved-to-fechados', eventData);

      // Se tinha vendedor atribuído, também notificar o vendedor
      if (attendance.sellerId) {
        socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance:moved-to-fechados', eventData);
      }

      invalidateSubdivisionCountsCache();
      socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

      logger.info('Eventos Socket.IO emitidos para fechamento de atendimento', {
        attendanceId: attendance.id,
        reason,
        hadSeller: !!attendance.sellerId,
      });
    } catch (e: any) {
      logger.error('Failed to emit attendance:moved-to-fechados', { 
        error: e?.message, 
        stack: e?.stack,
        attendanceId: attendance.id 
      });
      // Não lança erro - o fechamento já foi persistido, apenas o evento falhou
    }

    // Gerar resumo final
    await this.publishCloseSummary(attendance.id);
  }

  /**
   * Fecha atendimentos inativos por subdivisão baseado em configuração de tempo.
   * Verifica cada subdivisão configurada e fecha atendimentos que estão inativos
   * há mais tempo que o configurado sem mensagens do cliente.
   */
  async checkAndCloseBySubdivisionInactivity(): Promise<number> {
    try {
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      
      // Buscar configurações de tempo de inatividade por subdivisão
      const timeouts = await aiConfigService.getSubdivisionInactivityTimeouts();
      
      if (!timeouts || Object.keys(timeouts).length === 0) {
        // Sem configurações, não fazer nada
        return 0;
      }

      logger.info('Checking subdivision inactivity timeouts', {
        configuredSubdivisions: Object.keys(timeouts),
      });

      let totalClosed = 0;

      // Processar cada subdivisão configurada
      for (const [subdivisionKey, timeoutMinutes] of Object.entries(timeouts)) {
        try {
          // Validar timeoutMinutes
          if (!timeoutMinutes || typeof timeoutMinutes !== 'number' || timeoutMinutes < 1 || timeoutMinutes > 1440) {
            logger.warn('Invalid timeout value for subdivision, skipping', {
              subdivisionKey,
              timeoutMinutes,
            });
            continue;
          }

          const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000);
          
          // Determinar como buscar atendimentos baseado no tipo de subdivisão
          let whereClause: any = {};

          // Subdivisões não atribuídas (triagem, encaminhados-ecommerce, encaminhados-balcao)
          if (subdivisionKey === 'triagem') {
            whereClause.operationalState = OperationalState.TRIAGEM;
            whereClause.sellerId = IsNull();
            whereClause.interventionType = IsNull();
          } else if (subdivisionKey === 'encaminhados-ecommerce') {
            whereClause.operationalState = Not(OperationalState.FECHADO_OPERACIONAL);
            whereClause.interventionType = 'encaminhados-ecommerce';
            whereClause.sellerId = IsNull();
          } else if (subdivisionKey === 'encaminhados-balcao') {
            whereClause.operationalState = Not(OperationalState.FECHADO_OPERACIONAL);
            whereClause.interventionType = 'encaminhados-balcao';
            whereClause.sellerId = IsNull();
          } else if (subdivisionKey.startsWith('seller-')) {
            // Subdivisão de vendedor: formato "seller-{sellerId}-{subdivision}"
            const parts = subdivisionKey.split('-');
            if (parts.length >= 3) {
              const sellerId = parts[1];
              const sellerSubdivision = parts.slice(2).join('-');
              whereClause.operationalState = Not(OperationalState.FECHADO_OPERACIONAL);
              whereClause.sellerId = sellerId;
              whereClause.sellerSubdivision = sellerSubdivision;
            } else {
              logger.warn('Invalid seller subdivision format', { subdivisionKey });
              continue;
            }
          } else {
            logger.warn('Unknown subdivision type, skipping', { subdivisionKey });
            continue;
          }

          // Buscar atendimentos inativos nesta subdivisão
          const inactiveAttendances = await attendanceRepo.find({
            where: whereClause,
            relations: ['seller'],
          });

          let closedCount = 0;

          for (const attendance of inactiveAttendances) {
            // Verificar inatividade baseado em lastClientMessageAt ou updatedAt
            const lastActivity = attendance.lastClientMessageAt || attendance.updatedAt;
            
            if (lastActivity && lastActivity < cutoffTime) {
              // Verificar se não há timer ativo (balcão ou e-commerce)
              // Se houver timer, ele será fechado pelo timer check job
              if (attendance.balcaoClosingAt || attendance.ecommerceClosingAt) {
                continue; // Pular se tem timer ativo
              }

              logger.info('Closing attendance due to subdivision inactivity', {
                attendanceId: attendance.id,
                subdivisionKey,
                timeoutMinutes,
                lastActivity: lastActivity.toISOString(),
                cutoffTime: cutoffTime.toISOString(),
              });

              await this.moveToFechados(attendance, `inatividade_subdivisao_${subdivisionKey}`);
              closedCount++;
              totalClosed++;
            }
          }

          if (closedCount > 0) {
            logger.info('Subdivision inactivity check completed', {
              subdivisionKey,
              timeoutMinutes,
              closedCount,
            });
          }
        } catch (subdivisionError: any) {
          logger.error('Error checking subdivision inactivity', {
            subdivisionKey,
            error: subdivisionError.message,
            stack: subdivisionError.stack,
          });
          // Continua processando outras subdivisões mesmo se uma falhar
        }
      }

      if (totalClosed > 0) {
        logger.info('Subdivision inactivity check completed (all subdivisions)', {
          totalClosed,
          subdivisionsChecked: Object.keys(timeouts).length,
        });
      }

      return totalClosed;
    } catch (error: any) {
      logger.error('Error in checkAndCloseBySubdivisionInactivity', {
        error: error.message,
        stack: error.stack,
      });
      return 0;
    }
  }
}
