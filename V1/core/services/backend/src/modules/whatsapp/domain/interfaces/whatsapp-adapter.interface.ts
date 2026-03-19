export interface WhatsAppMessage {
  id: string;
  from: string; // JID: e.g., "5511987654321@s.whatsapp.net"
  to: string; // JID: e.g., "5511987654321@s.whatsapp.net"
  phoneNumber: string; // Extracted phone number: e.g., "5511987654321"
  text?: string;
  mediaUrl?: string;
  mediaType?: string;
  timestamp: Date;
  pushName?: string; // Contact name from WhatsApp
  participantJid?: string; // For group messages
  whatsappNumberId: string; // ID of the WhatsApp number that received the message
  /** Quando true: mensagem enviada pelo dono do número direto do celular (fora da plataforma) */
  fromMe?: boolean;
  /** Nome do dono do número (pushName do perfil) quando fromMe=true */
  ownerPushName?: string;
}

export interface IWhatsAppAdapter {
  /**
   * Send text message
   * @param to - Phone number or JID
   * @param message - Message content
   * @param senderName - Optional sender name to include in message (e.g., "Altese AI", "João Vendedor")
   */
  sendMessage(to: string, message: string, senderName?: string): Promise<void>;

  /**
   * Send media message
   */
  sendMedia(to: string, mediaUrl: string, caption?: string): Promise<void>;

  /**
   * Send typing indicator (presence update)
   * @param to - Phone number or JID
   * @param isTyping - true to show typing, false to stop
   */
  sendTyping(to: string, isTyping: boolean): Promise<void>;

  /**
   * Register callback for incoming messages
   */
  onMessage(callback: (message: WhatsAppMessage) => void): void;

  /**
   * Register callback for typing/presence updates
   * @param callback - Callback function that receives typing status updates
   */
  onTyping(callback: (data: { from: string; phoneNumber: string; isTyping: boolean }) => void): void;

  /**
   * Check if adapter is connected
   */
  isConnected(): boolean;

  /**
   * Connect to WhatsApp
   */
  connect(): Promise<void>;

  /**
   * Disconnect from WhatsApp
   */
  disconnect(): Promise<void>;

  /**
   * Get adapter type
   */
  getType(): 'OFFICIAL' | 'UNOFFICIAL';
}
