import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const FC_NAME = 'alocafixo';
const INTERVENTION_TYPE = 'demanda-telefone-fixo';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador específico para alocafixo.
 * Quando acionada, move o atendimento para a subdivisão
 * "Intervenção humana" → "Demanda telefone fixo" (interventionType = demanda-telefone-fixo).
 * Adiciona as informações do resumo no interventionData (aparece no card da direita).
 */
export function createAlocaFixoProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result) as Record<string, unknown>;
    const data = (parsed?.data as Record<string, unknown>) ?? parsed;

    try {
      const attendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      if (!attendance) {
        logger.error(`${FC_NAME}: attendance não encontrado`, { attendance_id });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      // Verificar se já está na subdivisão correta
      if (attendance.interventionType === INTERVENTION_TYPE) {
        logger.info(`${FC_NAME}: atendimento já está em Demanda telefone fixo, atualizando apenas interventionData`, {
          attendance_id,
          client_phone,
        });
      }

      // Preparar interventionData com os dados do resumo
      const interventionData = { ...(data as Record<string, unknown>), client_phone } as Record<string, unknown>;

      // Atualizar attendance: definir interventionType e interventionData
      // IMPORTANTE: Não alterar operationalState se já estiver definido (pode estar em TRIAGEM, ABERTO, etc.)
      // Apenas garantir que não seja FECHADO_OPERACIONAL
      const updateData: any = {
        interventionType: INTERVENTION_TYPE,
        interventionData,
      };

      // Se o attendance estiver fechado, não fazer nada (não deve aparecer em não atribuídos/intervenção)
      if (attendance.operationalState === 'FECHADO_OPERACIONAL') {
        logger.warn(`${FC_NAME}: atendimento está fechado, não será realocado`, {
          attendance_id,
          client_phone,
          operationalState: attendance.operationalState,
        });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      await attendanceRepo.update(
        { id: attendance_id },
        updateData
      );

      // Verificar se o update foi persistido
      const updatedAttendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      logger.info(`${FC_NAME}: atendimento movido para Demanda telefone fixo`, {
        attendance_id,
        client_phone,
        interventionType: updatedAttendance?.interventionType,
        operationalState: updatedAttendance?.operationalState,
        sellerId: updatedAttendance?.sellerId,
        hasInterventionData: !!updatedAttendance?.interventionData,
      });

      // Emitir eventos para atualizar o frontend em tempo real
      const socketPayload = {
        attendanceId: attendance_id,
        interventionType: INTERVENTION_TYPE,
        interventionData,
      };

      try {
        socketService.emitToRoom('supervisors', 'attendance:moved-to-intervention', socketPayload);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        logger.info(`${FC_NAME}: attendance:moved-to-intervention emitido via Socket.IO (tempo real)`);
      } catch (e: any) {
        logger.error(`${FC_NAME}: erro ao emitir Socket.IO`, { error: e?.message });
      }

      if (redisService.isConnected()) {
        try {
          await redisService.publish(
            'attendance:intervention-assigned',
            JSON.stringify(socketPayload)
          );
          logger.info(`${FC_NAME}: evento publicado no Redis`);
        } catch (e: any) {
          logger.error(`${FC_NAME}: erro ao publicar Redis`, { error: e?.message });
        }
      }
    } catch (err: any) {
      logger.error(`${FC_NAME}: erro ao mover atendimento para Demanda telefone fixo`, {
        error: err?.message,
        attendance_id,
        client_phone,
      });
    }

    return {
      output: null,
      data: { ...(data as Record<string, unknown>), client_phone },
      processed: true,
    };
  };
}

