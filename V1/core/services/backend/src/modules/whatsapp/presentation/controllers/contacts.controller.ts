import { Router, Request, Response } from 'express';
import multer from 'multer';
import { In, Not } from 'typeorm';
import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { Message } from '../../../message/domain/entities/message.entity';
import { ImportedContact } from '../../domain/entities/imported-contact.entity';
import { Seller } from '../../../seller/domain/entities/seller.entity';
import { WhatsAppNumber } from '../../domain/entities/whatsapp-number.entity';
import {
  AttendanceState,
  AttendanceType,
  MessageOrigin,
  OperationalState,
  UserRole,
  WhatsAppAdapterType,
} from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { invalidateSubdivisionCountsCache } from '../../../attendance/presentation/controllers/attendance.controller';
import { getSellersBySupervisorId } from '../../../seller/application/get-sellers-by-supervisor';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

type ContactRow = {
  clientPhone: string;
  lastContactAt: Date | string;
  totalAttendances: string | number;
  clientName?: string | null;
};

export class ContactsController {
  public router: Router;

  constructor() {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.router.get('/', this.listContacts.bind(this));
    this.router.get('/whatsapp-numbers', this.listWhatsAppNumbers.bind(this));
    this.router.post('/sync-history', this.syncHistory.bind(this));
    this.router.post('/import', upload.single('file'), this.importContacts.bind(this));
    this.router.post('/initiate', this.initiateConversation.bind(this));
    this.router.delete('/', this.deleteContact.bind(this));
  }

  private async listContacts(req: Request, res: Response): Promise<void> {
    try {
      if (!(req as any).user?.sub) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const messageRepo = AppDataSource.getRepository(Message);
      const importedContactRepo = AppDataSource.getRepository(ImportedContact);

      const rawContacts = await attendanceRepo
        .createQueryBuilder('a')
        .select('a.client_phone', 'clientPhone')
        .addSelect('MAX(a.created_at)', 'lastContactAt')
        .addSelect('COUNT(*)', 'totalAttendances')
        .where('a.client_phone IS NOT NULL')
        .groupBy('a.client_phone')
        .orderBy('MAX(a.created_at)', 'DESC')
        .getRawMany<ContactRow>();

      const contacts: Array<{
        clientPhone: string;
        lastContactAt: Date | string;
        totalAttendances: number;
        clientName: string | null;
      }> = [];

      for (const row of rawContacts) {
        const clientPhone = row.clientPhone;
        const latestAttendance = await attendanceRepo.findOne({
          where: { clientPhone },
          order: { createdAt: 'DESC' },
        });
        const aiContext = (latestAttendance?.aiContext ?? {}) as Record<string, unknown>;
        let clientName =
          (typeof aiContext.clientName === 'string' ? aiContext.clientName : null) || null;

        if (!clientName) {
          const attendancesForClient = await attendanceRepo.find({
            where: { clientPhone },
            select: ['id'],
            order: { createdAt: 'DESC' },
            take: 20,
          });
          const attendanceIds = attendancesForClient.map((a) => a.id);
          if (attendanceIds.length > 0) {
            const clientMsgWithPushName = await messageRepo.findOne({
              where: {
                attendanceId: In(attendanceIds),
                origin: MessageOrigin.CLIENT,
              },
              order: { sentAt: 'DESC' },
            });
            const meta = clientMsgWithPushName?.metadata as Record<string, unknown> | undefined;
            if (typeof meta?.pushName === 'string' && (meta.pushName as string).trim()) {
              clientName = meta.pushName as string;
            }
          }
        }

        contacts.push({
          clientPhone,
          lastContactAt: row.lastContactAt,
          totalAttendances: Number(row.totalAttendances),
          clientName,
        });
      }

      const importedRows = await importedContactRepo
        .createQueryBuilder('ic')
        .select('ic.client_phone', 'clientPhone')
        .addSelect('ic.client_name', 'clientName')
        .addSelect('MAX(ic.created_at)', 'lastContactAt')
        .groupBy('ic.client_phone')
        .addGroupBy('ic.client_name')
        .getRawMany<{ clientPhone: string; clientName: string | null; lastContactAt: string }>();

      const phonesWithAttendance = new Set(
        rawContacts.flatMap((r) => [r.clientPhone, r.clientPhone.replace(/\D/g, ''), r.clientPhone.replace(/@s\.whatsapp\.net$/, '')])
      );
      for (const imp of importedRows) {
        const digits = imp.clientPhone.replace(/\D/g, '');
        const hasAttendance =
          phonesWithAttendance.has(imp.clientPhone) ||
          phonesWithAttendance.has(digits) ||
          phonesWithAttendance.has(`${digits}@s.whatsapp.net`);
        if (!hasAttendance) {
          contacts.push({
            clientPhone: imp.clientPhone,
            lastContactAt: imp.lastContactAt,
            totalAttendances: 0,
            clientName: imp.clientName,
          });
        }
      }

      contacts.sort((a, b) => new Date(b.lastContactAt).getTime() - new Date(a.lastContactAt).getTime());

      res.json({ success: true, contacts });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Error listing contacts', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  }

  private async syncHistory(req: Request, res: Response): Promise<void> {
    try {
      if (!(req as any).user?.sub) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const body = req.body as { phoneNumber?: string; whatsappNumberId?: string };
      const digits = String(body.phoneNumber ?? '').replace(/\D/g, '');
      if (!digits || digits.length < 10 || digits.length > 15) {
        res.status(400).json({ error: 'Número de telefone inválido (use 10 a 15 dígitos)' });
        return;
      }

      if (!body.whatsappNumberId) {
        res.status(400).json({ error: 'whatsappNumberId é obrigatório' });
        return;
      }

      const whatsappNumberRepo = AppDataSource.getRepository(WhatsAppNumber);
      const wpNumber = await whatsappNumberRepo.findOne({
        where: { id: body.whatsappNumberId },
      });

      if (!wpNumber || wpNumber.adapterType !== WhatsAppAdapterType.UNOFFICIAL) {
        res.status(400).json({ error: 'Número selecionado não é Baileys (não-oficial)' });
        return;
      }

      res.json({
        success: true,
        message: 'Contato registrado. O histórico será sincronizado nas próximas interações.',
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Error syncing contact history', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  }

  /** Parseia uma linha CSV respeitando campos entre aspas (ex.: "nome","5521999999999") */
  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if ((c === ',' || c === ';' || c === '\t') && !inQuotes) {
        result.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += c;
      }
    }
    result.push(current.trim().replace(/^"|"$/g, ''));
    return result;
  }

  private parseContactsFromCsv(buffer: Buffer): Array<{ phone: string; clientName?: string }> {
    const text = buffer.toString('utf-8').replace(/^\uFEFF/, ''); // Remove BOM
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const phoneCols = ['telefone', 'phone', 'numero', 'celular', 'whatsapp', 'contact', 'fone'];
    const nameCols = ['nome', 'name', 'cliente', 'contact_name'];
    let phoneColIdx = -1;
    let nameColIdx = -1;
    const result: Array<{ phone: string; clientName?: string }> = [];
    const seenPhones = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const cells = this.parseCsvLine(line);
      if (i === 0) {
        const headerLower = cells.map((c) => c.toLowerCase().trim());
        phoneColIdx = headerLower.findIndex((h, j) => phoneCols.some((p) => h.includes(p)) || j === 0);
        nameColIdx = headerLower.findIndex((h) => nameCols.some((n) => h.includes(n)));
        if (phoneColIdx < 0) phoneColIdx = 0;
        continue;
      }
      const phoneCell = cells[phoneColIdx]?.trim() ?? '';
      const digits = phoneCell.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 15 && !seenPhones.has(digits)) {
        seenPhones.add(digits);
        const name = nameColIdx >= 0 ? (cells[nameColIdx]?.trim() || undefined) : undefined;
        result.push({
          phone: digits,
          clientName: name && name.length > 0 ? name : undefined,
        });
      }
    }
    return result;
  }

  private async importContacts(req: Request, res: Response): Promise<void> {
    try {
      if (!(req as any).user?.sub) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const file = req.file;
      if (!file || !file.originalname?.toLowerCase().endsWith('.csv')) {
        res.status(400).json({ error: 'Envie um arquivo CSV válido' });
        return;
      }

      const whatsappNumberId = (req.body?.whatsappNumberId ?? '').trim();
      if (!whatsappNumberId) {
        res.status(400).json({ error: 'whatsappNumberId é obrigatório' });
        return;
      }

      const whatsappNumberRepo = AppDataSource.getRepository(WhatsAppNumber);
      const wpNumber = await whatsappNumberRepo.findOne({ where: { id: whatsappNumberId } });
      if (!wpNumber || wpNumber.adapterType !== WhatsAppAdapterType.UNOFFICIAL) {
        res.status(400).json({ error: 'Número selecionado não é Baileys (não-oficial)' });
        return;
      }

      const contacts = this.parseContactsFromCsv(file.buffer);
      const valid = contacts.filter((c) => c.phone.length >= 10 && c.phone.length <= 15);
      const invalid = contacts.length - valid.length;

      const importedContactRepo = AppDataSource.getRepository(ImportedContact);
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      let created = 0;
      for (const { phone: digits, clientName } of valid) {
        const clientPhone = digits;
        const hasAttendance = await attendanceRepo.findOne({
          where: [
            { clientPhone, operationalState: Not(OperationalState.FECHADO_OPERACIONAL) },
            { clientPhone: `${digits}@s.whatsapp.net`, operationalState: Not(OperationalState.FECHADO_OPERACIONAL) },
          ],
          select: ['id'],
        });
        if (hasAttendance) continue;
        const existingImported = await importedContactRepo.findOne({
          where: { clientPhone, whatsappNumberId },
        });
        if (!existingImported) {
          const imp = importedContactRepo.create({
            clientPhone,
            clientName: clientName?.trim()?.slice(0, 200) ?? null,
            whatsappNumberId,
          });
          await importedContactRepo.save(imp);
          created++;
        }
      }

      res.json({
        success: true,
        imported: valid.length,
        created,
        invalid,
        message: `${created} contato(s) importado(s) para a lista. ${valid.length - created} já existia(m). Só aparecem em Atendimentos após enviar a primeira mensagem.${invalid > 0 ? ` ${invalid} número(s) inválido(s) ignorado(s).` : ''}`,
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Error importing contacts', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  }

  private async buildConversationFromAttendance(attendance: Attendance): Promise<Record<string, unknown>> {
    const messageRepo = AppDataSource.getRepository(Message);
    const lastMessage = await messageRepo.findOne({
      where: { attendanceId: attendance.id },
      order: { sentAt: 'DESC' },
    });
    const aiContext = (attendance.aiContext ?? {}) as Record<string, unknown>;
    let clientName =
      (typeof aiContext.clientName === 'string' && aiContext.clientName.trim()
        ? aiContext.clientName.trim()
        : null) ?? null;
    if (!clientName) {
      clientName = attendance.clientPhone?.split('@')[0] ?? attendance.clientPhone;
      if (lastMessage?.metadata?.pushName) {
        clientName = lastMessage.metadata.pushName;
      } else {
        const clientMsg = await messageRepo.findOne({
          where: { attendanceId: attendance.id, origin: MessageOrigin.CLIENT },
          order: { sentAt: 'DESC' },
        });
        const meta = clientMsg?.metadata as Record<string, unknown> | undefined;
        if (typeof meta?.pushName === 'string' && (meta.pushName as string).trim()) {
          clientName = meta.pushName as string;
        }
      }
    }
    return {
      id: attendance.id,
      clientPhone: attendance.clientPhone,
      clientName,
      lastMessage: lastMessage?.content ?? '',
      lastMessageTime: lastMessage?.sentAt ?? attendance.updatedAt,
      unread: 0,
      state: attendance.state,
      handledBy: attendance.handledBy,
      vehicleBrand: attendance.vehicleBrand ?? undefined,
      createdAt: attendance.createdAt.toISOString(),
      updatedAt: attendance.updatedAt.toISOString(),
      unassignedSource: 'triagem' as const,
    };
  }

  private async initiateConversation(req: Request, res: Response): Promise<void> {
    try {
      if (!(req as any).user?.sub) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const body = req.body as { clientPhone?: string; whatsappNumberId?: string };
      if (!body.clientPhone?.trim() || !body.whatsappNumberId) {
        res.status(400).json({ error: 'clientPhone e whatsappNumberId são obrigatórios' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);

      const existing = await attendanceRepo.findOne({
        where: {
          clientPhone: body.clientPhone.trim(),
          whatsappNumberId: body.whatsappNumberId,
          operationalState: Not(OperationalState.FECHADO_OPERACIONAL),
        },
        order: { updatedAt: 'DESC' },
      });

      if (existing) {
        const conversation = await this.buildConversationFromAttendance(existing);
        res.json({ success: true, attendanceId: existing.id, isNew: false, conversation });
        return;
      }

      const importedContactRepo = AppDataSource.getRepository(ImportedContact);
      const digitsForDelete = body.clientPhone.trim().replace(/\D/g, '');
      const imported = await importedContactRepo.findOne({
        where: { clientPhone: digitsForDelete, whatsappNumberId: body.whatsappNumberId },
      });
      const importedClientName = imported?.clientName?.trim() || null;

      const newAttendance = attendanceRepo.create({
        clientPhone: body.clientPhone.trim(),
        whatsappNumberId: body.whatsappNumberId,
        operationalState: OperationalState.AGUARDANDO_PRIMEIRA_MSG,
        handledBy: AttendanceType.HUMAN,
        state: AttendanceState.OPEN,
        aiContext: importedClientName ? { clientName: importedClientName.slice(0, 200) } : undefined,
      });
      await attendanceRepo.save(newAttendance);

      await importedContactRepo.delete({
        clientPhone: digitsForDelete,
        whatsappNumberId: body.whatsappNumberId,
      });

      const conversation = await this.buildConversationFromAttendance(newAttendance);
      res.json({ success: true, attendanceId: newAttendance.id, isNew: true, conversation });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Error initiating conversation', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  }

  private async listWhatsAppNumbers(req: Request, res: Response): Promise<void> {
    try {
      if (!(req as any).user?.sub) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const whatsappNumberRepo = AppDataSource.getRepository(WhatsAppNumber);
      const wpNumbers = await whatsappNumberRepo.find({
        where: { adapterType: WhatsAppAdapterType.UNOFFICIAL },
        select: ['id', 'number', 'config', 'connectionStatus'],
        order: { createdAt: 'DESC' },
      });

      const numbers = wpNumbers.map((n) => ({
        id: n.id,
        phoneNumber: n.number,
        label: typeof n.config?.name === 'string' ? n.config.name : null,
        connectionStatus: n.connectionStatus,
      }));

      res.json({ success: true, numbers });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Error listing Baileys WhatsApp numbers', {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Delete all attendances for a contact (by client phone).
   * DELETE /contacts?clientPhone=5521999999999
   */
  private async deleteContact(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.sub;
      const userRole = (req as any).user?.role;
      if (!userId || !userRole) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const clientPhone = String(req.query.clientPhone ?? '').trim();
      const digits = clientPhone.replace(/\D/g, '');
      if (!digits || digits.length < 10 || digits.length > 15) {
        res.status(400).json({ error: 'clientPhone inválido ou ausente (use 10 a 15 dígitos)' });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendances = await attendanceRepo.find({
        where: [
          { clientPhone: digits },
          { clientPhone: `${digits}@s.whatsapp.net` },
        ],
        relations: ['seller', 'supervisor'],
      });

      if (attendances.length === 0) {
        const importedContactRepo = AppDataSource.getRepository(ImportedContact);
        const deletedImported = await importedContactRepo.delete({ clientPhone: digits });
        const importedCount = deletedImported.affected ?? 0;
        if (importedCount > 0) {
          res.json({
            success: true,
            message: `${importedCount} contato(s) importado(s) removido(s) da lista`,
            deletedCount: 0,
          });
        } else {
          res.json({ success: true, message: 'Nenhum atendimento nem contato importado encontrado para este número', deletedCount: 0 });
        }
        return;
      }

      let supervisorSellerIds: string[] = [];
      if (userRole === UserRole.SUPERVISOR) {
        const sellerRepo = AppDataSource.getRepository(Seller);
        const supervisorSellers = await getSellersBySupervisorId(sellerRepo, userId, { withUser: false });
        supervisorSellerIds = supervisorSellers.map((s) => s.id);
      }

      let deletedCount = 0;
      for (const att of attendances) {
        let canDelete = false;
        if (userRole === UserRole.SUPERVISOR) {
          canDelete =
            !att.sellerId ||
            att.supervisorId === userId ||
            supervisorSellerIds.includes(att.sellerId);
        } else if (userRole === UserRole.SELLER) {
          canDelete = att.sellerId === userId;
        } else if (userRole === UserRole.SUPER_ADMIN) {
          canDelete = true;
        }
        if (canDelete) {
          await attendanceRepo.delete(att.id);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        await AppDataSource.getRepository(ImportedContact).delete({ clientPhone: digits });
        invalidateSubdivisionCountsCache();
        socketService.emitToRoom('supervisors', 'subdivision_counts_changed', {});
      }

      logger.info('Contact attendances deleted', {
        clientPhone: digits,
        deletedCount,
        totalFound: attendances.length,
        deletedBy: userId,
      });

      res.json({
        success: true,
        message: deletedCount > 0 ? `${deletedCount} atendimento(s) excluído(s)` : 'Nenhum atendimento excluído (sem permissão)',
        deletedCount,
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Error deleting contact', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  }
}
