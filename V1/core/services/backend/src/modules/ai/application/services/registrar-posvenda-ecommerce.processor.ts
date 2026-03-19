import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { AttendanceCase } from '../../../attendance/domain/entities/attendance-case.entity';
import { CaseType } from '../../../attendance/domain/entities/case-type.entity';
import { CaseStatus } from '../../../../shared/types/common.types';
import { FunctionCallConfigService } from './function-call-config.service';
import { whatsappManagerService } from '../../../whatsapp/application/services/whatsapp-manager.service';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';
import { canCreateNewCase } from './case-creation.utils';

const FC_NAME = 'registrarposvendaecommerce';
const CUSTOM_ATTR_ECOMMERCE_NUMBER = 'ecommerce_whatsapp_number';
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
    '——— *Demanda Pós-Venda E-commerce* ———',
    '',
    `*WhatsApp do cliente:* ${clientPhone}`,
    '',
  ];

  const tipoKeys = ['TipoDeSolicitacao', 'Tipo', 'tipo', 'tipo_solicitacao', 'GarantiaTrocaEstorno'];
  let tipo = '';
  for (const k of tipoKeys) {
    const v = data[k];
    if (v != null && String(v).trim()) {
      tipo = String(v).trim();
      break;
    }
  }
  if (tipo) {
    lines.push('*Tipo da solicitação:* ' + tipo);
    lines.push('');
  }

  lines.push('*Dados do cliente:*');
  const ignore = new Set(['raw', ...tipoKeys]);
  for (const [key, value] of Object.entries(data)) {
    if (ignore.has(key) || value == null || String(value).trim() === '') continue;
    lines.push(`• ${key}: ${value}`);
  }
  lines.push('');

  lines.push('*Dados do pedido (quando disponíveis):*');
  const pedidoKeys = ['NumeroDoPedido', 'NumeroPedido', 'DataCompra', 'DataDaCompra', 'NotaFiscal', 'Número da Nota Fiscal', 'Número do pedido'];
  let hasPedido = false;
  for (const k of Object.keys(data)) {
    if (pedidoKeys.some(p => k.toLowerCase().includes(p.toLowerCase()))) {
      hasPedido = true;
      lines.push(`• ${k}: ${data[k]}`);
    }
  }
  if (!hasPedido) {
    lines.push('• (não informado)');
  }

  lines.push('');
  lines.push('——— Fim da demanda ———');
  return lines.join('\n');
}

/**
 * Processador específico para registrarposvendaecommerce.
 * Após sucesso da FC: formata dados, envia para o número do setor E-commerce (custom_attributes.ecommerce_whatsapp_number).
 * Inclui sempre o WhatsApp do cliente na mensagem.
 */
export function createRegistrarPosVendaEcommerceProcessor(): FunctionCallProcessorHandler {
  const configService = new FunctionCallConfigService();
  const attendanceRepo = AppDataSource.getRepository(Attendance);
  const caseTypeRepo = AppDataSource.getRepository(CaseType);
  const attendanceCaseRepo = AppDataSource.getRepository(AttendanceCase);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result) as Record<string, unknown>;
    const data = (parsed?.data as Record<string, unknown>) ?? parsed;

    const config = await configService.getByFunctionCallName(FC_NAME);
    const ecommerceNumber = config?.customAttributes?.[CUSTOM_ATTR_ECOMMERCE_NUMBER];
    const num = typeof ecommerceNumber === 'string' ? ecommerceNumber.trim() : '';

    if (!num) {
      logger.warn('registrarposvendaecommerce: ecommerce_whatsapp_number não configurado em Atributos Personalizados. Não será enviado ao setor.');
      return {
        output: null,
        data: data as Record<string, unknown>,
        processed: true,
      };
    }

    try {
      const attendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      if (!attendance) {
        logger.error('registrarposvendaecommerce: attendance não encontrado', { attendance_id });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      const caseType = await caseTypeRepo.findOne({ where: { key: 'pos_venda', isActive: true } });
      if (caseType) {
        const canCreate = await canCreateNewCase(attendance_id, caseType.id, attendance.interventionType ?? undefined);
        if (canCreate) {
          const newCase = attendanceCaseRepo.create({
            attendanceId: attendance_id,
            caseTypeId: caseType.id,
            status: CaseStatus.NOVO,
            title: 'Pós-venda E-commerce',
          });
          await attendanceCaseRepo.save(newCase);
        }
      }

      const adapter = whatsappManagerService.getAdapter(attendance.whatsappNumberId);
      if (!adapter?.isConnected()) {
        logger.error('registrarposvendaecommerce: adapter WhatsApp não disponível para número do atendimento', {
          whatsappNumberId: attendance.whatsappNumberId,
        });
        return { output: null, data: data as Record<string, unknown>, processed: true };
      }

      const message = formatMessage(data as Record<string, unknown>, client_phone);
      await adapter.sendMessage(num, message);
      logger.info('registrarposvendaecommerce: demanda enviada ao setor E-commerce', {
        attendance_id,
        client_phone,
        ecommerce_number: num,
      });

      const interventionData = { ...(data as Record<string, unknown>), client_phone } as Record<string, unknown>;
      await attendanceRepo.update(
        { id: attendance_id },
        { interventionType: INTERVENTION_TYPE, interventionData } as any
      );
      logger.info('registrarposvendaecommerce: atendimento marcado como Encaminhados E-commerce', {
        attendance_id,
        client_phone,
      });

      const payload = {
        attendanceId: attendance_id,
        interventionType: INTERVENTION_TYPE,
        interventionData,
      };

      try {
        socketService.emitToRoom('supervisors', 'attendance:moved-to-intervention', payload);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        logger.info('registrarposvendaecommerce: attendance:moved-to-intervention emitido via Socket.IO (tempo real)');
      } catch (e: any) {
        logger.error('registrarposvendaecommerce: erro ao emitir Socket.IO', { error: e?.message });
      }

      if (redisService.isConnected()) {
        try {
          await redisService.publish(
            'attendance:intervention-assigned',
            JSON.stringify(payload)
          );
        } catch (e: any) {
          logger.error('registrarposvendaecommerce: erro ao publicar Redis', { error: e?.message });
        }
      }
    } catch (err: any) {
      logger.error('registrarposvendaecommerce: erro ao enviar ao setor E-commerce', {
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
