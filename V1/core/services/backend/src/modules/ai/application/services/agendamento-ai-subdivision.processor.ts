import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { AiSchedulingEvent } from '../../../attendance/domain/entities/ai-scheduling-event.entity';
import { buildAgendamentoTimerContext } from '../../../attendance/domain/utils/agendamento-auto-close.util';
import { logger } from '../../../../shared/utils/logger';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';
import type { AiInterestSubdivision } from './interesse-ai-subdivision.processor';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Regista um agendamento (FC agendamento_*) para estatísticas: percentual = interesses / chamadas agendamento.
 */
export function createAgendamentoAiSubdivisionProcessor(
  serviceKey: AiInterestSubdivision
): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);
  const eventRepo = AppDataSource.getRepository(AiSchedulingEvent);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result);
    const data = ((parsed?.data as Record<string, unknown>) ?? parsed) as Record<string, unknown>;

    try {
      const attendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      if (!attendance) {
        logger.error(`agendamento-ai: attendance não encontrado`, { attendance_id, serviceKey });
        return { output: null, data: { ...data, client_phone }, processed: true };
      }

      const row = eventRepo.create({
        attendanceId: attendance_id as any,
        serviceKey,
      });
      await eventRepo.save(row);

      attendance.aiContext = buildAgendamentoTimerContext(
        attendance.aiContext as Record<string, unknown> | undefined,
        serviceKey
      );
      await attendanceRepo.save(attendance);

      logger.info(`agendamento-ai: evento registado e timer de fechamento 30min iniciado`, {
        attendance_id,
        serviceKey,
        agendamentoAutoCloseAt: (attendance.aiContext as Record<string, unknown>).agendamentoAutoCloseAt,
      });
    } catch (err: any) {
      logger.error(`agendamento-ai: erro ao persistir evento`, {
        error: err?.message,
        attendance_id,
        serviceKey,
      });
    }

    return {
      output: null,
      data: { ...data, client_phone, serviceKey },
      processed: true,
    };
  };
}
