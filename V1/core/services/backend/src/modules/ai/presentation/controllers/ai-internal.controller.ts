import { Router, Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { Message } from '../../../message/domain/entities/message.entity';
import { AiResponseCost } from '../../domain/entities/ai-response-cost.entity';
import { RoutingDecision } from '../../domain/entities/routing-decision.entity';
import { logger } from '../../../../shared/utils/logger';
import { UUID, AttendanceType, AttendanceState, OperationalState, MessageOrigin, MessageStatus } from '../../../../shared/types/common.types';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { messageSenderService } from '../../../message/application/services/message-sender.service';
import { mediaService } from '../../../message/application/services/media.service';
import { MediaService } from '../../../message/application/services/media.service';
import { mediaProcessorService } from '../../../message/application/services/media-processor.service';
import { messageBufferService } from '../../../message/application/services/message-buffer.service';
import { whatsappManagerService } from '../../../whatsapp/application/services/whatsapp-manager.service';
import { InfrastructureFactory } from '../../../../shared/infrastructure/factories/infrastructure.factory';
import config from '../../../../config/app.config';
import { AttendanceSwitchService } from '../../../attendance/application/services/attendance-switch.service';

export class AIInternalController {
  public router: Router;

  constructor() {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Middleware de autenticação interna
    this.router.use(this.validateInternalAuth.bind(this));

    // Roteamento para vendedores é exclusivo via FC identificamarca (Node). Removido POST /attendances/:id/route.

    // Salvar metadata de mensagem (transcription, description)
    this.router.patch('/messages/:id/metadata', this.updateMessageMetadata.bind(this));

    // Salvar resumo de conversa
    this.router.post('/attendances/:id/summary', this.saveSummary.bind(this));

    // Obter URL de mídia (para AI worker processar áudio/imagem)
    this.router.get('/messages/:id/media-url', this.getMediaUrl.bind(this));

    // Atualizar mídia de mensagem (usado quando download é feito em background após emitir placeholder)
    this.router.post('/messages/update-media', this.updateMessageMedia.bind(this));

    // Enviar typing indicator (para AI worker notificar início de processamento)
    this.router.post('/typing', this.sendTypingIndicator.bind(this));

    // Registrar custo de resposta da IA (AI worker envia após cada resposta)
    this.router.post('/ai-costs', this.reportAiCost.bind(this));

    // Enviar mensagem ao cliente quando tool assíncrona (has_output + !is_sync) termina
    this.router.post('/send-tool-response', this.sendToolResponse.bind(this));

    // Decisão de atendimento (reabrir vs novo) — chamado pelo AI worker após passo de decisão
    this.router.post('/attendance/decide', this.attendanceDecide.bind(this));

    // Troca de atendimento ativo no meio da conversa
    this.router.post('/attendance/switch-active', this.attendanceSwitchActive.bind(this));

    // Status do atendimento (handledBy) — usado pelo AI worker para checar se deve responder ou só guardar contexto
    this.router.get('/attendance/:id/status', this.getAttendanceStatus.bind(this));

    // Registrar decisão de roteamento (auditoria) — usado pelo AI worker
    this.router.post('/routing-decisions', this.recordRoutingDecision.bind(this));
  }

  private async getAttendanceStatus(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as UUID;
      const repo = AppDataSource.getRepository(Attendance);
      const att = await repo.findOne({ where: { id } });
      if (!att) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }
      
      const now = new Date();
      // IA bloqueada por: (1) aiDisabledUntil no futuro OU (2) timer de 1h quando handledBy=HUMAN
      const aiDisabledByManual = att.aiDisabledUntil && new Date(att.aiDisabledUntil) > now;
      const oneHourMs = 60 * 60 * 1000;
      const assumedAtTime = att.assumedAt ? new Date(att.assumedAt).getTime() : 0;
      const expiresAt = assumedAtTime + oneHourMs;
      const aiDisabledByTimer = att.handledBy === 'HUMAN' && att.assumedAt && expiresAt > now.getTime();
      const aiDisabled = aiDisabledByManual || aiDisabledByTimer;
      
      res.json({
        handledBy: att.handledBy,
        interventionType: att.interventionType ?? null,
        aiDisabledUntil: att.aiDisabledUntil?.toISOString() ?? null,
        aiDisabled,
        assumedAt: att.assumedAt?.toISOString() ?? null,
      });
    } catch (error: any) {
      logger.error('Error in getAttendanceStatus', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  private async recordRoutingDecision(req: Request, res: Response): Promise<void> {
    try {
      const {
        attendanceId,
        messageId,
        routerId,
        outputId,
        destinationType,
        destinationId,
        responseId,
        intentId,
        channel,
        confidence,
      } = req.body;
      if (!attendanceId || !routerId || !destinationType) {
        res.status(400).json({ error: 'attendanceId, routerId and destinationType are required' });
        return;
      }
      const repo = AppDataSource.getRepository(RoutingDecision);
      const decision = repo.create({
        attendanceId,
        messageId: messageId ?? null,
        routerId,
        outputId: outputId ?? null,
        destinationType,
        destinationId: destinationId ?? null,
        responseId: responseId ?? null,
        intentId: intentId ?? null,
        channel: channel ?? null,
        confidence: confidence ?? null,
      });
      await repo.save(decision);
      res.status(201).json({ success: true, id: decision.id });
    } catch (error: any) {
      logger.error('Error in recordRoutingDecision', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  private validateInternalAuth(req: Request, res: Response, next: NextFunction): void {
    const token = req.headers['x-internal-auth'];

    if (token !== config.internal.apiKey) {
      res.status(401).json({ error: 'Unauthorized - Invalid internal API key' });
      return;
    }

    next();
  }

  private async updateMessageMetadata(req: Request, res: Response): Promise<void> {
    try {
      const messageId = req.params.id as UUID;
      const { metadata } = req.body;

      logger.info('Internal API: Updating message metadata', {
        messageId,
        metadata,
      });

      const messageRepo = AppDataSource.getRepository(Message);
      const message = await messageRepo.findOne({
        where: { id: messageId },
      });

      if (!message) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      // Merge metadata
      message.metadata = {
        ...message.metadata,
        ...metadata,
      };

      await messageRepo.save(message);

      logger.info('Message metadata updated successfully', { messageId });

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error updating message metadata', {
        error: error.message,
        messageId: req.params.id,
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Update message media (mediaUrl/mediaType) after background download.
   * Used when we emit placeholder first for real-time, then download media.
   */
  private async updateMessageMedia(req: Request, res: Response): Promise<void> {
    try {
      const { phoneNumber, whatsappNumberId, whatsappMessageId, mediaUrl, mediaType } = req.body;

      if (!phoneNumber || !whatsappNumberId || !whatsappMessageId || !mediaUrl || !mediaType) {
        res.status(400).json({
          error: 'Missing required fields: phoneNumber, whatsappNumberId, whatsappMessageId, mediaUrl, mediaType',
        });
        return;
      }

      const messageRepo = AppDataSource.getRepository(Message);
      const attendanceRepo = AppDataSource.getRepository(Attendance);

      // Buscar mensagem por whatsappMessageId + whatsappNumberId (robusto para mudanças de estado/atribuição).
      // Antes, a busca dependia do atendimento "ativo" por phoneNumber e falhava após roteamento/fechamento,
      // impedindo mediaUrl/transcrição de serem anexados.
      let message = await messageRepo
        .createQueryBuilder('m')
        .innerJoin(Attendance, 'a', 'a.id = m.attendance_id')
        .andWhere("m.metadata->>'whatsappMessageId' = :wid", { wid: whatsappMessageId })
        .andWhere('a.whatsapp_number_id = :wnid', { wnid: whatsappNumberId })
        .orderBy('m.sent_at', 'DESC')
        .getOne();

      // Fallback defensivo: em casos legados, tenta buscar pelo atendimento ativo do telefone.
      if (!message) {
        const fallbackAttendance = await attendanceRepo.findOne({
          where: [
            { clientPhone: phoneNumber, whatsappNumberId, operationalState: OperationalState.AGUARDANDO_PRIMEIRA_MSG },
            { clientPhone: phoneNumber, whatsappNumberId, operationalState: OperationalState.TRIAGEM },
            { clientPhone: phoneNumber, whatsappNumberId, operationalState: OperationalState.ABERTO },
            { clientPhone: phoneNumber, whatsappNumberId, operationalState: OperationalState.EM_ATENDIMENTO },
            { clientPhone: phoneNumber, whatsappNumberId, operationalState: OperationalState.AGUARDANDO_CLIENTE },
          ],
          order: { updatedAt: 'DESC' },
        });

        if (fallbackAttendance) {
          message = await messageRepo
            .createQueryBuilder('m')
            .where('m.attendance_id = :aid', { aid: fallbackAttendance.id })
            .andWhere("m.metadata->>'whatsappMessageId' = :wid", { wid: whatsappMessageId })
            .orderBy('m.sent_at', 'DESC')
            .getOne();
        }
      }

      if (!message) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      const attendance = await attendanceRepo.findOne({
        where: { id: message.attendanceId as UUID },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found for message' });
        return;
      }

      message.metadata = {
        ...message.metadata,
        mediaUrl,
        mediaType,
      };
      // Evitar que a mensagem fique travada em "[Processando imagem...]" ou "[Processando áudio...]"
      // quando o download termina: usar rótulo final para o chat.
      const processingPlaceholders = ['[Processando imagem...]', '[Processando áudio...]'];
      if (processingPlaceholders.includes(message.content)) {
        message.content = mediaType === 'audio' ? '[Áudio]' : '[Imagem]';
      }
      await messageRepo.save(message);

      const handledBy = (attendance.handledBy as string) || 'AI';
      const payload = {
        attendanceId: attendance.id,
        messageId: message.id,
        clientPhone: attendance.clientPhone,
        isUnassigned: !attendance.sellerId,
        handledBy,
        message: {
          id: message.id,
          content: message.content,
          origin: message.origin,
          sentAt: message.sentAt.toISOString(),
          metadata: {
            ...message.metadata,
            sentAt: message.sentAt.toISOString(),
            createdAt: message.sentAt.toISOString(),
          },
        },
      };

      // Emit media update to the same audience used by regular message events.
      // For assigned attendances, supervisors must also receive the update so
      // media players (image/audio) switch from placeholder to rendered media.
      if (!attendance.sellerId) {
        socketService.emitToRoom('supervisors', 'message_received', payload);
      } else {
        socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_received', payload);
        socketService.emitToRoom('supervisors', 'message_received', payload);
      }

      logger.info('Message media updated and socket emitted', {
        messageId: message.id,
        attendanceId: attendance.id,
        mediaType,
      });

      // NOW process audio/image for AI (fire-and-forget)
      const needsProcessing = mediaType === 'audio' || mediaType === 'image';
      const aiDisabledByManual = attendance.aiDisabledUntil && new Date(attendance.aiDisabledUntil) > new Date();
      const shouldProcessForAI = attendance.handledBy === AttendanceType.AI &&
                                 attendance.operationalState !== OperationalState.FECHADO_OPERACIONAL &&
                                 !aiDisabledByManual;

      if (needsProcessing && shouldProcessForAI) {
        logger.info('🎯 Media is now available - starting AI processing', {
          messageId: message.id,
          mediaType,
          attendanceId: attendance.id,
        });

        // Fire-and-forget: process media and update buffer
        void (async () => {
          try {
            // Generate signed URL for processing
            const mediaService = new MediaService();
            const signedUrl = await mediaService.getMediaUrl(mediaUrl, 3600);

            logger.info('⏳ Processing media for AI', {
              messageId: message.id,
              mediaType,
            });

            // Process media (Whisper/Vision)
            const processed = await mediaProcessorService.routeMediaProcessing(mediaType, signedUrl);

            logger.info('✅ Media processed successfully', {
              messageId: message.id,
              hasTranscription: !!processed.transcription,
              hasDescription: !!processed.description,
              preview: (processed.transcription || processed.description || '').substring(0, 100),
            });

            // Update buffer with processed content
            await messageBufferService.updateMessageMedia(
              attendance.id,
              message.id,
              processed.transcription,
              processed.description
            );

            logger.info('✅ Buffer updated with processed media', {
              messageId: message.id,
              attendanceId: attendance.id,
            });
          } catch (error: any) {
            logger.error('❌ Error processing media for AI', {
              error: error.message,
              stack: error.stack,
              messageId: message.id,
              mediaType,
            });

            // Fallback: mark as processed with error
            try {
              await messageBufferService.updateMessageMedia(
                attendance.id,
                message.id,
                mediaType === 'audio' ? '[Erro ao transcrever áudio]' : undefined,
                mediaType === 'image' ? '[Erro ao descrever imagem]' : undefined
              );
            } catch (fallbackError: any) {
              logger.error('❌ Even fallback failed', {
                error: fallbackError.message,
              });
            }
          }
        })();
      }

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error updating message media', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: error.message });
    }
  }

  private async saveSummary(req: Request, res: Response): Promise<void> {
    try {
      const attendanceId = req.params.id as UUID;
      const { summary } = req.body;

      logger.info('Internal API: Saving conversation summary', {
        attendanceId,
        summaryLength: summary?.length,
      });

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId },
      });

      if (!attendance) {
        res.status(404).json({ error: 'Attendance not found' });
        return;
      }

      // Update aiContext with summary
      attendance.aiContext = {
        ...attendance.aiContext,
        conversationSummary: summary,
        summaryCreatedAt: new Date().toISOString(),
      };

      await attendanceRepo.save(attendance);

      logger.info('Conversation summary saved successfully', { attendanceId });

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error saving summary', {
        error: error.message,
        attendanceId: req.params.id,
      });
      res.status(500).json({ error: error.message });
    }
  }

  private async getMediaUrl(req: Request, res: Response): Promise<void> {
    try {
      const messageId = req.params.id as UUID;

      logger.debug('Internal API: Getting media URL', { messageId });

      const messageRepo = AppDataSource.getRepository(Message);
      const message = await messageRepo.findOne({
        where: { id: messageId },
      });

      if (!message) {
        res.status(404).json({ 
          success: false,
          error: 'Message not found' 
        });
        return;
      }

      // Check if message has media
      const mediaUrl = message.metadata?.mediaUrl;
      if (!mediaUrl) {
        res.status(404).json({ 
          success: false,
          error: 'Message has no media' 
        });
        return;
      }

      // Generate pre-signed URL (valid for 1 hour)
      const url = await mediaService.getMediaUrl(mediaUrl, 3600);

      res.json({
        success: true,
        data: {
          url,
          mediaType: message.metadata?.mediaType,
          expiresIn: 3600,
        },
      });
    } catch (error: any) {
      logger.error('Error getting media URL via internal API', {
        error: error.message,
        messageId: req.params.id,
      });
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  private async sendTypingIndicator(req: Request, res: Response): Promise<void> {
    try {
      const { whatsappNumberId, clientPhone, isTyping } = req.body;

      if (!whatsappNumberId || !clientPhone || typeof isTyping !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'whatsappNumberId, clientPhone, and isTyping (boolean) are required',
        });
        return;
      }

      logger.debug('Internal API: Sending typing indicator', {
        whatsappNumberId,
        clientPhone,
        isTyping,
      });

      // Get WhatsApp adapter
      const adapter = whatsappManagerService.getAdapter(whatsappNumberId);

      if (!adapter) {
        res.status(404).json({
          success: false,
          error: 'WhatsApp adapter not found',
        });
        return;
      }

      // Send typing indicator
      await adapter.sendTyping(clientPhone, isTyping);

      logger.debug('Typing indicator sent successfully', {
        whatsappNumberId,
        clientPhone,
        isTyping,
      });

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error sending typing indicator via internal API', {
        error: error.message,
        body: req.body,
      });
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Decisão de atendimento (reabrir vs novo).
   * Chamado pelo AI worker após o passo de decisão. Reabre ou cria attendance, salva a mensagem
   * e publica payload normal em ai-messages para o fluxo gerar a resposta ao cliente.
   */
  private async attendanceDecide(req: Request, res: Response): Promise<void> {
    try {
      const {
        clientPhone,
        whatsappNumberId,
        messageId: whatsappMessageId,
        content,
        decision,
        timestamp,
        pushName,
        fromJid,
        participantJid,
        mediaUrl,
        mediaType,
      } = req.body as {
        clientPhone: string;
        whatsappNumberId: string;
        messageId: string;
        content: string;
        decision: { action: 'reopen' | 'new'; attendanceId?: string };
        timestamp?: string;
        pushName?: string;
        fromJid?: string;
        participantJid?: string;
        mediaUrl?: string;
        mediaType?: string;
      };

      if (!clientPhone || !whatsappNumberId || !content || !decision || !['reopen', 'new'].includes(decision?.action)) {
        res.status(400).json({
          success: false,
          error: 'clientPhone, whatsappNumberId, content and decision.action (reopen|new) are required',
        });
        return;
      }

      if (decision.action === 'reopen' && !decision.attendanceId) {
        res.status(400).json({
          success: false,
          error: 'decision.attendanceId is required when action is reopen',
        });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const messageRepo = AppDataSource.getRepository(Message);
      const queueService = InfrastructureFactory.createQueue();
      const aiQueueName = 'ai-messages';

      let attendance: Attendance;
      const sentAt = timestamp ? new Date(timestamp) : new Date();
      if (isNaN(sentAt.getTime())) {
        sentAt.setTime(Date.now());
      }

      if (decision.action === 'reopen' && decision.attendanceId) {
        const att = await attendanceRepo.findOne({
          where: {
            id: decision.attendanceId as UUID,
            clientPhone,
            whatsappNumberId: whatsappNumberId as UUID,
            operationalState: OperationalState.FECHADO_OPERACIONAL,
          },
        });
        if (!att) {
          res.status(404).json({
            success: false,
            error: 'Attendance not found or not eligible for reopen',
          });
          return;
        }
        await attendanceRepo.update(
          { id: att.id },
          { operationalState: OperationalState.EM_ATENDIMENTO, updatedAt: new Date(), lastClientMessageAt: sentAt }
        );
        const reloaded = await attendanceRepo.findOne({ where: { id: att.id } });
        attendance = reloaded ?? att;
      } else {
        attendance = attendanceRepo.create({
          clientPhone,
          whatsappNumberId: whatsappNumberId as UUID,
          state: AttendanceState.OPEN,
          operationalState: OperationalState.TRIAGEM,
          handledBy: AttendanceType.AI,
          sellerId: null,
          supervisorId: null,
          vehicleBrand: null,
          isFinalized: false,
          isAttributed: true,
          lastClientMessageAt: sentAt,
        });
        attendance = await attendanceRepo.save(attendance);
      }

      const message = messageRepo.create({
        attendanceId: attendance.id,
        origin: MessageOrigin.CLIENT,
        content: content || '[Mensagem de mídia]',
        metadata: {
          whatsappMessageId: whatsappMessageId ?? undefined,
          fromJid,
          pushName,
          participantJid,
          mediaUrl,
          mediaType: mediaType ?? 'text',
          originalTimestamp: sentAt.toISOString(),
        },
        status: MessageStatus.SENT,
        sentAt,
      });
      await messageRepo.save(message);

      const normalPayload = {
        messageId: message.id,
        attendanceId: attendance.id,
        clientPhone,
        whatsappNumberId,
        content: message.content,
        mediaType: mediaType ?? 'text',
        mediaUrl,
        metadata: {
          whatsappMessageId: whatsappMessageId ?? undefined,
          fromJid,
          pushName,
          participantJid,
          originalTimestamp: sentAt.toISOString(),
        },
        timestamp: sentAt.toISOString(),
      };
      await queueService.publish(aiQueueName, normalPayload);

      logger.info('Attendance decide applied and normal payload published', {
        action: decision.action,
        attendanceId: attendance.id,
        messageId: message.id,
      });

      res.json({ success: true, attendanceId: attendance.id, messageId: message.id });
    } catch (error: any) {
      logger.error('Error in attendance decide', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Troca de atendimento ativo no meio da conversa.
   * Marca o atual como AGUARDANDO_CLIENTE e o novo como EM_ATENDIMENTO.
   */
  private async attendanceSwitchActive(req: Request, res: Response): Promise<void> {
    try {
      const { currentAttendanceId, newAttendanceId, clientPhone } = req.body as {
        currentAttendanceId: string;
        newAttendanceId: string;
        clientPhone: string;
      };
      if (!currentAttendanceId || !newAttendanceId || !clientPhone) {
        res.status(400).json({
          success: false,
          error: 'currentAttendanceId, newAttendanceId and clientPhone are required',
        });
        return;
      }
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const current = await attendanceRepo.findOne({
        where: { id: currentAttendanceId as UUID },
      });
      if (!current?.whatsappNumberId) {
        res.status(404).json({ success: false, error: 'Current attendance not found' });
        return;
      }
      const switchService = new AttendanceSwitchService();
      const out = await switchService.switchActive(
        clientPhone,
        current.whatsappNumberId as UUID,
        currentAttendanceId as UUID,
        newAttendanceId as UUID
      );
      if (!out.ok) {
        res.status(400).json({ success: false, error: out.error });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error in attendance switch-active', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Enviar mensagem ao cliente quando tool assíncrona (has_output + !is_sync) termina.
   * Worker Node chama após processar a function call e ter result.output.
   */
  private async sendToolResponse(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId, content, senderName } = req.body as {
        attendanceId: string;
        content: string;
        senderName?: string;
      };

      if (!attendanceId || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({
          success: false,
          error: 'attendanceId and content (non-empty string) are required',
        });
        return;
      }

      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({ where: { id: attendanceId } });
      if (!attendance) {
        res.status(404).json({ success: false, error: 'Attendance not found' });
        return;
      }

      const messageRepo = AppDataSource.getRepository(Message);
      const message = messageRepo.create({
        attendanceId: attendance.id,
        origin: MessageOrigin.AI,
        content: content.trim(),
        metadata: { senderName: senderName || 'Altese AI', fromToolResponse: true },
        status: MessageStatus.PENDING,
        sentAt: new Date(),
      });
      await messageRepo.save(message);

      await messageSenderService.sendMessageAsync(
        message.id,
        attendance.id,
        content.trim(),
        senderName || 'Altese AI'
      );

      logger.info('Tool response sent to client', {
        messageId: message.id,
        attendanceId: attendance.id,
      });
      res.json({ success: true, messageId: message.id });
    } catch (error: any) {
      logger.error('Error sending tool response to client', {
        error: error?.message,
        stack: error?.stack,
      });
      res.status(500).json({ success: false, error: error?.message });
    }
  }

  private async reportAiCost(req: Request, res: Response): Promise<void> {
    try {
      const {
        attendanceId,
        messageId,
        clientPhone,
        scenario,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        whisperMinutes,
        usdCost,
        brlCost,
        routerModel,
        routerPromptTokens,
        routerCompletionTokens,
        routerTotalTokens,
        routerUsdCost,
        routerBrlCost,
        specialistName,
        specialistModel,
        specialistPromptTokens,
        specialistCompletionTokens,
        specialistTotalTokens,
        specialistUsdCost,
        specialistBrlCost,
        executionLog,
      } = req.body;

      if (!attendanceId || !model || typeof usdCost !== 'number') {
        res.status(400).json({
          success: false,
          error: 'attendanceId, model, and usdCost are required',
        });
        return;
      }

      const repo = AppDataSource.getRepository(AiResponseCost);
      const cost = repo.create({
        attendanceId,
        messageId: messageId || undefined,
        clientPhone: clientPhone || undefined,
        scenario: scenario || 'text',
        model,
        promptTokens: Math.max(0, parseInt(String(promptTokens), 10) || 0),
        completionTokens: Math.max(0, parseInt(String(completionTokens), 10) || 0),
        totalTokens: Math.max(0, parseInt(String(totalTokens), 10) || 0),
        whisperMinutes: whisperMinutes != null ? Number(whisperMinutes) : undefined,
        usdCost: Number(usdCost) || 0,
        brlCost: typeof brlCost === 'number' ? Number(brlCost) : 0,

        // Multi-agent breakdown (optional)
        routerModel: routerModel || undefined,
        routerPromptTokens: Math.max(0, parseInt(String(routerPromptTokens), 10) || 0),
        routerCompletionTokens: Math.max(0, parseInt(String(routerCompletionTokens), 10) || 0),
        routerTotalTokens: Math.max(0, parseInt(String(routerTotalTokens), 10) || 0),
        routerUsdCost: typeof routerUsdCost === 'number' ? Number(routerUsdCost) : 0,
        routerBrlCost: typeof routerBrlCost === 'number' ? Number(routerBrlCost) : 0,

        specialistName: specialistName || undefined,
        specialistModel: specialistModel || undefined,
        specialistPromptTokens: Math.max(0, parseInt(String(specialistPromptTokens), 10) || 0),
        specialistCompletionTokens: Math.max(0, parseInt(String(specialistCompletionTokens), 10) || 0),
        specialistTotalTokens: Math.max(0, parseInt(String(specialistTotalTokens), 10) || 0),
        specialistUsdCost: typeof specialistUsdCost === 'number' ? Number(specialistUsdCost) : 0,
        specialistBrlCost: typeof specialistBrlCost === 'number' ? Number(specialistBrlCost) : 0,
        executionLog:
          executionLog != null && typeof executionLog === 'object' && !Array.isArray(executionLog)
            ? (executionLog as Record<string, unknown>)
            : undefined,
      });
      await repo.save(cost);

      logger.debug('AI cost recorded', {
        id: cost.id,
        attendanceId,
        model,
        totalTokens: cost.totalTokens,
        usdCost: cost.usdCost,
      });

      socketService.emit('ai-cost:created', {
        id: cost.id,
        attendanceId,
        model,
        totalTokens: cost.totalTokens,
        usdCost: cost.usdCost,
        brlCost: cost.brlCost,
        routerTotalTokens: cost.routerTotalTokens,
        routerUsdCost: cost.routerUsdCost,
        routerBrlCost: cost.routerBrlCost,
        specialistTotalTokens: cost.specialistTotalTokens,
        specialistUsdCost: cost.specialistUsdCost,
        specialistBrlCost: cost.specialistBrlCost,
      });

      res.json({ success: true, id: cost.id });
    } catch (error: any) {
      logger.error('Error reporting AI cost', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ success: false, error: error.message });
    }
  }
}
