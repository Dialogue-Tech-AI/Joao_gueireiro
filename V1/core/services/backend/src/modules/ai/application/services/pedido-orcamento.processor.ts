import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { AttendanceCase } from '../../../attendance/domain/entities/attendance-case.entity';
import { CaseType } from '../../../attendance/domain/entities/case-type.entity';
import { QuoteRequest, type QuoteItem } from '../../../quote/domain/entities/quote-request.entity';
import { Message } from '../../../message/domain/entities/message.entity';
import { FunctionCallConfig } from '../../domain/entities/function-call-config.entity';
import { In } from 'typeorm';
import { CaseStatus, MessageOrigin, VehicleBrand, UserRole, OperationalState } from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { whatsappManagerService } from '../../../whatsapp/application/services/whatsapp-manager.service';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';
import { canCreateNewCase } from './case-creation.utils';

const FC_NAME = 'pedidoorcamento';
const SUBDIVISION = 'pedidos-orcamentos';
/** Número que sempre recebe o resumo quando a FC pedido-orçamento é ativada */
const NUMERO_RESUMO_PEDIDO_ORCAMENTO = '5521964211017';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Extrai um campo do payload, aceitando múltiplos nomes de campo.
 */
function extractField(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = data[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return String(val).trim();
    }
  }
  return undefined;
}

function truncateForVarchar(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Processador para pedidoorcamento.
 * 
 * Ações:
 * 1. Extrai informações obrigatórias: modelo-do-carro, marca-do-carro, ano-do-carro, peca-desejada, resumo-do-atendimento
 * 2. Extrai informação opcional: placa
 * 3. Movimentação: Se atendimento está em Triagem, roteia para vendedor da marca (round-robin)
 * 4. Card (QuoteRequest): Cria com todas as informações do pedido
 * 5. Demandas: Cria AttendanceCase do tipo "orcamento"
 * 6. Integração com FC: Se houver atributo "numero" e FC ativa, envia dados para esse número via WhatsApp
 */
export function createPedidoOrcamentoProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);
  const quoteRepo = AppDataSource.getRepository(QuoteRequest);
  const caseTypeRepo = AppDataSource.getRepository(CaseType);
  const attendanceCaseRepo = AppDataSource.getRepository(AttendanceCase);
  const configRepo = AppDataSource.getRepository(FunctionCallConfig);
  const messageRepo = AppDataSource.getRepository(Message);

  return async (payload): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> => {
    const { result, attendance_id, client_phone } = payload;
    const parsed = parseResult(result) as Record<string, unknown>;
    const data = (parsed?.data as Record<string, unknown>) ?? parsed;

    try {
      // ========== 1. BUSCAR ATTENDANCE ==========
      const attendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
      if (!attendance) {
        logger.error(`${FC_NAME}: attendance não encontrado`, { attendance_id });
        return { output: null, data: { ...(data as Record<string, unknown>), client_phone }, processed: true };
      }

      // ========== 2. EXTRAIR CAMPOS DO PAYLOAD ==========
      // Campos obrigatórios
      const modeloCarro = extractField(data, 
        'modelo-do-carro', 'modelo_do_carro', 'modeloDoCarro', 
        'modelo', 'model', 'veiculo', 'vehicle'
      );
      const marcaCarro = extractField(data,
        'marca-do-carro', 'marca_do_carro', 'marcaDoCarro',
        'marca', 'brand', 'vehicle_brand', 'vehicleBrand'
      );
      const anoCarro = extractField(data,
        'ano-do-carro', 'ano_do_carro', 'anoDoCarro',
        'ano', 'year'
      );
      const pecaDesejada = extractField(data,
        'peca-desejada', 'peca_desejada', 'pecaDesejada',
        'peca', 'part', 'piece', 'item'
      );
      const resumoAtendimento = extractField(data,
        'resumo-do-atendimento', 'resumo_do_atendimento', 'resumoDoAtendimento',
        'resumo-da-conversa', 'resumo_da_conversa', 'resumoDaConversa',
        'Resumo da conversa', 'resumo da conversa',
        'resumo', 'summary', 'observations', 'observacoes'
      );
      
      // Campo opcional
      const placa = extractField(data,
        'placa', 'plate', 'license_plate', 'licensePlate'
      );

      // Nome do cliente
      let clientName = extractField(data,
        'client_name', 'clientName', 'nome_cliente', 'nomeCliente', 'nome', 'name'
      );
      clientName = truncateForVarchar(clientName, 256);

      logger.info(`${FC_NAME}: campos extraídos`, {
        attendance_id,
        modeloCarro,
        marcaCarro,
        anoCarro,
        pecaDesejada,
        placa,
        temResumo: !!resumoAtendimento,
      });

      // ========== 3. MOVIMENTAÇÃO: ROTEAR SE EM TRIAGEM ==========
      let selectedSeller: { id: string; supervisorId: string | null; name: string } | null = null;
      let vehicleBrand: VehicleBrand | undefined = attendance.vehicleBrand;

      // Se o atendimento está em triagem E não tem vendedor, rotear para vendedor da marca
      if (attendance.operationalState === OperationalState.TRIAGEM && !attendance.sellerId && marcaCarro) {
        logger.info(`${FC_NAME}: atendimento em triagem, iniciando roteamento`, { attendance_id });

        // Normalizar a marca: extrair primeira parte se houver "GM/Chevrolet", "VW-Audi", etc.
        let brandUpper = marcaCarro.toUpperCase().trim();
        const firstPart = brandUpper.split(/[\/\-]/)[0]?.trim() || brandUpper;
        const validBrands = ['FORD', 'GM', 'VW', 'FIAT', 'IMPORTADOS'];

        // Regras especiais de mapeamento (checar tanto valor completo quanto primeira parte)
        const toCheck = [brandUpper, firstPart];
        for (const s of toCheck) {
          if (s === 'AUDI') { brandUpper = 'VW'; break; }
          if (s === 'JEEP') { brandUpper = 'FIAT'; break; }
          if (s === 'CHEVROLET' || s === 'GENERAL MOTORS' || s === 'GM') { brandUpper = 'GM'; break; }
          if (s.includes('CHEVROLET') || s.startsWith('GM')) { brandUpper = 'GM'; break; }
          if (s === 'VOLKSWAGEN' || s === 'VW') { brandUpper = 'VW'; break; }
          if (s.includes('VOLKSWAGEN') || s.startsWith('VW')) { brandUpper = 'VW'; break; }
          if (validBrands.includes(s)) { brandUpper = s; break; }
        }
        if (!validBrands.includes(brandUpper)) {
          brandUpper = 'IMPORTADOS';
        }

        vehicleBrand = brandUpper as VehicleBrand;

        // Round-robin para selecionar vendedor
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
          // Buscar vendedores ativos da marca
          const sellersRaw = await queryRunner.query(
            `SELECT s.id, s.supervisor_id, u.name, s.round_robin_order
             FROM sellers s
             JOIN users u ON s.id = u.id
             WHERE s.brands @> $1::jsonb
               AND u.active = true
               AND u.role = $2
               AND (s.unavailable_until IS NULL OR s.unavailable_until <= NOW())
             ORDER BY s.round_robin_order, s.id`,
            [`["${vehicleBrand}"]`, UserRole.SELLER]
          );

          if (sellersRaw && sellersRaw.length > 0) {
            // Buscar estado de routing
            const routingStateRows = await queryRunner.query(
              `SELECT last_assigned_seller_id, assignment_counter FROM seller_routing_state WHERE vehicle_brand = $1 FOR UPDATE`,
              [vehicleBrand]
            );

            let nextSellerIndex = 0;
            let counter = 0;

            if (routingStateRows && routingStateRows.length > 0) {
              const lastSellerId = routingStateRows[0].last_assigned_seller_id;
              counter = routingStateRows[0].assignment_counter || 0;
              const lastIndex = sellersRaw.findIndex((s: any) => s.id === lastSellerId);
              nextSellerIndex = lastIndex >= 0 ? (lastIndex + 1) % sellersRaw.length : 0;
              counter++;
            }

            const nextSeller = sellersRaw[nextSellerIndex];
            selectedSeller = {
              id: nextSeller.id,
              supervisorId: nextSeller.supervisor_id,
              name: nextSeller.name,
            };

            logger.info(`${FC_NAME}: vendedor selecionado: ${selectedSeller.name}`, {
              attendance_id,
              brand: vehicleBrand,
              counter,
            });

            // Atualizar seller_routing_state
            await queryRunner.query(
              `INSERT INTO seller_routing_state (vehicle_brand, last_assigned_seller_id, assignment_counter, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW())
               ON CONFLICT (vehicle_brand) 
               DO UPDATE SET last_assigned_seller_id = $2, assignment_counter = $3, updated_at = NOW()`,
              [vehicleBrand, selectedSeller.id, counter]
            );

            await queryRunner.commitTransaction();

            // Atualizar attendance: sair da triagem
            await attendanceRepo.update(
              { id: attendance_id },
              {
                sellerId: selectedSeller.id,
                supervisorId: selectedSeller.supervisorId,
                vehicleBrand,
                sellerSubdivision: SUBDIVISION,
                routedAt: new Date(),
                operationalState: OperationalState.ABERTO,
              } as any
            );

            logger.info(`${FC_NAME}: atendimento roteado para vendedor`, {
              attendance_id,
              sellerId: selectedSeller.id,
              vehicleBrand,
            });

            // Emitir Socket.IO
            const routingEventData = {
              attendanceId: attendance_id,
              sellerId: selectedSeller.id,
              supervisorId: selectedSeller.supervisorId,
              vehicleBrand,
              sellerSubdivision: SUBDIVISION,
              routedAt: new Date().toISOString(),
              source: 'pedidoorcamento',
            };

            socketService.emitToRoom(`seller_${selectedSeller.id}`, 'attendance:routed', routingEventData);
            socketService.emitToRoom('supervisors', 'attendance:routed', routingEventData);
            invalidateSubdivisionCountsCache();
            socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
          } else {
            await queryRunner.rollbackTransaction();
            logger.warn(`${FC_NAME}: nenhum vendedor disponível para marca ${vehicleBrand}`, { attendance_id });
            // Mesmo sem vendedor: sair da triagem (ABERTO) e marcar como pedidos-orcamentos para aparecer em Atribuídos
            await attendanceRepo.update(
              { id: attendance_id },
              {
                sellerSubdivision: SUBDIVISION,
                operationalState: OperationalState.ABERTO,
                ...(vehicleBrand && { vehicleBrand }),
              } as any
            );
          }
        } catch (routingErr) {
          await queryRunner.rollbackTransaction();
          logger.error(`${FC_NAME}: erro no roteamento`, { error: (routingErr as any)?.message, attendance_id });
        } finally {
          await queryRunner.release();
        }
      } else if (attendance.sellerId) {
        // Atendimento já tem vendedor, apenas atualizar sellerSubdivision
        selectedSeller = {
          id: attendance.sellerId,
          supervisorId: attendance.supervisorId ?? null,
          name: 'Vendedor atual',
        };
        await attendanceRepo.update(
          { id: attendance_id },
          { sellerSubdivision: SUBDIVISION } as any
        );
      } else if (attendance.operationalState === OperationalState.TRIAGEM) {
        // Em triagem sem marca ou sem vendedor: sair da triagem e colocar em Atribuídos (pedidos-orcamentos)
        await attendanceRepo.update(
          { id: attendance_id },
          { sellerSubdivision: SUBDIVISION, operationalState: OperationalState.ABERTO } as any
        );
        logger.info(`${FC_NAME}: atendimento saiu da triagem para pedidos-orcamentos (sem vendedor/marca)`, { attendance_id });
      }

      // Recarregar attendance para pegar dados atualizados
      const updatedAttendance = await attendanceRepo.findOne({ where: { id: attendance_id } });

      // Buscar pedido de orçamento ativo (pendente/em_elaboracao) para este atendimento
      const activeQuote = await quoteRepo.findOne({
        where: {
          attendanceId: attendance_id,
          status: In(['pendente', 'em_elaboracao']),
        },
        order: { createdAt: 'DESC' },
      });

      // ========== 4. CRIAR CASO EM DEMANDAS (Pedidos de Orçamento) ==========
      // Só criar novo caso se não existir pedido ativo (quando for novo pedido)
      const caseType = await caseTypeRepo.findOne({ where: { key: 'orcamento', isActive: true } });
      if (caseType && !activeQuote) {
        const canCreate = await canCreateNewCase(attendance_id, caseType.id, updatedAttendance?.interventionType ?? undefined);
        if (canCreate) {
          const caseTitleRaw = pecaDesejada ? `Orçamento: ${pecaDesejada}` : 'Orçamento';
          const newCase = attendanceCaseRepo.create({
            attendanceId: attendance_id,
            caseTypeId: caseType.id,
            status: CaseStatus.NOVO,
            title: truncateForVarchar(caseTitleRaw, 256),
          });
          await attendanceCaseRepo.save(newCase);
          logger.info(`${FC_NAME}: caso de orçamento criado`, { caseId: newCase.id, attendance_id });
        }
      }

      // ========== 5. CRIAR OU ATUALIZAR CARD (QuoteRequest) ==========
      // Se não temos nome do cliente, buscar do pushName
      if (!clientName?.trim()) {
        const lastClientMsg = await messageRepo.findOne({
          where: { attendanceId: attendance_id, origin: MessageOrigin.CLIENT },
          order: { sentAt: 'DESC' },
        });
        if (lastClientMsg?.metadata?.pushName && typeof lastClientMsg.metadata.pushName === 'string') {
          clientName = lastClientMsg.metadata.pushName.trim();
        }
      }

      // Resumo: usar o enviado pela IA ou fallback com últimas mensagens do atendimento
      let resumoFinal = resumoAtendimento;
      if (!resumoFinal?.trim()) {
        const recentMessages = await messageRepo.find({
          where: { attendanceId: attendance_id },
          order: { sentAt: 'DESC' },
          take: 20,
        });
        recentMessages.reverse();
        const lines = recentMessages.slice(0, 15).map((m) => {
          const role = m.origin === MessageOrigin.CLIENT ? 'Cliente' : 'Atendente';
          const text = (m.content || '').trim().slice(0, 200);
          return text ? `${role}: ${text}` : '';
        }).filter(Boolean);
        if (lines.length > 0) {
          resumoFinal = lines.join('\n');
          logger.info(`${FC_NAME}: resumo da conversa preenchido por fallback (últimas mensagens)`, { attendance_id, linhas: lines.length });
        }
      }

      // Montar observations: dados do veículo + "Resumo da conversa:" (frontend exibe em seção própria)
      const infoLines: string[] = [];
      if (marcaCarro) infoLines.push(`Marca: ${marcaCarro}`);
      if (modeloCarro) infoLines.push(`Modelo: ${modeloCarro}`);
      if (anoCarro) infoLines.push(`Ano: ${anoCarro}`);
      if (pecaDesejada) infoLines.push(`Peça desejada: ${pecaDesejada}`);
      if (placa) infoLines.push(`Placa: ${placa}`);
      if (resumoFinal?.trim()) infoLines.push(`\nResumo da conversa:\n${resumoFinal.trim()}`);

      const observations = infoLines.length > 0 ? infoLines.join('\n') : undefined;

      const vehicleInfo = {
        marca: marcaCarro,
        modelo: modeloCarro,
        ano: anoCarro,
        peca: pecaDesejada,
        placa,
        resumo: resumoFinal?.trim() || undefined,
      };

      let quote: QuoteRequest;
      if (activeQuote) {
        // Atualizar pedido existente com as novas informações; limpar sellerViewedAt para notificação verde reaparecer
        await quoteRepo.update(
          { id: activeQuote.id },
          {
            clientName: clientName?.trim() || activeQuote.clientName,
            observations,
            vehicleInfo,
            sellerId: updatedAttendance?.sellerId ?? activeQuote.sellerId,
            sellerViewedAt: null,
          }
        );
        quote = await quoteRepo.findOneOrFail({ where: { id: activeQuote.id } });
        logger.info(`${FC_NAME}: pedido de orçamento atualizado (existente)`, {
          quote_id: quote.id,
          attendance_id,
          client_phone,
        });
      } else {
        // Criar novo pedido
        quote = quoteRepo.create({
          attendanceId: attendance_id,
          sellerId: updatedAttendance?.sellerId ?? undefined,
          sellerSubdivision: SUBDIVISION,
          clientPhone: client_phone,
          clientName: clientName?.trim() || undefined,
          observations,
          vehicleInfo,
          status: 'pendente',
        });
        await quoteRepo.save(quote);
        logger.info(`${FC_NAME}: card de orçamento criado`, {
          quote_id: quote.id,
          attendance_id,
          client_phone,
          seller_id: updatedAttendance?.sellerId,
        });
      }

      // Preencher interventionData para exibir informações do pedido no card da direita do cliente
      const interventionData: Record<string, unknown> = {
        client_phone: client_phone,
        ...(clientName?.trim() && { Cliente: clientName.trim() }),
        ...(marcaCarro && { Marca: marcaCarro }),
        ...(modeloCarro && { Modelo: modeloCarro }),
        ...(anoCarro && { Ano: anoCarro }),
        ...(pecaDesejada && { 'Peça desejada': pecaDesejada }),
        ...(placa && { Placa: placa }),
        ...(resumoFinal?.trim() && { 'Resumo da conversa': resumoFinal.trim() }),
      };
      await attendanceRepo.update(
        { id: attendance_id },
        { interventionData } as any
      );
      try {
        socketService.emitToRoom('supervisors', 'attendance:moved-to-intervention', {
          attendanceId: attendance_id,
          interventionType: null,
          interventionData,
        });
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
      } catch (_) {}

      // Emitir Socket.IO: quote:updated quando atualizou, quote:created quando criou novo
      try {
        const quoteEventData = {
          quoteId: quote.id,
          attendanceId: attendance_id,
          sellerId: updatedAttendance?.sellerId ?? null,
          sellerSubdivision: SUBDIVISION,
          clientPhone: client_phone,
          clientName: quote.clientName,
          status: quote.status,
          marca: marcaCarro,
          modelo: modeloCarro,
          ano: anoCarro,
          peca: pecaDesejada,
          placa,
        };
        const eventName = activeQuote ? 'quote:updated' : 'quote:created';
        socketService.emitToRoom('supervisors', eventName, quoteEventData);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        if (updatedAttendance?.sellerId) {
          socketService.emitToRoom(`seller_${updatedAttendance.sellerId}`, eventName, quoteEventData);
        }
        socketService.emit(eventName, { quoteId: quote.id, attendanceId: attendance_id });
      } catch (e: any) {
        logger.error(`${FC_NAME}: erro ao emitir ${activeQuote ? 'quote:updated' : 'quote:created'}`, { error: e?.message });
      }

      // ========== 6. ENVIAR RESUMO POR WHATSAPP ==========
      // Sempre enviar resumo para o número fixo; opcionalmente também para número configurado na FC
      const msgLines: string[] = [
        activeQuote ? '📋 *PEDIDO DE ORÇAMENTO ATUALIZADO*\n' : '📋 *NOVO PEDIDO DE ORÇAMENTO*\n',
      ];
      if (clientName) msgLines.push(`👤 Cliente: ${clientName}`);
      msgLines.push(`📞 Telefone: ${client_phone}`);
      if (marcaCarro) msgLines.push(`🚗 Marca: ${marcaCarro}`);
      if (modeloCarro) msgLines.push(`📝 Modelo: ${modeloCarro}`);
      if (anoCarro) msgLines.push(`📅 Ano: ${anoCarro}`);
      if (pecaDesejada) msgLines.push(`🔧 Peça: ${pecaDesejada}`);
      if (placa) msgLines.push(`🪧 Placa: ${placa}`);
      if (resumoFinal?.trim()) msgLines.push(`\n📄 Resumo:\n${resumoFinal.trim()}`);
      const mensagemEnvio = msgLines.join('\n');

      const numerosParaEnviar = new Set<string>();
      numerosParaEnviar.add(NUMERO_RESUMO_PEDIDO_ORCAMENTO.replace(/\D/g, ''));
      const fcConfig = await configRepo.findOne({ where: { functionCallName: FC_NAME } });
      if (fcConfig?.isActive && fcConfig?.customAttributes) {
        const numeroExtra = (fcConfig.customAttributes['numero'] as string)?.trim?.();
        if (numeroExtra) numerosParaEnviar.add(numeroExtra.replace(/\D/g, ''));
      }

      const adapter = whatsappManagerService.getAdapter(attendance.whatsappNumberId);
      if (adapter?.isConnected()) {
        for (const numeroLimpo of numerosParaEnviar) {
          try {
            await adapter.sendMessage(numeroLimpo, mensagemEnvio);
            logger.info(`${FC_NAME}: resumo enviado`, { attendance_id, numero: numeroLimpo });
          } catch (sendErr: any) {
            logger.error(`${FC_NAME}: erro ao enviar resumo`, {
              error: sendErr?.message,
              attendance_id,
              numero: numeroLimpo,
            });
          }
        }
      } else {
        logger.warn(`${FC_NAME}: adapter WhatsApp não disponível para envio`, {
          attendance_id,
          whatsappNumberId: attendance.whatsappNumberId,
        });
      }

      // ========== RETORNO ==========
      // FC apenas aciona processos no sistema (criar orçamento, enviar resumo). Resposta ao cliente
      // é gerada em uma única mensagem pelo especialista (2ª chamada LLM), evitando duplicação.
      return {
        output: '',
        data: {
          ...(data as Record<string, unknown>),
          client_phone,
          marca: marcaCarro,
          modelo: modeloCarro,
          ano: anoCarro,
          peca: pecaDesejada,
          placa,
          vendedor: selectedSeller?.name,
          vendedor_id: selectedSeller?.id,
          quote_id: quote.id,
        },
        processed: true,
      };
    } catch (err: any) {
      logger.error(`${FC_NAME}: erro ao processar`, {
        error: err?.message,
        stack: err?.stack,
        attendance_id,
        client_phone,
      });
      return {
        output: '',
        data: { ...(data as Record<string, unknown>), client_phone, error: err?.message },
        processed: true,
      };
    }
  };
}
