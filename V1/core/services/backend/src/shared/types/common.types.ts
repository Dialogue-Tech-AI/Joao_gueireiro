export type UUID = string;

export enum UserRole {
  SELLER = 'SELLER',
  SUPERVISOR = 'SUPERVISOR',
  ADMIN_GENERAL = 'ADMIN_GENERAL',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum AttendanceState {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  FINISHED = 'FINISHED',
}

export enum AttendanceType {
  AI = 'AI',
  HUMAN = 'HUMAN',
}

export enum OperationalState {
  /** Atendimento criado via Chamar (Contatos) - aguardando primeira mensagem enviada; não aparece em subdivisões. */
  AGUARDANDO_PRIMEIRA_MSG = 'AGUARDANDO_PRIMEIRA_MSG',
  TRIAGEM = 'TRIAGEM',
  ABERTO = 'ABERTO',
  EM_ATENDIMENTO = 'EM_ATENDIMENTO',
  AGUARDANDO_CLIENTE = 'AGUARDANDO_CLIENTE',
  AGUARDANDO_VENDEDOR = 'AGUARDANDO_VENDEDOR',
  FECHADO_OPERACIONAL = 'FECHADO_OPERACIONAL',
}

export enum AttendanceCaseType {
  COMPRA = 'COMPRA',
  GARANTIA = 'GARANTIA',
  TROCA = 'TROCA',
  ESTORNO = 'ESTORNO',
  OUTROS = 'OUTROS',
  NAO_ATRIBUIDO = 'NAO_ATRIBUIDO',
}

/** Status de um caso (attendance_case) */
export enum CaseStatus {
  NOVO = 'novo',
  EM_ANDAMENTO = 'em_andamento',
  AGUARDANDO_VENDEDOR = 'aguardando_vendedor',
  AGUARDANDO_CLIENTE = 'aguardando_cliente',
  RESOLVIDO = 'resolvido',
  CANCELADO = 'cancelado',
}

export enum PurchaseOrigin {
  WHATSAPP = 'WHATSAPP',
  TELEFONE_FIXO = 'TELEFONE_FIXO',
  ECOMMERCE = 'ECOMMERCE',
  BALCAO = 'BALCAO',
  NAO_APLICA = 'NAO_APLICA',
}

export enum PurchaseStatus {
  PENDENTE = 'PENDENTE',
  PAGO = 'PAGO',
  CANCELADO = 'CANCELADO',
  ESTORNADO = 'ESTORNADO',
}

export enum PaymentMethod {
  PIX = 'PIX',
  CARTAO = 'CARTAO',
  BOLETO = 'BOLETO',
}

export enum DeliveryMethod {
  RETIRADA = 'RETIRADA',
  ENTREGA = 'ENTREGA',
}

export enum VehicleBrand {
  FORD = 'FORD',
  GM = 'GM',
  VW = 'VW',
  FIAT = 'FIAT',
  IMPORTADOS = 'IMPORTADOS',
}

export enum MessageOrigin {
  CLIENT = 'CLIENT',
  SYSTEM = 'SYSTEM',
  SELLER = 'SELLER',
  AI = 'AI',
}

export enum MessageStatus {
  PENDING = 'PENDING',
  SENDING = 'SENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum WhatsAppAdapterType {
  OFFICIAL = 'OFFICIAL',
  UNOFFICIAL = 'UNOFFICIAL',
}

export enum WhatsAppNumberType {
  UNDEFINED = 'UNDEFINED',
  PRIMARY = 'PRIMARY',
  SECONDARY = 'SECONDARY',
}

export enum ConnectionStatus {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
}

export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
  timestamp: string;
}
