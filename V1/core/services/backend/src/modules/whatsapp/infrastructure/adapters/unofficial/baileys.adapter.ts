// @ts-nocheck
import {
  IWhatsAppAdapter,
  WhatsAppMessage,
} from '../../../domain/interfaces/whatsapp-adapter.interface';
import { logger } from '../../../../../shared/utils/logger';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode';
import axios from 'axios';
import { EventEmitter } from 'events';
import pino from 'pino';
import { useDatabaseAuthState } from './baileys-database-store';
import { mediaService } from '../../../../message/application/services/media.service';

interface BaileysConfig {
  numberId: string;
  name: string;
  dataPath?: string;
}

/**
 * Baileys WhatsApp Adapter
 * 
 * This adapter uses Baileys library to connect to WhatsApp Web
 * without requiring a browser. It's lightweight and efficient.
 */
export class BaileysAdapter implements IWhatsAppAdapter {
  private readonly numberId: string;
  private readonly name: string;
  private socket: WASocket | null = null;
  private connected: boolean = false;
  private qrCode: string | null = null;
  private messageCallbacks: Array<(message: WhatsAppMessage) => void> = [];
  private typingCallbacks: Array<(data: { from: string; phoneNumber: string; isTyping: boolean }) => void> = [];
  private qrCodeEmitter: EventEmitter = new EventEmitter();
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private saveCredsWithState: ((creds: any) => Promise<void>) | null = null;
  private authState: { creds: any; keys: any } | null = null;
  private chatEphemeralCache: Map<string, number> = new Map();

  constructor(config: BaileysConfig) {
    this.numberId = config.numberId;
    this.name = config.name;

    logger.info('BaileysAdapter initialized', {
      numberId: this.numberId,
      usingDatabase: true,
    });
  }

  async connect(): Promise<{ qrCode?: string; status: string }> {
    try {
      logger.info('Connecting to WhatsApp via Baileys', {
        numberId: this.numberId,
      });

      // Load auth state from database
      const authStateResult = await useDatabaseAuthState(this.numberId);
      const { state, saveCredsWithState } = authStateResult;
      this.saveCredsWithState = saveCredsWithState;
      // Keep reference to the state object that Baileys will mutate
      this.authState = state;

      // Fetch latest version
      const { version } = await fetchLatestBaileysVersion();

      // Create Pino logger for Baileys (silent mode)
      const baileysLogger = pino({ level: 'silent' });

      // Create socket with auth state
      // Note: Baileys will mutate the state object directly (state.creds and state.keys)
      this.socket = makeWASocket({
        version,
        auth: state,
        logger: baileysLogger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async (key) => {
          // Return undefined to let Baileys handle message retrieval
          // Returning empty object can cause Baileys to skip messages
          return undefined;
        },
      });

      // Set up event handlers
      this.setupEventHandlers();

      // Wait a bit for connection to be established (if credentials are valid)
      // This allows the connection.update event to fire if credentials are already valid
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check if already connected (credentials were valid and connection was established)
      if (this.connected) {
        logger.info('WhatsApp already connected (credentials were valid)', {
          numberId: this.numberId,
        });
        return { status: 'connected' };
      }

      // Wait for QR code or connection (with longer timeout for auto-reconnect)
      const qrCode = await this.waitForQrCode(10000);

      if (qrCode) {
        logger.info('QR code generated, returning to frontend', {
          numberId: this.numberId,
        });
        return {
          status: 'connecting',
          qrCode: qrCode,
        };
      }

      // Check again if connected (connection might have been established while waiting)
      if (this.connected) {
        logger.info('WhatsApp connected while waiting for QR code', {
          numberId: this.numberId,
        });
        return { status: 'connected' };
      }

      // Still waiting
      logger.info('Waiting for QR code or authentication', {
        numberId: this.numberId,
      });
      return { status: 'connecting' };
    } catch (error: any) {
      logger.error('Failed to connect WhatsApp via Baileys', {
        numberId: this.numberId,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Connection update event
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Handle QR code
      if (qr) {
        logger.info('QR code received from Baileys', {
          numberId: this.numberId,
        });

        try {
          // Convert QR string to data URL image
          const qrCodeDataUrl = await qrcode.toDataURL(qr, {
            width: 450,
            margin: 4,
            errorCorrectionLevel: 'M',
            color: {
              dark: '#000000',
              light: '#FFFFFF',
            },
          });

          this.qrCode = qrCodeDataUrl;
          this.qrCodeEmitter.emit('qr', qrCodeDataUrl);

          logger.info('QR code converted to image', {
            numberId: this.numberId,
          });
        } catch (error: any) {
          logger.error('Error converting QR code to image', {
            numberId: this.numberId,
            error: error.message,
          });
        }
      }

      // Handle connection state
      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !==
          DisconnectReason.loggedOut;

        logger.warn('WhatsApp connection closed', {
          numberId: this.numberId,
          shouldReconnect,
          statusCode: (lastDisconnect?.error as Boom)?.output?.statusCode,
        });

        this.connected = false;
        this.qrCode = null;

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          logger.info('Attempting to reconnect', {
            numberId: this.numberId,
            attempt: this.reconnectAttempts,
          });

          // Wait a bit before reconnecting
          setTimeout(() => {
            this.connect().catch((error) => {
              logger.error('Reconnection failed', {
                numberId: this.numberId,
                error: error.message,
              });
            });
          }, 3000);
        } else {
          logger.error('Max reconnection attempts reached', {
            numberId: this.numberId,
          });
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp connection opened', {
          numberId: this.numberId,
        });

        this.connected = true;
        this.qrCode = null;
        this.reconnectAttempts = 0;
        
        // Log that connection is established and ready to receive messages
        logger.info('WhatsApp connection established and ready to receive messages', {
          numberId: this.numberId,
          hasSocket: !!this.socket,
          hasCallbacks: this.messageCallbacks.length > 0,
        });

        // Save credentials immediately after connection is established
        // Keys are now managed automatically by SignalKeyStore, so we only save creds
        if (this.saveCredsWithState && this.authState) {
          try {
            await this.saveCredsWithState({
              creds: this.authState.creds,
              keys: this.authState.keys, // SignalKeyStore - keys are saved automatically
            });
            
            logger.info('Credentials saved to database after connection opened', {
              numberId: this.numberId,
              hasCreds: !!this.authState.creds,
              hasKeys: !!this.authState.keys,
            });
          } catch (error) {
            logger.error('Error saving credentials after connection opened', {
              numberId: this.numberId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          logger.warn('Cannot save credentials: saveCredsWithState or authState is null', {
            numberId: this.numberId,
            hasSaveCreds: !!this.saveCredsWithState,
            hasAuthState: !!this.authState,
          });
        }

        // Get WhatsApp number from socket
        const me = this.socket?.user;
        if (me) {
          // Extract phone number from JID
          // JID format: 5511987654321@s.whatsapp.net or 5511987654321:12@s.whatsapp.net
          // We need just the phone number: 5511987654321
          const jid = me.id; // e.g., "5511987654321@s.whatsapp.net" or "5511987654321:12@s.whatsapp.net"
          const phoneNumber = jid.split('@')[0].split(':')[0]; // Extract just the phone number
          
          logger.info('WhatsApp number obtained', {
            numberId: this.numberId,
            jid,
            phoneNumber,
          });

          // Notify backend about connection with just the phone number
          await this.notifyBackendConnection(phoneNumber);
        }
      }
    });

    // Credentials update - save to database
    this.socket.ev.on('creds.update', async (update) => {
      if (this.saveCredsWithState && this.authState) {
        try {
          // Baileys mutates the state object directly, so we can access it from our reference
          // Save current credentials to database
          // Note: keys are now managed by SignalKeyStore and saved automatically via set()
          
          logger.info('creds.update event received, saving credentials', {
            numberId: this.numberId,
            hasCreds: !!this.authState.creds,
            hasKeys: !!this.authState.keys,
          });
          
          await this.saveCredsWithState({
            creds: this.authState.creds,
            keys: this.authState.keys, // SignalKeyStore - keys are saved automatically
          });
          
          logger.info('Credentials saved to database after update', {
            numberId: this.numberId,
          });
        } catch (error) {
          logger.error('Error saving credentials after update', {
            numberId: this.numberId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      } else {
        logger.warn('creds.update received but cannot save: saveCredsWithState or authState is null', {
          numberId: this.numberId,
          hasSaveCreds: !!this.saveCredsWithState,
          hasAuthState: !!this.authState,
        });
      }
    });

    // Incoming messages (type "notify" = incoming; "append" = our own sent messages — ignore to avoid duplicate processing)
    this.socket.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') {
        logger.debug('messages.upsert skipped (type !== notify)', {
          numberId: this.numberId,
          type: m.type,
        });
        return;
      }
      logger.info('messages.upsert event received', {
        numberId: this.numberId,
        type: m.type,
        messagesCount: m.messages?.length || 0,
        connected: this.connected,
        hasCallbacks: this.messageCallbacks.length > 0,
      });
      await this.handleIncomingMessages(m);
    });

    // Presence/typing updates
    this.socket.ev.on('presence.update', async (update) => {
      logger.info('🔵🔵🔵 presence.update event received from Baileys!', {
        numberId: this.numberId,
        update: JSON.stringify(update),
        hasPresences: !!update.presences,
        presencesCount: update.presences ? Object.keys(update.presences).length : 0,
        updateId: update.id,
      });
      await this.handlePresenceUpdate(update);
    });

    // Capture ephemeral/disappearing settings from chat updates
    this.socket.ev.on('chats.update', (updates: any[]) => {
      for (const chat of updates) {
        if (chat.id && chat.ephemeralExpiration && chat.ephemeralExpiration > 0) {
          this.chatEphemeralCache.set(chat.id, chat.ephemeralExpiration);
          logger.info('Cached ephemeral duration from chat update', {
            numberId: this.numberId,
            chatJid: chat.id,
            ephemeralExpiration: chat.ephemeralExpiration,
          });
        }
      }
    });

    this.socket.ev.on('chats.upsert', (chats: any[]) => {
      for (const chat of chats) {
        if (chat.id && chat.ephemeralExpiration && chat.ephemeralExpiration > 0) {
          this.chatEphemeralCache.set(chat.id, chat.ephemeralExpiration);
          logger.info('Cached ephemeral duration from chat upsert', {
            numberId: this.numberId,
            chatJid: chat.id,
            ephemeralExpiration: chat.ephemeralExpiration,
          });
        }
      }
    });

    // Listen to all events for debugging (to catch any presence-related events)
    this.socket.ev.on('*', async (eventName, data) => {
      // Log any event that might be related to presence/typing
      if (
        eventName === 'presence.update' || 
        eventName.includes('presence') || 
        eventName.includes('typing') ||
        eventName.includes('composing') ||
        (typeof data === 'object' && data && ('presences' in data || 'presence' in data))
      ) {
        logger.info('🔍 Baileys event detected (presence/typing related)', {
          numberId: this.numberId,
          eventName,
          hasData: !!data,
          dataType: typeof data,
          dataKeys: data && typeof data === 'object' ? Object.keys(data) : null,
        });
      }
    });
  }

  /**
   * Extract phone number from JID
   * JID can be in formats:
   * - "5511987654321@s.whatsapp.net"
   * - "5511987654321:12@s.whatsapp.net" (group message)
   * - "5511987654321@g.us" (group)
   * Returns: "5511987654321"
   */
  private extractPhoneNumberFromJid(jid: string | null | undefined): string {
    if (!jid) return '';
    
    // Remove @s.whatsapp.net or @g.us
    const withoutDomain = jid.split('@')[0];
    
    // Remove : suffix for group messages (e.g., "5511987654321:12" -> "5511987654321")
    const phoneNumber = withoutDomain.split(':')[0];
    
    return phoneNumber;
  }

  /**
   * Handle presence/typing updates
   */
  private async handlePresenceUpdate(update: {
    id?: string;
    presences?: { [jid: string]: proto.Presence };
  }): Promise<void> {
    try {
      logger.info('🔵 handlePresenceUpdate called', {
        numberId: this.numberId,
        hasPresences: !!update.presences,
        presences: update.presences ? Object.keys(update.presences) : [],
        updateId: update.id,
      });

      if (!update.presences) {
        logger.debug('No presences in update, skipping', {
          numberId: this.numberId,
        });
        return;
      }

      for (const [jid, presence] of Object.entries(update.presences)) {
        logger.info('🔵 Processing presence for JID', {
          numberId: this.numberId,
          jid,
          presence,
          presenceType: typeof presence,
        });

        const phoneNumber = this.extractPhoneNumberFromJid(jid);
        if (!phoneNumber) {
          logger.warn('Could not extract phone number from JID', {
            numberId: this.numberId,
            jid,
          });
          continue;
        }

        const status = typeof presence === 'string'
          ? presence
          : (presence as { lastKnownPresence?: string })?.lastKnownPresence;
        const isTyping = status === 'composing' || status === 'recording';

        logger.info('🔵 Calling typing callbacks', {
          numberId: this.numberId,
          from: jid,
          phoneNumber,
          presence,
          isTyping,
          callbacksCount: this.typingCallbacks.length,
        });

        // Notify all registered typing callbacks
        this.typingCallbacks.forEach((callback, index) => {
          try {
            logger.info(`🔵 Calling typing callback ${index + 1}/${this.typingCallbacks.length}`, {
              numberId: this.numberId,
              phoneNumber,
              isTyping,
            });
            callback({
              from: jid,
              phoneNumber,
              isTyping,
            });
            logger.info(`✅ Typing callback ${index + 1} executed successfully`, {
              numberId: this.numberId,
            });
          } catch (error: any) {
            logger.error('Error in typing callback', {
              numberId: this.numberId,
              callbackIndex: index,
              error: error.message,
              stack: error.stack,
            });
          }
        });

        logger.info('✅ Presence update processed successfully', {
          numberId: this.numberId,
          from: jid,
          phoneNumber,
          presence,
          isTyping,
          callbacksCount: this.typingCallbacks.length,
        });
      }
    } catch (error: any) {
      logger.error('❌ Error handling presence update', {
        numberId: this.numberId,
        error: error.message,
        stack: error.stack,
      });
    }
  }

  private async handleIncomingMessages(m: {
    messages: proto.IMessage[];
    type: 'notify' | 'append';
  }): Promise<void> {
    try {
      logger.info('handleIncomingMessages called', {
        numberId: this.numberId,
        type: m.type,
        messagesCount: m.messages?.length || 0,
        hasCallbacks: this.messageCallbacks.length > 0,
      });

      if (m.type !== 'notify') {
        logger.debug('Skipping message type (not notify)', {
          numberId: this.numberId,
          type: m.type,
        });
        return;
      }

      if (!m.messages || m.messages.length === 0) {
        logger.debug('No messages in upsert event', {
          numberId: this.numberId,
        });
        return;
      }

      for (const msg of m.messages) {
        logger.info('Processing message from upsert', {
          numberId: this.numberId,
          messageId: msg.key?.id,
          remoteJid: msg.key?.remoteJid,
          fromMe: msg.key?.fromMe,
          participant: msg.key?.participant,
        });
        // Skip messages from status broadcast
        if (msg.key.remoteJid === 'status@broadcast') {
          logger.debug('Skipping status broadcast message', {
            numberId: this.numberId,
            remoteJid: msg.key.remoteJid,
          });
          continue;
        }

        // IGNORE 100% OF GROUP MESSAGES
        // Groups have the format: XXXXXXXX@g.us
        if (msg.key.remoteJid?.endsWith('@g.us')) {
          logger.info('Ignoring group message', {
            numberId: this.numberId,
            remoteJid: msg.key.remoteJid,
            messageId: msg.key.id,
          });
          continue;
        }

        // Mensagens fromMe = dono do número enviou do celular (fora da plataforma)
        // Processar para exibir na plataforma com nome do dono
        const isFromMe = !!msg.key.fromMe;
        if (isFromMe) {
          // Para fromMe: remoteJid = cliente (chat 1:1), phoneNumber = cliente
          // pushName do msg = nome do dono (perfil WhatsApp)
          logger.info('Processing message from owner (fromMe=true)', {
            numberId: this.numberId,
            messageId: msg.key.id,
            remoteJid: msg.key.remoteJid,
          });
        }

        // Detect and cache ephemeral duration from incoming message
        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid) {
          const rawMsg = msg.message as any;
          const ephExp =
            rawMsg?.ephemeralMessage?.message?.messageContextInfo?.expiration ||
            rawMsg?.messageContextInfo?.expiration ||
            rawMsg?.ephemeralMessage?.expiration;
          if (ephExp && ephExp > 0) {
            this.chatEphemeralCache.set(remoteJid, ephExp);
            logger.info('Cached ephemeral duration from incoming message', {
              numberId: this.numberId,
              chatJid: remoteJid,
              ephemeralExpiration: ephExp,
            });
          }
        }

        // Extract message content
        const messageContent = await this.extractMessageContent(msg.message, msg);
        if (!messageContent) {
          logger.debug('Skipping message - no content extracted', {
            numberId: this.numberId,
            messageId: msg.key.id,
            hasMessage: !!msg.message,
          });
          continue;
        }

        // Baileys: baixar mídia e armazenar no MinIO (como a API oficial faz no webhook)
        // Sem mediaUrl, a IA não consegue transcrever áudio nem descrever imagem
        if (
          messageContent.mediaType &&
          (messageContent.mediaType === 'image' ||
            messageContent.mediaType === 'audio' ||
            messageContent.mediaType === 'video' ||
            messageContent.mediaType === 'document') &&
          !messageContent.mediaUrl &&
          this.socket
        ) {
          try {
            const stored = await mediaService.downloadAndStoreWhatsAppMedia(
              this.socket,
              msg as proto.IWebMessageInfo,
              this.numberId,
              msg.key?.id
            );
            if (stored) {
              messageContent.mediaUrl = stored.mediaUrl;
              messageContent.mediaType = stored.mediaType;
              logger.info('Baileys: media downloaded and stored in MinIO', {
                messageId: msg.key.id,
                mediaType: stored.mediaType,
                storagePath: stored.mediaUrl,
              });
            } else {
              logger.warn('Baileys: media download failed', {
                messageId: msg.key.id,
                mediaType: messageContent.mediaType,
              });
            }
          } catch (err: any) {
            logger.error('Baileys: error downloading media', {
              messageId: msg.key.id,
              mediaType: messageContent.mediaType,
              error: err?.message,
            });
          }
        }

        logger.info('Message content extracted successfully', {
          numberId: this.numberId,
          messageId: msg.key.id,
          hasText: !!messageContent.text,
          hasMedia: !!messageContent.mediaUrl,
          mediaType: messageContent.mediaType,
        });

        // Extract phone number from various possible fields
        // Priority: senderPn > participantPn > remoteJid/participant
        // senderPn and participantPn contain the real phone number (PN format) even when remoteJid is LID
        let phoneNumber = '';
        const fromJid = msg.key.remoteJid || msg.key.participant || '';
        
        // Log full message structure for debugging (including all possible fields)
        // Check both msg.key and msg object for any fields that might contain the real phone number
        const msgKeyFields = Object.keys(msg.key || {});
        const msgFields = Object.keys(msg || {});
        
        logger.info('Full message structure for phone number extraction', {
          numberId: this.numberId,
          messageId: msg.key.id,
          remoteJid: msg.key.remoteJid,
          participant: msg.key.participant,
          senderPn: (msg.key as any).senderPn,
          senderLid: (msg.key as any).senderLid,
          participantPn: (msg.key as any).participantPn,
          participantLid: (msg.key as any).participantLid,
          remoteJidAlt: (msg.key as any).remoteJidAlt,
          participantAlt: (msg.key as any).participantAlt,
          allKeyFields: msgKeyFields,
          allMsgFields: msgFields,
          // Log the full key object (but limit size to avoid huge logs)
          keyObject: JSON.stringify(msg.key).substring(0, 500),
          // Check if there are any other fields in msg that might have the phone number
          hasPushName: !!(msg as any).pushName,
          pushName: (msg as any).pushName,
        });
        
        // Priority 1: Use senderPn (Phone Number format) - contains real phone number even when remoteJid is LID
        if ((msg.key as any).senderPn) {
          phoneNumber = this.extractPhoneNumberFromJid((msg.key as any).senderPn);
          logger.info('Using senderPn for phone number (real phone number)', {
            senderPn: (msg.key as any).senderPn,
            phoneNumber,
            remoteJid: msg.key.remoteJid,
          });
        }
        // Priority 2: Use participantPn (for group messages or quoted messages)
        else if ((msg.key as any).participantPn) {
          phoneNumber = this.extractPhoneNumberFromJid((msg.key as any).participantPn);
          logger.info('Using participantPn for phone number (real phone number)', {
            participantPn: (msg.key as any).participantPn,
            phoneNumber,
            remoteJid: msg.key.remoteJid,
          });
        }
        // Priority 3: Try remoteJidAlt (alternative JID that might be PN when remoteJid is LID)
        else if ((msg.key as any).remoteJidAlt && !(msg.key as any).remoteJidAlt.includes('@lid')) {
          phoneNumber = this.extractPhoneNumberFromJid((msg.key as any).remoteJidAlt);
          logger.info('Using remoteJidAlt for phone number (real phone number)', {
            remoteJidAlt: (msg.key as any).remoteJidAlt,
            phoneNumber,
            remoteJid: msg.key.remoteJid,
          });
        }
        // Priority 4: Try to resolve LID to PN using Baileys contacts or signal repository
        else if (fromJid.includes('@lid') && this.socket) {
          try {
            // Try to get the real phone number from Baileys contacts store
            const contacts = (this.socket as any).store?.contacts || {};
            const contact = contacts[fromJid];
            
            if (contact && contact.id && !contact.id.includes('@lid')) {
              // Contact has a real JID (PN format)
              phoneNumber = this.extractPhoneNumberFromJid(contact.id);
              logger.info('Resolved LID to PN using contacts store', {
                fromJid,
                contactId: contact.id,
                phoneNumber,
                messageId: msg.key.id,
              });
            } else {
              // Try signal repository LID mapping
              const signalRepository = (this.socket as any).signalRepository;
              if (signalRepository) {
                // Try different ways to access LID mapping
                const lidMapping = signalRepository.lidMapping || 
                                 (signalRepository as any).getLidMapping?.() ||
                                 (signalRepository as any).lidToPnMapping;
                
                if (lidMapping) {
                  const lidNumber = this.extractPhoneNumberFromJid(fromJid);
                  // Try to find PN for this LID
                  const pnJid = lidMapping[lidNumber] || lidMapping[fromJid];
                  
                  if (pnJid && !pnJid.includes('@lid')) {
                    phoneNumber = this.extractPhoneNumberFromJid(pnJid);
                    logger.info('Resolved LID to PN using signal repository mapping', {
                      fromJid,
                      pnJid,
                      phoneNumber,
                      messageId: msg.key.id,
                    });
                  } else {
                    phoneNumber = lidNumber;
                    logger.warn('LID mapping found but no PN available - using LID number', {
                      fromJid,
                      phoneNumber: lidNumber,
                      messageId: msg.key.id,
                    });
                  }
                } else {
                  phoneNumber = this.extractPhoneNumberFromJid(fromJid);
                  logger.warn('JID contains @lid but senderPn/participantPn not available and no LID mapping - using LID as fallback', {
                    fromJid,
                    extractedPhoneNumber: phoneNumber,
                    messageId: msg.key.id,
                    note: 'This may cause duplicate conversations if same client uses both LID and PN',
                  });
                }
              } else {
                phoneNumber = this.extractPhoneNumberFromJid(fromJid);
                logger.warn('JID contains @lid but senderPn/participantPn not available and no signal repository - using LID as fallback', {
                  fromJid,
                  extractedPhoneNumber: phoneNumber,
                  messageId: msg.key.id,
                  note: 'This may cause duplicate conversations if same client uses both LID and PN',
                });
              }
            }
          } catch (error) {
            phoneNumber = this.extractPhoneNumberFromJid(fromJid);
            logger.warn('Error trying to resolve LID - using LID as fallback', {
              fromJid,
              extractedPhoneNumber: phoneNumber,
              messageId: msg.key.id,
              error: (error as any)?.message,
            });
          }
        }
        // Priority 5: Fallback to remoteJid or participant (may be LID or PN)
        else {
          phoneNumber = this.extractPhoneNumberFromJid(fromJid);
          logger.debug('Using remoteJid/participant for phone number', {
            fromJid,
            phoneNumber,
          });
        }
        
        // Validate phone number - must be at least 10 digits and not contain @lid
        if (!phoneNumber || phoneNumber.includes('@lid') || phoneNumber.length < 10 || !/^\d+$/.test(phoneNumber)) {
          logger.error('Invalid phone number extracted after all attempts', {
            phoneNumber,
            fromJid,
            messageId: msg.key.id,
            senderPn: (msg.key as any).senderPn,
            participantPn: (msg.key as any).participantPn,
          });
          
          // Last resort: try to extract from JID and clean it
          phoneNumber = this.extractPhoneNumberFromJid(fromJid);
          
          // Remove @lid if present
          if (phoneNumber.includes('@lid')) {
            phoneNumber = phoneNumber.split('@lid')[0];
          }
          
          // Remove any non-digit characters
          phoneNumber = phoneNumber.replace(/\D/g, '');
          
          if (!phoneNumber || phoneNumber.length < 10) {
            logger.error('Failed to extract valid phone number from message - skipping', {
              fromJid,
              messageId: msg.key.id,
              finalPhoneNumber: phoneNumber,
            });
            // Skip this message if we can't get a valid phone number
            continue;
          }
        }
        
        logger.info('Phone number extracted successfully', {
          phoneNumber,
          fromJid,
          senderPn: (msg.key as any).senderPn,
          messageId: msg.key.id,
        });
        
        // Get pushName (contact name) from message
        // In Baileys, pushName is available directly on the message object
        let pushName: string | undefined = undefined;
        
        // Try to get pushName from message object (proto.IWebMessageInfo)
        if ((msg as any).pushName) {
          pushName = (msg as any).pushName;
        }
        
        // Try to get from socket contacts cache
        if (!pushName && this.socket && fromJid) {
          try {
            // Baileys stores contacts in socket.store.contacts
            const contacts = (this.socket as any).store?.contacts || {};
            if (contacts[fromJid]) {
              pushName = contacts[fromJid].name || contacts[fromJid].notify || undefined;
            }
          } catch (error) {
            // Ignore errors when accessing contacts
            logger.debug('Could not access contacts for pushName', {
              fromJid,
              error: (error as any)?.message,
            });
          }
        }
        
        logger.debug('PushName extracted', {
          fromJid,
          pushName,
          hasPushName: !!pushName,
        });

        // Extract timestamp from message - use messageTimestamp if available, otherwise use current time
        // messageTimestamp is in seconds (Unix timestamp), convert to milliseconds
        const messageTimestamp = msg.messageTimestamp 
          ? new Date(Number(msg.messageTimestamp) * 1000)
          : new Date();
        
        // Validate timestamp - ensure it's not in the future and not too old (more than 1 year)
        const now = Date.now();
        const timestampMs = messageTimestamp.getTime();
        const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
        
        if (isNaN(timestampMs) || timestampMs > now || timestampMs < oneYearAgo) {
          logger.warn('Invalid or suspicious timestamp from WhatsApp message, using current time', {
            messageId: msg.key.id,
            originalTimestamp: msg.messageTimestamp,
            calculatedTimestamp: messageTimestamp.toISOString(),
            mediaType: messageContent.mediaType,
          });
          // Use current time as fallback
          messageTimestamp.setTime(now);
        }
        
        const whatsappMessage: WhatsAppMessage = {
          id: msg.key.id || '',
          from: fromJid,
          to: this.socket?.user?.id || '',
          phoneNumber,
          text: messageContent.text || '',
          timestamp: messageTimestamp,
          mediaUrl: messageContent.mediaUrl,
          mediaType: messageContent.mediaType,
          pushName,
          participantJid: msg.key.participant || undefined,
          whatsappNumberId: this.numberId,
          ...(isFromMe && {
            fromMe: true,
            ownerPushName: pushName || this.name || 'Dono',
          }),
        };
        
        logger.debug('WhatsApp message timestamp extracted', {
          messageId: whatsappMessage.id,
          timestamp: whatsappMessage.timestamp.toISOString(),
          originalMessageTimestamp: msg.messageTimestamp,
          mediaType: messageContent.mediaType,
        });

        logger.info('Message content extracted, calling callbacks', {
          numberId: this.numberId,
          messageId: whatsappMessage.id,
          from: whatsappMessage.from,
          phoneNumber: whatsappMessage.phoneNumber,
          textLength: whatsappMessage.text?.length || 0,
          callbacksCount: this.messageCallbacks.length,
        });

        // Notify all registered callbacks
        if (this.messageCallbacks.length === 0) {
          logger.warn('No message callbacks registered!', {
            numberId: this.numberId,
          });
        }

        this.messageCallbacks.forEach((callback, index) => {
          try {
            logger.debug('Calling message callback', {
              numberId: this.numberId,
              callbackIndex: index,
            });
            callback(whatsappMessage);
            logger.debug('Message callback executed successfully', {
              numberId: this.numberId,
              callbackIndex: index,
            });
          } catch (error: any) {
            logger.error('Error in message callback', {
              numberId: this.numberId,
              callbackIndex: index,
              error: error.message,
              stack: error.stack,
            });
          }
        });

        logger.info('Incoming WhatsApp message processed and callbacks notified', {
          numberId: this.numberId,
          from: msg.key.remoteJid,
          phoneNumber: whatsappMessage.phoneNumber,
          messageId: msg.key.id,
          callbacksExecuted: this.messageCallbacks.length,
        });

        // Download de mídia em background e atualização da mensagem (real-time já emitiu placeholder)
        const mediaTypes = ['video', 'image', 'audio', 'document'];
        if (
          messageContent.mediaType &&
          mediaTypes.includes(messageContent.mediaType) &&
          !whatsappMessage.mediaUrl &&
          msg &&
          this.socket
        ) {
          void (async () => {
            const fullMessage = msg as proto.IWebMessageInfo;
            const maxRetries = 4;
            const retryDelay = 1500;

            try {
              const mediaResult = await mediaService.downloadAndStoreWhatsAppMedia(
                this.socket!,
                fullMessage,
                this.numberId,
                fullMessage.key?.id
              );

              if (!mediaResult) return;

              const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
              const internalKey = process.env.INTERNAL_API_KEY || 'default-internal-key-change-in-production';
              const url = `${backendUrl}/api/internal/messages/update-media`;

              for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                  const { status } = await axios.post(
                    url,
                    {
                      phoneNumber: whatsappMessage.phoneNumber,
                      whatsappNumberId: this.numberId,
                      whatsappMessageId: whatsappMessage.id,
                      mediaUrl: mediaResult.mediaUrl,
                      mediaType: mediaResult.mediaType,
                    },
                    {
                      headers: { 'x-internal-auth': internalKey },
                      timeout: 10000,
                    }
                  );

                  if (status === 200) {
                    logger.info('Message media updated via update-media', {
                      messageId: whatsappMessage.id,
                      mediaType: mediaResult.mediaType,
                      attempt,
                    });
                    return;
                  }
                } catch (reqErr: any) {
                  const is404 = reqErr?.response?.status === 404;
                  logger.warn('update-media attempt failed', {
                    attempt,
                    status: reqErr?.response?.status,
                    messageId: whatsappMessage.id,
                  });
                  if (!is404 || attempt === maxRetries) throw reqErr;
                  await new Promise((r) => setTimeout(r, retryDelay));
                }
              }
            } catch (err: any) {
              logger.error('Background media download or update-media failed', {
                messageId: whatsappMessage.id,
                error: err?.message,
              });
            }
          })();
        }
      }
    } catch (error: any) {
      logger.error('Error handling incoming messages', {
        numberId: this.numberId,
        error: error.message,
      });
    }
  }

  private async extractMessageContent(
    message: proto.IMessage | null | undefined,
    fullMessage?: proto.IWebMessageInfo
  ): Promise<{ text?: string; mediaUrl?: string; mediaType?: string } | null> {
    if (!message) return null;

    // Text message
    if (message.conversation) {
      return { text: message.conversation };
    }

    // Extended text message
    if (message.extendedTextMessage?.text) {
      return { text: message.extendedTextMessage.text };
    }

    // Handle media messages: retornar placeholder imediato para tempo real; download em background.
    const hasMedia = 
      message.imageMessage || 
      message.videoMessage || 
      message.audioMessage || 
      message.documentMessage;

    if (hasMedia) {
      let caption = '';
      if (message.imageMessage?.caption) caption = message.imageMessage.caption;
      else if (message.videoMessage?.caption) caption = message.videoMessage.caption;
      else if (message.documentMessage?.caption) caption = message.documentMessage.caption;
      else if (message.documentMessage?.fileName) caption = message.documentMessage.fileName;

      // Placeholder imediato (sem download) para o chat atualizar em tempo real.
      if (message.imageMessage) {
        return { text: caption || '[Imagem]', mediaType: 'image' };
      }
      if (message.videoMessage) {
        return { text: caption || '[Vídeo]', mediaType: 'video' };
      }
      if (message.audioMessage) {
        return { text: '[Áudio]', mediaType: 'audio' };
      }
      if (message.documentMessage) {
        return {
          text: caption || message.documentMessage.fileName || '[Documento]',
          mediaType: 'document',
        };
      }
    }

    return null;
  }

  private async notifyBackendConnection(whatsappNumber: string): Promise<void> {
    try {
      // Format number with + prefix if not present
      const formattedNumber = whatsappNumber.startsWith('+') 
        ? whatsappNumber 
        : `+${whatsappNumber}`;

      const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
      const connectionUrl = `${backendUrl}/api/whatsapp/connection-confirmed`;

      logger.info('Notifying backend of WhatsApp connection', {
        numberId: this.numberId,
        whatsappNumber: formattedNumber,
        connectionUrl,
      });

      const response = await axios.post(connectionUrl, {
        number_id: this.numberId,
        whatsapp_number: formattedNumber,
        connected: true,
      });

      logger.info('Backend notified successfully of WhatsApp connection', {
        numberId: this.numberId,
        whatsappNumber: formattedNumber,
        responseStatus: response.status,
      });
    } catch (error: any) {
      logger.error('Error notifying backend of connection', {
        numberId: this.numberId,
        whatsappNumber,
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      });
    }
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  async disconnect(): Promise<void> {
    try {
      logger.info('Disconnecting WhatsApp', {
        numberId: this.numberId,
      });

      if (this.socket) {
        await this.socket.end(undefined);
        this.socket = null;
      }

      this.connected = false;
      this.qrCode = null;

      logger.info('WhatsApp disconnected successfully', {
        numberId: this.numberId,
      });
    } catch (error: any) {
      logger.error('Failed to disconnect WhatsApp', {
        numberId: this.numberId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Format phone number to JID format
   * Converts "5521996330409" to "5521996330409@s.whatsapp.net"
   */
  private formatPhoneToJid(phone: string): string {
    // Remove any existing @s.whatsapp.net suffix
    const cleanPhone = phone.replace('@s.whatsapp.net', '').trim();
    
    // If it already has @s.whatsapp.net, return as is
    if (phone.includes('@s.whatsapp.net')) {
      return phone;
    }
    
    // Add @s.whatsapp.net suffix
    return `${cleanPhone}@s.whatsapp.net`;
  }

  async sendTyping(to: string, isTyping: boolean): Promise<void> {
    if (!this.connected || !this.socket) {
      logger.warn('Cannot send typing indicator - WhatsApp is not connected', {
        numberId: this.numberId,
        to,
      });
      return;
    }

    try {
      // Format phone number to JID format
      const jid = this.formatPhoneToJid(to);
      
      // Send presence update: 'composing' for typing, 'available' to stop
      await this.socket.sendPresenceUpdate(isTyping ? 'composing' : 'available', jid);

      logger.debug('Typing indicator sent', {
        numberId: this.numberId,
        to: jid,
        isTyping,
      });
    } catch (error: any) {
      logger.error('Failed to send typing indicator', {
        numberId: this.numberId,
        to,
        isTyping,
        error: error.message,
      });
      // Don't throw - typing indicator failure shouldn't break message sending
    }
  }

  async sendMessage(to: string, message: string, senderName?: string): Promise<void> {
    if (!this.connected || !this.socket) {
      throw new Error('WhatsApp is not connected');
    }

    try {
      // Format phone number to JID format
      const jid = this.formatPhoneToJid(to);
      
      // Add sender name to message if provided
      const finalMessage = senderName ? `*${senderName}:*\n${message}` : message;
      
      const ephemeralExpiration = this.chatEphemeralCache.get(jid);

      logger.info('Sending WhatsApp message', {
        numberId: this.numberId,
        to: jid,
        originalTo: to,
        messageLength: finalMessage.length,
        senderName: senderName || 'none',
        ephemeralExpiration: ephemeralExpiration || 'none',
      });

      await this.socket.sendMessage(
        jid,
        { text: finalMessage },
        ephemeralExpiration ? { ephemeralExpiration } : undefined,
      );

      logger.info('WhatsApp message sent successfully', {
        numberId: this.numberId,
        to,
      });
    } catch (error: any) {
      logger.error('Failed to send WhatsApp message', {
        numberId: this.numberId,
        to,
        error: error.message,
      });
      throw error;
    }
  }

  onTyping(callback: (data: { from: string; phoneNumber: string; isTyping: boolean }) => void): void {
    this.typingCallbacks.push(callback);
    logger.info('Typing callback registered', {
      numberId: this.numberId,
      callbacksCount: this.typingCallbacks.length,
    });
  }

  async sendMedia(to: string, mediaUrl: string, caption?: string): Promise<void> {
    if (!this.connected || !this.socket) {
      throw new Error('WhatsApp is not connected');
    }

    try {
      // Format phone number to JID format
      const jid = this.formatPhoneToJid(to);
      
      // Download media from URL
      const response = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
      });

      const buffer = Buffer.from(response.data);
      const mimeType = response.headers['content-type'] || 'image/jpeg';

      // Determine media type
      let mediaType: 'image' | 'video' | 'audio' | 'document' = 'image';
      if (mimeType.startsWith('video/')) {
        mediaType = 'video';
      } else if (mimeType.startsWith('audio/')) {
        mediaType = 'audio';
      } else if (!mimeType.startsWith('image/')) {
        mediaType = 'document';
      }

      const ephemeralExpiration = this.chatEphemeralCache.get(jid);
      const sendOpts = ephemeralExpiration ? { ephemeralExpiration } : undefined;

      // Send media
      if (mediaType === 'image') {
        await this.socket.sendMessage(jid, {
          image: buffer,
          caption: caption,
        }, sendOpts);
      } else if (mediaType === 'video') {
        await this.socket.sendMessage(jid, {
          video: buffer,
          caption: caption,
        }, sendOpts);
      } else if (mediaType === 'audio') {
        await this.socket.sendMessage(jid, {
          audio: buffer,
          mimetype: mimeType,
        }, sendOpts);
      } else {
        await this.socket.sendMessage(jid, {
          document: buffer,
          mimetype: mimeType,
          fileName: caption || 'document',
        }, sendOpts);
      }

      logger.info('WhatsApp media sent successfully', {
        numberId: this.numberId,
        to,
        mediaUrl,
        mediaType,
      });
    } catch (error: any) {
      logger.error('Failed to send WhatsApp media', {
        numberId: this.numberId,
        to,
        error: error.message,
      });
      throw error;
    }
  }

  onMessage(callback: (message: WhatsAppMessage) => void): void {
    this.messageCallbacks.push(callback);
    logger.info('Message callback registered', {
      numberId: this.numberId,
      callbacksCount: this.messageCallbacks.length,
      adapterType: 'BAILEYS',
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  getType(): 'UNOFFICIAL' {
    return 'UNOFFICIAL';
  }

  /**
   * Wait for QR code (useful for polling)
   */
  async waitForQrCode(timeout: number = 30000): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.qrCode) {
        resolve(this.qrCode);
        return;
      }

      const timeoutId = setTimeout(() => {
        this.qrCodeEmitter.removeListener('qr', qrHandler);
        resolve(null);
      }, timeout);

      const qrHandler = (qr: string) => {
        clearTimeout(timeoutId);
        this.qrCodeEmitter.removeListener('qr', qrHandler);
        resolve(qr);
      };

      this.qrCodeEmitter.once('qr', qrHandler);
    });
  }
}
