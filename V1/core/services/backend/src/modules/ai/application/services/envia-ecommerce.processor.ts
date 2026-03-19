import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { FunctionCallConfig } from '../../domain/entities/function-call-config.entity';
import { FunctionCallConfigService } from './function-call-config.service';
import { whatsappManagerService } from '../../../whatsapp/application/services/whatsapp-manager.service';
import { logger } from '../../../../shared/utils/logger';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const FC_NAME = 'enviaecommerce';
const CUSTOM_ATTR_ECOMMERCE_NUMBER = 'contato_ecommerce';
const CUSTOM_ATTR_TEMPO_FECHAMENTO = 'tempo_fechamento_ecommerce';
const DEFAULT_TEMPO_FECHAMENTO_MIN = 30; // 30 minutos padrão
const MIN_TEMPO_MINUTOS = 1; // Mínimo 1 minuto
const MAX_TEMPO_MINUTOS = 60; // Máximo 1 hora
const INTERVENTION_TYPE = 'encaminhados-ecommerce';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

function formatMessage(
  data: Record<string, unknown>,
  clientPhone: string
): string {
  const lines: string[] = [
    '——— *Informações para Contato E-commerce* ———',
    '',
    `*WhatsApp do cliente:* ${clientPhone}`,
    '',
  ];

  // Adicionar todos os dados disponíveis
  lines.push('*Informações do atendimento:*');
  const ignore = new Set(['raw']);
  for (const [key, value] of Object.entries(data)) {
    if (ignore.has(key) || value == null || String(value).trim() === '') continue;
    lines.push(`• ${key}: ${value}`);
  }

  lines.push('');
  lines.push('*Instruções:*');
  lines.push('• Entre em contato com o cliente pelo WhatsApp informado acima');
  lines.push('• Resolva a questão do cliente');
  lines.push('• O atendimento será fechado automaticamente após o tempo configurado de inatividade');
  lines.push('');
  lines.push('——— Fim das informações ———');
  return lines.join('\n');
}

/**
 * Processador específico para enviaecommerce.
 * Quando acionada:
 * 1. Envia todas as informações que o e-commerce precisa para o número configurado
 * 2. Verifica se o atendimento já está em "Encaminhados e-commerce"
 * 3. Se não estiver, realoca o atendimento para "Encaminhados e-commerce" e anexa informações no card da direita
 * 4. Inicia um timer configurável (1 min a 1 hora) via atributos personalizados
 * 5. O timer reseta sempre que o cliente enviar uma mensagem nesse atendimento
 * 6. Quando o timer zerar, o atendimento é fechado automaticamente
 */
export function createEnviaEcommerceProcessor(): FunctionCallProcessorHandler {
  const configService = new FunctionCallConfigService();
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
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      // Buscar config da FC para obter número do e-commerce e tempo de fechamento
      const config = await configService.getByFunctionCallName(FC_NAME);
      const ecommerceNumber = config?.customAttributes?.[CUSTOM_ATTR_ECOMMERCE_NUMBER];
      const num = typeof ecommerceNumber === 'string' ? ecommerceNumber.trim() : '';

      if (!num) {
        logger.warn(`${FC_NAME}: contato_ecommerce não configurado em Atributos Personalizados. Não será enviado ao e-commerce.`);
        return {
          output: null,
          data: data as Record<string, unknown>,
          processed: true,
        };
      }

      // Buscar tempo de fechamento (1 min a 1 hora)
      let tempoFechamentoMinutos = DEFAULT_TEMPO_FECHAMENTO_MIN;
      try {
        const fcConfig = await fcConfigRepo.findOne({ where: { functionCallName: FC_NAME } });
        if (fcConfig) {
          const customAttrs = fcConfig.customAttributes as Record<string, unknown> | undefined;
          const metadata = fcConfig.metadata as Record<string, unknown> | undefined;
          
          const tempoFromCustom = customAttrs?.[CUSTOM_ATTR_TEMPO_FECHAMENTO];
          const tempoFromMeta = metadata?.[CUSTOM_ATTR_TEMPO_FECHAMENTO];
          
          const tempoRaw = tempoFromCustom ?? tempoFromMeta;
          if (tempoRaw !== undefined && tempoRaw !== null) {
            const tempoNum = Number(tempoRaw);
            if (!isNaN(tempoNum) && tempoNum >= MIN_TEMPO_MINUTOS && tempoNum <= MAX_TEMPO_MINUTOS) {
              tempoFechamentoMinutos = tempoNum;
            } else {
              logger.warn(`${FC_NAME}: tempo_fechamento_ecommerce fora do intervalo (1-60 min), usando padrão ${DEFAULT_TEMPO_FECHAMENTO_MIN}min`, {
                tempoRecebido: tempoNum,
              });
            }
          }
        }
      } catch (e: any) {
        logger.warn(`${FC_NAME}: erro ao buscar tempo de fechamento, usando padrão ${DEFAULT_TEMPO_FECHAMENTO_MIN}min`, { error: e?.message });
      }

      // Enviar mensagem para o e-commerce
      const adapter = whatsappManagerService.getAdapter(attendance.whatsappNumberId);
      if (!adapter?.isConnected()) {
        logger.error(`${FC_NAME}: adapter WhatsApp não disponível para número do atendimento`, {
          whatsappNumberId: attendance.whatsappNumberId,
        });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      const message = formatMessage(data as Record<string, unknown>, client_phone);
      await adapter.sendMessage(num, message);
      logger.info(`${FC_NAME}: informações enviadas ao e-commerce`, {
        attendance_id,
        client_phone,
        ecommerce_number: num,
      });

      // Verificar se o atendimento já está em "Encaminhados e-commerce"
      const isAlreadyInEcommerce = attendance.interventionType === INTERVENTION_TYPE;

      // Preparar dados para interventionData (aparece no card da direita)
      const interventionData = { ...(data as Record<string, unknown>), client_phone } as Record<string, unknown>;

      // Calcular ecommerceClosingAt = now + tempo
      const now = new Date();
      const ecommerceClosingAt = new Date(now.getTime() + tempoFechamentoMinutos * 60 * 1000);
      
      logger.info(`${FC_NAME}: Timer calculado`, {
        attendance_id,
        tempoFechamentoMinutos,
        now: now.toISOString(),
        ecommerceClosingAt: ecommerceClosingAt.toISOString(),
        millisecondsUntilClose: tempoFechamentoMinutos * 60 * 1000,
      });

      // Se não estiver em "Encaminhados e-commerce", realocar e anexar informações
      if (!isAlreadyInEcommerce) {
        logger.info(`${FC_NAME}: realocando atendimento para Encaminhamentos e-commerce`, {
          attendance_id,
          client_phone,
        });

        // Atualizar attendance: definir interventionType, interventionData e timer
        await attendanceRepo.update(
          { id: attendance_id },
          {
            interventionType: INTERVENTION_TYPE,
            interventionData,
            ecommerceClosingAt,
          } as any
        );
        
        // CORREÇÃO: Verificar se o timer foi salvo corretamente
        const updatedAttendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
        if (updatedAttendance) {
          logger.info(`${FC_NAME}: Timer salvo no banco de dados`, {
            attendance_id,
            ecommerceClosingAt: updatedAttendance.ecommerceClosingAt?.toISOString(),
            expectedEcommerceClosingAt: ecommerceClosingAt.toISOString(),
            timersMatch: updatedAttendance.ecommerceClosingAt?.getTime() === ecommerceClosingAt.getTime(),
          });
          
          if (!updatedAttendance.ecommerceClosingAt || updatedAttendance.ecommerceClosingAt.getTime() !== ecommerceClosingAt.getTime()) {
            logger.error(`${FC_NAME}: Timer NÃO foi salvo corretamente!`, {
              attendance_id,
              expected: ecommerceClosingAt.toISOString(),
              actual: updatedAttendance.ecommerceClosingAt?.toISOString() || 'null',
            });
          }
        }

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
          logger.info(`${FC_NAME}: attendance:moved-to-intervention emitido via Socket.IO`);
        } catch (e: any) {
          logger.error(`${FC_NAME}: erro ao emitir Socket.IO para realocação`, { error: e?.message });
        }
      } else {
        // Já está em "Encaminhados e-commerce", apenas atualizar o timer e interventionData (para atualizar informações no card)
        logger.info(`${FC_NAME}: atendimento já está em Encaminhamentos e-commerce, atualizando timer e informações`, {
          attendance_id,
          client_phone,
        });

        await attendanceRepo.update(
          { id: attendance_id },
          {
            interventionData, // Atualizar informações no card da direita
            ecommerceClosingAt, // Atualizar timer
          } as any
        );
        
        // CORREÇÃO: Verificar se o timer foi atualizado corretamente
        const updatedAttendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
        if (updatedAttendance) {
          logger.info(`${FC_NAME}: Timer atualizado no banco de dados`, {
            attendance_id,
            ecommerceClosingAt: updatedAttendance.ecommerceClosingAt?.toISOString(),
            expectedEcommerceClosingAt: ecommerceClosingAt.toISOString(),
            timersMatch: updatedAttendance.ecommerceClosingAt?.getTime() === ecommerceClosingAt.getTime(),
          });
          
          if (!updatedAttendance.ecommerceClosingAt || updatedAttendance.ecommerceClosingAt.getTime() !== ecommerceClosingAt.getTime()) {
            logger.error(`${FC_NAME}: Timer NÃO foi atualizado corretamente!`, {
              attendance_id,
              expected: ecommerceClosingAt.toISOString(),
              actual: updatedAttendance.ecommerceClosingAt?.toISOString() || 'null',
            });
          }
        }

        // Emitir evento para atualizar informações no card (mesmo que já esteja na subdivisão)
        const socketPayload = {
          attendanceId: attendance_id,
          interventionType: INTERVENTION_TYPE,
          interventionData,
        };

        try {
          socketService.emitToRoom('supervisors', 'attendance:intervention-data-updated', socketPayload);
          invalidateSubdivisionCountsCache();
          socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
          logger.info(`${FC_NAME}: attendance:intervention-data-updated emitido via Socket.IO`);
        } catch (e: any) {
          logger.error(`${FC_NAME}: erro ao emitir Socket.IO para atualização`, { error: e?.message });
        }
      }

      logger.info(`${FC_NAME}: processamento concluído`, {
        attendance_id,
        client_phone,
        tempoFechamentoMinutos,
        ecommerceClosingAt: ecommerceClosingAt.toISOString(),
        wasAlreadyInEcommerce: isAlreadyInEcommerce,
        interventionType: INTERVENTION_TYPE,
      });

      // Emitir evento para o frontend sobre o timer (independente de realocação)
      const eventPayload = {
        attendanceId: attendance_id,
        ecommerceClosingAt: ecommerceClosingAt.toISOString(),
        tempoFechamentoMinutos,
      };

      try {
        socketService.emitToRoom('supervisors', 'attendance:ecommerce-timer-started', eventPayload);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        logger.info(`${FC_NAME}: attendance:ecommerce-timer-started emitido via Socket.IO`);
      } catch (e: any) {
        logger.error(`${FC_NAME}: erro ao emitir Socket.IO para timer`, { error: e?.message });
      }

    } catch (err: any) {
      logger.error(`${FC_NAME}: erro ao processar`, {
        error: err?.message,
        stack: err?.stack,
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
