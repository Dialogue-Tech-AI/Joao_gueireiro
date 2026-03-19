import api from './api';
import { UUID } from '@/types/common.types';

/** Identificador de onde o atendimento está atribuído (ex.: Intervenção humana → Demanda telefone fixo) */
export interface AttributionSource {
  type: 'intervention' | 'seller';
  label: string;
  interventionType?: string;
  sellerId?: string;
  sellerName?: string;
  vehicleBrand?: string;
}

export interface Conversation {
  id: UUID;
  clientPhone: string;
  clientName: string;
  lastMessage: string;
  lastMessageTime: string;
  unread: number;
  state: 'OPEN' | 'IN_PROGRESS' | 'FINISHED';
  handledBy: 'AI' | 'HUMAN';
  vehicleBrand?: 'FORD' | 'GM' | 'VW' | 'FIAT' | 'IMPORTADOS';
  createdAt: string;
  updatedAt: string;
  /** Dados coletados pela FC (ex.: Demanda telefone fixo, E-commerce) */
  interventionData?: Record<string, unknown>;
  /** Tipo de intervenção (ex.: demanda-telefone-fixo, encaminhados-ecommerce) */
  interventionType?: string;
  /** Em "Atribuídos": identificador do chat (ex.: Intervenção humana → Demanda telefone fixo) */
  attributionSource?: AttributionSource;
  /** Em "Não atribuídos" > Todos: origem para badge (triagem | encaminhados-ecommerce | encaminhados-balcao) */
  unassignedSource?: 'triagem' | 'encaminhados-ecommerce' | 'encaminhados-balcao';
  /** Subdivisão do vendedor (pedidos-orcamentos, perguntas-pos-orcamento, etc.) */
  sellerSubdivision?: string;
}

export interface ContactHistoryMessage {
  id: string;
  attendanceId: UUID;
  sender: string;
  content: string;
  origin: 'CLIENT' | 'AI' | 'SELLER' | 'SYSTEM';
  isClient: boolean;
  sentAt: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
}

export interface ContactHistoryAttendance {
  attendanceId: UUID;
  state: 'OPEN' | 'IN_PROGRESS' | 'FINISHED';
  handledBy: 'AI' | 'HUMAN';
  createdAt: string;
  updatedAt: string;
  messages: ContactHistoryMessage[];
}

export interface GetConversationsBySellerResponse {
  success: boolean;
  conversations: Conversation[];
}

export interface Pending {
  id: UUID;
  clientPhone: string;
  clientName: string;
  sellerId?: UUID;
  sellerName?: string;
  vehicleBrand?: string;
  state: 'OPEN' | 'IN_PROGRESS' | 'FINISHED';
  handledBy: 'AI' | 'HUMAN';
  createdAt: string;
  updatedAt: string;
}

export interface SupervisorPendingsResponse {
  success: boolean;
  pendings: {
    orcamentos: Pending[];
    fechamento: Pending[];
    garantias: Pending[];
    encomendas: Pending[];
    chamadosHumanos: Pending[];
  };
}

export interface SupervisorStatsResponse {
  success: boolean;
  stats: {
    dayAttendances: number;
    filteredAttendances: number;
    totalAttendances: number;
    byBrand: Record<string, number>;
    byIntervention: Record<string, number>;
    unclassifiedCount: number;
  };
  filters: {
    from: string;
    to: string;
    selectedDay: string;
    brand: string | null;
  };
}

export const attendanceService = {
  /**
   * Get all conversations (attendances) routed to a specific seller
   */
  async getConversationsBySeller(sellerId: UUID): Promise<Conversation[]> {
    const response = await api.get<GetConversationsBySellerResponse>(`/attendances/seller/${sellerId}`);
    return response.data.conversations;
  },

  /**
   * Get all pending items (pendências) from all sellers assigned to the supervisor
   */
  async getSupervisorPendings(): Promise<SupervisorPendingsResponse['pendings']> {
    const response = await api.get<SupervisorPendingsResponse>('/attendances/supervisor/pendings');
    return response.data.pendings;
  },

  /**
   * Get active attendance counts per subdivision (for supervisor sidebar).
   * Ativos = isFinalized: false.
   * Keys: triagem, encaminhados-ecommerce, encaminhados-balcao, demanda-telefone-fixo, garantia, troca, estorno, seller-{id}-{sub}.
   */
  async getSubdivisionCounts(options?: { bust?: boolean }): Promise<Record<string, number>> {
    const url = options?.bust
      ? '/attendances/supervisor/subdivision-counts?bust=1'
      : '/attendances/supervisor/subdivision-counts';
    const response = await api.get<{ success: boolean; counts: Record<string, number> }>(url);
    return response.data.counts ?? {};
  },

  /**
   * Get supervisor statistics for dashboard cards.
   */
  async getSupervisorStats(params: {
    from: string;
    to: string;
    selectedDay: string;
    brand?: string;
  }): Promise<SupervisorStatsResponse['stats']> {
    const searchParams = new URLSearchParams({
      from: params.from,
      to: params.to,
      selectedDay: params.selectedDay,
    });
    if (params.brand && params.brand !== 'ALL') {
      searchParams.set('brand', params.brand);
    }
    const response = await api.get<SupervisorStatsResponse>(
      `/attendances/supervisor/stats?${searchParams.toString()}`
    );
    return response.data.stats;
  },

  /**
   * Get all unassigned attendances (for supervisor "Não Atribuídos").
   * filter: 'todos' | 'triagem' | 'encaminhados-ecommerce' | 'encaminhados-balcao'
   */
  async getUnassignedAttendances(filter?: string): Promise<Conversation[]> {
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    const response = await api.get<GetConversationsBySellerResponse>(`/attendances/unassigned${qs}`);
    return response.data.conversations;
  },

  /**
   * Get attendances "Demanda telefone fixo" (Intervenção humana)
   */
  async getInterventionDemandaTelefoneFixo(): Promise<Conversation[]> {
    const response = await api.get<GetConversationsBySellerResponse>(
      '/attendances/intervention/demanda-telefone-fixo'
    );
    return response.data.conversations;
  },

  /**
   * Get attendances por intervention type (ex.: garantia, troca, estorno)
   */
  async getInterventionByType(type: string): Promise<Conversation[]> {
    const response = await api.get<GetConversationsBySellerResponse>(
      `/attendances/intervention/${encodeURIComponent(type)}`
    );
    return response.data.conversations;
  },

  /**
   * Get all attributed attendances (seller OR intervention) for "Atribuídos" tab
   */
  async getAttributedAttendances(): Promise<Conversation[]> {
    const response = await api.get<GetConversationsBySellerResponse>('/attendances/attributed');
    return response.data.conversations;
  },

  /**
   * Get messages for a specific attendance with pagination
   */
  async getAttendanceMessages(
    attendanceId: UUID,
    limit: number = 15,
    offset: number = 0
  ): Promise<{ messages: Message[]; attendance: any; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }> {
    const response = await api.get<{ 
      success: boolean; 
      messages: Message[]; 
      attendance: any;
      pagination: { total: number; limit: number; offset: number; hasMore: boolean };
    }>(
      `/attendances/${attendanceId}/messages?limit=${limit}&offset=${offset}`
    );
    return response.data;
  },

  /**
   * Get contact-wide history (all attendances of same client contact)
   */
  async getContactHistory(
    attendanceId: UUID,
    limit: number = 250
  ): Promise<{
    success: boolean;
    contactPhone: string;
    currentAttendanceId: UUID;
    history: ContactHistoryAttendance[];
  }> {
    const response = await api.get<{
      success: boolean;
      contactPhone: string;
      currentAttendanceId: UUID;
      history: ContactHistoryAttendance[];
    }>(`/attendances/${attendanceId}/contact-history?limit=${limit}`);
    return response.data;
  },

  /**
   * Send a message to a specific attendance (text only)
   */
  async sendMessage(attendanceId: UUID, content: string): Promise<{ success: boolean; message: any }> {
    const response = await api.post<{ success: boolean; message: any }>(
      `/attendances/${attendanceId}/messages`,
      { content }
    );
    return response.data;
  },

  /**
   * Send a message with media to a specific attendance
   */
  async sendMessageWithMedia(
    attendanceId: UUID,
    file: File,
    caption?: string
  ): Promise<{ success: boolean; message: any }> {
    const formData = new FormData();
    formData.append('media', file);
    if (caption) {
      formData.append('content', caption);
    }

    // Content-Type é removido pelo interceptor da api para FormData, assim o browser envia multipart/form-data com boundary
    // e o servidor (Multer) consegue interpretar req.file corretamente.
    const response = await api.post<{ success: boolean; message: any }>(
      `/attendances/${attendanceId}/messages`,
      formData
    );
    return response.data;
  },

  /**
   * Mark messages as read for a specific attendance
   */
  async markAsRead(attendanceId: UUID): Promise<{ success: boolean; lastReadAt: string }> {
    const response = await api.post<{ success: boolean; lastReadAt: string }>(
      `/attendances/${attendanceId}/mark-read`
    );
    return response.data;
  },

  /**
   * Delete attendance (contact/conversation)
   */
  async deleteAttendance(attendanceId: UUID): Promise<{ success: boolean; message: string }> {
    const response = await api.delete<{ success: boolean; message: string }>(
      `/attendances/${attendanceId}`
    );
    return response.data;
  },

  /**
   * Assume attendance (human takes over from AI)
   */
  async assumeAttendance(attendanceId: UUID): Promise<{ 
    success: boolean; 
    message: string; 
    attendance: { id: UUID; handledBy: 'AI' | 'HUMAN'; assumedAt: string } 
  }> {
    const response = await api.post<{ 
      success: boolean; 
      message: string; 
      attendance: { id: UUID; handledBy: 'AI' | 'HUMAN'; assumedAt: string } 
    }>(
      `/attendances/${attendanceId}/assume`
    );
    return response.data;
  },

  /**
   * Return attendance to AI (human releases control)
   */
  async returnAttendanceToAI(attendanceId: UUID): Promise<{ 
    success: boolean; 
    message: string; 
    attendance: { id: UUID; handledBy: 'AI' | 'HUMAN'; returnedAt: string } 
  }> {
    const response = await api.post<{ 
      success: boolean; 
      message: string; 
      attendance: { id: UUID; handledBy: 'AI' | 'HUMAN'; returnedAt: string } 
    }>(
      `/attendances/${attendanceId}/return-to-ai`
    );
    return response.data;
  },

  /**
   * Relocation seen: creates system message + notification only when supervisor was NOT viewing.
   */
  async relocationSeen(
    attendanceId: UUID,
    wasViewing: boolean,
    interventionType: string = 'demanda-telefone-fixo'
  ): Promise<{ success: boolean; created: boolean }> {
    const response = await api.post<{ success: boolean; created: boolean }>(
      `/attendances/${attendanceId}/relocation-seen`,
      { wasViewing, interventionType }
    );
    return response.data;
  },

  /**
   * Manual assignment of attendance to a seller (supervisor / super admin).
   */
  async assignSeller(attendanceId: UUID, sellerId: UUID): Promise<{ success: boolean; attendanceId: UUID; sellerId: UUID }> {
    const response = await api.post<{ success: boolean; attendanceId: UUID; sellerId: UUID }>(
      `/attendances/${attendanceId}/assign-seller`,
      { sellerId }
    );
    return response.data;
  },

  /**
   * Get inactivity timer remaining time for an attendance
   */
  async getInactivityTimer(attendanceId: UUID): Promise<{ 
    remainingSeconds: number;
    isActive: boolean;
    assumedAt?: string;
    expiresAt?: string;
  }> {
    const response = await api.get<{ 
      remainingSeconds: number;
      isActive: boolean;
      assumedAt?: string;
      expiresAt?: string;
    }>(
      `/attendances/${attendanceId}/inactivity-timer`
    );
    return response.data;
  },

  /**
   * Get closed attendances (Fechados - FECHADO_OPERACIONAL)
   */
  async getFechadosAttendances(): Promise<Conversation[]> {
    const response = await api.get<{ success: boolean; conversations: any[] }>(
      '/attendances/fechados'
    );
    return (response.data.conversations || []).map((c: any) => ({
      id: c.id,
      clientPhone: c.clientPhone,
      clientName: c.clientName || 'Desconhecido',
      lastMessage: c.lastMessage || '',
      lastMessageTime: c.lastMessageAt || c.finalizedAt || c.updatedAt,
      unread: c.unreadCount ?? 0,
      state: 'FINISHED',
      handledBy: c.handledBy || 'AI',
      vehicleBrand: c.vehicleBrand || undefined,
      createdAt: c.createdAt || '',
      updatedAt: c.updatedAt || '',
      interventionType: undefined,
    })) as Conversation[];
  },

  /**
   * Get closed attendances for a seller (only their own).
   */
  async getFechadosAttendancesBySeller(sellerId: UUID): Promise<Conversation[]> {
    const response = await api.get<{ success: boolean; conversations: any[] }>(
      `/attendances/seller/${sellerId}/fechados`
    );
    return (response.data.conversations || []).map((c: any) => ({
      id: c.id,
      clientPhone: c.clientPhone,
      clientName: c.clientName || 'Desconhecido',
      lastMessage: c.lastMessage || '',
      lastMessageTime: c.lastMessageAt || c.finalizedAt || c.updatedAt,
      unread: c.unreadCount ?? 0,
      state: 'FINISHED',
      handledBy: c.handledBy || 'AI',
      vehicleBrand: c.vehicleBrand || undefined,
      createdAt: c.createdAt || '',
      updatedAt: c.updatedAt || '',
      interventionType: undefined,
    })) as Conversation[];
  },

  /**
   * Close attendance manually (supervisor or assigned seller)
   */
  async closeAttendance(attendanceId: UUID): Promise<{ 
    success: boolean; 
    message: string;
    attendance: { id: UUID; operationalState: string; finalizedAt: string };
  }> {
    const response = await api.post<{ 
      success: boolean; 
      message: string;
      attendance: { id: UUID; operationalState: string; finalizedAt: string };
    }>(
      `/attendances/${attendanceId}/close`
    );
    return response.data;
  },

  /**
   * Get AI status for an attendance
   */
  async getAIStatus(attendanceId: UUID): Promise<{
    aiDisabled: boolean;
    aiDisabledUntil: string | null;
    remainingSeconds: number;
    isUnlimited: boolean;
  }> {
    const response = await api.get(`/attendances/${attendanceId}/ai-status`);
    return response.data;
  },

  /**
   * Enable AI for an attendance
   */
  async enableAI(attendanceId: UUID): Promise<{ success: boolean; message: string }> {
    const response = await api.post(`/attendances/${attendanceId}/ai-enable`);
    return response.data;
  },

  /**
   * Disable AI for an attendance
   * @param hours - Number of hours to disable AI. If 0 or undefined, disable indefinitely
   */
  async disableAI(attendanceId: UUID, hours?: number): Promise<{ 
    success: boolean; 
    message: string;
    aiDisabledUntil: string;
  }> {
    const response = await api.post(`/attendances/${attendanceId}/ai-disable`, { hours });
    return response.data;
  },
};

export interface Message {
  id: string;
  sender: string;
  content: string;
  time: string;
  sentAt: string;
  isClient: boolean;
  origin?: 'CLIENT' | 'AI' | 'SELLER' | 'SYSTEM';
  avatar?: string;
  hasLink?: boolean;
  attachments?: string[];
  metadata?: Record<string, any>;
}
