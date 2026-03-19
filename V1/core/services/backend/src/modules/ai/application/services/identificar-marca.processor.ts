import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { Seller } from '../../../seller/domain/entities/seller.entity';
import { User } from '../../../auth/domain/entities/user.entity';
import { VehicleBrand, UserRole, OperationalState } from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import type { FunctionCallProcessorHandler } from '../../domain/interfaces/function-call-processor.interface';

const FC_NAME = 'identificamarca';

function parseResult(resultRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(resultRaw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : { raw: resultRaw };
  } catch {
    return { raw: resultRaw };
  }
}

/**
 * Processador para identificamarca.
 * Roteia o cliente da triagem para um vendedor da marca (sempre round-robin).
 */
export function createIdentificarMarcaProcessor(): FunctionCallProcessorHandler {
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
      logger.info(`${FC_NAME}: marca identificada: ${vehicleBrand}`, { attendance_id, client_phone });

      let selectedSeller: { id: string; supervisorId: string | null; name: string } | null = null;

      {
        logger.info(`${FC_NAME}: round-robin para marca ${vehicleBrand}`, { attendance_id });

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
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
          });

          // Atualizar seller_routing_state (round-robin)
          await queryRunner.query(
            `INSERT INTO seller_routing_state (vehicle_brand, last_assigned_seller_id, assignment_counter, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (vehicle_brand) 
             DO UPDATE SET last_assigned_seller_id = $2, assignment_counter = $3, updated_at = NOW()`,
            [vehicleBrand, selectedSeller.id, counter]
          );

          await queryRunner.commitTransaction();
        } catch (err) {
          await queryRunner.rollbackTransaction();
          throw err;
        } finally {
          await queryRunner.release();
        }
      }

      if (!selectedSeller) {
        logger.error(`${FC_NAME}: falha ao selecionar vendedor`, { attendance_id, vehicleBrand });
        return { output: null, data: { ...(data as Record<string, unknown>), client_phone, error: 'Falha ao selecionar vendedor' }, processed: true };
      }

      // Atualizar attendance: setar sellerId, supervisorId, vehicleBrand, sellerSubdivision (padrão: pedidos-orcamentos), routedAt
      // IMPORTANTE: Mudar operationalState de TRIAGEM → ABERTO para remover da triagem (API filtra triagem por operationalState TRIAGEM).
      const sellerSubdivision = 'pedidos-orcamentos';
      try {
        const updateResult = await attendanceRepo.update(
          { id: attendance_id },
          {
            sellerId: selectedSeller.id,
            supervisorId: selectedSeller.supervisorId,
            vehicleBrand,
            sellerSubdivision,
            routedAt: new Date(),
            operationalState: OperationalState.ABERTO,
          } as any
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
        source: 'identificamarca', // Indica que o roteamento veio da identificamarca
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
