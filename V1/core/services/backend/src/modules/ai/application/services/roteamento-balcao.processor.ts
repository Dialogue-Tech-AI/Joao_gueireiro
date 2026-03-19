import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const INTERVENTION_TYPE = 'encaminhados-balcao';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador para roteamentobalcao.
 * Marca o atendimento como "Encaminhados Balcão" (intervention_type), grava
 * os dados coletados (intervention_data) e emite as mesmas notificações do sistema
 * (Socket.IO + Redis) para tempo real, badges e notificações vermelhas.
 */
export function createRoteamentoBalcaoProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result) as Record<string, unknown>;
    const data = (parsed?.data as Record<string, unknown>) ?? parsed;

    try {
      const attendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      if (!attendance) {
        logger.error('roteamentobalcao: attendance não encontrado', { attendance_id });
        return { output: null, data: { ...(data as Record<string, unknown>), client_phone }, processed: true };
      }

      const interventionData = { ...(data as Record<string, unknown>), client_phone } as Record<string, unknown>;
      await attendanceRepo.update(
        { id: attendance_id },
        { interventionType: INTERVENTION_TYPE, interventionData } as any
      );

      logger.info('roteamentobalcao: atendimento marcado como Encaminhados Balcão', {
        attendance_id,
        client_phone,
      });

      const eventPayload = {
        attendanceId: attendance_id,
        interventionType: INTERVENTION_TYPE,
        interventionData,
      };

      try {
        socketService.emitToRoom('supervisors', 'attendance:moved-to-intervention', eventPayload);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        logger.info('roteamentobalcao: attendance:moved-to-intervention emitido via Socket.IO (tempo real)');
      } catch (e: any) {
        logger.error('roteamentobalcao: erro ao emitir Socket.IO', { error: e?.message });
      }

      if (redisService.isConnected()) {
        try {
          await redisService.publish(
            'attendance:intervention-assigned',
            JSON.stringify(eventPayload)
          );
          logger.info('roteamentobalcao: publicado no Redis attendance:intervention-assigned');
        } catch (e: any) {
          logger.error('roteamentobalcao: erro ao publicar Redis', { error: e?.message });
        }
      }
    } catch (err: any) {
      logger.error('roteamentobalcao: erro ao atualizar attendance', {
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
