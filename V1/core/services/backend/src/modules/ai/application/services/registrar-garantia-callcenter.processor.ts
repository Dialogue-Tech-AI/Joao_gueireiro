import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { AttendanceCase } from '../../../attendance/domain/entities/attendance-case.entity';
import { CaseType } from '../../../attendance/domain/entities/case-type.entity';
import { CaseStatus } from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';
import { canCreateNewCase } from './case-creation.utils';

const FC_NAME = 'registrargarantiacallcenter';
const INTERVENTION_TYPE = 'garantia';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador para registrargarantiacallcenter.
 * Roteia o cliente da triagem para a subdivisão "Garantia" em Intervenção humana.
 * Armazena os dados coletados em intervention_data e emite Socket.IO + Redis para tempo real.
 */
export function createRegistrarGarantiaCallCenterProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);
  const caseTypeRepo = AppDataSource.getRepository(CaseType);
  const attendanceCaseRepo = AppDataSource.getRepository(AttendanceCase);

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

      const caseType = await caseTypeRepo.findOne({ where: { key: 'garantia', isActive: true } });
      if (caseType) {
        const canCreate = await canCreateNewCase(attendance_id, caseType.id, attendance.interventionType ?? undefined);
        if (canCreate) {
          const newCase = attendanceCaseRepo.create({
            attendanceId: attendance_id,
            caseTypeId: caseType.id,
            status: CaseStatus.NOVO,
            title: 'Garantia',
          });
          await attendanceCaseRepo.save(newCase);
        }
      }

      const interventionData = { ...(data as Record<string, unknown>), client_phone } as Record<string, unknown>;
      await attendanceRepo.update(
        { id: attendance_id },
        { interventionType: INTERVENTION_TYPE, interventionData } as any
      );

      logger.info(`${FC_NAME}: atendimento roteado para Garantia (Intervenção humana)`, {
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
        logger.info(`${FC_NAME}: attendance:moved-to-intervention emitido via Socket.IO (tempo real)`);
      } catch (e: any) {
        logger.error(`${FC_NAME}: erro ao emitir Socket.IO`, { error: e?.message });
      }

      if (redisService.isConnected()) {
        try {
          await redisService.publish('attendance:intervention-assigned', JSON.stringify(eventPayload));
          logger.info(`${FC_NAME}: publicado no Redis attendance:intervention-assigned`);
        } catch (e: any) {
          logger.error(`${FC_NAME}: erro ao publicar Redis`, { error: e?.message });
        }
      }
    } catch (err: any) {
      logger.error(`${FC_NAME}: erro ao atualizar attendance`, {
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
