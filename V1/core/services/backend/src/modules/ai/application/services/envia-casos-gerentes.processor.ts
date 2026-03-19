import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const FC_NAME = 'enviacasosgerentes';
const INTERVENTION_TYPE = 'casos_gerentes';
const AI_DISABLED_HOURS = 10;

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador para enviacasosgerentes.
 * Quando acionada: anexa as informações coletadas ao card do cliente (interventionData)
 * e desativa a IA por 10 horas (aiDisabledUntil) para esse atendimento.
 */
export function createEnviaCasosGerentesProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result) as Record<string, unknown>;
    const data = (parsed?.data as Record<string, unknown>) ?? parsed;

    try {
      const attendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      if (!attendance) {
        logger.error(`${FC_NAME}: attendance não encontrado`, { attendance_id });
        return { output: null, data: { ...(data as Record<string, unknown>), client_phone }, processed: true };
      }

      const interventionData = { ...(data as Record<string, unknown>), client_phone } as Record<string, unknown>;

      const tenHoursFromNow = new Date();
      tenHoursFromNow.setHours(tenHoursFromNow.getHours() + AI_DISABLED_HOURS);

      await attendanceRepo.update(
        { id: attendance_id },
        {
          interventionType: INTERVENTION_TYPE,
          interventionData,
          aiDisabledUntil: tenHoursFromNow,
        } as any
      );

      logger.info(`${FC_NAME}: informações anexadas ao card e IA desativada por ${AI_DISABLED_HOURS}h`, {
        attendance_id,
        client_phone,
        aiDisabledUntil: tenHoursFromNow.toISOString(),
      });

      const eventPayload = {
        attendanceId: attendance_id,
        interventionType: INTERVENTION_TYPE,
        interventionData,
        aiDisabledUntil: tenHoursFromNow.toISOString(),
      };

      try {
        socketService.emitToRoom('supervisors', 'attendance:moved-to-intervention', eventPayload);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        if (attendance.sellerId) {
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance:moved-to-intervention', eventPayload);
        }
        logger.info(`${FC_NAME}: attendance:moved-to-intervention emitido via Socket.IO (tempo real)`);
      } catch (e: any) {
        logger.error(`${FC_NAME}: erro ao emitir Socket.IO`, { error: e?.message });
      }

      if (redisService.isConnected()) {
        try {
          await redisService.publish('attendance:intervention-assigned', JSON.stringify(eventPayload));
          logger.info(`${FC_NAME}: evento publicado no Redis`);
        } catch (e: any) {
          logger.error(`${FC_NAME}: erro ao publicar Redis`, { error: e?.message });
        }
      }

      return { output: null, data: interventionData, processed: true };
    } catch (err: any) {
      logger.error(`${FC_NAME}: erro ao processar`, {
        error: err?.message,
        stack: err?.stack,
        attendance_id,
        client_phone,
      });
      return {
        output: null,
        data: { ...(data as Record<string, unknown>), client_phone, error: err?.message },
        processed: true,
      };
    }
  };
}
