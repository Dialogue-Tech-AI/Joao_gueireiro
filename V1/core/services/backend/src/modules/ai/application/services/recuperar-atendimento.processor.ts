import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { Message } from '../../../message/domain/entities/message.entity';
import { AttendanceCase } from '../../../attendance/domain/entities/attendance-case.entity';
import { OperationalState } from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const FC_NAME = 'recuperaratendimento';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador específico para recuperaratendimento.
 * Quando acionada:
 * 1. Busca o último atendimento fechado do cliente
 * 2. Reabre o atendimento (muda operationalState de FECHADO_OPERACIONAL para o estado apropriado)
 * 3. Restaura campos como interventionType, sellerSubdivision, etc.
 * 4. Limpa finalizedAt
 * 5. Emite eventos Socket.IO para atualizar o frontend
 */
export function createRecuperarAtendimentoProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result) as Record<string, unknown>;
    const data = (parsed?.data as Record<string, unknown>) ?? parsed;

    let currentAttendance: Attendance | null = null;
    let closedAttendance: Attendance | null = null;

    try {
      // Buscar o atendimento atual (onde a function call foi acionada)
      currentAttendance = await attendanceRepo.findOne({ 
        where: { id: attendance_id },
        relations: ['seller', 'supervisor'],
      });
      
      if (!currentAttendance) {
        logger.error(`${FC_NAME}: attendance atual não encontrado`, { attendance_id });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      // Buscar o último atendimento fechado do cliente
      closedAttendance = await attendanceRepo.findOne({
        where: {
          clientPhone: currentAttendance.clientPhone,
          whatsappNumberId: currentAttendance.whatsappNumberId,
          operationalState: OperationalState.FECHADO_OPERACIONAL,
        },
        order: { finalizedAt: 'DESC' },
      });

      if (!closedAttendance) {
        logger.warn(`${FC_NAME}: nenhum atendimento fechado encontrado para o cliente`, {
          client_phone: currentAttendance.clientPhone,
          attendance_id,
        });
        return {
          output: 'Não foi encontrado nenhum atendimento fechado anterior para recuperar.',
          data: data as Record<string, unknown>,
          processed: true,
        };
      }

      // Tentar restaurar estado anterior do aiContext
      const aiContext = closedAttendance.aiContext as Record<string, unknown> | undefined;
      const previousState = aiContext?.previousStateBeforeClosing as {
        interventionType?: string;
        sellerSubdivision?: string;
        operationalState?: OperationalState;
      } | undefined;

      // Restaurar interventionType e sellerSubdivision se disponíveis
      let restoredInterventionType: string | null = null;
      let restoredSellerSubdivision: string | null = null;
      let newOperationalState: OperationalState;

      if (previousState) {
        restoredInterventionType = previousState.interventionType || null;
        restoredSellerSubdivision = previousState.sellerSubdivision || null;
        
        // Tentar restaurar o estado operacional anterior, ou inferir
        if (previousState.operationalState && previousState.operationalState !== OperationalState.FECHADO_OPERACIONAL) {
          newOperationalState = previousState.operationalState;
        } else if (closedAttendance.sellerId) {
          // Tinha vendedor atribuído - voltar para EM_ATENDIMENTO
          newOperationalState = OperationalState.EM_ATENDIMENTO;
        } else if (restoredInterventionType) {
          // Tinha interventionType - voltar para ABERTO para aparecer na subdivisão correta
          newOperationalState = OperationalState.ABERTO;
        } else {
          // Caso padrão - voltar para TRIAGEM
          newOperationalState = OperationalState.TRIAGEM;
        }
      } else {
        // Se não há estado anterior salvo, inferir do que temos
        if (closedAttendance.sellerId) {
          newOperationalState = OperationalState.EM_ATENDIMENTO;
          // Se tinha sellerId mas não temos sellerSubdivision salvo, usar padrão
          if (!restoredSellerSubdivision) {
            restoredSellerSubdivision = 'pedidos-orcamentos'; // Padrão comum
          }
        } else {
          // Tentar inferir interventionType de interventionData se disponível
          const interventionData = closedAttendance.interventionData as Record<string, unknown> | undefined;
          if (interventionData) {
            // Se interventionData existe, pode ter sido de algum tipo de intervenção
            // Mas sem interventionType salvo, não podemos saber qual era
            // Vamos deixar null e voltar para TRIAGEM
            newOperationalState = OperationalState.TRIAGEM;
          } else {
            newOperationalState = OperationalState.TRIAGEM;
          }
        }
      }

      // Reabrir o atendimento fechado
      const now = new Date();
      const updateData: any = {
        operationalState: newOperationalState,
        finalizedAt: null, // Limpar finalizedAt
        updatedAt: now, // Atualizar para ser o mais recente
        lastClientMessageAt: now, // Atualizar última mensagem do cliente
        balcaoClosingAt: null, // Limpar timers de fechamento
        ecommerceClosingAt: null,
      };

      // Restaurar interventionType e sellerSubdivision se disponíveis
      if (restoredInterventionType) {
        updateData.interventionType = restoredInterventionType;
      }
      if (restoredSellerSubdivision) {
        updateData.sellerSubdivision = restoredSellerSubdivision;
      }

      await attendanceRepo.update(
        { id: closedAttendance.id },
        updateData
      );

      logger.info(`${FC_NAME}: atendimento reaberto`, {
        closed_attendance_id: closedAttendance.id,
        new_operational_state: newOperationalState,
        client_phone: currentAttendance.clientPhone,
        had_seller: !!closedAttendance.sellerId,
        restored_intervention_type: restoredInterventionType,
        restored_seller_subdivision: restoredSellerSubdivision,
        had_previous_state: !!previousState,
      });

      // Recarregar o atendimento reaberto para obter dados atualizados
      const reopenedAttendance = await attendanceRepo.findOne({
        where: { id: closedAttendance.id },
        relations: ['seller', 'supervisor'],
      });

      if (!reopenedAttendance) {
        logger.error(`${FC_NAME}: erro ao recarregar atendimento reaberto`, {
          closed_attendance_id: closedAttendance.id,
        });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      // Emitir eventos Socket.IO para atualizar o frontend
      try {
        // Remover de "Fechados" e adicionar na subdivisão apropriada
        const eventData = {
          attendanceId: reopenedAttendance.id,
          previousState: OperationalState.FECHADO_OPERACIONAL,
          newState: newOperationalState,
          interventionType: reopenedAttendance.interventionType,
          sellerId: reopenedAttendance.sellerId,
          sellerSubdivision: reopenedAttendance.sellerSubdivision,
          reopenedAt: new Date().toISOString(),
        };

        // Emitir evento de remoção de "Fechados"
        socketService.emitToRoom('supervisors', 'attendance:removed-from-fechados', eventData);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        
        // Emitir evento de adição na subdivisão apropriada
        if (reopenedAttendance.sellerId) {
          // Se tinha vendedor, notificar o vendedor
          socketService.emitToRoom(`seller_${reopenedAttendance.sellerId}`, 'attendance:reopened', eventData);
        } else {
          // Se não tinha vendedor, notificar supervisores (aparece em "Não atribuídos")
          socketService.emitToRoom('supervisors', 'attendance:reopened', eventData);
          invalidateSubdivisionCountsCache();
          socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        }

        logger.info(`${FC_NAME}: eventos Socket.IO emitidos`, {
          attendance_id: reopenedAttendance.id,
          new_state: newOperationalState,
        });
      } catch (e: any) {
        logger.error(`${FC_NAME}: erro ao emitir Socket.IO`, { error: e?.message });
      }

      // IMPORTANTE: Se o atendimento atual (onde a function call foi acionada) é diferente do reaberto,
      // fazer merge: mover todas as mensagens do atual para o reaberto, depois fechar o atual
      if (currentAttendance.id !== closedAttendance.id) {
        logger.info(`${FC_NAME}: fazendo merge - movendo mensagens do atendimento atual para o reaberto`, {
          current_attendance_id: currentAttendance.id,
          reopened_attendance_id: closedAttendance.id,
        });

        // Buscar todas as mensagens do atendimento atual
        const messageRepo = AppDataSource.getRepository(Message);
        const currentMessages = await messageRepo.find({
          where: { attendanceId: currentAttendance.id },
          order: { sentAt: 'ASC' }, // Ordenar por data para manter ordem cronológica
        });

        if (currentMessages.length > 0) {
          logger.info(`${FC_NAME}: movendo ${currentMessages.length} mensagens do atendimento atual para o reaberto`, {
            current_attendance_id: currentAttendance.id,
            reopened_attendance_id: closedAttendance.id,
            message_count: currentMessages.length,
          });

          // Mover todas as mensagens para o atendimento reaberto
          await messageRepo.update(
            { attendanceId: currentAttendance.id },
            { attendanceId: closedAttendance.id } as any
          );

          logger.info(`${FC_NAME}: ${currentMessages.length} mensagens movidas com sucesso`, {
            current_attendance_id: currentAttendance.id,
            reopened_attendance_id: closedAttendance.id,
          });
        }

        // Mover casos abertos do atendimento atual para o reaberto
        const attendanceCaseRepo = AppDataSource.getRepository(AttendanceCase);
        const currentCases = await attendanceCaseRepo.find({
          where: { attendanceId: currentAttendance.id },
        });

        if (currentCases.length > 0) {
          logger.info(`${FC_NAME}: movendo ${currentCases.length} casos do atendimento atual para o reaberto`, {
            current_attendance_id: currentAttendance.id,
            reopened_attendance_id: closedAttendance.id,
            case_count: currentCases.length,
          });

          // Mover todos os casos para o atendimento reaberto
          await attendanceCaseRepo.update(
            { attendanceId: currentAttendance.id },
            { attendanceId: closedAttendance.id } as any
          );

          logger.info(`${FC_NAME}: ${currentCases.length} casos movidos com sucesso`, {
            current_attendance_id: currentAttendance.id,
            reopened_attendance_id: closedAttendance.id,
          });
        }

        // IMPORTANTE: Verificar se o atendimento atual ainda tem mensagens antes de fechar
        // Se não tiver mensagens, pode ser que já foram movidas ou nunca existiram
        const remainingMessages = await messageRepo.count({
          where: { attendanceId: currentAttendance.id },
        });

        // Se não tem mensagens, deletar o atendimento ao invés de apenas fechar
        // Isso evita que apareça em "Fechados" sem conteúdo
        if (remainingMessages === 0) {
          logger.info(`${FC_NAME}: atendimento atual sem mensagens após merge - deletando ao invés de fechar`, {
            current_attendance_id: currentAttendance.id,
            reopened_attendance_id: closedAttendance.id,
          });

          // Deletar o atendimento vazio (casos já foram movidos)
          await attendanceRepo.delete({ id: currentAttendance.id });

          // Emitir evento de remoção (não precisa aparecer em "Fechados")
          try {
            socketService.emitToRoom('supervisors', 'attendance:removed', {
              attendanceId: currentAttendance.id,
              reason: 'Deletado após merge - atendimento vazio',
              mergedInto: closedAttendance.id,
            });
            invalidateSubdivisionCountsCache();
            socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
          } catch (e: any) {
            logger.warn(`${FC_NAME}: erro ao emitir evento de remoção do atendimento vazio`, { error: e?.message });
          }
        } else {
          // Se ainda tem mensagens (não deveria acontecer após mover), fechar normalmente
          logger.warn(`${FC_NAME}: atendimento atual ainda tem ${remainingMessages} mensagens após mover - fechando normalmente`, {
            current_attendance_id: currentAttendance.id,
            reopened_attendance_id: closedAttendance.id,
          });

          await attendanceRepo.update(
            { id: currentAttendance.id },
            {
              operationalState: OperationalState.FECHADO_OPERACIONAL,
              finalizedAt: new Date(),
              balcaoClosingAt: null,
              ecommerceClosingAt: null,
            } as any
          );

          // Emitir eventos de fechamento
          try {
            const closeEventData = {
              attendanceId: currentAttendance.id,
              reason: 'Fechado ao reabrir atendimento anterior (merge realizado)',
              closedAt: new Date().toISOString(),
            };

            socketService.emitToRoom('supervisors', 'attendance:moved-to-fechados', closeEventData);
            socketService.emitToRoom('supervisors', 'attendance:removed', {
              attendanceId: currentAttendance.id,
              reason: 'Merge realizado - atendimento consolidado',
              mergedInto: closedAttendance.id,
            });
            invalidateSubdivisionCountsCache();
            socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
          } catch (e: any) {
            logger.warn(`${FC_NAME}: erro ao emitir eventos de fechamento`, { error: e?.message });
          }
        }

        logger.info(`${FC_NAME}: atendimento atual processado após merge`, {
          current_attendance_id: currentAttendance.id,
          reopened_attendance_id: closedAttendance.id,
          was_deleted: remainingMessages === 0,
        });

        // Emitir eventos para remover o atual de "Não atribuídos" ou "Atribuídos"
        try {
          const closeEventData = {
            attendanceId: currentAttendance.id,
            reason: 'Fechado ao reabrir atendimento anterior (merge realizado)',
            closedAt: new Date().toISOString(),
          };

          // Emitir evento de fechamento (para remover da lista)
          socketService.emitToRoom('supervisors', 'attendance:moved-to-fechados', closeEventData);
          invalidateSubdivisionCountsCache();
          socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

          // Emitir evento adicional de remoção explícita (para garantir remoção da UI)
          socketService.emitToRoom('supervisors', 'attendance:removed', {
            attendanceId: currentAttendance.id,
            reason: 'Merge realizado - atendimento consolidado',
            mergedInto: closedAttendance.id,
          });
          invalidateSubdivisionCountsCache();
          socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

          // Se tinha vendedor, também notificar o vendedor
          if (currentAttendance.sellerId) {
            socketService.emitToRoom(`seller_${currentAttendance.sellerId}`, 'attendance:moved-to-fechados', closeEventData);
            socketService.emitToRoom(`seller_${currentAttendance.sellerId}`, 'attendance:removed', {
              attendanceId: currentAttendance.id,
              reason: 'Merge realizado - atendimento consolidado',
              mergedInto: closedAttendance.id,
            });
          }

          logger.info(`${FC_NAME}: eventos Socket.IO emitidos para remover atendimento atual`, {
            current_attendance_id: currentAttendance.id,
            reopened_attendance_id: closedAttendance.id,
          });
        } catch (e: any) {
          logger.warn(`${FC_NAME}: erro ao emitir evento de fechamento do atendimento atual`, { error: e?.message });
        }
      }

    } catch (err: any) {
      logger.error(`${FC_NAME}: erro ao processar`, {
        error: err?.message,
        stack: err?.stack,
        attendance_id,
        client_phone,
      });
    }

    // Retornar o novo attendanceId se houve merge (para que a resposta da IA seja salva no atendimento correto)
    const returnData: Record<string, unknown> = {
      ...(data as Record<string, unknown>),
      client_phone,
    };

    // Se houve merge e o atendimento atual foi fechado/deletado, retornar o ID do atendimento reaberto
    if (currentAttendance && closedAttendance && currentAttendance.id !== closedAttendance.id) {
      returnData.newAttendanceId = closedAttendance.id;
      returnData.originalAttendanceId = currentAttendance.id;
      logger.info(`${FC_NAME}: retornando novo attendanceId após merge`, {
        original_attendance_id: currentAttendance.id,
        new_attendance_id: closedAttendance.id,
      });
    }

    return {
      output: null,
      data: returnData,
      processed: true,
    };
  };
}
