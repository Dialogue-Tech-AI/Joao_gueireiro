import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const INTERVENTION_TYPE = 'outros-assuntos';
/** IA pausada para o cliente após roteamento para intervenção humana (Outros assuntos) */
const AI_DISABLED_HOURS_AFTER_ROUTING = 1;

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Move atendimento para Intervenção Humana > Outros assuntos.
 * Mantém o atendimento ativo e dispara eventos para atualizar cards/badges/estatísticas.
 */
export function createAlocaOutrosAssuntosProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { function_call_name, result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result) as Record<string, unknown>;
    const data = (parsed?.data as Record<string, unknown>) ?? parsed;

    try {
      const attendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      if (!attendance) {
        logger.error(`${function_call_name}: attendance nao encontrado`, { attendance_id });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      if (attendance.operationalState === 'FECHADO_OPERACIONAL') {
        logger.warn(`${function_call_name}: atendimento fechado, realocacao ignorada`, {
          attendance_id,
          client_phone,
          operationalState: attendance.operationalState,
        });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      const interventionData = { ...(data as Record<string, unknown>), client_phone } as Record<string, unknown>;

      const aiDisabledUntil = new Date(Date.now() + AI_DISABLED_HOURS_AFTER_ROUTING * 60 * 60 * 1000);

      // Sai da fila AI (não classificados / subdivisões) e vai para Intervenção humana > Outros assuntos
      attendance.interventionType = INTERVENTION_TYPE;
      attendance.interventionData = interventionData as any;
      attendance.aiDisabledUntil = aiDisabledUntil;
      attendance.aiContext = {
        ...(attendance.aiContext ?? {}),
        ai_subdivision: null,
      };

      await attendanceRepo.save(attendance);

      const updatedAttendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      logger.info(`${function_call_name}: atendimento movido para intervencao outros assuntos`, {
        attendance_id,
        client_phone,
        interventionType: updatedAttendance?.interventionType,
        operationalState: updatedAttendance?.operationalState,
        sellerId: updatedAttendance?.sellerId,
        hasInterventionData: !!updatedAttendance?.interventionData,
      });

      const socketPayload = {
        attendanceId: attendance_id,
        interventionType: INTERVENTION_TYPE,
        interventionData,
        aiDisabledUntil: aiDisabledUntil.toISOString(),
      };

      try {
        socketService.emitToRoom('supervisors', 'attendance:moved-to-intervention', socketPayload);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        if (updatedAttendance?.sellerId) {
          socketService.emitToRoom(`seller_${updatedAttendance.sellerId}`, 'attendance:moved-to-intervention', socketPayload);
        }
      } catch (e: any) {
        logger.error(`${function_call_name}: erro ao emitir Socket.IO`, { error: e?.message });
      }

      if (redisService.isConnected()) {
        try {
          await redisService.publish('attendance:intervention-assigned', JSON.stringify(socketPayload));
        } catch (e: any) {
          logger.error(`${function_call_name}: erro ao publicar Redis`, { error: e?.message });
        }
      }
    } catch (err: any) {
      logger.error(`${function_call_name}: erro ao mover para outros assuntos`, {
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
