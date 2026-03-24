import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

export type AiInterestSubdivision = 'flash-day' | 'locacao-estudio' | 'captacao-videos';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

function pickSummary(data: Record<string, unknown>): string | undefined {
  const keys = [
    'resumo-da-conversa',
    'resumo_conversa',
    'resumoConversa',
    'conversation_summary',
    'resumo',
    'summary',
    'interesseConversationSummary',
  ];
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function pickQuestions(data: Record<string, unknown>): string | string[] | undefined {
  const keys = [
    'perguntas-do-cliente',
    'perguntas_cliente',
    'perguntasCliente',
    'client_questions',
    'perguntas',
    'interesseClientQuestions',
  ];
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v)) {
      const arr = v.map((x) => String(x ?? '').trim()).filter(Boolean);
      if (arr.length) return arr;
    }
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Quando a IA aciona interesse (Flash day, Locação de estúdio, Captação de vídeos),
 * move o atendimento para a subdivisão AI correspondente (ai_context.ai_subdivision)
 * e grava resumo + perguntas para o painel do supervisor.
 */
export function createInteresseAiSubdivisionProcessor(
  aiSubdivision: AiInterestSubdivision
): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result);
    const data = ((parsed?.data as Record<string, unknown>) ?? parsed) as Record<string, unknown>;

    const summary = pickSummary(data);
    const questions = pickQuestions(data);

    try {
      const attendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      if (!attendance) {
        logger.error(`interesse-ai: attendance não encontrado`, { attendance_id, aiSubdivision });
        return { output: null, data: { ...data, client_phone }, processed: true };
      }

      if (attendance.operationalState === 'FECHADO_OPERACIONAL') {
        logger.warn(`interesse-ai: atendimento fechado, ignorando`, { attendance_id, aiSubdivision });
        return { output: null, data: { ...data, client_phone }, processed: true };
      }

      const nextCtx: Record<string, unknown> = {
        ...(attendance.aiContext ?? {}),
        ai_subdivision: aiSubdivision,
      };
      if (summary !== undefined) nextCtx.interesseConversationSummary = summary;
      if (questions !== undefined) nextCtx.interesseClientQuestions = questions;

      await attendanceRepo.update({ id: attendance_id }, { aiContext: nextCtx as any });

      const unassignedSource =
        aiSubdivision === 'flash-day'
          ? 'ai-flash-day'
          : aiSubdivision === 'locacao-estudio'
            ? 'ai-locacao-estudio'
            : 'ai-captacao-videos';

      const socketPayload = {
        attendanceId: attendance_id,
        unassignedSource,
        aiContext: {
          ai_subdivision: aiSubdivision,
          interesseConversationSummary: summary,
          interesseClientQuestions: questions,
        },
      };

      try {
        socketService.emitToRoom('supervisors', 'attendance:ai-subdivision-updated', socketPayload);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        logger.info(`interesse-ai: subdivisão AI atualizada`, { attendance_id, aiSubdivision, unassignedSource });
      } catch (e: any) {
        logger.error(`interesse-ai: erro Socket.IO`, { error: e?.message });
      }

      if (redisService.isConnected()) {
        try {
          await redisService.publish('attendance:ai-subdivision-updated', JSON.stringify(socketPayload));
        } catch (e: any) {
          logger.error(`interesse-ai: erro Redis`, { error: e?.message });
        }
      }
    } catch (err: any) {
      logger.error(`interesse-ai: erro ao persistir`, {
        error: err?.message,
        attendance_id,
        aiSubdivision,
      });
    }

    return {
      output: null,
      data: { ...data, client_phone, ai_subdivision: aiSubdivision },
      processed: true,
    };
  };
}
