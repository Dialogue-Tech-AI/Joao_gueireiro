import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { AttendanceCase } from '../../../attendance/domain/entities/attendance-case.entity';
import { CaseType } from '../../../attendance/domain/entities/case-type.entity';
import { CaseStatus } from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';
import { canCreateNewCase } from './case-creation.utils';

const FC_NAME = 'registrarposvendatelefonefixo';
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
 * Processador para registrarposvendatelefonefixo.
 * Marca o atendimento como "Demanda telefone fixo" (intervention_type) e grava
 * os dados coletados (intervention_data). O atendimento deixa de aparecer em
 * "Não atribuídos" e passa a ser listado em "Demanda telefone fixo" (Intervenção humana).
 */
export function createRegistrarPosVendaTelefoneFixoProcessor(): FunctionCallProcessorHandler {
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
        logger.error('registrarposvendatelefonefixo: attendance não encontrado', { attendance_id });
        return { output: null, data: { ...(data as Record<string, unknown>), client_phone }, processed: true };
      }

      const caseType = await caseTypeRepo.findOne({ where: { key: 'pos_venda', isActive: true } });
      if (caseType) {
        const canCreate = await canCreateNewCase(attendance_id, caseType.id, attendance.interventionType ?? undefined);
        if (canCreate) {
          const newCase = attendanceCaseRepo.create({
            attendanceId: attendance_id,
            caseTypeId: caseType.id,
            status: CaseStatus.NOVO,
            title: 'Pós-venda Telefone Fixo',
          });
          await attendanceCaseRepo.save(newCase);
        }
      }

      await attendanceRepo.update(
        { id: attendance_id },
        {
          interventionType: INTERVENTION_TYPE,
          interventionData: data as object,
        } as any
      );

      logger.info('registrarposvendatelefonefixo: atendimento marcado como Demanda telefone fixo', {
        attendance_id,
        client_phone,
      });

      // Publicar no Redis para notificação em tempo real
      const redisConnected = redisService.isConnected();
      logger.info('registrarposvendatelefonefixo: verificando conexão Redis', {
        attendance_id,
        redisConnected,
      });

      if (redisConnected) {
        try {
          const payload = {
            attendanceId: attendance_id,
            interventionType: INTERVENTION_TYPE,
            interventionData: data as Record<string, unknown>,
          };
          await redisService.publish(
            'attendance:intervention-assigned',
            JSON.stringify(payload)
          );
          logger.info('registrarposvendatelefonefixo: publicado no Redis com sucesso', {
            attendance_id,
            channel: 'attendance:intervention-assigned',
            payload,
          });
          invalidateSubdivisionCountsCache();
          socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        } catch (pubErr: any) {
          logger.error('registrarposvendatelefonefixo: ERRO ao publicar no Redis', {
            error: pubErr?.message,
            stack: pubErr?.stack,
            attendance_id,
          });
        }
      } else {
        logger.error('registrarposvendatelefonefixo: Redis NÃO CONECTADO - roteamento em tempo real não funcionará', {
          attendance_id,
          client_phone,
        });
      }
    } catch (err: any) {
      logger.error('registrarposvendatelefonefixo: erro ao atualizar attendance', {
        error: err?.message,
        attendance_id,
      });
    }

    return {
      output: null,
      data: { ...(data as Record<string, unknown>), client_phone },
      processed: true,
    };
  };
}
