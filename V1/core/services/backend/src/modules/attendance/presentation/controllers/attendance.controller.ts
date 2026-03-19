import { Router, Request, Response } from 'express';
import multer from 'multer';
import { Not, In } from 'typeorm';
import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../domain/entities/attendance.entity';
import { Message } from '../../../message/domain/entities/message.entity';
import { MessageRead } from '../../../message/domain/entities/message-read.entity';
import { Seller } from '../../../seller/domain/entities/seller.entity';
import { User } from '../../../auth/domain/entities/user.entity';
import { WhatsAppNumber } from '../../../whatsapp/domain/entities/whatsapp-number.entity';
import { logger } from '../../../../shared/utils/logger';
import { UUID, UserRole, MessageOrigin, MessageStatus, AttendanceType, VehicleBrand, OperationalState } from '../../../../shared/types/common.types';
import { whatsappManagerService } from '../../../whatsapp/application/services/whatsapp-manager.service';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { messageSenderService } from '../../../message/application/services/message-sender.service';
import { mediaService } from '../../../message/application/services/media.service';
import { notificationService } from '../../../notification/application/services/notification.service';
import { Notification, NotificationType } from '../../../notification/domain/entities/notification.entity';
import { QuoteRequest } from '../../../quote/domain/entities/quote-request.entity';
import { aiConfigService } from '../../../ai/application/services/ai-config.service';
import { getSellersBySupervisorId } from '../../../seller/application/get-sellers-by-supervisor';

function normalizePhone(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

/** Normaliza quebras de linha para \n para exibir corretamente no chat (ex.: orçamentos, textos colados). */
function normalizeLineBreaks(text: string): string {
  return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

async function filterBlacklistedAttendances<T extends { clientPhone: string }>(list: T[]): Promise<T[]> {
  const blacklistSet = await aiConfigService.getBlacklistedPhonesSet();
  if (!blacklistSet || blacklistSet.size === 0) return list;
  return list.filter((a) => !blacklistSet.has(normalizePhone(a.clientPhone)));
}

// Configure multer for file uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 16 * 1024 * 1024, // 16MB max
  },
});

const subdivisionCountsCache = new Map<string, { expiresAt: number; counts: Record<string, number> }>();

export function invalidateSubdivisionCountsCache(): void {
  subdivisionCountsCache.clear();
}

export class AttendanceController {
  public router: Router;
  private attributedConversationsCache = new Map<string, { expiresAt: number; conversations: any[] }>();

  constructor() {
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    // Get closed attendances for a seller (only their own) - rota mais específica primeiro
    this.router.get(
      '/seller/:sellerId/fechados',
      this.getFechadosBySeller.bind(this)
    );

    // Get conversations/attendances by seller ID
    this.router.get(
      '/seller/:sellerId',
      this.getConversationsBySeller.bind(this)
    );

    // Get supervisor's pending items (pendências)
    this.router.get(
      '/supervisor/pendings',
      this.getSupervisorPendings.bind(this)
    );

    // Get active attendance counts per subdivision (for supervisor sidebar)
    this.router.get(
      '/supervisor/subdivision-counts',
      this.getSubdivisionCounts.bind(this)
    );

    // Get supervisor statistics (cards + by brand)
    this.router.get(
      '/supervisor/stats',
      this.getSupervisorStats.bind(this)
    );

    // Get unassigned attendances (for supervisor "Não Atribuídos")
    this.router.get(
      '/unassigned',
      this.getUnassignedAttendances.bind(this)
    );

    // Get attendances by intervention type (ex.: Demanda telefone fixo, garantia)
    this.router.get(
      '/intervention/demanda-telefone-fixo',
      this.getInterventionDemandaTelefoneFixo.bind(this)
    );
    this.router.get(
      '/intervention/:type',
      this.getInterventionByType.bind(this)
    );

    // Get all attributed attendances (seller OR intervention) for "Atribuídos" tab
    this.router.get(
      '/attributed',
      this.getAttributedAttendances.bind(this)
    );

    // Get closed attendances (Fechados - FECHADO_OPERACIONAL)
    this.router.get(
      '/fechados',
      this.getFechadosAttendances.bind(this)
    );

    // Get messages for a specific attendance
    this.router.get(
      '/:attendanceId/messages',
      this.getAttendanceMessages.bind(this)
    );

    // Get contact-wide message history (all attendances of same client)
    this.router.get(
      '/:attendanceId/contact-history',
      this.getContactHistory.bind(this)
    );

    // Send a message to a specific attendance (with optional media)
    this.router.post(
      '/:attendanceId/messages',
      upload.single('media'),
      this.sendMessage.bind(this)
    );

    // Mark messages as read for a specific attendance
    this.router.post(
      '/:attendanceId/mark-read',
      this.markAsRead.bind(this)
    );

    // Delete attendance (contact/conversation)
    this.router.delete(
      '/:attendanceId',
      this.deleteAttendance.bind(this)
    );

    // Assume attendance (human takes over from AI)
    this.router.post(
      '/:attendanceId/assume',
      this.assumeAttendance.bind(this)
    );

    // Return attendance to AI
    this.router.post(
      '/:attendanceId/return-to-ai',
      this.returnAttendanceToAI.bind(this)
    );

    // Get inactivity timer remaining time
    this.router.get(
      '/:attendanceId/inactivity-timer',
      this.getInactivityTimer.bind(this)
    );

    // Get AI status for a specific attendance
    this.router.get(
      '/:attendanceId/ai-status',
      this.getAIStatus.bind(this)
    );

    // Enable AI for a specific attendance
    this.router.post(
      '/:attendanceId/ai-enable',
      this.enableAI.bind(this)
    );

    // Disable AI for a specific attendance
    this.router.post(
      '/:attendanceId/ai-disable',
      this.disableAI.bind(this)
    );

    // Relocation seen (system message + notification only when supervisor was NOT viewing)
    this.router.post(
      '/:attendanceId/relocation-seen',
      this.relocationSeen.bind(this)
    );

    // Manual assignment of attendance to a seller (supervisor / super admin)
    this.router.post(
      '/:attendanceId/assign-seller',
      this.assignSellerToSeller.bind(this)
    );

    // Close attendance manually (supervisor)
    this.router.post(
      '/:attendanceId/close',
      this.closeAttendance.bind(this)
    );
  }

  /**
   * Get contact-wide history for a specific attendance
   * (all attendances of same client phone, filtered by role permissions)
   */
  private async getContactHistory(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const messageRepo = AppDataSource.getRepository(Message);
      const userRepo = AppDataSource.getRepository(User);

      const currentAttendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!currentAttendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Reuse the same permission rule from messages endpoint for selected attendance
      if (userRole === UserRole.SUPERVISOR) {
        if (currentAttendance.sellerId) {
          const sellerRepo = AppDataSource.getRepository(Seller);
          const seller = await sellerRepo.findOne({
            where: { id: currentAttendance.sellerId },
            relations: ['supervisors'],
          });
          const canAccess =
            currentAttendance.supervisorId === userId || seller?.supervisors?.some((s) => s.id === userId);
          if (!canAccess) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }
        }
      } else if (userRole === UserRole.SELLER) {
        if (currentAttendance.sellerId !== userId) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (userRole !== UserRole.SUPER_ADMIN && userRole !== UserRole.ADMIN_GENERAL) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const limit = Math.min(parseInt(req.query.limit as string, 10) || 250, 500);
      const phone = currentAttendance.clientPhone;

      // Build visible attendances for same contact
      const attendancesQb = attendanceRepo
        .createQueryBuilder('a')
        .where('a.clientPhone = :phone', { phone });

      if (userRole === UserRole.SELLER) {
        attendancesQb.andWhere('a.sellerId = :userId', { userId });
      } else if (userRole === UserRole.SUPERVISOR) {
        attendancesQb.andWhere(
          '(a.supervisorId = :userId OR a.sellerId IN (SELECT seller_id FROM seller_supervisors WHERE supervisor_id = :userId))',
          { userId }
        );
      }

      const attendances = await attendancesQb
        .orderBy('a.createdAt', 'DESC')
        .getMany();

      if (!attendances.length) {
        res.json({ success: true, contactPhone: phone, history: [] });
        return;
      }

      const attendanceIds = attendances.map((a) => a.id);
      const attendanceMap = new Map(attendances.map((a) => [a.id, a]));

      const allMessages = await messageRepo
        .createQueryBuilder('m')
        .where('m.attendanceId IN (:...attendanceIds)', { attendanceIds })
        .orderBy('m.sentAt', 'DESC')
        .limit(limit)
        .getMany();

      // Pre-load sender names referenced by metadata.sentBy (when available)
      const senderIds = Array.from(
        new Set(
          allMessages
            .map((m) => m.metadata?.sentBy)
            .filter((id): id is UUID => typeof id === 'string' && id.length > 0)
        )
      );
      const senderUsers = senderIds.length
        ? await userRepo.find({ where: { id: In(senderIds) } })
        : [];
      const senderMap = new Map(senderUsers.map((u) => [u.id, u.name]));

      const grouped = new Map<string, any[]>();
      for (const message of allMessages) {
        const att = attendanceMap.get(message.attendanceId);
        if (!att) continue;

        const isClient = message.origin === MessageOrigin.CLIENT;
        const isFromSeller = message.origin === MessageOrigin.SELLER;
        const isFromAI = message.origin === MessageOrigin.AI;
        const isFromSystem = message.origin === MessageOrigin.SYSTEM;

        let sender = 'Cliente';
        if (isFromSystem) sender = 'Sistema';
        else if (isFromAI) sender = 'AI';
        else if (isFromSeller) sender = message.metadata?.ownerPushName || senderMap.get(message.metadata?.sentBy as UUID) || 'Vendedor';
        else if (isClient && message.metadata?.pushName) sender = String(message.metadata.pushName);

        const item = {
          id: message.id,
          attendanceId: message.attendanceId,
          sender,
          content: message.content,
          origin: message.origin,
          isClient,
          sentAt: message.sentAt.toISOString(),
          mediaUrl: message.metadata?.mediaUrl ?? null,
          mediaType: message.metadata?.mediaType ?? null,
        };

        if (!grouped.has(message.attendanceId)) grouped.set(message.attendanceId, []);
        grouped.get(message.attendanceId)!.push(item);
      }

      const history = attendances.map((a) => ({
        attendanceId: a.id,
        state: a.state,
        handledBy: a.handledBy,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        messages: (grouped.get(a.id) || [])
          .map((m) => ({
            ...m,
            metadata: undefined, // not used currently, kept for forward-compat
          }))
          .sort((m1, m2) => new Date(m1.sentAt).getTime() - new Date(m2.sentAt).getTime()),
      }));

      res.json({
        success: true,
        contactPhone: phone,
        currentAttendanceId: currentAttendance.id,
        history,
      });
    } catch (error: any) {
      logger.error('Error getting contact history', {
        error: error.message,
        stack: error.stack,
        attendanceId: req.params.attendanceId,
        userId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all conversations (attendances) routed to a specific seller
   * Accessible by:
   * - Supervisors: can access conversations of their sellers
   * - Sellers: can access their own conversations
   */
  private async getConversationsBySeller(req: Request, res: Response): Promise<void> {
    try {
      const { sellerId } = req.params;
      const userId = (req as any).user?.sub; // Get user ID from JWT token
      const userRole = (req as any).user?.role; // Get user role from JWT token

      logger.info('Getting conversations by seller', {
        sellerId,
        userId,
        userRole,
        requestUser: (req as any).user,
      });

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Check if user is accessing their own conversations (seller) or supervisor accessing seller's conversations
      if (userRole === UserRole.SELLER) {
        // Seller can only access their own conversations
        if (sellerId !== userId) {
          logger.warn('Seller trying to access another seller\'s conversations', {
            sellerId,
            userId,
          });
          res.status(403).json({ error: 'Access denied: You can only access your own conversations' });
          return;
        }
      } else if (userRole === UserRole.SUPERVISOR) {
        const sellerRepo = AppDataSource.getRepository(Seller);
        const seller = await sellerRepo.findOne({
          where: { id: sellerId as UUID },
          relations: ['user', 'supervisors'],
        });
        const belongsToSupervisor = seller?.supervisors?.some((s) => s.id === userId);
        if (!seller || !belongsToSupervisor) {
          logger.warn('Supervisor trying to access seller not under their supervision', { sellerId, supervisorId: userId });
          res.status(403).json({ error: 'Seller not found or does not belong to this supervisor' });
          return;
        }
      } else {
        logger.warn('Invalid role trying to access conversations', {
          userRole,
          userId,
        });
        res.status(403).json({ error: 'Access denied: Invalid role' });
        return;
      }

      // Get attendances routed to this seller (excluindo fechados)
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      let attendances = await attendanceRepo.find({
        where: { 
          sellerId: sellerId as UUID,
          operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
        },
        relations: ['seller'],
        order: { updatedAt: 'DESC' },
      });
      attendances = await filterBlacklistedAttendances(attendances);

      // Get last message for each attendance
      const messageRepo = AppDataSource.getRepository(Message);
      const conversations = await Promise.all(
        attendances.map(async (attendance) => {
          // Get last message
          const lastMessage = await messageRepo.findOne({
            where: { attendanceId: attendance.id },
            order: { sentAt: 'DESC' },
          });

          // Get unread count (messages from client that haven't been read)
          // Supervisor vendo conversas de vendedor: usar MessageRead do VENDEDOR (se vendedor leu, aparece lido no painel)
          // Vendedor vendo suas conversas: usar sellerId (mesmo id do markAsRead - garantir consistência)
          const messageReadRepo = AppDataSource.getRepository(MessageRead);
          const readUserId = sellerId as UUID;
          const messageRead = await messageReadRepo.findOne({
            where: {
              attendanceId: attendance.id,
              userId: readUserId,
            },
          });

          let unreadCount = 0;
          if (messageRead) {
            // Count only messages sent after last_read_at
            const unreadMessages = await messageRepo.find({
              where: {
                attendanceId: attendance.id,
                origin: MessageOrigin.CLIENT,
              },
            });
            unreadCount = unreadMessages.filter(
              (msg) => new Date(msg.sentAt) > new Date(messageRead.lastReadAt)
            ).length;
            if (unreadCount > 0) {
              logger.info('getConversationsBySeller: unread > 0 DESPITE MessageRead', {
                attendanceId: attendance.id,
                readUserId,
                lastReadAt: messageRead.lastReadAt?.toISOString(),
                messageReadId: messageRead.id,
                clientMessagesAfterRead: unreadMessages
                  .filter((msg) => new Date(msg.sentAt) > new Date(messageRead.lastReadAt))
                  .map((m) => ({ id: m.id, sentAt: m.sentAt?.toISOString(), origin: m.origin, content: m.content?.substring(0, 50) })),
                allClientMessages: unreadMessages.map((m) => ({ id: m.id, sentAt: m.sentAt?.toISOString(), origin: m.origin })),
              });
            }
          } else {
            // If never read, count all client messages
            unreadCount = await messageRepo.count({
              where: {
                attendanceId: attendance.id,
                origin: MessageOrigin.CLIENT,
              },
            });
            if (unreadCount > 0) {
              logger.info('getConversationsBySeller: NO MessageRead found', {
                attendanceId: attendance.id,
                readUserId,
                sellerId,
                userId,
                userRole,
                unreadCount,
              });
            }
          }

          // Format client phone for display (extract name if available)
          const clientPhone = attendance.clientPhone;
          let clientName = clientPhone.split('@')[0]; // Remove @s.whatsapp.net if present
          
          // Try to get pushName from any client message (not just last message)
          // Search for the most recent client message with pushName
          if (!lastMessage?.metadata?.pushName) {
            const clientMessages = await messageRepo.find({
              where: {
                attendanceId: attendance.id,
                origin: MessageOrigin.CLIENT,
              },
              order: { sentAt: 'DESC' },
              take: 10, // Check last 10 client messages
            });
            
            // Find the most recent message with pushName
            for (const msg of clientMessages) {
              if (msg.metadata?.pushName) {
                clientName = msg.metadata.pushName;
                break;
              }
            }
          } else {
            clientName = lastMessage.metadata.pushName;
          }

          return {
            id: attendance.id,
            clientPhone: attendance.clientPhone,
            clientName: clientName,
            lastMessage: lastMessage?.content || '',
            lastMessageTime: lastMessage?.sentAt || attendance.updatedAt,
            lastMessageMediaType: lastMessage?.metadata?.mediaType, // Include media type for display
            unread: unreadCount,
            state: attendance.state,
            handledBy: attendance.handledBy,
            createdAt: attendance.createdAt,
            updatedAt: attendance.updatedAt,
            sellerId: attendance.sellerId,
            sellerSubdivision: attendance.sellerSubdivision,
            interventionType: attendance.interventionType ?? undefined,
            interventionData: attendance.interventionData ?? undefined,
          };
        })
      );

      logger.info('getConversationsBySeller: returning', {
        sellerId,
        userId,
        userRole,
        conversationCount: conversations.length,
        unreadSummary: conversations.map((c: any) => ({ id: c.id, unread: c.unread, clientName: c.clientName?.substring(0, 15) })),
      });

      res.json({
        success: true,
        conversations,
      });
    } catch (error: any) {
      logger.error('Error getting conversations by seller', {
        error: error.message,
        stack: error.stack,
        sellerId: req.params.sellerId,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all pending items (pendências) from all sellers assigned to the supervisor
   */
  private async getSupervisorPendings(req: Request, res: Response): Promise<void> {
    try {
      const supervisorId = (req as any).user?.sub; // Get supervisor ID from JWT token

      if (!supervisorId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Verify supervisor exists and has SUPERVISOR role
      const userRepo = AppDataSource.getRepository(User);
      const supervisorUser = await userRepo.findOne({
        where: { id: supervisorId as UUID },
      });

      if (!supervisorUser || supervisorUser.role !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'User is not a supervisor' });
        return;
      }

      const sellerRepo = AppDataSource.getRepository(Seller);
      const sellers = await getSellersBySupervisorId(sellerRepo, supervisorId as string);
      const sellerIds = sellers.map((s) => s.id);

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      // Atendimentos visíveis: supervisor_id = eu OU vendedor em seller_supervisors
      const visibleQb = attendanceRepo
        .createQueryBuilder('attendance')
        .leftJoinAndSelect('attendance.seller', 'seller')
        .where('attendance.supervisor_id = :supervisorId', { supervisorId })
        .orWhere(
          'attendance.seller_id IN (SELECT seller_id FROM seller_supervisors WHERE supervisor_id = :supervisorId)',
          { supervisorId }
        )
        .andWhere('attendance.operational_state != :closedState', { closedState: OperationalState.FECHADO_OPERACIONAL })
        .orderBy('attendance.updated_at', 'DESC');
      let attendances = await visibleQb.getMany();
      if (sellerIds.length === 0 && attendances.length === 0) {
        res.json({
          success: true,
          pendings: {
            orcamentos: [],
            fechamento: [],
            garantias: [],
            encomendas: [],
            chamadosHumanos: [],
          },
        });
        return;
      }
      attendances = await filterBlacklistedAttendances(attendances);

      // Group pendências by type (usando operationalState em vez de state legacy)
      const IN_PROGRESS_STATES: OperationalState[] = [
        OperationalState.EM_ATENDIMENTO,
        OperationalState.AGUARDANDO_CLIENTE,
        OperationalState.AGUARDANDO_VENDEDOR,
        OperationalState.ABERTO,
      ];
      const isNotClosed = (a: Attendance) =>
        a.operationalState !== OperationalState.FECHADO_OPERACIONAL;
      const isInProgressHuman = (a: Attendance) =>
        a.handledBy === 'HUMAN' &&
        a.operationalState != null &&
        IN_PROGRESS_STATES.includes(a.operationalState);
      const pendings = {
        orcamentos: attendances.filter(a => isNotClosed(a) && a.handledBy === 'AI'),
        fechamento: attendances.filter(isInProgressHuman),
        garantias: [], // TODO: Implement when warranty system is added
        encomendas: [], // TODO: Implement when order system is added
        chamadosHumanos: attendances.filter(a => isNotClosed(a) && a.handledBy === 'HUMAN'),
      };

      // Format response - get pushName from messages
      const messageRepo = AppDataSource.getRepository(Message);
      const formatPending = async (attendance: Attendance) => {
        // Safely extract client name from phone number
        let clientName = attendance.clientPhone || 'N/A';
        if (clientName && clientName.includes('@')) {
          clientName = clientName.split('@')[0];
        }
        
        // Try to get pushName from any client message
        try {
          const clientMessages = await messageRepo.find({
            where: {
              attendanceId: attendance.id,
              origin: MessageOrigin.CLIENT,
            },
            order: { sentAt: 'DESC' },
            take: 10, // Check last 10 client messages
          });
          
          // Find the most recent message with pushName
          for (const msg of clientMessages) {
            if (msg.metadata?.pushName) {
              clientName = msg.metadata.pushName;
              break;
            }
          }
        } catch (error) {
          logger.warn('Error fetching client messages for pending', {
            attendanceId: attendance.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        
        return {
          id: attendance.id,
          clientPhone: attendance.clientPhone || 'N/A',
          clientName: clientName,
          sellerId: attendance.sellerId,
          sellerName: attendance.seller?.name || 'N/A',
          vehicleBrand: attendance.vehicleBrand || null,
          state: attendance.state,
          handledBy: attendance.handledBy,
          createdAt: attendance.createdAt.toISOString(),
          updatedAt: attendance.updatedAt.toISOString(),
        };
      };

      res.json({
        success: true,
        pendings: {
          orcamentos: await Promise.all(pendings.orcamentos.map(formatPending)),
          fechamento: await Promise.all(pendings.fechamento.map(formatPending)),
          garantias: await Promise.all(pendings.garantias.map(formatPending)),
          encomendas: await Promise.all(pendings.encomendas.map(formatPending)),
          chamadosHumanos: await Promise.all(pendings.chamadosHumanos.map(formatPending)),
        },
      });
    } catch (error: any) {
      logger.error('Error getting supervisor pendings', {
        error: error.message,
        stack: error.stack,
        supervisorId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all unassigned attendances (sellerId = null).
   * Query ?filter=todos|triagem|encaminhados-ecommerce|encaminhados-balcao (default: todos)
   * - todos: todos os não atribuídos (triagem + ecommerce + balcão), cada item com unassignedSource para badge
   * - triagem: operationalState TRIAGEM + isTriagem (sem interventionType ecommerce/balcão/etc). identificamarca roteia → ABERTO + sellerId → sai da triagem.
   * - encaminhados-ecommerce: intervention_type = encaminhados-ecommerce (inclui interventionData)
   * - encaminhados-balcao: intervention_type = encaminhados-balcao (inclui interventionData)
   */
  private async getUnassignedAttendances(req: Request, res: Response): Promise<void> {
    try {
      const supervisorId = (req as any).user?.sub;

      if (!supervisorId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const userRepo = AppDataSource.getRepository(User);
      const supervisorUser = await userRepo.findOne({
        where: { id: supervisorId as UUID },
      });

      if (!supervisorUser || supervisorUser.role !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'User is not a supervisor' });
        return;
      }

      const filter = (req.query.filter as string) || 'todos';
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      
      // IMPORTANTE: Filtrar attendances SEM sellerId (não roteados), não finalizados e NÃO FECHADOS
      // sellerId null garante que não foram roteados para vendedores
      // operationalState != FECHADO_OPERACIONAL garante que atendimentos fechados não aparecem
      let allUnassigned = await attendanceRepo.find({
        where: { 
          sellerId: null, 
          isFinalized: false,
          operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
        },
        order: { updatedAt: 'DESC' },
      });
      allUnassigned = await filterBlacklistedAttendances(allUnassigned);

      const isTriagem = (a: Attendance) =>
        a.interventionType !== 'demanda-telefone-fixo' &&
        a.interventionType !== 'encaminhados-ecommerce' &&
        a.interventionType !== 'encaminhados-balcao' &&
        a.interventionType !== 'protese-capilar' &&
        a.interventionType !== 'outros-assuntos';

      /** Triagem = apenas operationalState TRIAGEM (estado inicial). identificamarca roteia → ABERTO + sellerId → sai da triagem. */
      const isTriagemState = (a: Attendance) =>
        a.operationalState === OperationalState.TRIAGEM || a.operationalState == null;

      let attendances: typeof allUnassigned;
      if (filter === 'todos') {
        // Triagem exige operationalState TRIAGEM (evita exibir atendimentos com estado ABERTO que ficaram sem sellerId)
        attendances = allUnassigned.filter((a) => (isTriagem(a) && isTriagemState(a)) || a.interventionType === 'encaminhados-ecommerce' || a.interventionType === 'encaminhados-balcao');
      } else if (filter === 'triagem') {
        attendances = allUnassigned.filter((a) => isTriagem(a) && isTriagemState(a));
      } else if (filter === 'encaminhados-ecommerce') {
        attendances = allUnassigned.filter((a) => a.interventionType === 'encaminhados-ecommerce');
      } else if (filter === 'encaminhados-balcao') {
        attendances = allUnassigned.filter((a) => a.interventionType === 'encaminhados-balcao');
      } else {
        attendances = allUnassigned.filter((a) => isTriagem(a) && isTriagemState(a));
      }
      attendances = await filterBlacklistedAttendances(attendances);

      // Get last message for each attendance
      const messageRepo = AppDataSource.getRepository(Message);
      const conversations = await Promise.all(
        attendances.map(async (attendance) => {
          // Get last message
          const lastMessage = await messageRepo.findOne({
            where: { attendanceId: attendance.id },
            order: { sentAt: 'DESC' },
          });

          // Get unread count (messages from client that haven't been read)
          // Check if user has read this attendance
          const messageReadRepo = AppDataSource.getRepository(MessageRead);
          const messageRead = await messageReadRepo.findOne({
            where: {
              attendanceId: attendance.id,
              userId: (req as any).user?.sub as UUID,
            },
          });

          let unreadCount = 0;
          if (messageRead) {
            // Get count of messages sent after last_read_at
            const unreadMessages = await messageRepo.find({
              where: {
                attendanceId: attendance.id,
                origin: MessageOrigin.CLIENT,
              },
            });
            unreadCount = unreadMessages.filter(
              (msg) => new Date(msg.sentAt) > new Date(messageRead.lastReadAt)
            ).length;
          } else {
            // If never read, count all client messages
            unreadCount = await messageRepo.count({
              where: {
                attendanceId: attendance.id,
                origin: MessageOrigin.CLIENT,
              },
            });
          }

          // Extract client name from phone number or metadata
          const clientPhone = attendance.clientPhone;
          let clientName = clientPhone.split('@')[0]; // Remove @s.whatsapp.net if present
          
          // Try to get pushName from any client message (not just last message)
          // Search for the most recent client message with pushName
          if (!lastMessage?.metadata?.pushName) {
            const clientMessages = await messageRepo.find({
              where: {
                attendanceId: attendance.id,
                origin: MessageOrigin.CLIENT,
              },
              order: { sentAt: 'DESC' },
              take: 10, // Check last 10 client messages
            });
            
            // Find the most recent message with pushName
            for (const msg of clientMessages) {
              if (msg.metadata?.pushName) {
                clientName = msg.metadata.pushName;
                break;
              }
            }
          } else {
            clientName = lastMessage.metadata.pushName;
          }

          const unassignedSource: 'triagem' | 'encaminhados-ecommerce' | 'encaminhados-balcao' =
            attendance.interventionType === 'encaminhados-ecommerce'
              ? 'encaminhados-ecommerce'
              : attendance.interventionType === 'encaminhados-balcao'
                ? 'encaminhados-balcao'
                : 'triagem';

          const item: Record<string, unknown> = {
            id: attendance.id,
            clientPhone: attendance.clientPhone,
            clientName: clientName,
            lastMessage: lastMessage?.content || '',
            lastMessageTime: lastMessage?.sentAt || attendance.updatedAt,
            lastMessageMediaType: lastMessage?.metadata?.mediaType,
            unread: unreadCount,
            state: attendance.state,
            handledBy: attendance.handledBy,
            vehicleBrand: attendance.vehicleBrand,
            createdAt: attendance.createdAt.toISOString(),
            updatedAt: attendance.updatedAt.toISOString(),
          };
          if (filter === 'todos') {
            item.unassignedSource = unassignedSource;
          }
          if (filter === 'encaminhados-ecommerce' || filter === 'encaminhados-balcao' || (filter === 'todos' && unassignedSource !== 'triagem')) {
            item.interventionData = attendance.interventionData ?? undefined;
            item.interventionType = attendance.interventionType ?? undefined;
          }
          return item;
        })
      );

      res.json({
        success: true,
        conversations,
      });
    } catch (error: any) {
      logger.error('Error getting unassigned attendances', {
        error: error.message,
        stack: error.stack,
        supervisorId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get attendances roteados para "Demanda telefone fixo" (Intervenção humana).
   * Só supervisores. Retorna mesmo formato que unassigned, com interventionData em cada item.
   */
  private async getInterventionDemandaTelefoneFixo(req: Request, res: Response): Promise<void> {
    try {
      const supervisorId = (req as any).user?.sub;
      if (!supervisorId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const userRepo = AppDataSource.getRepository(User);
      const supervisorUser = await userRepo.findOne({
        where: { id: supervisorId as UUID },
      });
      if (!supervisorUser || supervisorUser.role !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'User is not a supervisor' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      let attendances = await attendanceRepo.find({
        where: {
          interventionType: 'demanda-telefone-fixo',
          operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
        },
        order: { updatedAt: 'DESC' },
      });
      attendances = await filterBlacklistedAttendances(attendances);

      const messageRepo = AppDataSource.getRepository(Message);
      const conversations = await Promise.all(
        attendances.map(async (attendance) => {
          const lastMessage = await messageRepo.findOne({
            where: { attendanceId: attendance.id },
            order: { sentAt: 'DESC' },
          });

          const messageReadRepo = AppDataSource.getRepository(MessageRead);
          const messageRead = await messageReadRepo.findOne({
            where: {
              attendanceId: attendance.id,
              userId: (req as any).user?.sub as UUID,
            },
          });

          let unreadCount = 0;
          if (messageRead) {
            const unreadMessages = await messageRepo.find({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
            });
            unreadCount = unreadMessages.filter(
              (msg) => new Date(msg.sentAt) > new Date(messageRead.lastReadAt)
            ).length;
          } else {
            unreadCount = await messageRepo.count({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
            });
          }

          let clientName = attendance.clientPhone?.split('@')[0] ?? 'N/A';
          if (!lastMessage?.metadata?.pushName) {
            const clientMessages = await messageRepo.find({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
              order: { sentAt: 'DESC' },
              take: 10,
            });
            for (const msg of clientMessages) {
              if (msg.metadata?.pushName) {
                clientName = msg.metadata.pushName;
                break;
              }
            }
          } else {
            clientName = lastMessage.metadata.pushName;
          }

          return {
            id: attendance.id,
            clientPhone: attendance.clientPhone,
            clientName,
            lastMessage: lastMessage?.content || '',
            lastMessageTime: lastMessage?.sentAt || attendance.updatedAt,
            lastMessageMediaType: lastMessage?.metadata?.mediaType,
            unread: unreadCount,
            state: attendance.state,
            handledBy: attendance.handledBy,
            vehicleBrand: attendance.vehicleBrand,
            createdAt: attendance.createdAt.toISOString(),
            updatedAt: attendance.updatedAt.toISOString(),
            interventionData: attendance.interventionData ?? undefined,
          };
        })
      );

      res.json({ success: true, conversations });
    } catch (error: any) {
      logger.error('Error getting intervention demanda-telefone-fixo', {
        error: error.message,
        supervisorId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get attendances por intervention type (ex.: garantia, troca, estorno).
   * Mesmo formato que getInterventionDemandaTelefoneFixo, com interventionData em cada item.
   */
  private async getInterventionByType(req: Request, res: Response): Promise<void> {
    try {
      const type = (req.params.type as string)?.toLowerCase();
      if (!type || type === 'demanda-telefone-fixo') {
        res.status(400).json({ error: 'Invalid intervention type' });
        return;
      }

      const supervisorId = (req as any).user?.sub;
      if (!supervisorId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const userRepo = AppDataSource.getRepository(User);
      const supervisorUser = await userRepo.findOne({
        where: { id: supervisorId as UUID },
      });
      if (!supervisorUser || supervisorUser.role !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'User is not a supervisor' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      let attendances = await attendanceRepo.find({
        where: {
          interventionType: type,
          operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
        },
        order: { updatedAt: 'DESC' },
      });
      attendances = await filterBlacklistedAttendances(attendances);

      const messageRepo = AppDataSource.getRepository(Message);
      const conversations = await Promise.all(
        attendances.map(async (attendance) => {
          const lastMessage = await messageRepo.findOne({
            where: { attendanceId: attendance.id },
            order: { sentAt: 'DESC' },
          });

          const messageReadRepo = AppDataSource.getRepository(MessageRead);
          const messageRead = await messageReadRepo.findOne({
            where: {
              attendanceId: attendance.id,
              userId: (req as any).user?.sub as UUID,
            },
          });

          let unreadCount = 0;
          if (messageRead) {
            const unreadMessages = await messageRepo.find({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
            });
            unreadCount = unreadMessages.filter(
              (msg) => new Date(msg.sentAt) > new Date(messageRead.lastReadAt)
            ).length;
          } else {
            unreadCount = await messageRepo.count({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
            });
          }

          let clientName = attendance.clientPhone?.split('@')[0] ?? 'N/A';
          if (!lastMessage?.metadata?.pushName) {
            const clientMessages = await messageRepo.find({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
              order: { sentAt: 'DESC' },
              take: 10,
            });
            for (const msg of clientMessages) {
              if (msg.metadata?.pushName) {
                clientName = msg.metadata.pushName;
                break;
              }
            }
          } else {
            clientName = lastMessage.metadata.pushName;
          }

          return {
            id: attendance.id,
            clientPhone: attendance.clientPhone,
            clientName,
            lastMessage: lastMessage?.content || '',
            lastMessageTime: lastMessage?.sentAt || attendance.updatedAt,
            lastMessageMediaType: lastMessage?.metadata?.mediaType,
            unread: unreadCount,
            state: attendance.state,
            handledBy: attendance.handledBy,
            vehicleBrand: attendance.vehicleBrand,
            createdAt: attendance.createdAt.toISOString(),
            updatedAt: attendance.updatedAt.toISOString(),
            interventionType: type,
            interventionData: attendance.interventionData ?? undefined,
          };
        })
      );

      res.json({ success: true, conversations });
    } catch (error: any) {
      logger.error('Error getting intervention by type', {
        error: error.message,
        type: req.params.type,
        supervisorId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /** Label for intervention type (extensible for future types) */
  private static interventionTypeLabel(type: string): string {
    const map: Record<string, string> = {
      'demanda-telefone-fixo': 'Demanda telefone fixo',
      'protese-capilar': 'Protese capilar',
      'outros-assuntos': 'Outros assuntos',
      'casos_gerentes': 'Casos gerentes',
    };
    return map[type] ?? type.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  }

  private static brandLabel(brand: VehicleBrand | null | undefined): string {
    if (!brand) return '';
    const map: Record<string, string> = {
      [VehicleBrand.FORD]: 'Ford',
      [VehicleBrand.GM]: 'GM',
      [VehicleBrand.VW]: 'Volkswagen',
      [VehicleBrand.FIAT]: 'Fiat',
      [VehicleBrand.IMPORTADOS]: 'Importados',
    };
    return map[brand] ?? String(brand);
  }

  /**
   * Get all attributed attendances (seller OR intervention) for "Atribuídos" tab.
   * Each conversation includes attributionSource: { type, label } for card badge.
   */
  private async getAttributedAttendances(req: Request, res: Response): Promise<void> {
    try {
      const supervisorId = (req as any).user?.sub;
      if (!supervisorId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const attributedCacheKey = `sup:${supervisorId}`;
      const cachedAttributed = this.attributedConversationsCache.get(attributedCacheKey);
      if (cachedAttributed && cachedAttributed.expiresAt > Date.now()) {
        res.json({ success: true, conversations: cachedAttributed.conversations });
        return;
      }

      const userRepo = AppDataSource.getRepository(User);
      const supervisorUser = await userRepo.findOne({ where: { id: supervisorId as UUID } });
      if (!supervisorUser || supervisorUser.role !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'User is not a supervisor' });
        return;
      }

      const sellerRepo = AppDataSource.getRepository(Seller);
      const sellers = await getSellersBySupervisorId(sellerRepo, supervisorId as string);
      const sellerIds = sellers.map((s) => s.id);
      const sellerMap = new Map<string, { name: string; brands: VehicleBrand[] }>();
      sellers.forEach((s) => {
        sellerMap.set(s.id, { name: s.user?.name ?? 'Vendedor', brands: s.brands ?? [] });
      });

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      // Atendimentos visíveis ao supervisor: supervisor_id = eu OU vendedor em seller_supervisors
      // Excluir fechados: aba Atribuídos não deve exibir atendimentos em FECHADO_OPERACIONAL
      const qb = attendanceRepo
        .createQueryBuilder('a')
        .where('(a.operational_state IS NULL OR a.operational_state != :closedState)', {
          closedState: OperationalState.FECHADO_OPERACIONAL,
        })
        .andWhere(
          '(a.supervisor_id = :supervisorId OR a.seller_id IN (SELECT seller_id FROM seller_supervisors WHERE supervisor_id = :supervisorId))',
          { supervisorId }
        )
        .orderBy('a.updated_at', 'DESC');

      const interventionTypes = ['demanda-telefone-fixo', 'protese-capilar', 'outros-assuntos'];
      if (sellerIds.length) {
        qb.andWhere(
          '(a.seller_id IN (:...sellerIds) OR a.intervention_type IN (:...interventionTypes))',
          { sellerIds, interventionTypes }
        );
      } else {
        qb.andWhere('a.intervention_type IN (:...interventionTypes)', { interventionTypes });
      }

      let attendances = await qb.getMany();
      attendances = await filterBlacklistedAttendances(attendances);

      const messageRepo = AppDataSource.getRepository(Message);
      const messageReadRepo = AppDataSource.getRepository(MessageRead);
      const supervisorUserId = supervisorId as UUID;

      const conversations = await Promise.all(
        attendances.map(async (attendance) => {
          const lastMessage = await messageRepo.findOne({
            where: { attendanceId: attendance.id },
            order: { sentAt: 'DESC' },
          });

          // Atribuído a vendedor: usar MessageRead do vendedor (se vendedor leu, aparece lido no painel do supervisor)
          // Intervenção humana (sem vendedor): usar MessageRead do supervisor
          const readUserId = attendance.sellerId ?? supervisorUserId;
          const messageRead = await messageReadRepo.findOne({
            where: { attendanceId: attendance.id, userId: readUserId },
          });
          let unreadCount = 0;
          if (messageRead) {
            const unreadMessages = await messageRepo.find({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
            });
            unreadCount = unreadMessages.filter(
              (msg) => new Date(msg.sentAt) > new Date(messageRead.lastReadAt)
            ).length;
          } else {
            unreadCount = await messageRepo.count({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
            });
          }

          let clientName = attendance.clientPhone?.split('@')[0] ?? 'N/A';
          if (!lastMessage?.metadata?.pushName) {
            const clientMessages = await messageRepo.find({
              where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
              order: { sentAt: 'DESC' },
              take: 10,
            });
            for (const msg of clientMessages) {
              if (msg.metadata?.pushName) {
                clientName = msg.metadata.pushName;
                break;
              }
            }
          } else {
            clientName = lastMessage.metadata.pushName;
          }

          let attributionSource: { type: 'intervention' | 'seller'; label: string; interventionType?: string; sellerId?: string; sellerName?: string; vehicleBrand?: string };
          if (attendance.interventionType) {
            const label = AttendanceController.interventionTypeLabel(attendance.interventionType);
            attributionSource = {
              type: 'intervention',
              label,
              interventionType: attendance.interventionType,
            };
          } else if (attendance.sellerId) {
            const info = sellerMap.get(attendance.sellerId);
            const sellerName = info?.name ?? 'Vendedor';
            const brand = attendance.vehicleBrand ?? info?.brands?.[0];
            const brandStr = AttendanceController.brandLabel(brand);
            const label = brandStr ? `${brandStr} → ${sellerName}` : sellerName;
            attributionSource = {
              type: 'seller',
              label,
              sellerId: attendance.sellerId,
              sellerName,
              vehicleBrand: brand ?? undefined,
            };
          } else {
            attributionSource = { type: 'seller', label: 'Atribuído' };
          }

          return {
            id: attendance.id,
            clientPhone: attendance.clientPhone,
            clientName,
            lastMessage: lastMessage?.content || '',
            lastMessageTime: lastMessage?.sentAt || attendance.updatedAt,
            lastMessageMediaType: lastMessage?.metadata?.mediaType,
            unread: unreadCount,
            state: attendance.state,
            handledBy: attendance.handledBy,
            vehicleBrand: attendance.vehicleBrand,
            createdAt: attendance.createdAt.toISOString(),
            updatedAt: attendance.updatedAt.toISOString(),
            interventionType: attendance.interventionType ?? undefined,
            interventionData: attendance.interventionData ?? undefined,
            attributionSource,
            sellerSubdivision: attendance.sellerSubdivision,
          };
        })
      );

      this.attributedConversationsCache.set(attributedCacheKey, {
        conversations,
        expiresAt: Date.now() + 10000, // 10s
      });
      res.json({ success: true, conversations });
    } catch (error: any) {
      logger.error('Error getting attributed attendances', {
        error: error.message,
        supervisorId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get closed attendances (Fechados - operationalState = FECHADO_OPERACIONAL)
   */
  private async getFechadosAttendances(req: Request, res: Response): Promise<void> {
    try {
      const supervisorId = (req as any).user?.sub;
      if (!supervisorId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const userRepo = AppDataSource.getRepository(User);
      const sup = await userRepo.findOne({ where: { id: supervisorId as UUID } });
      if (!sup || sup.role !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'User not a supervisor' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const messageRepo = AppDataSource.getRepository(Message);

      // Buscar atendimentos fechados, ordenados por finalizedAt DESC
      // IMPORTANTE: Excluir atendimentos fechados sem mensagens (geralmente são resultado de merge)
      const allFechados = await attendanceRepo.find({
        where: { operationalState: OperationalState.FECHADO_OPERACIONAL },
        relations: ['seller', 'supervisor'],
        order: { finalizedAt: 'DESC' },
        take: 100, // Limitar para performance
      });

      // Filtrar apenas atendimentos que têm pelo menos uma mensagem
      const fechadosWithMessages = await Promise.all(
        allFechados.map(async (att) => {
          const messageCount = await messageRepo.count({
            where: { attendanceId: att.id },
          });
          return messageCount > 0 ? att : null;
        })
      );

      let fechados = fechadosWithMessages.filter((att) => att !== null) as Attendance[];
      fechados = await filterBlacklistedAttendances(fechados);

      const conversations = await Promise.all(
        fechados.map(async (att) => {
          const lastMsg = await messageRepo.findOne({
            where: { attendanceId: att.id },
            order: { sentAt: 'DESC' },
          });
          
          // Buscar nome do cliente das mensagens se não estiver salvo
          let clientName = (att.aiContext?.clientName as string | undefined) ?? null;
          if (!clientName) {
            // Buscar da última mensagem do cliente
            const lastClientMsg = await messageRepo.findOne({
              where: { 
                attendanceId: att.id,
                origin: MessageOrigin.CLIENT,
              },
              order: { sentAt: 'DESC' },
            });
            
            if (lastClientMsg?.metadata?.pushName) {
              clientName = lastClientMsg.metadata.pushName as string;
            } else {
              // Buscar em todas as mensagens do cliente
              const clientMessages = await messageRepo.find({
                where: { 
                  attendanceId: att.id,
                  origin: MessageOrigin.CLIENT,
                },
                order: { sentAt: 'DESC' },
                take: 10,
              });
              
              for (const msg of clientMessages) {
                if (msg.metadata?.pushName) {
                  clientName = msg.metadata.pushName as string;
                  break;
                }
              }
            }
          }
          
          return {
            id: att.id,
            clientPhone: att.clientPhone,
            clientName: clientName || att.clientPhone?.split('@')[0] || 'Desconhecido',
            lastMessage: lastMsg?.content || null,
            lastMessageAt: lastMsg?.sentAt || att.updatedAt,
            unreadCount: 0, // Fechados não têm não lidas
            operationalState: att.operationalState,
            handledBy: att.handledBy,
            seller: att.seller
              ? { id: att.seller.id, name: att.seller.name }
              : null,
            supervisor: att.supervisor
              ? { id: att.supervisor.id, name: att.supervisor.name }
              : null,
            vehicleBrand: att.vehicleBrand,
            finalizedAt: att.finalizedAt,
          };
        })
      );

      res.json({ success: true, conversations });
    } catch (error: any) {
      logger.error('Error getting fechados attendances', {
        error: error.message,
        supervisorId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get closed attendances for a seller (only their own).
   * GET /attendances/seller/:sellerId/fechados
   */
  private async getFechadosBySeller(req: Request, res: Response): Promise<void> {
    try {
      const { sellerId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role as UserRole;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (userRole === UserRole.SELLER && sellerId !== userId) {
        res.status(403).json({ error: 'You can only access your own closed attendances' });
        return;
      }

      if (userRole === UserRole.SUPERVISOR) {
        const sellerRepo = AppDataSource.getRepository(Seller);
        const seller = await sellerRepo.findOne({
          where: { id: sellerId as UUID },
          relations: ['user', 'supervisors'],
        });
        if (!seller || !seller.supervisors?.some((s) => s.id === userId)) {
          res.status(403).json({ error: 'Seller not found or does not belong to this supervisor' });
          return;
        }
      } else if (userRole !== UserRole.SELLER) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const messageRepo = AppDataSource.getRepository(Message);

      const allFechados = await attendanceRepo.find({
        where: {
          operationalState: OperationalState.FECHADO_OPERACIONAL,
          sellerId: sellerId as UUID,
        },
        relations: ['seller'],
        order: { finalizedAt: 'DESC' },
        take: 100,
      });

      const fechadosWithMessages = await Promise.all(
        allFechados.map(async (att) => {
          const messageCount = await messageRepo.count({
            where: { attendanceId: att.id },
          });
          return messageCount > 0 ? att : null;
        })
      );

      let fechados = fechadosWithMessages.filter((att) => att !== null) as Attendance[];
      fechados = await filterBlacklistedAttendances(fechados);

      const conversations = await Promise.all(
        fechados.map(async (att) => {
          const lastMsg = await messageRepo.findOne({
            where: { attendanceId: att.id },
            order: { sentAt: 'DESC' },
          });
          let clientName = (att.aiContext?.clientName as string | undefined) ?? null;
          if (!clientName) {
            const lastClientMsg = await messageRepo.findOne({
              where: { attendanceId: att.id, origin: MessageOrigin.CLIENT },
              order: { sentAt: 'DESC' },
            });
            if (lastClientMsg?.metadata?.pushName) {
              clientName = lastClientMsg.metadata.pushName as string;
            } else {
              const clientMessages = await messageRepo.find({
                where: { attendanceId: att.id, origin: MessageOrigin.CLIENT },
                order: { sentAt: 'DESC' },
                take: 10,
              });
              for (const msg of clientMessages) {
                if (msg.metadata?.pushName) {
                  clientName = msg.metadata.pushName as string;
                  break;
                }
              }
            }
          }
          return {
            id: att.id,
            clientPhone: att.clientPhone,
            clientName: clientName || att.clientPhone?.split('@')[0] || 'Desconhecido',
            lastMessage: lastMsg?.content || null,
            lastMessageAt: lastMsg?.sentAt || att.updatedAt,
            unreadCount: 0,
            operationalState: att.operationalState,
            handledBy: att.handledBy,
            vehicleBrand: att.vehicleBrand,
            finalizedAt: att.finalizedAt,
          };
        })
      );

      res.json({ success: true, conversations });
    } catch (error: any) {
      logger.error('Error getting fechados by seller', {
        error: error.message,
        sellerId: req.params.sellerId,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get active attendance counts per subdivision (for supervisor sidebar).
   * Ativos = isFinalized: false.
   * Keys: triagem, encaminhados-ecommerce, encaminhados-balcao, demanda-telefone-fixo, outros-assuntos, garantia, troca, estorno, seller-{id}-{sub}.
   */
  private async getSubdivisionCounts(req: Request, res: Response): Promise<void> {
    try {
      const supervisorId = (req as any).user?.sub;
      if (!supervisorId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const countsCacheKey = `sup:${supervisorId}`;
      const bustCache = req.query.bust === '1';
      if (!bustCache) {
        const cachedCounts = subdivisionCountsCache.get(countsCacheKey);
        if (cachedCounts && cachedCounts.expiresAt > Date.now()) {
          res.json({ success: true, counts: cachedCounts.counts });
          return;
        }
      }
      const userRepo = AppDataSource.getRepository(User);
      const sup = await userRepo.findOne({ where: { id: supervisorId as UUID } });
      if (!sup || sup.role !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'User not a supervisor' });
        return;
      }
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const counts: Record<string, number> = {};

      const isTriagem = (a: Attendance) =>
        a.interventionType !== 'demanda-telefone-fixo' &&
        a.interventionType !== 'encaminhados-ecommerce' &&
        a.interventionType !== 'encaminhados-balcao' &&
        a.interventionType !== 'protese-capilar' &&
        a.interventionType !== 'outros-assuntos';
      const isTriagemState = (a: Attendance) =>
        a.operationalState === OperationalState.TRIAGEM || a.operationalState == null;

      const allUnassigned = await attendanceRepo.find({
        where: { 
          sellerId: null as any, 
          isFinalized: false,
          operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
        },
        select: ['id', 'interventionType', 'operationalState'],
      });
      counts['triagem'] = allUnassigned.filter((a) => isTriagem(a) && isTriagemState(a)).length;
      counts['encaminhados-ecommerce'] = allUnassigned.filter((a) => a.interventionType === 'encaminhados-ecommerce').length;
      counts['encaminhados-balcao'] = allUnassigned.filter((a) => a.interventionType === 'encaminhados-balcao').length;

      const interventionTypes = ['demanda-telefone-fixo', 'protese-capilar', 'outros-assuntos'] as const;
      const interventionRows = await attendanceRepo
        .createQueryBuilder('a')
        .select('a.intervention_type', 'interventionType')
        .addSelect('COUNT(*)', 'count')
        .where('a.is_finalized = :fin', { fin: false })
        .andWhere('a.operational_state != :closed', { closed: OperationalState.FECHADO_OPERACIONAL })
        .andWhere('a.intervention_type IN (:...types)', { types: interventionTypes as unknown as string[] })
        .groupBy('a.intervention_type')
        .getRawMany();
      const interventionMap = new Map<string, number>();
      for (const row of interventionRows) interventionMap.set(row.interventionType, parseInt(row.count, 10) || 0);
      for (const t of interventionTypes) counts[t] = interventionMap.get(t) || 0;

      const sellerRepo = AppDataSource.getRepository(Seller);
      const sellers = await getSellersBySupervisorId(sellerRepo, supervisorId as string, { withUser: false });
      const sellerIds = sellers.map((s) => s.id);

      // Contar atendimentos ativos por vendedor (consulta agregada única)
      if (sellerIds.length > 0) {
        const sellerTotalRows = await attendanceRepo
          .createQueryBuilder('a')
          .select('a.seller_id', 'sellerId')
          .addSelect('COUNT(*)', 'count')
          .where('a.is_finalized = :fin', { fin: false })
          .andWhere('a.operational_state != :closed', { closed: OperationalState.FECHADO_OPERACIONAL })
          .andWhere('a.seller_id IN (:...sellerIds)', { sellerIds })
          .groupBy('a.seller_id')
          .getRawMany();
        for (const row of sellerTotalRows) {
          const total = parseInt(row.count, 10) || 0;
          if (total > 0) counts[`seller-${row.sellerId}`] = total;
        }
      }

      // Contagem total "Atribuídos": atendimentos com vendedor do supervisor + pedidos-orcamentos sem vendedor
      const attributedQb = attendanceRepo
        .createQueryBuilder('a')
        .where('a.is_finalized = :fin', { fin: false })
        .andWhere('a.operational_state != :closed', { closed: OperationalState.FECHADO_OPERACIONAL });
      if (sellerIds.length > 0) {
        attributedQb.andWhere(
          '(a.seller_id IN (:...sellerIds) OR (a.seller_id IS NULL AND a.seller_subdivision = :pedidosOrc))',
          { sellerIds, pedidosOrc: 'pedidos-orcamentos' }
        );
      } else {
        attributedQb.andWhere('a.seller_id IS NULL AND a.seller_subdivision = :pedidosOrc', {
          pedidosOrc: 'pedidos-orcamentos',
        });
      }
      counts['attributed'] = await attributedQb.getCount();

      // Total "Abertos": todos os atendimentos não fechados visíveis ao supervisor
      const openQb = attendanceRepo
        .createQueryBuilder('a')
        .where('a.is_finalized = :fin', { fin: false })
        .andWhere('a.operational_state != :closed', { closed: OperationalState.FECHADO_OPERACIONAL })
        .andWhere(
          '(a.seller_id IS NULL OR a.supervisor_id = :supervisorId OR a.seller_id IN (SELECT seller_id FROM seller_supervisors WHERE supervisor_id = :supervisorId))',
          { supervisorId }
        );
      counts['abertos'] = await openQb.getCount();
      
      // Contar APENAS pendências (quote_requests) por subdivisão
      // "Todas as Demandas" exibe quote_requests, não conversas de chat
      const subKeys = [
        'pedidos-orcamentos',
        'perguntas-pos-orcamento',
        'confirmacao-pix',
        'tirar-pedido',
        'informacoes-entrega',
        'encomendas',
        'cliente-pediu-humano',
      ];
      
      const quoteRequestRepo = AppDataSource.getRepository(QuoteRequest);
      
      if (sellerIds.length > 0) {
        const quotePendingRows = await quoteRequestRepo
          .createQueryBuilder('q')
          .select('q.seller_id', 'sellerId')
          .addSelect('q.seller_subdivision', 'sellerSubdivision')
          .addSelect('COUNT(*)', 'count')
          .where('q.seller_id IN (:...sellerIds)', { sellerIds })
          .andWhere('q.seller_subdivision IN (:...subKeys)', { subKeys })
          .andWhere('q.status IN (:...statuses)', { statuses: ['pendente', 'em_elaboracao'] })
          .groupBy('q.seller_id')
          .addGroupBy('q.seller_subdivision')
          .getRawMany();
        for (const row of quotePendingRows) {
          const total = parseInt(row.count, 10) || 0;
          if (total > 0) counts[`seller-${row.sellerId}-${row.sellerSubdivision}`] = total;
        }
      }

      // Contagem global de pedidos de orçamento (inclui os sem vendedor) para "Todas as Demandas"
      const sellerIdsForQuotes = sellers.map((s) => s.id);
      const pedidosOrcQb = quoteRequestRepo
        .createQueryBuilder('q')
        .where('q.seller_subdivision = :sub', { sub: 'pedidos-orcamentos' })
        .andWhere('q.status IN (:...statuses)', { statuses: ['pendente', 'em_elaboracao'] });
      if (sellerIdsForQuotes.length > 0) {
        pedidosOrcQb.andWhere('(q.seller_id IN (:...ids) OR q.seller_id IS NULL)', { ids: sellerIdsForQuotes });
      } else {
        pedidosOrcQb.andWhere('q.seller_id IS NULL');
      }
      const pedidosOrcTotal = await pedidosOrcQb.getCount();
      if (pedidosOrcTotal > 0) counts['pedidos-orcamentos'] = pedidosOrcTotal;

      // Contagem de fechados (FECHADO_OPERACIONAL) - apenas os que têm mensagens
      // IMPORTANTE: Excluir atendimentos fechados sem mensagens (geralmente são resultado de merge)
      // Usar subquery para eficiência
      const fechadosCountResult = await attendanceRepo
        .createQueryBuilder('a')
        .innerJoin(Message, 'm', 'm.attendanceId = a.id')
        .where('a.operationalState = :state', { state: OperationalState.FECHADO_OPERACIONAL })
        .select('COUNT(DISTINCT a.id)', 'count')
        .getRawOne();
      counts['fechados'] = parseInt(fechadosCountResult?.count || '0', 10);

      // Contagens Follow up (fluxo 1h/24h/36h):
      // - inativo-1h: >1h sem resposta e aguardando 1º follow-up
      // - inativo-12h: já recebeu 1º follow-up e aguarda 2º (24h)
      // - inativo-24h: já recebeu 2º follow-up e permanece até 36h de inatividade
      // - follow-up: soma das 3 fases acima
      const followUpBaseWhere =
        "a.is_finalized = :fin AND a.operational_state = :awaitingClient AND a.last_client_message_at IS NOT NULL AND (a.seller_id IS NULL OR a.supervisor_id = :supervisorId OR a.seller_id IN (SELECT seller_id FROM seller_supervisors WHERE supervisor_id = :supervisorId)) AND COALESCE(a.ai_context->>'closedManually', 'false') != 'true' AND EXISTS (SELECT 1 FROM messages mr WHERE mr.attendance_id = a.id AND mr.origin IN (:aiOrigin, :sellerOrigin) AND mr.sent_at >= a.last_client_message_at) AND NOT (a.intervention_type IS NOT NULL AND COALESCE((SELECT m.origin FROM messages m WHERE m.attendance_id = a.id ORDER BY m.sent_at DESC LIMIT 1), :clientOrigin) != :clientOrigin)";
      const followUpParams = {
        fin: false,
        awaitingClient: OperationalState.AGUARDANDO_CLIENTE,
        supervisorId,
        clientOrigin: MessageOrigin.CLIENT,
        aiOrigin: MessageOrigin.AI,
        sellerOrigin: MessageOrigin.SELLER,
      };
      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);
      const thirtySixHoursAgo = new Date();
      thirtySixHoursAgo.setHours(thirtySixHoursAgo.getHours() - 36);

      counts['inativo-1h'] = await attendanceRepo
        .createQueryBuilder('a')
        .where(
          followUpBaseWhere +
            " AND (a.ai_context #>> '{followUpState,firstSentAt}') IS NULL AND a.last_client_message_at < :oneHourAgo",
          {
            ...followUpParams,
            oneHourAgo,
          }
        )
        .getCount();

      const twelveHoursAgo = new Date();
      twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);
      counts['inativo-12h'] = await attendanceRepo
        .createQueryBuilder('a')
        .where(
          followUpBaseWhere +
            " AND (a.ai_context #>> '{followUpState,firstSentAt}') IS NOT NULL AND (a.ai_context #>> '{followUpState,secondSentAt}') IS NULL AND ((a.ai_context #>> '{followUpState,firstSentAt}')::timestamp) < :twelveHoursAgo",
          {
            ...followUpParams,
            twelveHoursAgo,
          }
        )
        .getCount();

      counts['inativo-24h'] = await attendanceRepo
        .createQueryBuilder('a')
        .where(
          followUpBaseWhere +
            " AND (a.ai_context #>> '{followUpState,secondSentAt}') IS NOT NULL AND a.last_client_message_at >= :thirtySixHoursAgo",
          {
            ...followUpParams,
            thirtySixHoursAgo,
          }
        )
        .getCount();
      counts['follow-up'] =
        (counts['inativo-1h'] ?? 0) +
        (counts['inativo-12h'] ?? 0) +
        (counts['inativo-24h'] ?? 0);

      subdivisionCountsCache.set(countsCacheKey, {
        counts,
        expiresAt: Date.now() + 15000, // 15s
      });
      res.json({ success: true, counts });
    } catch (error: any) {
      logger.error('Error getting subdivision counts', {
        error: error.message,
        supervisorId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get supervisor dashboard statistics with optional filters.
   * Query:
   * - from: ISO date or YYYY-MM-DD (inclusive start)
   * - to: ISO date or YYYY-MM-DD (inclusive end)
   * - selectedDay: YYYY-MM-DD for "atendimentos hoje/no dia"
   * - brand: optional VehicleBrand
   */
  private async getSupervisorStats(req: Request, res: Response): Promise<void> {
    try {
      const supervisorId = (req as any).user?.sub;
      if (!supervisorId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const userRepo = AppDataSource.getRepository(User);
      const sup = await userRepo.findOne({ where: { id: supervisorId as UUID } });
      if (!sup || sup.role !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'User not a supervisor' });
        return;
      }

      const parseDate = (value: unknown): Date | null => {
        if (typeof value !== 'string' || !value.trim()) return null;
        const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
        const date = new Date(normalized);
        return Number.isNaN(date.getTime()) ? null : date;
      };
      const startOfDay = (date: Date): Date => {
        const d = new Date(date);
        d.setUTCHours(0, 0, 0, 0);
        return d;
      };
      const endOfDay = (date: Date): Date => {
        const d = new Date(date);
        d.setUTCHours(23, 59, 59, 999);
        return d;
      };

      const now = new Date();
      const fromParsed = parseDate(req.query.from);
      const toParsed = parseDate(req.query.to);
      const selectedDayParsed = parseDate(req.query.selectedDay) ?? now;
      const fromDate = fromParsed ? startOfDay(fromParsed) : startOfDay(selectedDayParsed);
      const toDate = toParsed ? endOfDay(toParsed) : endOfDay(selectedDayParsed);

      if (toDate < fromDate) {
        res.status(400).json({ error: 'Parâmetros de data inválidos: "to" deve ser maior ou igual a "from".' });
        return;
      }

      const brandParamRaw = typeof req.query.brand === 'string' ? req.query.brand.toUpperCase() : '';
      const validBrands = Object.values(VehicleBrand);
      const brandFilter = validBrands.includes(brandParamRaw as VehicleBrand)
        ? (brandParamRaw as VehicleBrand)
        : null;

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      // Inclui: atribuídos ao supervisor, atribuídos a vendedores do supervisor, OU não atribuídos (AI)
      const visibilityWhere =
        '(a.supervisor_id = :supervisorId OR a.seller_id IN (SELECT seller_id FROM seller_supervisors WHERE supervisor_id = :supervisorId) OR a.seller_id IS NULL)';

      const makeBaseQuery = () => {
        const qb = attendanceRepo
          .createQueryBuilder('a')
          .where(visibilityWhere, { supervisorId });
        if (brandFilter) {
          qb.andWhere('a.vehicle_brand = :brand', { brand: brandFilter });
        }
        return qb;
      };

      const totalAttendances = await attendanceRepo
        .createQueryBuilder('a')
        .where(visibilityWhere, { supervisorId })
        .getCount();

      const filteredAttendances = await makeBaseQuery()
        .andWhere('a.created_at BETWEEN :from AND :to', { from: fromDate, to: toDate })
        .getCount();

      const selectedDayStart = startOfDay(selectedDayParsed);
      const selectedDayEnd = endOfDay(selectedDayParsed);
      const dayAttendances = await makeBaseQuery()
        .andWhere('a.created_at BETWEEN :dayStart AND :dayEnd', {
          dayStart: selectedDayStart,
          dayEnd: selectedDayEnd,
        })
        .getCount();

      const byBrandRows = await makeBaseQuery()
        .andWhere('a.created_at BETWEEN :from AND :to', { from: fromDate, to: toDate })
        .select('a.vehicle_brand', 'brand')
        .addSelect('COUNT(*)', 'count')
        .groupBy('a.vehicle_brand')
        .getRawMany<{ brand: VehicleBrand | null; count: string }>();

      const byInterventionRows = await makeBaseQuery()
        .andWhere('a.created_at BETWEEN :from AND :to', { from: fromDate, to: toDate })
        .andWhere('a.intervention_type IS NOT NULL')
        .select('a.intervention_type', 'interventionType')
        .addSelect('COUNT(*)', 'count')
        .groupBy('a.intervention_type')
        .getRawMany<{ interventionType: string | null; count: string }>();

      const byBrand: Record<string, number> = {};
      for (const brand of validBrands) byBrand[brand] = 0;
      for (const row of byBrandRows) {
        if (row.brand && validBrands.includes(row.brand)) {
          byBrand[row.brand] = parseInt(row.count, 10) || 0;
        }
      }

      const trackedInterventionTypes = [
        'protese-capilar',
        'demanda-telefone-fixo',
        'outros-assuntos',
      ] as const;

      const byIntervention: Record<string, number> = {};
      for (const type of trackedInterventionTypes) byIntervention[type] = 0;
      const trackedInterventionSet = new Set<string>(trackedInterventionTypes as readonly string[]);
      for (const row of byInterventionRows) {
        if (row.interventionType && trackedInterventionSet.has(row.interventionType)) {
          byIntervention[row.interventionType] = parseInt(row.count, 10) || 0;
        }
      }

      // Atendimentos não classificados: fechados (FECHADO_OPERACIONAL) sem nenhuma function call (intervention_type IS NULL)
      const unclassifiedCount = await makeBaseQuery()
        .andWhere('a.created_at BETWEEN :from AND :to', { from: fromDate, to: toDate })
        .andWhere('a.operational_state = :closed', { closed: OperationalState.FECHADO_OPERACIONAL })
        .andWhere('a.intervention_type IS NULL')
        .getCount();

      res.json({
        success: true,
        stats: {
          dayAttendances,
          filteredAttendances,
          totalAttendances,
          byBrand,
          byIntervention,
          unclassifiedCount,
        },
        filters: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          selectedDay: selectedDayStart.toISOString(),
          brand: brandFilter,
        },
      });
    } catch (error: any) {
      logger.error('Error getting supervisor stats', {
        error: error.message,
        supervisorId: (req as any).user?.sub,
        query: req.query,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all messages for a specific attendance
   */
  private async getAttendanceMessages(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub; // Get user ID from JWT token
      const userRole = (req as any).user?.role; // Get user role from JWT token

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Verify attendance exists
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
        relations: ['seller', 'supervisor'],
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Authorization check based on role
      const userRepo = AppDataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: userId as UUID } });

      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }

      // Verify access:
      // - SUPERVISOR can access if attendance belongs to their seller or is unassigned
      // - SELLER can access if attendance is assigned to them
      if (userRole === UserRole.SUPERVISOR) {
        if (attendance.sellerId) {
          const sellerRepo = AppDataSource.getRepository(Seller);
          const seller = await sellerRepo.findOne({
            where: { id: attendance.sellerId },
            relations: ['supervisors'],
          });
          const canAccess =
            attendance.supervisorId === userId || seller?.supervisors?.some((s) => s.id === userId);
          if (!canAccess) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }
        }
      } else if (userRole === UserRole.SELLER) {
        // Seller can only access if attendance is assigned to them
        if (attendance.sellerId !== userId) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (userRole !== UserRole.SUPER_ADMIN && userRole !== UserRole.ADMIN_GENERAL) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Get message repository
      const messageRepo = AppDataSource.getRepository(Message);

      // Get pagination parameters
      const limit = parseInt(req.query.limit as string) || 15;
      const offset = parseInt(req.query.offset as string) || 0;

      // Get messages for this attendance with pagination
      // Using query builder with DISTINCT to avoid duplicates at DB level
      const queryBuilder = messageRepo
        .createQueryBuilder('message')
        .where('message.attendanceId = :attendanceId', { attendanceId })
        // Ocultar mensagens legadas de realocação em qualquer visualização de chat.
        .andWhere(
          "NOT (message.origin = :systemOrigin AND ((message.metadata ->> 'type') = :relType OR message.content LIKE :relPrefix))",
          {
            systemOrigin: MessageOrigin.SYSTEM,
            relType: 'relocation',
            relPrefix: '🔁 Conversa realocada para%',
          }
        )
        .orderBy('message.sentAt', 'ASC')
        .addOrderBy('message.id', 'ASC'); // Secondary sort by ID for stability
      const totalCount = await queryBuilder.getCount();
      
      let messages;
      if (offset === 0) {
        // Initial load: get the most recent messages (last N messages)
        const allMessages = await queryBuilder.getMany();
        
        // Remove duplicates by ID (keep last occurrence)
        const uniqueMessages = Array.from(
          new Map(allMessages.map(msg => [msg.id, msg])).values()
        );
        
        if (allMessages.length !== uniqueMessages.length) {
          logger.warn('Found duplicate messages in database!', {
            attendanceId,
            total: allMessages.length,
            unique: uniqueMessages.length,
            duplicates: allMessages.length - uniqueMessages.length,
            duplicateIds: allMessages
              .filter((msg, index, self) => 
                self.findIndex(m => m.id === msg.id) !== index
              )
              .map(m => ({ id: m.id, content: m.content.substring(0, 50), sentAt: m.sentAt }))
          });
        } else {
          logger.info('No duplicates found in messages', {
            attendanceId,
            messageCount: uniqueMessages.length
          });
        }
        
        // Take the last 'limit' messages (most recent)
        messages = uniqueMessages.slice(-limit);
      } else {
        // Load more: get older messages
        const allMessages = await queryBuilder.getMany();
        
        // Remove duplicates by ID (keep last occurrence)
        const uniqueMessages = Array.from(
          new Map(allMessages.map(msg => [msg.id, msg])).values()
        );
        
        const alreadyLoaded = offset;
        const startIndex = Math.max(0, uniqueMessages.length - alreadyLoaded - limit);
        const endIndex = uniqueMessages.length - alreadyLoaded;
        messages = uniqueMessages.slice(startIndex, endIndex);
      }

      // Format messages for response
      const formattedMessages = await Promise.all(messages.map(async (message) => {
        const isClient = message.origin === MessageOrigin.CLIENT;
        const isFromSeller = message.origin === MessageOrigin.SELLER;
        const isFromAI = message.origin === MessageOrigin.AI;
        const isFromSystem = message.origin === MessageOrigin.SYSTEM;

        let sender = 'Cliente';
        if (isFromSystem) {
          sender = 'Sistema';
        } else if (isFromSeller) {
          // Mensagem do dono enviada do celular (fora da plataforma)
          if (message.metadata?.ownerPushName) {
            sender = String(message.metadata.ownerPushName);
          } else if (attendance.seller?.name) {
            sender = attendance.seller.name;
          } else if (message.metadata?.sentBy) {
            // If no seller relationship, try to get user name from sentBy
            try {
              const sentByUser = await userRepo.findOne({ where: { id: message.metadata.sentBy as UUID } });
              sender = sentByUser?.name || 'Vendedor';
            } catch (error) {
              logger.warn('Could not fetch user name for message', { messageId: message.id, sentBy: message.metadata.sentBy });
              sender = 'Vendedor';
            }
          } else {
            sender = 'Vendedor';
          }
        } else if (isFromAI) {
          sender = 'AI';
        } else if (isClient && message.metadata?.pushName) {
          sender = message.metadata.pushName;
        }

        // Format time (Brazilian format - 24 hours)
        // IMPORTANT: Convert to Brazil timezone (America/Sao_Paulo) for consistent display
        // message.sentAt is a Date object from TypeORM - ensure we format in Brazil timezone
        const date = new Date(message.sentAt);
        // Use Intl.DateTimeFormat to format in Brazil timezone
        const formatter = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const parts = formatter.formatToParts(date);
        const hours = parts.find(p => p.type === 'hour')?.value || '00';
        const minutes = parts.find(p => p.type === 'minute')?.value || '00';
        const time = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
        const sentAt = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;

        return {
          id: message.id,
          sender,
          content: message.content,
          time,
          sentAt,
          isClient,
          isSystem: isFromSystem,
          origin: message.origin,
          avatar: isClient && !isFromSystem
            ? `https://ui-avatars.com/api/?name=${encodeURIComponent(sender)}&background=F07000&color=fff`
            : undefined,
          hasLink: message.content.includes('http'),
          metadata: {
            ...message.metadata,
            sentAt: message.sentAt.toISOString(),
            createdAt: message.sentAt.toISOString(),
          },
        };
      }));

      res.json({
        success: true,
        messages: formattedMessages,
        attendance: {
          id: attendance.id,
          clientPhone: attendance.clientPhone,
          clientName: messages.find(m => m.origin === MessageOrigin.CLIENT)?.metadata?.pushName || attendance.clientPhone.split('@')[0],
          state: attendance.state,
          handledBy: attendance.handledBy,
          interventionType: attendance.interventionType ?? undefined,
          interventionData: attendance.interventionData ?? undefined,
        },
        pagination: {
          total: totalCount,
          limit,
          offset,
          hasMore: offset + limit < totalCount,
        },
      });
    } catch (error: any) {
      logger.error('Error getting attendance messages', {
        error: error.message,
        stack: error.stack,
        attendanceId: req.params.attendanceId,
        userId: (req as any).user?.sub,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Send a message to a specific attendance (via WhatsApp)
   * Supports text and media messages with async processing
   */
  private async sendMessage(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const { content } = req.body;
      const mediaFile = (req as any).file; // Multer file
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role;

      if (!userId || !userRole) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const normalizedContent = content != null ? normalizeLineBreaks(String(content)) : '';
      // At least content or media must be provided
      if (normalizedContent.length === 0 && !mediaFile) {
        res.status(400).json({ error: 'Message content or media is required' });
        return;
      }

      // Verify attendance exists
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
        relations: ['seller', 'supervisor'],
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Authorization check
      if (userRole === UserRole.SUPERVISOR) {
        const sellerRepo = AppDataSource.getRepository(Seller);
        const supervisorSellers = await getSellersBySupervisorId(sellerRepo, userId as string, { withUser: false });
        const isAssignedToSupervisorSeller =
          attendance.supervisorId === userId || supervisorSellers.some((s) => s.id === attendance.sellerId);
        if (attendance.sellerId !== null && !isAssignedToSupervisorSeller) {
          res.status(403).json({ error: 'Access denied: Attendance not assigned to your sellers' });
          return;
        }
      } else if (userRole === UserRole.SELLER) {
        if (attendance.sellerId !== userId) {
          res.status(403).json({ error: 'Access denied: Attendance not assigned to you' });
          return;
        }
      } else if (userRole !== UserRole.ADMIN_GENERAL && userRole !== UserRole.SUPER_ADMIN) {
        res.status(403).json({ error: 'Access denied: Insufficient permissions' });
        return;
      }

      // Get WhatsApp adapter to verify connection
      const adapter = whatsappManagerService.getAdapter(attendance.whatsappNumberId);
      if (!adapter || !adapter.isConnected()) {
        res.status(400).json({ error: 'WhatsApp number is not connected' });
        return;
      }

      let mediaUrl: string | undefined;
      let mediaType: string | undefined;
      let mediaBuffer: Buffer | undefined;
      let mimeType: string | undefined;

      // Handle media validation if provided
      if (mediaFile) {
        logger.debug('Media file received', {
          mimetype: mediaFile.mimetype,
          originalname: mediaFile.originalname,
          size: mediaFile.size,
        });
        
        // Validate media
        const validation = mediaService.validateMedia(mediaFile.buffer, mediaFile.mimetype);
        if (!validation.valid) {
          logger.warn('Media validation failed', {
            mimetype: mediaFile.mimetype,
            error: validation.error,
          });
          res.status(400).json({ error: validation.error });
          return;
        }

        mediaBuffer = mediaFile.buffer;
        mimeType = mediaFile.mimetype;

        // Determine media type
        if (mimeType.startsWith('image/')) {
          mediaType = 'image';
        } else if (mimeType.startsWith('video/')) {
          mediaType = 'video';
        } else if (mimeType.startsWith('audio/')) {
          mediaType = 'audio';
        } else {
          mediaType = 'document';
        }
      }

      // Get user name for metadata
      const userRepo = AppDataSource.getRepository(User);
      const senderUser = await userRepo.findOne({ where: { id: userId as UUID } });
      const senderName = senderUser?.name || 'Vendedor';

      // Create message in database with PENDING status (conteúdo com quebras de linha normalizadas para exibir no chat)
      const messageRepo = AppDataSource.getRepository(Message);
      const message = messageRepo.create({
        attendanceId: attendance.id,
        origin: MessageOrigin.SELLER,
        content: normalizedContent || (mediaFile ? '[Mídia]' : ''),
        status: MessageStatus.PENDING,
        metadata: {
          sentBy: userId,
          sentByRole: userRole,
          senderName: senderName, // Include sender name for frontend display
          mediaType,
          hasMedia: !!mediaFile,
        },
        sentAt: new Date(),
      });

      await messageRepo.save(message);

      // Upload media to MinIO AFTER saving message (so we have message.id) but BEFORE response
      if (mediaFile && mediaBuffer && mimeType) {
        try {
          mediaUrl = await mediaService.uploadMediaBuffer(
            mediaBuffer,
            mimeType,
            attendance.whatsappNumberId,
            message.id
          );

          // Update message metadata with storage path
          message.metadata = {
            ...message.metadata,
            mediaUrl,
          };
          await messageRepo.save(message);

          logger.info('Media uploaded to MinIO and metadata updated', {
            messageId: message.id,
            storagePath: mediaUrl,
            mediaType,
          });
        } catch (error: any) {
          logger.error('Error uploading media', {
            messageId: message.id,
            error: error.message,
          });
          // Don't fail the request, but log the error
          // The message will be saved without mediaUrl, and the async send will handle it
        }
      }

      // Update attendance's updatedAt
      attendance.updatedAt = new Date();
      
      // Reset inactivity timer if attendance is handled by HUMAN
      // This resets the 1-hour timer when human sends a message
      if (attendance.handledBy === 'HUMAN' && attendance.assumedAt) {
        attendance.assumedAt = new Date();
        logger.debug('Reset inactivity timer for assumed attendance', {
          attendanceId: attendance.id,
          newAssumedAt: attendance.assumedAt,
        });
      }
      
      await attendanceRepo.save(attendance);

      logger.info('Message created with PENDING status', {
        messageId: message.id,
        attendanceId: attendance.id,
        hasMedia: !!mediaFile,
        sentBy: userId,
      });

      // Return immediate response to client
      const sentDate = new Date(message.sentAt);
      const hours = sentDate.getHours();
      const minutes = sentDate.getMinutes();
      const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

      res.json({
        success: true,
        message: {
          id: message.id,
          content: message.content,
          origin: message.origin,
          status: message.status,
          sentAt: message.sentAt.toISOString(),
          time,
          sentAtFormatted: time,
          metadata: message.metadata,
        },
      });

      // Process sending asynchronously (don't await - fire and forget)
      if (mediaFile && mediaBuffer && mimeType) {
        // Media already uploaded and metadata already saved
        // Send media message asynchronously
        messageSenderService.sendMediaAsync(
          message.id,
          attendance.id,
          mediaBuffer,
          mimeType,
          normalizedContent || undefined
        ).catch((error) => {
          logger.error('Async media send failed', {
            messageId: message.id,
            error: error.message,
          });
        });
      } else {
        // Send text message asynchronously (conteúdo com quebras de linha preservadas)
        messageSenderService.sendMessageAsync(
          message.id,
          attendance.id,
          normalizedContent,
          senderName // Pass sender name
        ).catch((error) => {
          logger.error('Async message send failed', {
            messageId: message.id,
            error: error.message,
          });
        });
      }

      // Emit initial Socket.IO event (with pending status)
      try {
        const eventData = {
          attendanceId: attendance.id,
          messageId: message.id,
          clientPhone: attendance.clientPhone,
          isUnassigned: !attendance.sellerId,
          ...(attendance.sellerId && { sellerId: attendance.sellerId }),
          ...(attendance.sellerId && attendance.sellerSubdivision && { sellerSubdivision: attendance.sellerSubdivision }),
          message: {
            id: message.id,
            content: message.content,
            origin: message.origin,
            status: message.status,
            sentAt: message.sentAt.toISOString(),
            metadata: {
              ...message.metadata,
              sentAt: message.sentAt.toISOString(),
              createdAt: message.sentAt.toISOString(),
            },
          },
        };

        // Emit to specific rooms only (not global to avoid duplication)
        if (!attendance.sellerId) {
          socketService.emitToRoom('supervisors', 'message_sent', eventData);
          socketService.emitToRoom('supervisors', 'message_received', eventData);
        } else {
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_sent', eventData);
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_received', eventData);
          socketService.emitToRoom('supervisors', 'message_sent', eventData);
          socketService.emitToRoom('supervisors', 'message_received', eventData);
        }
      } catch (socketError: any) {
        logger.warn('Failed to emit Socket.IO event for sent message', {
          error: socketError.message,
          messageId: message.id,
        });
      }
    } catch (error: any) {
      logger.error('Error sending message', {
        error: error.message,
        stack: error.stack,
        attendanceId: req.params.attendanceId,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Mark messages as read for a specific attendance
   */
  private async markAsRead(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role;

      if (!userId || !userRole) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Verify attendance exists
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Authorization check
      if (userRole === UserRole.SUPERVISOR) {
        // Supervisor NÃO pode marcar como lido atendimento atribuído a vendedor (só o vendedor pode)
        if (attendance.sellerId !== null) {
          res.status(403).json({ error: 'Supervisor não pode marcar como lido um atendimento atribuído a vendedor' });
          return;
        }
      } else if (userRole === UserRole.SELLER) {
        if (attendance.sellerId !== userId) {
          res.status(403).json({ error: 'Access denied: Attendance not assigned to you' });
          return;
        }
      } else if (userRole !== UserRole.ADMIN_GENERAL && userRole !== UserRole.SUPER_ADMIN) {
        res.status(403).json({ error: 'Access denied: Insufficient permissions' });
        return;
      }

      // Mark as read: create or update MessageRead record
      // IMPORTANTE: usar o maior entre agora e o sentAt da última mensagem CLIENT
      // para lidar com desalinhamento de fuso horário entre mensagens salvas pelo WhatsApp e o servidor
      const messageReadRepo = AppDataSource.getRepository(MessageRead);
      const messageRepo2 = AppDataSource.getRepository(Message);
      const markReadUserId = userId as UUID;
      let messageRead = await messageReadRepo.findOne({
        where: {
          attendanceId: attendanceId as UUID,
          userId: markReadUserId,
        },
      });

      // Buscar sentAt da última mensagem (qualquer origin) para garantir que lastReadAt >= sentAt mais recente
      const latestMsg = await messageRepo2.findOne({
        where: { attendanceId: attendanceId as UUID },
        order: { sentAt: 'DESC' },
        select: ['sentAt'],
      });
      const now = new Date();
      const latestSentAt = latestMsg?.sentAt ? new Date(latestMsg.sentAt) : now;
      // Usar o maior: garante que markAsRead cobre todas as mensagens existentes mesmo com timezone mismatch
      const effectiveReadAt = latestSentAt > now ? new Date(latestSentAt.getTime() + 1000) : now;

      if (messageRead) {
        // Update existing record
        messageRead.lastReadAt = effectiveReadAt;
        await messageReadRepo.save(messageRead);
      } else {
        // Create new record
        messageRead = messageReadRepo.create({
          attendanceId: attendanceId as UUID,
          userId: markReadUserId,
          lastReadAt: effectiveReadAt,
        });
        await messageReadRepo.save(messageRead);
      }

      // Verificar persistência: buscar novamente para confirmar
      const verify = await messageReadRepo.findOne({
        where: { attendanceId: attendanceId as UUID, userId: markReadUserId },
      });
      logger.info('Messages marked as read (verified)', {
        attendanceId: attendance.id,
        userId: markReadUserId,
        userRole,
        savedLastReadAt: now.toISOString(),
        verifiedLastReadAt: verify?.lastReadAt?.toISOString() ?? 'NOT FOUND',
        verifiedId: verify?.id ?? 'NOT FOUND',
      });

      // Quando vendedor marca como lido: notificar supervisors para atualizar painel "Atribuídos" em tempo real
      if (userRole === UserRole.SELLER && attendance.sellerId) {
        socketService.emitToRoom('supervisors', 'attendance:marked-read-by-seller', {
          attendanceId: attendance.id,
          sellerId: attendance.sellerId,
          sellerSubdivision: attendance.sellerSubdivision ?? 'pedidos-orcamentos',
        });
      }

      res.json({
        success: true,
        lastReadAt: messageRead.lastReadAt.toISOString(),
      });
    } catch (error: any) {
      logger.error('Error marking messages as read', {
        error: error.message,
        stack: error.stack,
        attendanceId: req.params.attendanceId,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Delete attendance (contact/conversation)
   */
  private async deleteAttendance(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role;

      if (!userId || !userRole) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Verify attendance exists
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
        relations: ['seller', 'supervisor'],
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Authorization check
      if (userRole === UserRole.SUPERVISOR) {
        const sellerRepo = AppDataSource.getRepository(Seller);
        const supervisorSellers = await getSellersBySupervisorId(sellerRepo, userId as string, { withUser: false });
        const supervisorSellerIds = supervisorSellers.map((s) => s.id);
        const canDelete =
          !attendance.sellerId ||
          attendance.supervisorId === userId ||
          supervisorSellerIds.includes(attendance.sellerId);
        if (!canDelete) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (userRole === UserRole.SELLER) {
        // Seller can only delete their own attendances
        if (attendance.sellerId !== userId) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (userRole !== UserRole.SUPER_ADMIN) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Delete attendance (messages will be cascade deleted due to foreign key constraints)
      await attendanceRepo.delete(attendanceId as UUID);

      invalidateSubdivisionCountsCache();
      socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

      logger.info('Attendance deleted successfully', {
        attendanceId,
        deletedBy: userId,
        userRole,
      });

      res.json({ success: true, message: 'Attendance deleted successfully' });
    } catch (error: any) {
      logger.error('Error deleting attendance', {
        attendanceId: req.params.attendanceId,
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Assume attendance (human takes over from AI)
   * Switches handledBy from AI to HUMAN
   * This allows human to take control while AI continues storing context
   */
  private async assumeAttendance(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role;

      if (!userId || !userRole) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Verify attendance exists
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
        relations: ['seller', 'supervisor'],
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Authorization check
      if (userRole === UserRole.SUPERVISOR) {
        const sellerRepo = AppDataSource.getRepository(Seller);
        const supervisorSellers = await getSellersBySupervisorId(sellerRepo, userId as string, { withUser: false });
        const supervisorSellerIds = supervisorSellers.map((s) => s.id);
        const canAssume =
          !attendance.sellerId ||
          attendance.supervisorId === userId ||
          supervisorSellerIds.includes(attendance.sellerId);
        if (!canAssume) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (userRole === UserRole.SELLER) {
        // Seller can only assume their own attendances
        if (attendance.sellerId !== userId) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (userRole !== UserRole.SUPER_ADMIN) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Check if attendance can be assumed (must be handled by AI)
      if (!attendance.canBeAssumedByHuman()) {
        res.status(400).json({ 
          error: 'Attendance cannot be assumed - it is not being handled by AI or is already finished' 
        });
        return;
      }

      // Update attendance to be handled by HUMAN
      attendance.handledBy = AttendanceType.HUMAN;
      attendance.assumedAt = new Date();
      attendance.updatedAt = new Date();
      await attendanceRepo.save(attendance);

      logger.info('Attendance assumed by human', {
        attendanceId,
        assumedBy: userId,
        userRole,
      });

      // Emit Socket.IO event to notify about assumption
      try {
        const eventData = {
          attendanceId: attendance.id,
          handledBy: 'HUMAN',
          assumedBy: userId,
          assumedAt: attendance.assumedAt.toISOString(),
        };

        if (attendance.sellerId) {
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance_assumed', eventData);
        }
        socketService.emitToRoom('supervisors', 'attendance_assumed', eventData);
      } catch (socketError: any) {
        logger.warn('Failed to emit attendance_assumed Socket.IO event', {
          error: socketError.message,
          attendanceId,
        });
      }

      invalidateSubdivisionCountsCache();
      socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

      res.json({ 
        success: true, 
        message: 'Attendance assumed successfully',
        attendance: {
          id: attendance.id,
          handledBy: attendance.handledBy,
          assumedAt: attendance.assumedAt,
        },
      });
    } catch (error: any) {
      logger.error('Error assuming attendance', {
        attendanceId: req.params.attendanceId,
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Manual assignment of attendance to a seller by supervisor/super admin.
   */
  private async assignSellerToSeller(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const { sellerId } = req.body as { sellerId?: string };
      const userId = (req as any).user?.sub as UUID;
      const userRole = (req as any).user?.role as UserRole;

      if (!userId || !userRole) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (!sellerId) {
        res.status(400).json({ error: 'sellerId is required' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const sellerRepo = AppDataSource.getRepository(Seller);

      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      const seller = await sellerRepo.findOne({
        where: { id: sellerId as UUID },
        relations: ['supervisors'],
      });

      if (!seller) {
        res.status(404).json({ error: 'Seller not found' });
        return;
      }

      if (userRole === UserRole.SUPERVISOR) {
        const isUnderSupervisor = seller.supervisors?.some((s) => s.id === userId);
        if (!isUnderSupervisor) {
          res.status(403).json({ error: 'Seller does not belong to this supervisor' });
          return;
        }
      } else if (userRole !== UserRole.SUPER_ADMIN) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const previousSellerId = attendance.sellerId;
      attendance.sellerId = seller.id;
      if (!attendance.supervisorId) {
        attendance.supervisorId = userId;
      }
      if (!attendance.operationalState || attendance.operationalState === OperationalState.TRIAGEM) {
        attendance.operationalState = OperationalState.ABERTO;
      }
      attendance.updatedAt = new Date();
      await attendanceRepo.save(attendance);

      logger.info('Attendance manually assigned to seller', {
        attendanceId,
        sellerId,
        supervisorId: userId,
      });

      const eventData = {
        attendanceId: attendance.id,
        sellerId: attendance.sellerId,
        previousSellerId: previousSellerId ?? null,
        supervisorId: attendance.supervisorId,
        clientPhone: attendance.clientPhone,
        state: attendance.state,
        handledBy: attendance.handledBy,
      };

      if (attendance.sellerId) {
        socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance:routed', eventData);
      }
      if (previousSellerId) {
        socketService.emitToRoom(`seller_${previousSellerId}`, 'attendance:routed', eventData);
      }
      socketService.emitToRoom('supervisors', 'attendance:routed', eventData);

      invalidateSubdivisionCountsCache();
      socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

      res.json({ success: true, attendanceId: attendance.id, sellerId: attendance.sellerId });
    } catch (error: any) {
      logger.error('Error assigning attendance to seller', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: error.message ?? 'Internal server error' });
    }
  }

  /**
   * Return attendance to AI
   * Switches handledBy from HUMAN back to AI
   */
  private async returnAttendanceToAI(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role;

      if (!userId || !userRole) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Verify attendance exists
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
        relations: ['seller', 'supervisor'],
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Authorization check
      if (userRole === UserRole.SUPERVISOR) {
        const sellerRepo = AppDataSource.getRepository(Seller);
        const supervisorSellers = await getSellersBySupervisorId(sellerRepo, userId as string, { withUser: false });
        const supervisorSellerIds = supervisorSellers.map((s) => s.id);
        const canReturn =
          !attendance.sellerId ||
          attendance.supervisorId === userId ||
          supervisorSellerIds.includes(attendance.sellerId);
        if (!canReturn) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (userRole === UserRole.SELLER) {
        // Seller can only return their own attendances
        if (attendance.sellerId !== userId) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (userRole !== UserRole.SUPER_ADMIN) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Check if attendance can be returned (must be handled by HUMAN)
      if (!attendance.canBeReturnedToAI()) {
        res.status(400).json({ 
          error: 'Attendance cannot be returned - it is not being handled by a human or is already finished' 
        });
        return;
      }

      // Update attendance to be handled by AI
      attendance.handledBy = AttendanceType.AI;
      attendance.returnedAt = new Date();
      attendance.updatedAt = new Date();
      await attendanceRepo.save(attendance);

      // Verify the update was saved correctly and reload from DB
      const savedAttendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!savedAttendance) {
        logger.error('Failed to verify attendance update - attendance not found after save', {
          attendanceId,
        });
        res.status(500).json({ error: 'Failed to verify attendance update' });
        return;
      }

      if (savedAttendance.handledBy !== AttendanceType.AI) {
        logger.error('Failed to verify attendance update - handledBy mismatch', {
          attendanceId,
          expected: AttendanceType.AI,
          actual: savedAttendance.handledBy,
        });
        // Try to fix it
        savedAttendance.handledBy = AttendanceType.AI;
        await attendanceRepo.save(savedAttendance);
      }

      logger.info('Attendance returned to AI', {
        attendanceId,
        returnedBy: userId,
        userRole,
        handledBy: savedAttendance.handledBy,
        verified: savedAttendance.handledBy === AttendanceType.AI,
      });

      // Emit Socket.IO event to notify about return
      try {
        const eventData = {
          attendanceId: attendance.id,
          handledBy: 'AI',
          returnedBy: userId,
          returnedAt: attendance.returnedAt.toISOString(),
        };

        if (attendance.sellerId) {
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance_returned_to_ai', eventData);
        }
        socketService.emitToRoom('supervisors', 'attendance_returned_to_ai', eventData);
      } catch (socketError: any) {
        logger.warn('Failed to emit attendance_returned_to_ai Socket.IO event', {
          error: socketError.message,
          attendanceId,
        });
      }

      invalidateSubdivisionCountsCache();
      socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

      res.json({ 
        success: true, 
        message: 'Attendance returned to AI successfully',
        attendance: {
          id: attendance.id,
          handledBy: attendance.handledBy,
          returnedAt: attendance.returnedAt,
        },
      });
    } catch (error: any) {
      logger.error('Error returning attendance to AI', {
        attendanceId: req.params.attendanceId,
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Get inactivity timer remaining time for an attendance
   * Returns the remaining seconds until the attendance is automatically returned to AI
   * (1 hour from assumedAt, reset when human sends messages)
   */
  private async getInactivityTimer(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role as UserRole;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Check authorization
      if (userRole === UserRole.SELLER && attendance.sellerId !== userId) {
        res.status(403).json({ error: 'Forbidden - You can only access your own attendances' });
        return;
      }

      // If not handled by HUMAN, return 0 (no timer)
      if (attendance.handledBy !== AttendanceType.HUMAN || !attendance.assumedAt) {
        res.json({ 
          remainingSeconds: 0,
          isActive: false,
        });
        return;
      }

      // Se a IA está permanentemente desligada, não mostrar timer (não vai retornar para IA)
      if (attendance.aiDisabledUntil && new Date(attendance.aiDisabledUntil).getFullYear() > 2100) {
        res.json({
          remainingSeconds: 0,
          isActive: false,
          aiPermanentlyDisabled: true,
        });
        return;
      }

      // Calculate remaining time: assumedAt + 1 hour - now
      const oneHourInMs = 60 * 60 * 1000; // 1 hour in milliseconds
      const assumedAtTime = new Date(attendance.assumedAt).getTime();
      const expirationTime = assumedAtTime + oneHourInMs;
      const now = Date.now();
      const remainingMs = Math.max(0, expirationTime - now);
      const remainingSeconds = Math.floor(remainingMs / 1000);

      res.json({
        remainingSeconds,
        isActive: remainingSeconds > 0,
        assumedAt: attendance.assumedAt.toISOString(),
        expiresAt: new Date(expirationTime).toISOString(),
      });
    } catch (error: any) {
      logger.error('Error getting inactivity timer', {
        attendanceId: req.params.attendanceId,
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Get AI status for an attendance
   * Returns aiDisabledUntil and whether AI is currently disabled
   */
  private async getAIStatus(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role as UserRole;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Check authorization
      if (userRole === UserRole.SELLER && attendance.sellerId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      // Check if AI is disabled
      const now = new Date();
      const aiDisabled = attendance.aiDisabledUntil ? new Date(attendance.aiDisabledUntil) > now : false;
      const remainingSeconds = aiDisabled 
        ? Math.floor((new Date(attendance.aiDisabledUntil!).getTime() - now.getTime()) / 1000)
        : 0;

      res.json({
        aiDisabled,
        aiDisabledUntil: attendance.aiDisabledUntil?.toISOString() || null,
        remainingSeconds,
        isUnlimited: attendance.aiDisabledUntil ? new Date(attendance.aiDisabledUntil).getFullYear() > 2100 : false,
      });
    } catch (error: any) {
      logger.error('Error getting AI status', {
        attendanceId: req.params.attendanceId,
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Enable AI for an attendance (remove aiDisabledUntil)
   */
  private async enableAI(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role as UserRole;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Check authorization
      if (userRole === UserRole.SELLER && attendance.sellerId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      // Enable AI by removing aiDisabledUntil
      await attendanceRepo.update(
        { id: attendanceId as UUID },
        { aiDisabledUntil: null }
      );

      logger.info('AI enabled for attendance', { attendanceId, userId });

      res.json({ success: true, message: 'AI enabled successfully' });
    } catch (error: any) {
      logger.error('Error enabling AI', {
        attendanceId: req.params.attendanceId,
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Disable AI for an attendance
   * Body: { hours?: number } - If not provided or 0, disable indefinitely
   */
  private async disableAI(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const { hours } = req.body as { hours?: number };
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role as UserRole;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Check authorization
      if (userRole === UserRole.SELLER && attendance.sellerId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      // Disable AI
      let aiDisabledUntil: Date;
      
      if (hours && hours > 0) {
        // Disable for specific hours
        aiDisabledUntil = new Date();
        aiDisabledUntil.setHours(aiDisabledUntil.getHours() + hours);
      } else {
        // Disable indefinitely (set to year 2200)
        aiDisabledUntil = new Date('2200-01-01');
      }

      await attendanceRepo.update(
        { id: attendanceId as UUID },
        { aiDisabledUntil }
      );

      logger.info('AI disabled for attendance', { 
        attendanceId, 
        userId, 
        hours: hours || 'unlimited',
        aiDisabledUntil: aiDisabledUntil.toISOString()
      });

      res.json({ 
        success: true, 
        message: hours ? `AI disabled for ${hours} hours` : 'AI disabled indefinitely',
        aiDisabledUntil: aiDisabledUntil.toISOString()
      });
    } catch (error: any) {
      logger.error('Error disabling AI', {
        attendanceId: req.params.attendanceId,
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /attendances/:attendanceId/relocation-seen
   * Body: { wasViewing: boolean, interventionType: string }
   * Só supervisores. Se wasViewing === false: cria mensagem de sistema no chat e notificação
   * no dropdown Intervenção Humana. Se wasViewing === true: no-op.
   */
  private async relocationSeen(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role;
      const body = req.body as { wasViewing?: boolean; interventionType?: string };
      const wasViewing = !!body?.wasViewing;
      const interventionType = body?.interventionType || 'demanda-telefone-fixo';

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (userRole !== UserRole.SUPERVISOR) {
        res.status(403).json({ error: 'Apenas supervisores' });
        return;
      }

      if (wasViewing) {
        res.json({ success: true, created: false });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });
      if (!attendance || attendance.interventionType !== interventionType) {
        res.status(404).json({ error: 'Attendance not found or not relocated' });
        return;
      }

      const chatName = interventionType === 'demanda-telefone-fixo'
        ? 'Demanda telefone fixo'
        : interventionType.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');

      // Mensagens legadas de realocação no chat foram descontinuadas.
      // Mantemos apenas a notificação do dropdown (sem criar Message de sistema).
      const notificationRepo = AppDataSource.getRepository(Notification);
      const existingNotif = await notificationRepo.findOne({
        where: {
          userId: userId as UUID,
          attendanceId: attendanceId as UUID,
          type: NotificationType.ATTENDANCE_RELOCATED_INTERVENTION,
        },
      });
      if (!existingNotif) {
        const title = 'Conversa realocada';
        const message = `Uma conversa foi realocada para ${chatName}.`;
        await notificationService.createNotification({
          userId: userId as UUID,
          type: NotificationType.ATTENDANCE_RELOCATED_INTERVENTION,
          title,
          message,
          attendanceId: attendanceId as UUID,
          referenceId: `relocation-${attendanceId}`,
          metadata: { interventionType },
        });
        res.json({ success: true, created: true });
        return;
      }

      res.json({ success: true, created: false });
    } catch (error: any) {
      logger.error('relocation-seen error', { error: error.message, attendanceId: req.params.attendanceId });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Close attendance manually (supervisor or seller owning the attendance)
   */
  private async closeAttendance(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role as UserRole;
      
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const userRepo = AppDataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: userId as UUID } });
      if (!user) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId as UUID },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Supervisor pode fechar qualquer um; vendedor só o próprio atendimento
      const isSupervisor = user.role === UserRole.SUPERVISOR;
      const isSellerOwning = user.role === UserRole.SELLER && attendance.sellerId === userId;
      if (!isSupervisor && !isSellerOwning) {
        res.status(403).json({ error: 'Only supervisors or the assigned seller can close this attendance' });
        return;
      }

      // Verificar se já está fechado
      if (attendance.operationalState === OperationalState.FECHADO_OPERACIONAL) {
        res.status(400).json({ error: 'Attendance is already closed' });
        return;
      }

      // Impedir fechar se houver pedidos de orçamento em aberto para este atendimento
      const quoteRepo = AppDataSource.getRepository(QuoteRequest);
      const openQuotesCount = await quoteRepo.count({
        where: {
          attendanceId: attendance.id as UUID,
          status: In(['pendente', 'em_elaboracao']),
        },
      });
      if (openQuotesCount > 0) {
        res.status(400).json({ error: 'Este atendimento possui pedidos de orçamento em aberto. Finalize ou envie os orçamentos antes de fechar o atendimento.' });
        return;
      }

      // Preservar nome do cliente antes de fechar (buscar da última mensagem se não estiver salvo)
      const currentClientName = attendance.aiContext?.clientName as string | undefined;
      if (!currentClientName) {
        const messageRepo = AppDataSource.getRepository(Message);
        const lastClientMessage = await messageRepo.findOne({
          where: { 
            attendanceId: attendance.id,
            origin: MessageOrigin.CLIENT,
          },
          order: { sentAt: 'DESC' },
        });
        
        let resolvedClientName: string | undefined;
        if (lastClientMessage?.metadata?.pushName) {
          resolvedClientName = lastClientMessage.metadata.pushName as string;
        } else {
          // Buscar em todas as mensagens do cliente
          const clientMessages = await messageRepo.find({
            where: { 
              attendanceId: attendance.id,
              origin: MessageOrigin.CLIENT,
            },
            order: { sentAt: 'DESC' },
            take: 10,
          });
          
          for (const msg of clientMessages) {
            if (msg.metadata?.pushName) {
              resolvedClientName = msg.metadata.pushName as string;
              break;
            }
          }
        }
        if (resolvedClientName) {
          attendance.aiContext = {
            ...(attendance.aiContext ?? {}),
            clientName: resolvedClientName,
          };
        }
      }

      // Salvar estado anterior no aiContext antes de limpar (para poder restaurar depois, incluindo timer da IA)
      const previousState = {
        interventionType: attendance.interventionType,
        sellerSubdivision: attendance.sellerSubdivision,
        operationalState: attendance.operationalState,
        handledBy: attendance.handledBy,
        assumedAt: attendance.assumedAt?.toISOString(),
      };
      
      // Atualizar aiContext preservando dados existentes
      attendance.aiContext = {
        ...attendance.aiContext,
        previousStateBeforeClosing: previousState,
        closedAt: new Date().toISOString(),
        closedManually: true,
        closedManuallyBy: userId,
        closedManuallyRole: user.role,
      };

      // Fechar atendimento
      attendance.operationalState = OperationalState.FECHADO_OPERACIONAL;
      attendance.interventionType = null as any;
      attendance.sellerSubdivision = null as any;
      attendance.balcaoClosingAt = undefined;
      attendance.ecommerceClosingAt = undefined;
      attendance.finalizedAt = new Date();

      await attendanceRepo.save(attendance);

      logger.info('Attendance closed manually', {
        attendanceId: attendance.id,
        closedBy: userId,
        role: user.role,
      });

      // Emitir evento Socket.IO
      try {
        const eventData = {
          attendanceId: attendance.id,
          reason: isSupervisor ? 'Fechado manualmente pelo supervisor' : 'Fechado manualmente pelo vendedor',
          closedAt: new Date().toISOString(),
        };
        socketService.emitToRoom('supervisors', 'attendance:moved-to-fechados', eventData);
        
        // Notificar vendedor se houver
        if (attendance.sellerId) {
          socketService.emitToRoom(`seller_${attendance.sellerId}`, 'attendance:moved-to-fechados', eventData);
        }
      } catch (socketError: any) {
        logger.warn('Failed to emit attendance:moved-to-fechados Socket.IO event', {
          error: socketError.message,
          attendanceId: attendance.id,
        });
      }

      // Publicar evento para gerar resumo final
      try {
        const { InfrastructureFactory } = await import('../../../../shared/infrastructure/factories/infrastructure.factory');
        const queue = InfrastructureFactory.createQueue();
        await queue.publish('ai-messages', { mode: 'close_summary', attendanceId: attendance.id });
      } catch (e: any) {
        logger.warn('Failed to publish close_summary for attendance', { attendanceId: attendance.id, error: e?.message });
      }

      invalidateSubdivisionCountsCache();
      socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});

      res.json({ 
        success: true, 
        message: 'Attendance closed successfully',
        attendance: {
          id: attendance.id,
          operationalState: attendance.operationalState,
          finalizedAt: attendance.finalizedAt,
        }
      });
    } catch (error: any) {
      logger.error('Error closing attendance', {
        error: error.message,
        attendanceId: req.params.attendanceId,
        supervisorId: (req as any).user?.sub,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
