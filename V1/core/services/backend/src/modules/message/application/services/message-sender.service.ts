import { LessThan } from 'typeorm';
import { AppDataSource } from '../../../../shared/infrastructure/database/typeorm/config/database.config';
import { Message } from '../../domain/entities/message.entity';
import { Attendance } from '../../../attendance/domain/entities/attendance.entity';
import { MessageStatus, UUID } from '../../../../shared/types/common.types';
import { logger } from '../../../../shared/utils/logger';
import { socketService } from '../../../../shared/infrastructure/socket/socket.service';
import { whatsappManagerService } from '../../../whatsapp/application/services/whatsapp-manager.service';
import { mediaService } from './media.service';

/**
 * Message Sender Service
 * 
 * Handles asynchronous message sending to allow continuous message flow
 */
export class MessageSenderService {
  /**
   * Send text message asynchronously
   * Returns immediately with message ID while processing in background
   */
  async sendMessageAsync(
    messageId: UUID,
    attendanceId: UUID,
    content: string,
    senderName?: string
  ): Promise<void> {
    try {
      logger.info('Starting async message send', { messageId, attendanceId, senderName });

      // Update status to SENDING
      await this.updateMessageStatus(messageId, MessageStatus.SENDING);

      // Get attendance to find WhatsApp number and client phone
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId },
      });

      if (!attendance) {
        throw new Error(`Attendance not found: ${attendanceId}`);
      }

      // Get the message that was sent immediately before this one (by sentAt) so we only show
      // sender name when the previous message was from someone else (igual à IA: nome só na 1ª do bloco)
      const messageRepo = AppDataSource.getRepository(Message);
      const currentMessage = await messageRepo.findOne({ where: { id: messageId } });
      if (!currentMessage) {
        throw new Error(`Message not found: ${messageId}`);
      }
      const lastMessage = await messageRepo.findOne({
        where: { attendanceId, sentAt: LessThan(currentMessage.sentAt) },
        order: { sentAt: 'DESC' },
      });

      // Check if we should include sender name (only if sender changed or no previous message)
      let shouldIncludeName = !lastMessage; // Include if first message
      
      if (lastMessage && senderName) {
        // Get last message's sender name from metadata
        const lastSenderName = lastMessage.metadata?.senderName;
        
        // Include name if sender changed
        if (lastSenderName !== senderName) {
          shouldIncludeName = true;
        }
      }

      // Get WhatsApp adapter for this number
      const adapter = whatsappManagerService.getAdapter(attendance.whatsappNumberId);
      if (!adapter) {
        throw new Error(`WhatsApp adapter not found for number: ${attendance.whatsappNumberId}`);
      }

      if (!adapter.isConnected()) {
        throw new Error(`WhatsApp not connected for number: ${attendance.whatsappNumberId}`);
      }

      // Send message via WhatsApp: prefixo apenas para usuários (vendedores), nunca para IA
      const nameForWhatsApp = shouldIncludeName && senderName && senderName !== 'Altese AI' ? senderName : undefined;
      await adapter.sendMessage(
        attendance.clientPhone, 
        content,
        nameForWhatsApp
      );

      // Update status to SENT
      await this.updateMessageStatus(messageId, MessageStatus.SENT);

      // Emit Socket.IO event for real-time update to specific rooms only
      // CORREÇÃO: Usar emitToRoom ao invés de broadcast global
      const eventData = {
        messageId,
        attendanceId,
        status: MessageStatus.SENT,
        timestamp: new Date().toISOString(),
      };
      
      if (attendance.sellerId) {
        socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_status_updated', eventData);
      }
      socketService.emitToRoom('supervisors', 'message_status_updated', eventData);

      logger.info('Message sent successfully', { messageId, attendanceId, includedName: shouldIncludeName });
    } catch (error: any) {
      logger.error('Error sending message asynchronously', {
        messageId,
        attendanceId,
        error: error.message,
        stack: error.stack,
      });

      // Update status to FAILED
      await this.updateMessageStatus(messageId, MessageStatus.FAILED);

      // Emit Socket.IO event for failure to specific rooms only
      // CORREÇÃO: Usar emitToRoom ao invés de broadcast global
      // Recarregar attendance para obter sellerId
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId },
      });
      
      const eventData = {
        messageId,
        attendanceId,
        status: MessageStatus.FAILED,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
      
      if (attendance?.sellerId) {
        socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_status_updated', eventData);
      }
      socketService.emitToRoom('supervisors', 'message_status_updated', eventData);
    }
  }

  /**
   * Send media message asynchronously
   * Returns immediately with message ID while processing in background
   */
  async sendMediaAsync(
    messageId: UUID,
    attendanceId: UUID,
    mediaBuffer: Buffer,
    mimeType: string,
    caption?: string
  ): Promise<void> {
    try {
      logger.info('Starting async media send', { messageId, attendanceId, mimeType });

      // Update status to SENDING
      await this.updateMessageStatus(messageId, MessageStatus.SENDING);

      // Get attendance to find WhatsApp number and client phone
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId },
      });

      if (!attendance) {
        throw new Error(`Attendance not found: ${attendanceId}`);
      }

      // Get WhatsApp adapter for this number
      const adapter = whatsappManagerService.getAdapter(attendance.whatsappNumberId);
      if (!adapter) {
        throw new Error(`WhatsApp adapter not found for number: ${attendance.whatsappNumberId}`);
      }

      if (!adapter.isConnected()) {
        throw new Error(`WhatsApp not connected for number: ${attendance.whatsappNumberId}`);
      }

      if (adapter.getType() === 'OFFICIAL') {
        const messageRepo = AppDataSource.getRepository(Message);
        const message = await messageRepo.findOne({ where: { id: messageId } });
        const storagePath = message?.metadata?.mediaUrl as string | undefined;
        if (!storagePath) {
          throw new Error('Official adapter requires message metadata.mediaUrl (storage path) to send media');
        }
        const mediaUrl = await mediaService.getMediaUrl(storagePath, 3600);
        await adapter.sendMedia(attendance.clientPhone, mediaUrl, caption);
      } else {
        await this.sendMediaViaAdapter(
          adapter,
          attendance.clientPhone,
          mediaBuffer,
          mimeType,
          caption
        );
      }

      // Update status to SENT
      await this.updateMessageStatus(messageId, MessageStatus.SENT);

      // Emit Socket.IO event for real-time update to specific rooms only
      // CORREÇÃO: Usar emitToRoom ao invés de broadcast global
      const eventData = {
        messageId,
        attendanceId,
        status: MessageStatus.SENT,
        timestamp: new Date().toISOString(),
      };
      
      if (attendance.sellerId) {
        socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_status_updated', eventData);
      }
      socketService.emitToRoom('supervisors', 'message_status_updated', eventData);

      logger.info('Media sent successfully', { messageId, attendanceId });
    } catch (error: any) {
      logger.error('Error sending media asynchronously', {
        messageId,
        attendanceId,
        error: error.message,
        stack: error.stack,
      });

      // Update status to FAILED
      await this.updateMessageStatus(messageId, MessageStatus.FAILED);

      // Emit Socket.IO event for failure to specific rooms only
      // CORREÇÃO: Usar emitToRoom ao invés de broadcast global
      // Recarregar attendance para obter sellerId
      const attendanceRepo = AppDataSource.getRepository(Attendance);
      const attendance = await attendanceRepo.findOne({
        where: { id: attendanceId },
      });
      
      const eventData = {
        messageId,
        attendanceId,
        status: MessageStatus.FAILED,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
      
      if (attendance?.sellerId) {
        socketService.emitToRoom(`seller_${attendance.sellerId}`, 'message_status_updated', eventData);
      }
      socketService.emitToRoom('supervisors', 'message_status_updated', eventData);
    }
  }

  /**
   * Send media via adapter
   */
  private async sendMediaViaAdapter(
    adapter: any,
    to: string,
    mediaBuffer: Buffer,
    mimeType: string,
    caption?: string
  ): Promise<void> {
    // Determine media type from MIME type
    let mediaType: 'image' | 'video' | 'audio' | 'document' = 'document';
    
    if (mimeType.startsWith('image/')) {
      mediaType = 'image';
    } else if (mimeType.startsWith('video/')) {
      mediaType = 'video';
    } else if (mimeType.startsWith('audio/')) {
      mediaType = 'audio';
    }

    // Format phone number to JID format
    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;

    // Get socket from adapter
    const socket = (adapter as any).socket;
    if (!socket) {
      throw new Error('WhatsApp socket not available');
    }

    // Send media based on type
    try {
      logger.debug('Preparing to send media via Baileys', {
        to,
        jid,
        mediaType,
        mimeType,
        bufferSize: mediaBuffer.length,
      });

      let sendResult: any;
      
      if (mediaType === 'image') {
        sendResult = await socket.sendMessage(jid, {
          image: mediaBuffer,
          caption: caption,
        });
      } else if (mediaType === 'video') {
        sendResult = await socket.sendMessage(jid, {
          video: mediaBuffer,
          caption: caption,
        });
      } else if (mediaType === 'audio') {
        // WhatsApp may not accept audio/webm directly
        // For voice notes, we need to use ptt: true and a compatible mimetype
        // WhatsApp typically accepts: audio/ogg, audio/mpeg, audio/mp4, audio/wav
        if (mimeType === 'audio/webm') {
          logger.info('Sending audio/webm as voice note (ptt) with ogg mimetype', {
            to,
            originalMimeType: mimeType,
            bufferSize: mediaBuffer.length,
          });
          // Send as voice note (ptt: true) with ogg mimetype
          // WhatsApp will accept this as a voice note
          sendResult = await socket.sendMessage(jid, {
            audio: mediaBuffer,
            mimetype: 'audio/ogg; codecs=opus', // WhatsApp accepts this for voice notes
            ptt: true, // Push to talk (voice note) - this is important!
          });
        } else {
          // For other audio formats, send as voice note if it's a short audio
          // or as regular audio if it's longer
          const isVoiceNote = mimeType === 'audio/ogg' || mimeType === 'audio/mp4';
          logger.info('Sending audio', {
            to,
            mimeType,
            ptt: isVoiceNote,
            bufferSize: mediaBuffer.length,
          });
          sendResult = await socket.sendMessage(jid, {
            audio: mediaBuffer,
            mimetype: mimeType,
            ptt: isVoiceNote, // Use ptt for voice notes
          });
        }
      } else {
        sendResult = await socket.sendMessage(jid, {
          document: mediaBuffer,
          mimetype: mimeType,
          fileName: caption || 'document',
        });
      }

      logger.info('Media sent via adapter successfully', {
        to,
        mediaType,
        mimeType,
        messageId: sendResult?.key?.id,
        status: sendResult?.status,
      });
    } catch (sendError: any) {
      logger.error('Error sending media via Baileys', {
        to,
        jid,
        mediaType,
        mimeType,
        bufferSize: mediaBuffer.length,
        error: sendError.message,
        stack: sendError.stack,
        errorName: sendError.name,
      });
      throw sendError;
    }
  }

  /**
   * Update message status in database
   */
  private async updateMessageStatus(
    messageId: UUID,
    status: MessageStatus
  ): Promise<void> {
    const messageRepo = AppDataSource.getRepository(Message);
    await messageRepo.update({ id: messageId }, { status });

    logger.debug('Message status updated', { messageId, status });
  }
}

// Singleton instance
export const messageSenderService = new MessageSenderService();
