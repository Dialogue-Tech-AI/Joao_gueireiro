import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const FC_NAME = 'alocagerentes';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador específico para alocagerentes.
 * Quando acionada, identifica qual das três opções está true (troca, garantia ou estorno)
 * e move o atendimento para a subdivisão correspondente em "Intervenção humana".
 * Adiciona as informações do resumo no interventionData (aparece no card da direita).
 */
export function createAlocaGerentesProcessor(): FunctionCallProcessorHandler {
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

      // Identificar qual das três opções está true
      // Aceita: (1) campos booleanos troca/garantia/estorno ou (2) campo combinado "estorno ou garantia" com valor "garantia" ou "estorno"
      const estornoOuGarantiaRaw = data['estorno ou garantia'] ?? data['estorno_ou_garantia'] ?? (parsed as any)['estorno ou garantia'];
      const estornoOuGarantia = typeof estornoOuGarantiaRaw === 'string' ? estornoOuGarantiaRaw.trim().toLowerCase() : '';

      const troca = Boolean(
        (data.troca && data.troca !== '') ||
        data.Troca ||
        data.TROCA ||
        (data['troca'] && data['troca'] !== '') ||
        (parsed as any).troca
      );

      const garantia = Boolean(
        data.garantia ||
        data.Garantia ||
        data.GARANTIA ||
        data['garantia'] ||
        (parsed as any).garantia ||
        estornoOuGarantia === 'garantia'
      );

      const estorno = Boolean(
        data.estorno ||
        data.Estorno ||
        data.ESTORNO ||
        data['estorno'] ||
        (parsed as any).estorno ||
        estornoOuGarantia === 'estorno'
      );

      // Validar que exatamente uma opção está true
      const trueCount = [troca, garantia, estorno].filter(Boolean).length;
      if (trueCount !== 1) {
        logger.error(`${FC_NAME}: deve haver exatamente uma opção true (troca, garantia ou estorno)`, {
          attendance_id,
          client_phone,
          troca,
          garantia,
          estorno,
          trueCount,
          data,
        });
        return {
          output: null,
          data: { ...(data as Record<string, unknown>), client_phone, error: 'Deve haver exatamente uma opção true (troca, garantia ou estorno)' },
          processed: true,
        };
      }

      // Determinar o interventionType baseado na opção true
      let interventionType: string;
      let interventionLabel: string;
      
      if (troca) {
        interventionType = 'troca';
        interventionLabel = 'Troca';
      } else if (garantia) {
        interventionType = 'garantia';
        interventionLabel = 'Garantia';
      } else {
        interventionType = 'estorno';
        interventionLabel = 'Estorno';
      }

      logger.info(`${FC_NAME}: alocando atendimento para ${interventionLabel}`, {
        attendance_id,
        client_phone,
        interventionType,
        troca,
        garantia,
        estorno,
      });

      // Verificar se já está na subdivisão correta
      if (attendance.interventionType === interventionType) {
        logger.info(`${FC_NAME}: atendimento já está em ${interventionLabel}, atualizando apenas interventionData`, {
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
        interventionType,
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
      logger.info(`${FC_NAME}: atendimento movido para ${interventionLabel} (Intervenção humana)`, {
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
        interventionType,
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
      logger.error(`${FC_NAME}: erro ao alocar atendimento para gerentes`, {
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

    return {
      output: null,
      data: { ...(data as Record<string, unknown>), client_phone },
      processed: true,
    };
  };
}
