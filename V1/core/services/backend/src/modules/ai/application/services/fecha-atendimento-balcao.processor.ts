import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { FunctionCallConfig } from '../../domain/entities/function-call-config.entity';
import { logger } from '../../../../shared/utils/logger';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const FC_NAME = 'fechaatendimentobalcao';
const DEFAULT_TEMPO_FECHAMENTO_MIN = 30; // 30 minutos padrão

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador para fechaatendimentobalcao.
 * Inicia o timer de fechamento automático para atendimentos de balcão.
 * O timer é configurável no painel (campo tempo_fechamento_balcao em custom_attributes).
 * Quando o timer expira (verificado pelo job de inatividade), o atendimento é movido para Fechados.
 */
export function createFechaAtendimentoBalcaoProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);
  const fcConfigRepo = AppDataSource.getRepository(FunctionCallConfig);

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

      // Buscar config da FC para obter tempo_fechamento_balcao
      let tempoFechamentoMinutos = DEFAULT_TEMPO_FECHAMENTO_MIN;
      try {
        const fcConfig = await fcConfigRepo.findOne({ where: { functionCallName: FC_NAME } });
        if (fcConfig) {
          // Tentar ler de custom_attributes ou metadata
          const customAttrs = fcConfig.customAttributes as Record<string, unknown> | undefined;
          const metadata = fcConfig.metadata as Record<string, unknown> | undefined;
          
          const tempoFromCustom = customAttrs?.tempo_fechamento_balcao;
          const tempoFromMeta = metadata?.tempo_fechamento_balcao;
          
          const tempoRaw = tempoFromCustom ?? tempoFromMeta;
          if (tempoRaw !== undefined && tempoRaw !== null) {
            const tempoNum = Number(tempoRaw);
            if (!isNaN(tempoNum) && tempoNum >= 1 && tempoNum <= 60) {
              tempoFechamentoMinutos = tempoNum;
            }
          }
        }
      } catch (e: any) {
        logger.warn(`${FC_NAME}: erro ao buscar config, usando padrão ${DEFAULT_TEMPO_FECHAMENTO_MIN}min`, { error: e?.message });
      }

      // Calcular balcaoClosingAt = now + tempo
      const now = new Date();
      const balcaoClosingAt = new Date(now.getTime() + tempoFechamentoMinutos * 60 * 1000);

      // Atualizar attendance com o timer
      await attendanceRepo.update(
        { id: attendance_id },
        { balcaoClosingAt } as any
      );

      logger.info(`${FC_NAME}: timer de fechamento iniciado`, {
        attendance_id,
        client_phone,
        tempoFechamentoMinutos,
        balcaoClosingAt: balcaoClosingAt.toISOString(),
      });

      // Emitir evento para o frontend (pode exibir countdown se quiser)
      const eventPayload = {
        attendanceId: attendance_id,
        balcaoClosingAt: balcaoClosingAt.toISOString(),
        tempoFechamentoMinutos,
      };

      try {
        socketService.emitToRoom('supervisors', 'attendance:balcao-timer-started', eventPayload);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        logger.info(`${FC_NAME}: attendance:balcao-timer-started emitido via Socket.IO`);
      } catch (e: any) {
        logger.error(`${FC_NAME}: erro ao emitir Socket.IO`, { error: e?.message });
      }

    } catch (err: any) {
      logger.error(`${FC_NAME}: erro ao processar`, {
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
