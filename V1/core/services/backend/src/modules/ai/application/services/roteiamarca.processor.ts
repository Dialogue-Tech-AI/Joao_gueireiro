import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { Seller } from '../../../seller/domain/entities/seller.entity';
import { User } from '../../../auth/domain/entities/user.entity';
import { VehicleBrand, UserRole } from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const FC_NAME = 'roteiamarca';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador para roteiamarca.
 * Roteia o atendimento para o primeiro vendedor da fila da respectiva marca (round-robin).
 * Pode ser usado em qualquer momento do atendimento, não apenas na triagem.
 */
export function createRoteiamarcaProcessor(): FunctionCallProcessorHandler {
  const attendanceRepo = AppDataSource.getRepository(Attendance);
  const sellerRepo = AppDataSource.getRepository(Seller);
  const userRepo = AppDataSource.getRepository(User);

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

      // VERIFICAÇÃO: Se o atendimento já tem um vendedor, não rotear novamente
      if (attendance.sellerId) {
        logger.info(`${FC_NAME}: atendimento já possui vendedor, ignorando roteamento`, {
          attendance_id,
          currentSellerId: attendance.sellerId,
          vehicleBrand: attendance.vehicleBrand,
        });
        return {
          output: null,
          data: {
            ...(data as Record<string, unknown>),
            client_phone,
            message: 'Atendimento já possui vendedor',
            vendedor_id: attendance.sellerId,
            marca: attendance.vehicleBrand,
          },
          processed: true,
        };
      }

      // Extrair marca dos dados coletados (aceita diversos formatos de campo)
      const brandRaw = (
        data.marca || 
        data.brand || 
        data.vehicle_brand || 
        data.vehicleBrand || 
        data['Nome da marca do carro'] ||
        data['nome da marca do carro'] ||
        data['nome_da_marca_do_carro']
      ) as string;
      
      if (!brandRaw) {
        logger.error(`${FC_NAME}: marca não encontrada nos dados coletados`, { data, attendance_id });
        return { output: null, data: { ...(data as Record<string, unknown>), client_phone, error: 'Marca não identificada' }, processed: true };
      }

      let brandUpper = brandRaw.trim().toUpperCase();
      const validBrands = ['FORD', 'GM', 'VW', 'FIAT', 'IMPORTADOS'];
      
      // Regras especiais de mapeamento
      if (brandUpper === 'AUDI') {
        logger.info(`${FC_NAME}: marca "Audi" mapeada para VW`, { 
          brandOriginal: brandRaw, 
          attendance_id 
        });
        brandUpper = 'VW';
      } else if (brandUpper === 'JEEP') {
        logger.info(`${FC_NAME}: marca "Jeep" mapeada para Fiat`, { 
          brandOriginal: brandRaw, 
          attendance_id 
        });
        brandUpper = 'FIAT';
      } else if (!validBrands.includes(brandUpper)) {
        // Se a marca não é uma das 5 padrão (e não é Audi/Jeep), mapeia para IMPORTADOS
        logger.info(`${FC_NAME}: marca "${brandRaw}" não está nas 5 padrão, mapeando para IMPORTADOS`, { 
          brandOriginal: brandRaw, 
          attendance_id 
        });
        brandUpper = 'IMPORTADOS';
      }

      const vehicleBrand = brandUpper as VehicleBrand;
      logger.info(`${FC_NAME}: roteando para marca ${vehicleBrand}`, { attendance_id, client_phone });

      let selectedSeller: { id: string; supervisorId: string | null; name: string } | null = null;
      let isReturningClient = false;

      const queryRunner = AppDataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        // 1. VERIFICAR HISTÓRICO DO CLIENTE PARA ESSA MARCA (primeira prioridade)
        const historyRows = await queryRunner.query(
          `SELECT seller_id, supervisor_id, total_attendances 
           FROM client_seller_history 
           WHERE client_phone = $1 AND vehicle_brand = $2`,
          [client_phone, vehicleBrand]
        );

        if (historyRows && historyRows.length > 0) {
          const historySellerId = historyRows[0].seller_id;
          const historySupervisorId = historyRows[0].supervisor_id;
          
          logger.info(`${FC_NAME}: cliente tem histórico com marca ${vehicleBrand}, vendedor: ${historySellerId}`, {
            attendance_id,
            client_phone,
            historySellerId,
          });

          // Verificar se o vendedor ainda está ativo e trabalha com essa marca
          const sellerCheck = await queryRunner.query(
            `SELECT s.id, s.supervisor_id, u.name, u.active
             FROM sellers s
             JOIN users u ON s.id = u.id
             WHERE s.id = $1
               AND s.brands @> $2::jsonb
               AND u.active = true
               AND u.role = $3
               AND (s.unavailable_until IS NULL OR s.unavailable_until <= NOW())`,
            [historySellerId, `["${vehicleBrand}"]`, UserRole.SELLER]
          );

          if (sellerCheck && sellerCheck.length > 0) {
            // Cliente retornando: usar o mesmo vendedor (ignorar fila)
            selectedSeller = {
              id: sellerCheck[0].id,
              supervisorId: sellerCheck[0].supervisor_id,
              name: sellerCheck[0].name,
            };
            isReturningClient = true;

            // Atualizar histórico: incrementar contador e atualizar last_routed_at
            await queryRunner.query(
              `UPDATE client_seller_history
               SET last_routed_at = NOW(), total_attendances = total_attendances + 1
               WHERE client_phone = $1 AND vehicle_brand = $2`,
              [client_phone, vehicleBrand]
            );

            logger.info(`${FC_NAME}: cliente retornando - usando mesmo vendedor: ${selectedSeller.name} (${selectedSeller.id})`, {
              attendance_id,
              brand: vehicleBrand,
              isReturningClient: true,
            });
          } else {
            // Vendedor histórico não está mais ativo ou não trabalha mais com essa marca
            // Continuar para round-robin (nova atribuição)
            logger.info(`${FC_NAME}: vendedor histórico não está mais disponível, usando round-robin`, {
              attendance_id,
              historySellerId,
            });
          }
        }

        // 2. SE NÃO TEM HISTÓRICO OU VENDEDOR HISTÓRICO NÃO ESTÁ DISPONÍVEL: usar round-robin
        if (!selectedSeller) {
          logger.info(`${FC_NAME}: primeira vez do cliente com marca ${vehicleBrand} ou vendedor histórico indisponível - usando round-robin`, {
            attendance_id,
          });

          // Buscar todos os vendedores ativos dessa marca
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

          if (!sellersRaw || sellersRaw.length === 0) {
            await queryRunner.rollbackTransaction();
            logger.error(`${FC_NAME}: nenhum vendedor disponível para marca ${vehicleBrand}`, { attendance_id });
            return {
              output: null,
              data: { ...(data as Record<string, unknown>), client_phone, error: `Nenhum vendedor disponível para ${vehicleBrand}` },
              processed: true,
            };
          }

          // Buscar estado de routing para essa marca com lock (FOR UPDATE)
          const routingStateRows = await queryRunner.query(
            `SELECT last_assigned_seller_id, assignment_counter FROM seller_routing_state WHERE vehicle_brand = $1 FOR UPDATE`,
            [vehicleBrand]
          );

          let nextSellerIndex = 0;
          let counter = 0;

          if (routingStateRows && routingStateRows.length > 0) {
            const lastSellerId = routingStateRows[0].last_assigned_seller_id;
            counter = routingStateRows[0].assignment_counter || 0;

            // Encontrar índice do último vendedor atribuído
            const lastIndex = sellersRaw.findIndex((s: any) => s.id === lastSellerId);
            if (lastIndex >= 0) {
              nextSellerIndex = (lastIndex + 1) % sellersRaw.length;
            } else {
              // Se não encontrou (vendedor inativo ou removido), começa do 0
              nextSellerIndex = 0;
            }
            counter++;
          } else {
            // Primeira atribuição para essa marca
            nextSellerIndex = 0;
            counter = 0;
          }

          const nextSeller = sellersRaw[nextSellerIndex];
          selectedSeller = {
            id: nextSeller.id,
            supervisorId: nextSeller.supervisor_id,
            name: nextSeller.name,
          };

          logger.info(`${FC_NAME}: vendedor selecionado via round-robin: ${selectedSeller.name} (${selectedSeller.id})`, {
            attendance_id,
            brand: vehicleBrand,
            counter,
            isReturningClient: false,
          });

          // Criar/atualizar histórico do cliente para essa marca (primeira vez)
          await queryRunner.query(
            `INSERT INTO client_seller_history (client_phone, vehicle_brand, seller_id, supervisor_id, first_routed_at, last_routed_at, total_attendances)
             VALUES ($1, $2, $3, $4, NOW(), NOW(), 1)
             ON CONFLICT (client_phone, vehicle_brand)
             DO UPDATE SET seller_id = $3, supervisor_id = $4, last_routed_at = NOW(), total_attendances = client_seller_history.total_attendances + 1`,
            [client_phone, vehicleBrand, selectedSeller.id, selectedSeller.supervisorId]
          );

          // Atualizar seller_routing_state (round-robin)
          await queryRunner.query(
            `INSERT INTO seller_routing_state (vehicle_brand, last_assigned_seller_id, assignment_counter, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (vehicle_brand) 
             DO UPDATE SET last_assigned_seller_id = $2, assignment_counter = $3, updated_at = NOW()`,
            [vehicleBrand, selectedSeller.id, counter]
          );
        }

        await queryRunner.commitTransaction();
      } catch (err) {
        await queryRunner.rollbackTransaction();
        throw err;
      } finally {
        await queryRunner.release();
      }

      if (!selectedSeller) {
        logger.error(`${FC_NAME}: falha ao selecionar vendedor`, { attendance_id, vehicleBrand });
        return { output: null, data: { ...(data as Record<string, unknown>), client_phone, error: 'Falha ao selecionar vendedor' }, processed: true };
      }

      // IMPORTANTE: Mesmo se o atendimento estiver fechado, se o cliente pedir uma peça da mesma marca,
      // deve voltar para o mesmo vendedor (já foi tratado acima com o histórico)
      // Se for outra marca, já foi tratado acima (histórico da nova marca ou round-robin)
      // Então sempre roteamos, independente do estado do atendimento

      // Atualizar attendance: setar sellerId, supervisorId, vehicleBrand, sellerSubdivision (padrão: pedidos-orcamentos), routedAt
      // IMPORTANTE: Não alterar operationalState aqui, pois pode já estar em ABERTO ou EM_ATENDIMENTO
      const sellerSubdivision = attendance.sellerSubdivision || 'pedidos-orcamentos';
      try {
        const updateData: any = {
          sellerId: selectedSeller.id,
          supervisorId: selectedSeller.supervisorId,
          vehicleBrand,
          sellerSubdivision,
          routedAt: new Date(),
        };

        // Se estiver em TRIAGEM, mudar para ABERTO
        if (attendance.operationalState === 'TRIAGEM') {
          updateData.operationalState = 'ABERTO';
        }

        const updateResult = await attendanceRepo.update(
          { id: attendance_id },
          updateData
        );

        if (updateResult.affected === 0) {
          logger.error(`${FC_NAME}: UPDATE falhou - nenhuma linha afetada`, { attendance_id });
          return { output: null, data: { ...(data as Record<string, unknown>), client_phone, error: 'UPDATE falhou' }, processed: true };
        }

        logger.info(`${FC_NAME}: attendance roteado para vendedor ${selectedSeller.name}`, {
          attendance_id,
          sellerId: selectedSeller.id,
          supervisorId: selectedSeller.supervisorId,
          vehicleBrand,
          sellerSubdivision,
          affected: updateResult.affected,
          isReturningClient,
          previousState: attendance.operationalState,
        });

        // VERIFICAR se o UPDATE foi persistido (leitura imediata do banco)
        const updatedAttendance = await attendanceRepo.findOne({ where: { id: attendance_id } });
        logger.info(`${FC_NAME}: VERIFICAÇÃO PÓS-UPDATE`, {
          attendance_id,
          sellerIdNoBanco: updatedAttendance?.sellerId,
          vehicleBrandNoBanco: updatedAttendance?.vehicleBrand,
          sellerSubdivisionNoBanco: updatedAttendance?.sellerSubdivision,
          routedAtNoBanco: updatedAttendance?.routedAt,
          supervisorIdNoBanco: updatedAttendance?.supervisorId,
          operationalStateNoBanco: updatedAttendance?.operationalState,
        });
      } catch (updateErr: any) {
        logger.error(`${FC_NAME}: erro ao atualizar attendance no banco`, {
          attendance_id,
          error: updateErr?.message,
          stack: updateErr?.stack,
        });
        return { output: null, data: { ...(data as Record<string, unknown>), client_phone, error: 'Erro ao persistir roteamento' }, processed: true };
      }

      // Emitir Socket.IO para tempo real (attendance:routed)
      const routingEventData = {
        attendanceId: attendance_id,
        sellerId: selectedSeller.id,
        supervisorId: selectedSeller.supervisorId,
        vehicleBrand,
        sellerSubdivision,
        routedAt: new Date().toISOString(),
        source: 'roteiamarca', // Indica que o roteamento veio da roteiamarca
      };

      try {
        const io = socketService.getIO();
        
        // Log diagnóstico completo
        logger.info(`${FC_NAME}: 🔴 EMITINDO attendance:routed`, {
          attendanceId: attendance_id,
          sellerId: selectedSeller.id,
          vehicleBrand,
          totalSockets: io.of('/').sockets.size,
          supervisorsRoom: io.of('/').adapter.rooms.get('supervisors')?.size || 0,
        });

        // Emitir para o seller específico
        socketService.emitToRoom(`seller_${selectedSeller.id}`, 'attendance:routed', routingEventData);
        // Emitir para supervisores
        socketService.emitToRoom('supervisors', 'attendance:routed', routingEventData);
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
        // CORREÇÃO: Remover broadcasts globais para evitar notificações duplicadas e mistura de eventos
        
        logger.info(`${FC_NAME}: attendance:routed emitido via Socket.IO para seller e supervisors rooms`);
      } catch (e: any) {
        logger.error(`${FC_NAME}: erro ao emitir Socket.IO`, { error: e?.message });
      }

      // Não enviar mensagem ao cliente sobre o direcionamento
      return {
        output: null,
        data: {
          ...(data as Record<string, unknown>),
          client_phone,
          marca: vehicleBrand,
          vendedor: selectedSeller.name,
          vendedor_id: selectedSeller.id,
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
        output: null,
        data: { ...(data as Record<string, unknown>), client_phone, error: err?.message },
        processed: true,
      };
    }
  };
}
