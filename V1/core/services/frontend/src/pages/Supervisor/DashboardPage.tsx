import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, startTransition } from 'react';
import { useAuthStore } from '../../store/auth.store';
import { MediaPlayer } from '../../components/Chat/MediaPlayer';
import { MediaUpload } from '../../components/Chat/MediaUpload';
import { AudioRecorder } from '../../components/Chat/AudioRecorder';
import { EmojiPicker } from '../../components/Chat/EmojiPicker';
import { TypingIndicator } from '../../components/Chat/TypingIndicator';
import { userService } from '../../services/user.service';
import { attendanceService, Conversation, Message, ContactHistoryAttendance } from '../../services/attendance.service';
import { socketService } from '../../services/socket.service';
import { useNotifications } from '../../contexts/NotificationContext';
import { quoteService, type QuoteRequest } from '../../services/quote.service';
import { mediaService } from '../../services/media.service';
import toast from 'react-hot-toast';
import { contactsService, type Contact, type WhatsAppNumberInfo } from '../../services/contacts.service';

type VehicleBrand = 'FORD' | 'GM' | 'VW' | 'FIAT' | 'IMPORTADOS';

/** Categorias de serviço (Intervenção humana - apenas Outros assuntos) */
type ServiceCategory = 'OUTROS_ASSUNTOS';
type FollowUpNode = 'follow-up' | 'inativo-1h' | 'inativo-12h' | 'inativo-24h';
const SERVICE_CATEGORIES: { key: ServiceCategory; label: string; icon: string }[] = [
  { key: 'OUTROS_ASSUNTOS', label: 'Outros assuntos', icon: 'topic' },
];
/** Mapeamento categoria -> marcas (para compatibilidade com backend) */
const CATEGORY_TO_BRANDS: Record<ServiceCategory, VehicleBrand[]> = {
  OUTROS_ASSUNTOS: ['VW', 'FIAT', 'IMPORTADOS'],
};
const FOLLOW_UP_LABELS: Record<FollowUpNode, string> = {
  'follow-up': 'Follow UP',
  'inativo-1h': 'Aguardando 1º Follow up',
  'inativo-12h': 'Aguardando 2º Follow up',
  'inativo-24h': 'Aguardando',
};
/** Subdivisões da AI (Abertos): primeiro "Não classificados", depois as classificadas */
type AISubdivision =
  | 'ai-nao-classificados'
  | 'ai-flash-day'
  | 'ai-locacao-estudio'
  | 'ai-captacao-videos';
const AI_SUBDIVISIONS: { key: AISubdivision; label: string; icon: string }[] = [
  { key: 'ai-nao-classificados', label: 'Não classificados', icon: 'label_off' },
  { key: 'ai-flash-day', label: 'Flash Day', icon: 'flash_on' },
  { key: 'ai-locacao-estudio', label: 'Locação de estúdio', icon: 'videocam' },
  { key: 'ai-captacao-videos', label: 'Captação de vídeos', icon: 'movie' },
];

/** Badge na lista: nome da subdivisão AI ou null (usa "AI" quando não há subdivisão) */
function getAiSubdivisionBadgeLabel(
  unassignedSource: string | undefined,
  aiContextSubdivision?: string | undefined
): string | null {
  if (unassignedSource === 'triagem') return 'Não classificados';
  const fromKey = unassignedSource ? AI_SUBDIVISIONS.find((s) => s.key === unassignedSource)?.label : null;
  if (fromKey) return fromKey;
  const map: Record<string, string> = {
    'flash-day': 'Flash Day',
    'locacao-estudio': 'Locação de estúdio',
    'captacao-videos': 'Captação de vídeos',
  };
  if (aiContextSubdivision && map[aiContextSubdivision]) return map[aiContextSubdivision];
  return null;
}
/** Mapeamento serviço -> interventionType (quando filtro Intervenção humana está ativo) */
const SERVICE_TO_INTERVENTION: Record<ServiceCategory, string | string[]> = {
  OUTROS_ASSUNTOS: ['outros-assuntos'],
};
/** Mapeamento interventionType -> serviço (para roteamento em tempo real) */
const INTERVENTION_TO_SERVICE: Record<string, ServiceCategory> = {
  'protese-capilar': 'OUTROS_ASSUNTOS',
  'demanda-telefone-fixo': 'OUTROS_ASSUNTOS',
  'outros-assuntos': 'OUTROS_ASSUNTOS',
};
/** interventionType -> label do serviço para badge no card */
const INTERVENTION_TO_SERVICE_LABEL: Record<string, string> = {
  'protese-capilar': 'Outros assuntos',
  'demanda-telefone-fixo': 'Outros assuntos',
  'outros-assuntos': 'Outros assuntos',
};
/** Rótulos do backend (interventionTypeLabel) -> nosso label */
const BACKEND_LABEL_TO_SERVICE: Record<string, string> = {
  'Protese capilar': 'Outros assuntos',
  'Demanda telefone fixo': 'Outros assuntos',
  'Outros assuntos': 'Outros assuntos',
};
const isLegacyRelocationSystemMessage = (msg?: {
  origin?: string;
  content?: string;
  metadata?: Record<string, any>;
}): boolean => {
  if (!msg) return false;
  const origin = String(msg.origin || '').toUpperCase();
  const content = String(msg.content || '');
  const type = String(msg.metadata?.type || '').toLowerCase();
  return origin === 'SYSTEM' && (type === 'relocation' || content.includes('Conversa realocada para'));
};
function getServiceLabelFromConv(conv: any, serviceHint?: ServiceCategory | null): string | null {
  const it = conv?.interventionType ?? conv?.attributionSource?.interventionType;
  if (it && INTERVENTION_TO_SERVICE_LABEL[it]) return INTERVENTION_TO_SERVICE_LABEL[it];

  const labelRaw = String(conv?.attributionSource?.label || '').trim();
  if (labelRaw && BACKEND_LABEL_TO_SERVICE[labelRaw]) return BACKEND_LABEL_TO_SERVICE[labelRaw];
  if (labelRaw) {
    const normalized = labelRaw.toLowerCase();
    if (normalized.includes('protese') || normalized.includes('prótese') || normalized.includes('telefone fixo') || normalized.includes('manutenc') || normalized.includes('outros assuntos')) return 'Outros assuntos';
  }

  const brand = conv?.vehicleBrand as VehicleBrand | undefined;
  if (brand) return getCategoryLabelForBrand(brand);

  if (serviceHint) {
    const cat = SERVICE_CATEGORIES.find((c) => c.key === serviceHint);
    if (cat) return cat.label;
  }

  return null;
}
/** Mapeia marca do vendedor para rótulo da categoria de serviço */
const getCategoryLabelForBrand = (brand: VehicleBrand): string => {
  for (const [cat, brands] of Object.entries(CATEGORY_TO_BRANDS)) {
    if (brands.includes(brand)) return SERVICE_CATEGORIES.find(c => c.key === cat)!.label;
  }
  return String(brand);
};
type SupervisorTab = 'chat' | 'estatisticas' | 'contatos';
const SUPERVISOR_TAB_ORDER: SupervisorTab[] = ['chat', 'estatisticas', 'contatos'];
/** Retorna classes de translate (GPU: translate3d): mobile X, desktop Y. Usa classes CSS otimizadas para transição fluida. */
function getSupervisorTabSlideClass(panelTab: SupervisorTab, activeTab: SupervisorTab): string {
  const pi = SUPERVISOR_TAB_ORDER.indexOf(panelTab);
  const ai = SUPERVISOR_TAB_ORDER.indexOf(activeTab);
  if (pi === ai) return 'supervisor-tab-mobile-center supervisor-tab-desktop-center';
  if (pi < ai) return 'supervisor-tab-mobile-left supervisor-tab-desktop-up';
  return 'supervisor-tab-mobile-right supervisor-tab-desktop-down';
}
type StatsPeriod = 'dia' | 'semana' | 'mes';

interface SupervisorStatsState {
  dayAttendances: number;
  filteredAttendances: number;
  totalAttendances: number;
  byBrand: Record<string, number>;
  byIntervention: Record<string, number>;
  byAiSubdivision?: Record<string, number>;
  /** FCs agendamento_* no período */
  byAgendamentoCalls?: Record<string, number>;
  unclassifiedCount: number;
}

interface Seller {
  id: string;
  name: string;
  email: string;
  brands: VehicleBrand[];
  isUnavailable?: boolean;
  unavailableUntil?: string | null;
}

/** Rótulos amigáveis para chaves de interventionData (evita exibir nomes de variáveis como client_phone). */
const INTERVENTION_DATA_LABELS: Record<string, string> = {
  client_phone: 'Telefone',
  clientPhone: 'Telefone',
  client_name: 'Nome do cliente',
  clientName: 'Nome do cliente',
  nome_cliente: 'Nome do cliente',
  vehicle_brand: 'Marca do veículo',
  vehicleBrand: 'Marca do veículo',
  placa: 'Placa',
  chassi: 'Chassi',
  modelo: 'Modelo',
  ano: 'Ano',
  nome: 'Nome',
  telefone: 'Telefone',
  email: 'E-mail',
  observacoes: 'Observações',
  observações: 'Observações',
  'Proximos-Passos': 'Próximos passos',
  'Motivo-Do-Contato': 'Motivo do contato',
  'Resumo-Da-Conversa': 'Resumo da conversa',
  'Intencao-Do-Cliente': 'Intenção do cliente',
  'Pra-Quem-E-A-Protese': 'Pra quem é a prótese',
};

export const SupervisorDashboard: React.FC = () => {
  const { user } = useAuthStore();
  const { notifications, markRelocationAsReadByAttendance } = useNotifications();
  const [selectedConversation, setSelectedConversation] = useState<string | number | null>(null);
  const [messageInput, setMessageInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [activeSupervisorTab, setActiveSupervisorTab] = useState<SupervisorTab>('chat');
  const [hasUserSwitchedTabs, setHasUserSwitchedTabs] = useState(false);
  const [contactsList, setContactsList] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsSearch, setContactsSearch] = useState('');
  const [contactsSortOrder, setContactsSortOrder] = useState<'recent' | 'alphabetical'>('recent');
  const [contactsSortDropdownOpen, setContactsSortDropdownOpen] = useState(false);
  const contactsSortDropdownRef = useRef<HTMLDivElement>(null);
  const [baileysNumbers, setBaileysNumbers] = useState<WhatsAppNumberInfo[]>([]);
  const [mobileChatLayer, setMobileChatLayer] = useState<'entry' | 'conversations' | 'chat'>('entry');
  const [mobileCustomerInfoOpen, setMobileCustomerInfoOpen] = useState(false);
  useEffect(() => { if (activeSupervisorTab === 'chat') setMobileChatLayer('entry'); }, [activeSupervisorTab]);

  const handleSupervisorTabChange = useCallback((tab: SupervisorTab) => {
    if (tab !== activeSupervisorTab) setHasUserSwitchedTabs(true);
    setActiveSupervisorTab(tab);
  }, [activeSupervisorTab]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSelectedNumber, setImportSelectedNumber] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const [contactsBulkSelectMode, setContactsBulkSelectMode] = useState(false);
  const [selectedContactsForBulk, setSelectedContactsForBulk] = useState<Set<string>>(new Set());
  const [isDeletingContactsBulk, setIsDeletingContactsBulk] = useState(false);
  const [customerSidebarOpen, setCustomerSidebarOpen] = useState(true);
  const [selectedAttendanceFilter, setSelectedAttendanceFilter] = useState<string>('abertos');
  /** true = view "Intervenção humana" (todas intervenções com badge por serviço); false = view de serviços (vendedores) */
  const [viewingIntervencaoHumana, setViewingIntervencaoHumana] = useState<boolean>(false);
  const [selectedNaoAtribuidosFilter, setSelectedNaoAtribuidosFilter] = useState<
    | 'todos'
    | 'triagem'
    | 'encaminhados-ecommerce'
    | 'encaminhados-balcao'
    | 'ai-nao-classificados'
    | 'ai-flash-day'
    | 'ai-locacao-estudio'
    | 'ai-captacao-videos'
  >('todos');
  const [selectedFechadosFilter, setSelectedFechadosFilter] = useState<boolean>(false);
  const [fechadosConversations, setFechadosConversations] = useState<Conversation[]>([]);
  const [isLoadingFechados, setIsLoadingFechados] = useState(false);
  const [selectedSeller, setSelectedSeller] = useState<string | null>(null);
  const [selectedSellerSubdivision, setSelectedSellerSubdivision] = useState<string | null>(null);
  /** Marca do contexto ao clicar vendedor em MARCAS (ex.: Fiat → João). Usado no header. */
  const [selectedSellerBrand, setSelectedSellerBrand] = useState<VehicleBrand | null>(null);
  const [expandedTodasDemandas, setExpandedTodasDemandas] = useState<boolean>(false);
  const [selectedTodasDemandasSubdivision, setSelectedTodasDemandasSubdivision] = useState<string | null>(null);
  /** Quando não nulo, a view de demandas veio do dropdown "Demandas" (e não de "Todas as Demandas"). */
  const [selectedDemandaKey, setSelectedDemandaKey] = useState<string | null>(null);
  const [supervisorBrands, setSupervisorBrands] = useState<VehicleBrand[]>([]);
  const [selectedServiceCategory, setSelectedServiceCategory] = useState<ServiceCategory | null>(null);
  const [selectedFollowUpNode, setSelectedFollowUpNode] = useState<FollowUpNode | null>(null);
  const [supervisorSellers, setSupervisorSellers] = useState<Seller[]>([]);
  const [updatingSellerAvailabilityIds, setUpdatingSellerAvailabilityIds] = useState<Record<string, boolean>>({});
  const [availabilityNow, setAvailabilityNow] = useState(() => Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [pendingQuotes, setPendingQuotes] = useState<QuoteRequest[]>([]);
  const [isLoadingPendingQuotes, setIsLoadingPendingQuotes] = useState(false);
  /** Pedidos de Orçamento: mesma view do vendedor (sub-tabs + lista + card de detalhe) */
  const [quoteCards, setQuoteCards] = useState<QuoteRequest[]>([]);
  const [sentQuoteCards, setSentQuoteCards] = useState<QuoteRequest[]>([]);
  const [selectedQuote, setSelectedQuote] = useState<QuoteRequest | null>(null);
  const [quoteSubTab, setQuoteSubTab] = useState<'pendentes' | 'enviados'>('pendentes');
  /** Quando true, veio do clique no card "Demandas" - não exibir abas Pendentes/Orçamentos enviados */
  const [viewingFromDemandasCard, setViewingFromDemandasCard] = useState(false);
  const [isLoadingQuotes, setIsLoadingQuotes] = useState(false);
  /** Resposta a pedidos de orçamento (supervisor pode enviar orçamento e perguntar) */
  const [selectedQuoteForPerguntar, setSelectedQuoteForPerguntar] = useState<string | null>(null);
  const [perguntarText, setPerguntarText] = useState('');
  const [isSendingPerguntar, setIsSendingPerguntar] = useState(false);
  const [quoteResponseText, setQuoteResponseText] = useState('');
  const [quoteResponseImage, setQuoteResponseImage] = useState<File | null>(null);
  const [isSendingQuote, setIsSendingQuote] = useState(false);
  const [isDeletingQuote, setIsDeletingQuote] = useState<string | null>(null);
  /** VERDE: IDs de pedidos de orçamento visualizados pelo vendedor (baseado em sellerViewedAt do backend) */
  const [viewedQuoteIds, setViewedQuoteIds] = useState<Set<string>>(() => new Set());
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [contactHistory, setContactHistory] = useState<ContactHistoryAttendance[]>([]);
  const [isLoadingContactHistory, setIsLoadingContactHistory] = useState(false);
  const [showFullContactHistoryModal, setShowFullContactHistoryModal] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [messagesOffset, setMessagesOffset] = useState(0);
  const [refreshMessagesTrigger, setRefreshMessagesTrigger] = useState(0);
  const [totalUnreadUnassigned, setTotalUnreadUnassigned] = useState(0);
  const [totalUnreadAbertos, setTotalUnreadAbertos] = useState(0);
  const [unassignedConversationsCache, setUnassignedConversationsCache] = useState<Conversation[]>([]);
  /** Contagem de não lidas por subdivisão: triagem, encaminhados-ecommerce, encaminhados-balcao, demanda-telefone-fixo, seller-{id} */
  const [unreadBySubdivision, setUnreadBySubdivision] = useState<Record<string, number>>({});
  /** Notificações vermelhas (roteamento): contagem por divisão (nao-atribuidos, intervencao-humana, FORD, GM, ...) */
  const [redByDivision, setRedByDivision] = useState<Record<string, number>>({});
  /** Notificações vermelhas por subdivisão (mesmas chaves que unreadBySubdivision) */
  const [redBySubdivision, setRedBySubdivision] = useState<Record<string, number>>({});
  /** IDs de conversas com notificação vermelha pendente (para badge no card) */
  const [redConversationIds, setRedConversationIds] = useState<Record<string, true>>({});
  /** Contagem de atendimentos abertos por subdivisão (tempo real). Keys: triagem, encaminhados-ecommerce, demanda-telefone-fixo, seller-{id}-{sub}, etc. */
  const [activeCountBySubdivision, setActiveCountBySubdivision] = useState<Record<string, number>>({});
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [selectedConversationData, setSelectedConversationData] = useState<Conversation | null>(null);
  /** Sidebar details prontos: evita exibir "Humano" antes do dado real (piscar). Opacity 0→1 quando loadMessages conclui. */
  const [sidebarDetailsReady, setSidebarDetailsReady] = useState(false);
  /** Chat ao vivo: fade-in suave ao carregar mensagens (evita piscar). */
  const [chatMessagesFadeIn, setChatMessagesFadeIn] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const getConversationSortTimestamp = (c: Conversation): number => {
    const ts = (c as any).lastMessageTime || c.updatedAt || c.createdAt;
    if (!ts) return 0;
    const t = new Date(ts).getTime();
    return isNaN(t) ? 0 : t;
  };
  const [showAudioRecorder, setShowAudioRecorder] = useState(false);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const chatMessageTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [isAITyping, setIsAITyping] = useState<Record<string, boolean>>({});
  const [isClientTyping, setIsClientTyping] = useState<Record<string, boolean>>({});
  const typingTimeoutRef = useRef<Record<string, NodeJS.Timeout>>({});
  const clientTypingTimeoutRef = useRef<Record<string, NodeJS.Timeout>>({});
  const processedMessagesRef = useRef<Set<string>>(new Set());
  const processedMessageReceivedRef = useRef<Set<string>>(new Set());
  const processedRelocationsRef = useRef<Set<string>>(new Set());
  const processedRoutedAttendancesRef = useRef<Set<string>>(new Set());
  const [inactivityTimer, setInactivityTimer] = useState<Record<string, number>>({}); // Time remaining in seconds (from backend)
  const inactivityTimerIntervalRef = useRef<Record<string, NodeJS.Timeout>>({});
  const [aiStatus, setAiStatus] = useState<Record<string, { disabled: boolean }>>({}); // Intervals for fetching timer from backend
  const [isReturningToAI, setIsReturningToAI] = useState(false);
  const [isBulkSelectMode, setIsBulkSelectMode] = useState(false);
  const [selectedAttendancesForBulk, setSelectedAttendancesForBulk] = useState<Set<string>>(new Set());
  const [isClosingBulk, setIsClosingBulk] = useState(false);
  const [pastedImage, setPastedImage] = useState<File | null>(null);
  const [statsPeriod, setStatsPeriod] = useState<StatsPeriod>('dia');
  const [statsDay, setStatsDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [statsWeekStart, setStatsWeekStart] = useState(() => {
    const now = new Date();
    const day = now.getDay(); // 0 = domingo
    const diffToMonday = day === 0 ? -6 : 1 - day;
    now.setDate(now.getDate() + diffToMonday);
    return now.toISOString().slice(0, 10);
  });
  const [statsMonth, setStatsMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [supervisorStats, setSupervisorStats] = useState<SupervisorStatsState>({
    dayAttendances: 0,
    filteredAttendances: 0,
    totalAttendances: 0,
    byBrand: {},
    byIntervention: {},
    byAgendamentoCalls: {},
    unclassifiedCount: 0,
  });
  const [isLoadingSupervisorStats, setIsLoadingSupervisorStats] = useState(false);
  const [monthAttendances, setMonthAttendances] = useState(0);
  const [isLoadingMonthAttendances, setIsLoadingMonthAttendances] = useState(false);
  const [weekAttendances, setWeekAttendances] = useState(0);
  const [isLoadingWeekAttendances, setIsLoadingWeekAttendances] = useState(false);
  const selectedNavTextStyle = useMemo(
    () => ({ color: isDarkMode ? '#e2e8f0' : '#003070' }),
    [isDarkMode]
  );

  const themeStorageKey = useMemo(
    () => (user?.id ? `altese:theme:${user.id}` : 'altese:theme:guest'),
    [user?.id]
  );

  const statsRange = useMemo(() => {
    const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);
    if (statsPeriod === 'dia') {
      return { from: statsDay, to: statsDay, selectedDay: statsDay };
    }
    if (statsPeriod === 'semana') {
      const start = new Date(`${statsWeekStart}T00:00:00`);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return { from: statsWeekStart, to: toIsoDate(end), selectedDay: statsWeekStart };
    }
    const [year, month] = statsMonth.split('-').map(Number);
    const start = new Date(year, (month || 1) - 1, 1);
    const end = new Date(year, month || 1, 0);
    const startIso = toIsoDate(start);
    return { from: startIso, to: toIsoDate(end), selectedDay: startIso };
  }, [statsPeriod, statsDay, statsWeekStart, statsMonth]);

  const statsMonthRange = useMemo(() => {
    const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);
    const [year, month] = statsMonth.split('-').map(Number);
    const start = new Date(year, (month || 1) - 1, 1);
    const end = new Date(year, month || 1, 0);
    const startIso = toIsoDate(start);
    return { from: startIso, to: toIsoDate(end), selectedDay: startIso };
  }, [statsMonth]);

  const statsWeekRange = useMemo(() => {
    const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);
    const start = new Date(`${statsWeekStart}T00:00:00`);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: statsWeekStart, to: toIsoDate(end), selectedDay: statsWeekStart };
  }, [statsWeekStart]);

  const activeSupervisorTabRef = useRef(activeSupervisorTab);
  const statsRangeRef = useRef(statsRange);
  const statsMonthRangeRef = useRef(statsMonthRange);
  const statsWeekRangeRef = useRef(statsWeekRange);
  const statsRealtimeRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const statsRealtimeRefreshInFlightRef = useRef(false);

  useEffect(() => {
    activeSupervisorTabRef.current = activeSupervisorTab;
  }, [activeSupervisorTab]);

  useEffect(() => {
    statsRangeRef.current = statsRange;
  }, [statsRange]);

  useEffect(() => {
    statsMonthRangeRef.current = statsMonthRange;
  }, [statsMonthRange]);

  useEffect(() => {
    statsWeekRangeRef.current = statsWeekRange;
  }, [statsWeekRange]);

  const refreshStatsRealtime = useCallback(async () => {
    if (!user?.id || user?.role !== 'SUPERVISOR') return;
    if (activeSupervisorTabRef.current !== 'estatisticas') return;
    if (statsRealtimeRefreshInFlightRef.current) return;

    statsRealtimeRefreshInFlightRef.current = true;
    try {
      const [stats, monthStats, weekStats] = await Promise.all([
        attendanceService.getSupervisorStats({
          from: statsRangeRef.current.from,
          to: statsRangeRef.current.to,
          selectedDay: statsRangeRef.current.selectedDay,
          brand: 'ALL',
        }),
        attendanceService.getSupervisorStats({
          from: statsMonthRangeRef.current.from,
          to: statsMonthRangeRef.current.to,
          selectedDay: statsMonthRangeRef.current.selectedDay,
          brand: 'ALL',
        }),
        attendanceService.getSupervisorStats({
          from: statsWeekRangeRef.current.from,
          to: statsWeekRangeRef.current.to,
          selectedDay: statsWeekRangeRef.current.selectedDay,
          brand: 'ALL',
        }),
      ]);

      setSupervisorStats(stats);
      setMonthAttendances(monthStats.filteredAttendances ?? 0);
      setWeekAttendances(weekStats.filteredAttendances ?? 0);
    } catch (error) {
      console.warn('Falha ao atualizar estatísticas em tempo real:', error);
    } finally {
      statsRealtimeRefreshInFlightRef.current = false;
    }
  }, [user?.id, user?.role]);

  const scheduleStatsRealtimeRefresh = useCallback((delayMs = 500) => {
    if (activeSupervisorTabRef.current !== 'estatisticas') return;
    if (statsRealtimeRefreshTimeoutRef.current) {
      clearTimeout(statsRealtimeRefreshTimeoutRef.current);
    }
    statsRealtimeRefreshTimeoutRef.current = setTimeout(() => {
      refreshStatsRealtime();
    }, delayMs);
  }, [refreshStatsRealtime]);

  useEffect(() => {
    return () => {
      if (statsRealtimeRefreshTimeoutRef.current) {
        clearTimeout(statsRealtimeRefreshTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setAvailabilityNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedTheme = localStorage.getItem(themeStorageKey);
    const guestTheme = localStorage.getItem('altese:theme:guest');
    const legacyTheme = localStorage.getItem('darkMode');
    const domAlreadyDark = document.documentElement.classList.contains('dark');
    const parseTheme = (value: string | null): boolean | null => {
      if (value == null) return null;
      const normalized = value.trim().toLowerCase();
      if (normalized === 'dark' || normalized === 'true' || normalized === '1') return true;
      if (normalized === 'light' || normalized === 'false' || normalized === '0') return false;
      return null;
    };
    const parsedSaved = parseTheme(savedTheme);
    const parsedGuest = parseTheme(guestTheme);
    const parsedLegacy = parseTheme(legacyTheme);
    const shouldUseDark =
      parsedSaved != null
        ? parsedSaved
        : parsedGuest != null
          ? parsedGuest
          : parsedLegacy != null
            ? parsedLegacy
            : domAlreadyDark;

    setIsDarkMode(shouldUseDark);
    document.documentElement.classList.toggle('dark', shouldUseDark);

    // Migração automática para chave por conta.
    if (!savedTheme && user?.id) {
      localStorage.setItem(themeStorageKey, shouldUseDark ? 'dark' : 'light');
    }
  }, [themeStorageKey, user?.id]);

  const toggleTheme = useCallback(() => {
    const nextMode = !isDarkMode;
    setIsDarkMode(nextMode);
    localStorage.setItem(themeStorageKey, nextMode ? 'dark' : 'light');
    // Mantém fallback consistente quando user ainda não carregou.
    localStorage.setItem('altese:theme:guest', nextMode ? 'dark' : 'light');
    // Compatibilidade com chave antiga usada em outras telas.
    localStorage.setItem('darkMode', nextMode ? 'true' : 'false');
    document.documentElement.classList.toggle('dark', nextMode);
  }, [isDarkMode, themeStorageKey]);

  useEffect(() => {
    if (activeSupervisorTab !== 'estatisticas') return;
    let cancelled = false;
    const loadStats = async () => {
      try {
        setIsLoadingSupervisorStats(true);
        const stats = await attendanceService.getSupervisorStats({
          from: statsRange.from,
          to: statsRange.to,
          selectedDay: statsRange.selectedDay,
          brand: 'ALL',
        });
        if (!cancelled) setSupervisorStats(stats);
      } catch (error) {
        if (!cancelled) {
          console.error('Error loading supervisor stats:', error);
          toast.error('Erro ao carregar estatísticas');
        }
      } finally {
        if (!cancelled) setIsLoadingSupervisorStats(false);
      }
    };
    loadStats();
    return () => {
      cancelled = true;
    };
  }, [activeSupervisorTab, statsRange]);

  useEffect(() => {
    if (activeSupervisorTab !== 'estatisticas') return;
    let cancelled = false;
    const loadMonthAttendances = async () => {
      try {
        setIsLoadingMonthAttendances(true);
        const monthStats = await attendanceService.getSupervisorStats({
          from: statsMonthRange.from,
          to: statsMonthRange.to,
          selectedDay: statsMonthRange.selectedDay,
          brand: 'ALL',
        });
        if (!cancelled) {
          setMonthAttendances(monthStats.filteredAttendances ?? 0);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error loading month attendances:', error);
          setMonthAttendances(0);
        }
      } finally {
        if (!cancelled) setIsLoadingMonthAttendances(false);
      }
    };

    loadMonthAttendances();
    return () => {
      cancelled = true;
    };
  }, [activeSupervisorTab, statsMonthRange]);

  useEffect(() => {
    if (activeSupervisorTab !== 'estatisticas') return;
    let cancelled = false;
    const loadWeekAttendances = async () => {
      try {
        setIsLoadingWeekAttendances(true);
        const weekStats = await attendanceService.getSupervisorStats({
          from: statsWeekRange.from,
          to: statsWeekRange.to,
          selectedDay: statsWeekRange.selectedDay,
          brand: 'ALL',
        });
        if (!cancelled) {
          setWeekAttendances(weekStats.filteredAttendances ?? 0);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error loading week attendances:', error);
          setWeekAttendances(0);
        }
      } finally {
        if (!cancelled) setIsLoadingWeekAttendances(false);
      }
    };

    loadWeekAttendances();
    return () => {
      cancelled = true;
    };
  }, [activeSupervisorTab, statsWeekRange]);

  useEffect(() => {
    if (activeSupervisorTab !== 'contatos') return;
    let cancelled = false;
    const loadContacts = async () => {
      try {
        setContactsLoading(true);
        const [contacts, numbers] = await Promise.all([
          contactsService.listContacts(),
          contactsService.listWhatsAppNumbers(),
        ]);
        if (!cancelled) {
          setContactsList(contacts);
          setBaileysNumbers(numbers);
        }
      } catch (error: any) {
        if (!cancelled) {
          console.error('Error loading contacts:', error);
          const msg = error?.response?.data?.error || error?.message || 'Sem conexão com o servidor';
          toast.error(`Erro ao carregar contatos: ${typeof msg === 'string' ? msg : 'Tente novamente'}`);
        }
      } finally {
        if (!cancelled) setContactsLoading(false);
      }
    };
    loadContacts();
    return () => { cancelled = true; };
  }, [activeSupervisorTab]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contactsSortDropdownRef.current && !contactsSortDropdownRef.current.contains(e.target as Node)) {
        setContactsSortDropdownOpen(false);
      }
    };
    if (contactsSortDropdownOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contactsSortDropdownOpen]);

  const filteredContacts = useMemo(() => {
    let list = contactsList;
    if (contactsSearch.trim()) {
      const q = contactsSearch.toLowerCase();
      list = list.filter(
        (c) => c.clientPhone.includes(q) || (c.clientName && c.clientName.toLowerCase().includes(q))
      );
    }
    const sorted = [...list];
    if (contactsSortOrder === 'recent') {
      sorted.sort((a, b) => new Date(b.lastContactAt).getTime() - new Date(a.lastContactAt).getTime());
    } else {
      sorted.sort((a, b) => {
        const nameA = (a.clientName || a.clientPhone || '').toLowerCase().trim();
        const nameB = (b.clientName || b.clientPhone || '').toLowerCase().trim();
        return nameA.localeCompare(nameB, 'pt-BR');
      });
    }
    return sorted;
  }, [contactsList, contactsSearch, contactsSortOrder]);

  const handleImportContacts = async () => {
    if (!importFile || !importSelectedNumber) {
      toast.error('Selecione o arquivo CSV e o número WhatsApp');
      return;
    }
    if (!importFile.name.toLowerCase().endsWith('.csv')) {
      toast.error('O arquivo deve ser CSV');
      return;
    }
    try {
      setImportLoading(true);
      const result = await contactsService.importContacts(importFile, importSelectedNumber);
      toast.success(result.message);
      setShowImportModal(false);
      setImportFile(null);
      setImportSelectedNumber('');
      if (importFileInputRef.current) importFileInputRef.current.value = '';
      if (result.imported > 0 && activeSupervisorTab === 'contatos') {
        const contacts = await contactsService.listContacts();
        setContactsList(contacts);
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Erro ao importar');
    } finally {
      setImportLoading(false);
    }
  };

  const pendingChamarConversationRef = useRef<{ id: string } & Record<string, unknown> | null>(null);

  const handleInitiateConversation = async (clientPhone: string) => {
    if (baileysNumbers.length === 0) {
      toast.error('Nenhum número Baileys disponível');
      return;
    }
    try {
      const connectedNumber = baileysNumbers.find((n) => n.connectionStatus === 'CONNECTED') || baileysNumbers[0];
      const result = await contactsService.initiateConversation(clientPhone, connectedNumber.id);
      toast.success(result.isNew ? 'Atendimento iniciado!' : 'Atendimento em aberto encontrado.');
      const newConv = { ...(result.conversation as Conversation), id: result.attendanceId };
      if (result.isNew) pendingChamarConversationRef.current = newConv;
      handleSupervisorTabChange('chat');
      setSelectedAttendanceFilter('abertos');
      setSelectedConversation(result.attendanceId);
      setSelectedConversationData(result.conversation as Conversation);
      setSidebarDetailsReady(true);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Erro ao iniciar conversa');
    }
  };

  const otherSubjectAttendances = useMemo(() => {
    const fromIntervention = (supervisorStats.byIntervention?.['outros-assuntos'] ?? 0)
      + (supervisorStats.byIntervention?.['demanda-telefone-fixo'] ?? 0)
      + (supervisorStats.byIntervention?.['protese-capilar'] ?? 0);
    if (fromIntervention > 0) return fromIntervention;
    const brands = CATEGORY_TO_BRANDS.OUTROS_ASSUNTOS;
    return brands.reduce((sum, b) => sum + (supervisorStats.byBrand?.[b] ?? 0), 0);
  }, [supervisorStats.byIntervention, supervisorStats.byBrand]);

  const percentageByAttendances = useCallback((value: number, total: number) => {
    if (!total) return '0.0%';
    return `${((value / total) * 100).toFixed(1)}%`;
  }, []);

  const aiFlashDayCount = supervisorStats.byAiSubdivision?.['flash-day'] ?? 0;
  const aiLocacaoEstudioCount = supervisorStats.byAiSubdivision?.['locacao-estudio'] ?? 0;
  const aiCaptacaoVideosCount = supervisorStats.byAiSubdivision?.['captacao-videos'] ?? 0;

  /**
   * Partição exclusiva do total filtrado: Flash + Locação + Captação + Intervenção + Não classificados (resto).
   * Evita somar >100% (ex.: "não classificados" da API incluía quem já tinha subdivisão AI).
   */
  const pieClassificationPercents = useMemo(() => {
    const T = supervisorStats.filteredAttendances ?? 0;
    const F = aiFlashDayCount;
    const L = aiLocacaoEstudioCount;
    const C = aiCaptacaoVideosCount;
    const I = otherSubjectAttendances;
    if (!T) {
      return { flash: 0, loc: 0, cap: 0, interv: 0, uncl: 0 };
    }
    const R = T - F - L - C - I;
    if (R >= 0) {
      const r = R;
      return {
        flash: (F / T) * 100,
        loc: (L / T) * 100,
        cap: (C / T) * 100,
        interv: (I / T) * 100,
        uncl: (r / T) * 100,
      };
    }
    const sum = F + L + C + I;
    if (sum <= 0) return { flash: 0, loc: 0, cap: 0, interv: 0, uncl: 0 };
    return {
      flash: (F / sum) * 100,
      loc: (L / sum) * 100,
      cap: (C / sum) * 100,
      interv: (I / sum) * 100,
      uncl: 0,
    };
  }, [
    supervisorStats.filteredAttendances,
    aiFlashDayCount,
    aiLocacaoEstudioCount,
    aiCaptacaoVideosCount,
    otherSubjectAttendances,
  ]);

  /** Quantidade exclusiva "não classificados" = total − (AI + intervenção), alinhada ao gráfico. */
  const remainderUnclassifiedCount = useMemo(() => {
    const T = supervisorStats.filteredAttendances ?? 0;
    if (!T) return 0;
    const R = T - aiFlashDayCount - aiLocacaoEstudioCount - aiCaptacaoVideosCount - otherSubjectAttendances;
    return Math.max(0, R);
  }, [
    supervisorStats.filteredAttendances,
    aiFlashDayCount,
    aiLocacaoEstudioCount,
    aiCaptacaoVideosCount,
    otherSubjectAttendances,
  ]);

  /**
   * Percentual de agendamentos (cards): atendimentos com interesse (FC interesse) no período
   * dividido pelas chamadas da FC agendamento_* no mesmo período.
   */
  const aiFlashDaySchedulingPercent = useMemo(() => {
    const ag = supervisorStats.byAgendamentoCalls?.['flash-day'] ?? 0;
    if (!ag) return 0;
    return (aiFlashDayCount / ag) * 100;
  }, [aiFlashDayCount, supervisorStats.byAgendamentoCalls]);
  const aiLocacaoEstudioSchedulingPercent = useMemo(() => {
    const ag = supervisorStats.byAgendamentoCalls?.['locacao-estudio'] ?? 0;
    if (!ag) return 0;
    return (aiLocacaoEstudioCount / ag) * 100;
  }, [aiLocacaoEstudioCount, supervisorStats.byAgendamentoCalls]);
  const aiCaptacaoVideosSchedulingPercent = useMemo(() => {
    const ag = supervisorStats.byAgendamentoCalls?.['captacao-videos'] ?? 0;
    if (!ag) return 0;
    return (aiCaptacaoVideosCount / ag) * 100;
  }, [aiCaptacaoVideosCount, supervisorStats.byAgendamentoCalls]);

  const classificationChartBackground = useMemo(() => {
    const p = pieClassificationPercents;
    const slices = [
      { color: '#0ea5e9', value: Math.max(0, p.flash) },
      { color: '#f59e0b', value: Math.max(0, p.loc) },
      { color: '#10b981', value: Math.max(0, p.cap) },
      { color: '#d946ef', value: Math.max(0, p.interv) },
      { color: '#94a3b8', value: Math.max(0, p.uncl) },
    ];
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    if (total <= 0) {
      return 'conic-gradient(#e2e8f0 0% 100%)';
    }

    const parts: string[] = [];
    let pos = 0;
    for (const slice of slices) {
      if (slice.value <= 0) continue;
      const start = pos;
      const share = (slice.value / total) * 100;
      pos = Math.min(100, pos + share);
      const end = pos;
      parts.push(`${slice.color} ${start.toFixed(4)}% ${end.toFixed(4)}%`);
    }
    if (pos < 100) {
      parts.push(`#e2e8f0 ${pos.toFixed(4)}% 100%`);
    }

    return `conic-gradient(from 0deg, ${parts.join(', ')})`;
  }, [pieClassificationPercents]);

  const isSellerCurrentlyUnavailable = useCallback((seller: Seller) => {
    if (seller.isUnavailable === false) return false;
    if (!seller.unavailableUntil) return !!seller.isUnavailable;
    const until = new Date(seller.unavailableUntil).getTime();
    return Number.isFinite(until) && until > availabilityNow;
  }, [availabilityNow]);

  // Auto-resize textarea conforme o texto (altura máxima 200px)
  useEffect(() => {
    const el = chatMessageTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [messageInput]);

  // Função para obter vendedores de uma marca específica
  const getSellersByServiceCategory = (category: ServiceCategory): Seller[] => {
    const brands = CATEGORY_TO_BRANDS[category];
    return supervisorSellers.filter(seller => {
      if (!seller.brands || !Array.isArray(seller.brands)) return false;
      return seller.brands.some((b: string) => brands.includes(String(b).toUpperCase() as VehicleBrand));
    });
  };

  const pendingBySubdivisionAndAttendanceRef = useRef<Record<string, Record<string, number>>>({});
  /** Por attendanceId: lista de { divisionKey, subdivisionKey } para decrementar ao abrir */
  const redPendingByAttendanceRef = useRef<Record<string, { divisionKey: string; subdivisionKey: string }[]>>({});
  const entryNavRef = useRef<HTMLElement | null>(null);
  const entryNavInnerRef = useRef<HTMLDivElement | null>(null);
  const [slidingIndicatorRect, setSlidingIndicatorRect] = useState<{ top: number; height: number; left: number; width: number } | null>(null);
  const [entryPanelHasScroll, setEntryPanelHasScroll] = useState(false);
  const sidebarNavRef = useRef<HTMLElement | null>(null);
  const [sidebarTabIndicatorRect, setSidebarTabIndicatorRect] = useState<{ top: number; height: number; left: number; width: number } | null>(null);

  const incrementSubdivision = (key: string, delta = 1, attendanceId?: string) => {
    if (attendanceId) {
      const ref = pendingBySubdivisionAndAttendanceRef.current;
      if (!ref[key]) ref[key] = {};
      ref[key][attendanceId] = (ref[key][attendanceId] ?? 0) + delta;
    }
    setUnreadBySubdivision((prev) => {
      const next = { ...prev };
      next[key] = (next[key] ?? 0) + delta;
      return next;
    });
  };

  const decrementSubdivisionForConversation = (key: string, attendanceId: string) => {
    const ref = pendingBySubdivisionAndAttendanceRef.current;
    const sub = ref[key];
    const count = sub?.[attendanceId] ?? 0;
    if (count <= 0) return;
    delete sub[attendanceId];
    if (Object.keys(sub).length === 0) delete ref[key];
    setUnreadBySubdivision((prev) => {
      const next = { ...prev };
      next[key] = Math.max(0, (next[key] ?? 0) - count);
      return next;
    });
  };

  const getSubdivisionBadge = (key: string) => {
    const n = unreadBySubdivision[key] ?? 0;
    return n > 0 ? (n > 99 ? '99+' : n) : 0;
  };

  const incrementRed = (divisionKey: string, subdivisionKey: string, attendanceId: string) => {
    const ref = redPendingByAttendanceRef.current;
    if (!ref[attendanceId]) ref[attendanceId] = [];
    ref[attendanceId].push({ divisionKey, subdivisionKey });
    setRedByDivision((prev) => {
      const next = { ...prev };
      next[divisionKey] = (next[divisionKey] ?? 0) + 1;
      return next;
    });
    setRedBySubdivision((prev) => {
      const next = { ...prev };
      next[subdivisionKey] = (next[subdivisionKey] ?? 0) + 1;
      return next;
    });
    setRedConversationIds((prev) => ({ ...prev, [attendanceId]: true }));

    // Auto-dismiss após 3 segundos
    setTimeout(() => {
      setRedByDivision((prev) => {
        const next = { ...prev };
        next[divisionKey] = Math.max(0, (next[divisionKey] ?? 0) - 1);
        return next;
      });
      if (subdivisionKey) {
        setRedBySubdivision((prev) => {
          const next = { ...prev };
          next[subdivisionKey] = Math.max(0, (next[subdivisionKey] ?? 0) - 1);
          return next;
        });
      }
      const entries = redPendingByAttendanceRef.current[attendanceId];
      if (entries) {
        const idx = entries.findIndex((e) => e.divisionKey === divisionKey && e.subdivisionKey === subdivisionKey);
        if (idx >= 0) entries.splice(idx, 1);
        if (entries.length === 0) {
          delete redPendingByAttendanceRef.current[attendanceId];
          setRedConversationIds((prev) => {
            const next = { ...prev };
            delete next[attendanceId];
            return next;
          });
        }
      }
    }, 3000);
  };

  const decrementRedForConversation = (attendanceId: string) => {
    const ref = redPendingByAttendanceRef.current;
    const entries = ref[attendanceId];
    if (!entries?.length) return;
    setRedByDivision((prev) => {
      const next = { ...prev };
      for (const { divisionKey } of entries) {
        next[divisionKey] = Math.max(0, (next[divisionKey] ?? 0) - 1);
      }
      return next;
    });
    setRedBySubdivision((prev) => {
      const next = { ...prev };
      for (const { subdivisionKey } of entries) {
        // Só decrementa se subdivisionKey não estiver vazia (casos de identificamarca usam '')
        if (subdivisionKey) {
          next[subdivisionKey] = Math.max(0, (next[subdivisionKey] ?? 0) - 1);
        }
      }
      return next;
    });
    delete ref[attendanceId];
    setRedConversationIds((prev) => {
      const next = { ...prev };
      delete next[attendanceId];
      return next;
    });
  };

  const getRedBadgeDivision = (key: string) => (redByDivision[key] ?? 0) > 0 ? Math.min(99, redByDivision[key] ?? 0) : 0;
  const getRedBadgeSubdivision = (key: string) => (redBySubdivision[key] ?? 0) > 0 ? Math.min(99, redBySubdivision[key] ?? 0) : 0;
  const hasRedOnConversation = (attendanceId: string) => !!redConversationIds[attendanceId];

  const markBlueAsReadForConversation = (attendanceId: string) => {
    const ref = pendingBySubdivisionAndAttendanceRef.current;
    const keysToDecrement: string[] = [];
    for (const [subKey, byAtt] of Object.entries(ref)) {
      if (attendanceId in (byAtt || {})) keysToDecrement.push(subKey);
    }
    if (keysToDecrement.length === 0) return;
    for (const subKey of keysToDecrement) {
      const sub = ref[subKey];
      const count = sub?.[attendanceId] ?? 0;
      if (count <= 0) continue;
      delete sub![attendanceId];
      if (Object.keys(sub!).length === 0) delete ref[subKey];
      setUnreadBySubdivision((prev) => {
        const next = { ...prev };
        next[subKey] = Math.max(0, (next[subKey] ?? 0) - count);
        return next;
      });
    }
  };

  // Carregar dados do supervisor ao montar o componente
  useEffect(() => {
    const loadSupervisorData = async () => {
      // Verificar se o usuário está autenticado antes de fazer a requisição
      if (!user?.id) {
        console.warn('User not authenticated, skipping supervisor data load');
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        console.log('Loading supervisor data for user:', user.id);
        const data = await userService.getSupervisorSellers();
        
        // Definir marcas do supervisor (todas as marcas possíveis se o supervisor não tiver marcas definidas)
        const allBrands: VehicleBrand[] = ['FORD', 'GM', 'VW', 'FIAT', 'IMPORTADOS'];
        setSupervisorBrands(data.supervisor.brands.length > 0 ? (data.supervisor.brands as VehicleBrand[]) : allBrands);
        
        // Definir vendedores atribuídos ao supervisor
        const sellers = (data.sellers || []).map((seller: any) => ({
          ...seller,
          brands: Array.isArray(seller.brands) ? seller.brands : [],
          isUnavailable: !!seller.isUnavailable,
          unavailableUntil: seller.unavailableUntil ?? null,
        })) as Seller[];
        
        console.log('Loaded supervisor sellers:', {
          count: sellers.length,
          sellers: sellers.map(s => ({ id: s.id, name: s.name, brands: s.brands }))
        });
        
        setSupervisorSellers(sellers);
      } catch (error: any) {
        console.error('Error loading supervisor data:', error);
        const msg = error?.response?.data?.error || error?.message || 'Sem conexão com o servidor';
        toast.error(`Erro ao carregar dados do supervisor: ${typeof msg === 'string' ? msg : 'Tente novamente'}`);
        // Fallback para marcas padrão se houver erro
        setSupervisorBrands(['FORD', 'GM', 'VW', 'FIAT', 'IMPORTADOS']);
        setSupervisorSellers([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadSupervisorData();
  }, [user?.id]);

  // Get dynamic header title based on current selection
  const getConversationsHeaderTitle = (): string => {
    if (selectedTodasDemandasSubdivision === '__all__') return 'Todas as Demandas';
    if (selectedTodasDemandasSubdivision) {
      const subdivLabels: Record<string, string> = {
        'pedidos-orcamentos': 'Pedidos de Orçamentos',
        'perguntas-pos-orcamento': 'Perguntas Pós Orçamento',
        'confirmacao-pix': 'Confirmação Pix',
        'tirar-pedido': 'Tirar Pedido',
        'informacoes-entrega': 'Informações sobre Entrega',
        'encomendas': 'Encomendas',
        'cliente-pediu-humano': 'Cliente pediu Humano',
      };
      return subdivLabels[selectedTodasDemandasSubdivision] || selectedTodasDemandasSubdivision;
    }

    // Intervenção humana ativa sem serviço específico (todas as intervenções)
    if (viewingIntervencaoHumana && !selectedServiceCategory) {
      return 'Intervenção humana';
    }

    // Se categoria de serviço selecionada (inclui intervenção quando filtro ativo)
    if (selectedServiceCategory) {
      const cat = SERVICE_CATEGORIES.find(c => c.key === selectedServiceCategory);
      return cat?.label ?? 'Atribuídos';
    }

    // Se vendedor selecionado (ex.: ao clicar "Ir para conversa" em orçamento)
    if (selectedSeller) {
      const seller = supervisorSellers.find(s => s.id === selectedSeller);
      if (seller) {
        const cat = SERVICE_CATEGORIES.find(c => getSellersByServiceCategory(c.key).some(s => s.id === seller.id));
        if (cat) return `${cat.label} → ${seller.name}`;
        return seller.name;
      }
    }

    if (selectedAttendanceFilter === 'abertos') return 'Abertos';
    if (selectedAttendanceFilter === 'nao-atribuidos') return 'AI';
    if (selectedFollowUpNode) return FOLLOW_UP_LABELS[selectedFollowUpNode] ?? 'Follow UP';

    if (selectedFechadosFilter) {
      return 'Fechados';
    }

    // If "Atribuídos" is selected but no seller or category
    if (selectedAttendanceFilter === 'tudo') {
      return 'Atribuídos';
    }

    // Default fallback
    return 'Atribuídos';
  };

  const handleToggleSellerAvailability = async (seller: Seller) => {
    const isUnavailable = isSellerCurrentlyUnavailable(seller);
    setUpdatingSellerAvailabilityIds((prev) => ({ ...prev, [seller.id]: true }));
    try {
      const data = await userService.setSellerAvailability(seller.id, !isUnavailable);
      setSupervisorSellers((prev) =>
        prev.map((s) =>
          s.id === seller.id
            ? { ...s, isUnavailable: data.isUnavailable, unavailableUntil: data.unavailableUntil }
            : s
        )
      );
      if (data.isUnavailable) {
        toast.success(`${seller.name} marcado como ausente por ate 2 horas.`);
      } else {
        toast.success(`${seller.name} marcado como presente.`);
      }
    } catch (error) {
      console.error('Erro ao atualizar disponibilidade do vendedor:', error);
      toast.error('Nao foi possivel atualizar o status do vendedor.');
    } finally {
      setUpdatingSellerAvailabilityIds((prev) => ({ ...prev, [seller.id]: false }));
    }
  };

  const handleSelectNaoAtribuidos = (filter: typeof selectedNaoAtribuidosFilter = 'todos') => {
    setSelectedConversation(null);
    setSelectedSeller(null);
    setSelectedSellerBrand(null);
    setSelectedServiceCategory(null);
    setViewingIntervencaoHumana(false);
    setSelectedTodasDemandasSubdivision(null);
    setSelectedDemandaKey(null);
    setSelectedFechadosFilter(false);
    setSelectedFollowUpNode(null);
    setSelectedAttendanceFilter('nao-atribuidos');
    setSelectedNaoAtribuidosFilter(filter);
    setMobileChatLayer('conversations');
  };

  /** Busca conversas de um serviço: vendedores + intervenções (visualização única, sem filtro on/off) */
  const fetchServiceConversations = async (category: ServiceCategory) => {
    setIsLoadingConversations(true);
    try {
      const sellersInCategory = getSellersByServiceCategory(category);
      const sellerIds = new Set(sellersInCategory.map((s) => s.id));
      const types = SERVICE_TO_INTERVENTION[category];
      const interventionTypes = Array.isArray(types) ? types : [types];

      const [attributedList, ...interventionLists] = await Promise.all([
        attendanceService.getAttributedAttendances(),
        ...interventionTypes.map((t) => attendanceService.getInterventionByType(t)),
      ]);

      const vendedorList =
        sellerIds.size > 0
          ? attributedList.filter((c) => {
              const sid = (c as any).sellerId ?? (c as any).attributionSource?.sellerId;
              return sid && sellerIds.has(sid);
            })
          : [];

      const interventionMerged = interventionLists.flatMap((list, i) =>
        list.map((c) => ({ ...c, interventionType: (c as any).interventionType ?? interventionTypes[i] }))
      );

      const seen = new Set<string>();
      const merged = [...vendedorList, ...interventionMerged].filter((c) =>
        seen.has(c.id) ? false : (seen.add(c.id), true)
      );
      setConversations(merged);
    } catch (e) {
      console.error('Error fetching service conversations', e);
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  /** Busca todas as conversas de intervenção (view Intervenção humana) */
  const fetchAllInterventionConversations = async () => {
    setIsLoadingConversations(true);
    try {
      const types = ['demanda-telefone-fixo', 'protese-capilar', 'outros-assuntos'];
      const lists = await Promise.all(types.map((t) => attendanceService.getInterventionByType(t)));
      const merged = lists.flatMap((list, i) =>
        list.map((c) => ({ ...c, interventionType: (c as any).interventionType ?? types[i] }))
      );
      const seen = new Set<string>();
      setConversations(merged.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))));
    } catch (e) {
      console.error('Error fetching all intervention conversations', e);
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const handleSelectServiceCategory = (category: ServiceCategory) => {
    if (selectedServiceCategory === category) return;
    setViewingIntervencaoHumana(false);
    setSelectedFollowUpNode(null);
    setSelectedFechadosFilter(false);
    setSelectedServiceCategory(category);
    setSelectedSeller(null);
    setSelectedSellerSubdivision(null);
    setSelectedSellerBrand(null);
    setSelectedAttendanceFilter('tudo');
    setSelectedConversation(null);
    setConversations([]);
    setMobileChatLayer('conversations');
    fetchServiceConversations(category);
  };

  const handleSelectFollowUpNode = (node: FollowUpNode) => {
    setSelectedFollowUpNode(node);
    setSelectedConversation(null);
    setSelectedSeller(null);
    setSelectedSellerBrand(null);
    setSelectedServiceCategory(null);
    setViewingIntervencaoHumana(false);
    setSelectedNaoAtribuidosFilter('todos');
    setSelectedAttendanceFilter('tudo');
    setSelectedFechadosFilter(false);
    setSelectedTodasDemandasSubdivision(null);
    setSelectedDemandaKey(null);
    setConversations([]);
    setSearchTerm('');
    setMobileChatLayer('conversations');
  };

  const toggleTodasDemandas = () => {
    setExpandedTodasDemandas((prev) => !prev);
    setSelectedFechadosFilter(false);
  };

  /** Clique no card principal: exibir TODAS as demandas (todas as subdivisões) em uma única lista. */
  const handleSelectTodasDemandasMain = async () => {
    setSelectedTodasDemandasSubdivision('__all__');
    setSelectedSeller(null);
    setSelectedSellerSubdivision(null);
    setSelectedSellerBrand(null);
    setSelectedServiceCategory(null);
    setViewingIntervencaoHumana(false);
    setSelectedAttendanceFilter('tudo');
    setSelectedConversation(null);
    setConversations([]); // Clear conversations

    try {
      setIsLoadingPendingQuotes(true);
      // Buscar APENAS pendências (quote_requests) de todas as subdivisões
      const allSubdivisions = ['pedidos-orcamentos', 'perguntas-pos-orcamento', 'confirmacao-pix', 'tirar-pedido', 'informacoes-entrega', 'encomendas', 'cliente-pediu-humano'];
      const allQuotes: Array<QuoteRequest & { sellerSubdivision?: string }> = [];
      
      for (const subdivision of allSubdivisions) {
        try {
          const quotes = await quoteService.list(subdivision);
          const quotesWithSubdivision = quotes.map(q => ({ ...q, sellerSubdivision: subdivision }));
          allQuotes.push(...quotesWithSubdivision);
        } catch (e) {
          console.warn(`Erro ao carregar pendências da subdivisão ${subdivision}:`, e);
        }
      }
      
      // Ordenar por data de criação (mais recentes primeiro)
      allQuotes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setPendingQuotes(allQuotes);
    } catch (error: any) {
      console.error('Error loading todas demandas:', error);
      toast.error('Erro ao carregar pendências');
      setPendingQuotes([]);
    } finally {
      setIsLoadingPendingQuotes(false);
    }
  };

  const handleSelectTodasDemandasSubdivision = async (subdivision: string, fromDemandas?: boolean) => {
    if (fromDemandas) setSelectedDemandaKey(subdivision);
    else setSelectedDemandaKey(null);
    setSelectedTodasDemandasSubdivision(subdivision);
    setSelectedSeller(null);
    setSelectedSellerSubdivision(null);
    setSelectedSellerBrand(null);
    setSelectedServiceCategory(null);
    setViewingIntervencaoHumana(false);
    setSelectedAttendanceFilter('tudo');
    setSelectedConversation(null);
    setConversations([]);
    setSelectedQuote(null);

    if (subdivision === 'pedidos-orcamentos') {
      setPendingQuotes([]);
      return;
    }

    try {
      setIsLoadingPendingQuotes(true);
      const quotes = await quoteService.list(subdivision);
      const quotesWithSubdivision = quotes.map(q => ({ ...q, sellerSubdivision: subdivision }));
      quotesWithSubdivision.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setPendingQuotes(quotesWithSubdivision);
    } catch (error: any) {
      console.error('Error loading todas demandas:', error);
      toast.error('Erro ao carregar pendências');
      setPendingQuotes([]);
    } finally {
      setIsLoadingPendingQuotes(false);
    }
  };

  const isPedidosOrcamentosView =
    selectedTodasDemandasSubdivision === 'pedidos-orcamentos' ||
    (!!selectedSeller && selectedSellerSubdivision === 'pedidos-orcamentos');

  // VERDE: Construir set de IDs visualizados pelo vendedor a partir de sellerViewedAt
  useEffect(() => {
    const viewed = new Set<string>();
    for (const q of quoteCards) {
      if (q.sellerViewedAt) viewed.add(q.id);
    }
    setViewedQuoteIds(viewed);
  }, [quoteCards]);

  const unviewedQuoteCountTotal = quoteCards.filter((q) => !q.sellerViewedAt).length;
  const getUnviewedQuoteCountForSeller = useCallback((sellerId: string) => {
    return quoteCards.filter((q) => q.sellerId === sellerId && !q.sellerViewedAt).length;
  }, [quoteCards]);

  // Carregar listas de orçamentos para o badge (sempre) e para a lista (quando na view)
  useEffect(() => {
    if (!user?.id || user?.role !== 'SUPERVISOR') return;
    let cancelled = false;
    const load = async () => {
      if (isPedidosOrcamentosView) setIsLoadingQuotes(true);
      try {
        const [pendentes, enviados] = await Promise.all([
          quoteService.list('pedidos-orcamentos'),
          quoteService.list('pedidos-orcamentos-enviados'),
        ]);
        if (!cancelled) {
          setQuoteCards(pendentes);
          setSentQuoteCards(enviados);
        }
      } catch (e) {
        if (!cancelled) {
          console.error('Error loading quote cards (supervisor)', e);
          if (isPedidosOrcamentosView) toast.error('Erro ao carregar pedidos de orçamento.');
          setQuoteCards([]);
          setSentQuoteCards([]);
        }
      } finally {
        if (!cancelled && isPedidosOrcamentosView) setIsLoadingQuotes(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user?.id, user?.role, isPedidosOrcamentosView]);

  const handleSelectSeller = async (sellerId: string, subdivision?: string, brand?: VehicleBrand, fromDemandasCard?: boolean) => {
    setViewingFromDemandasCard(fromDemandasCard ?? false);
    setSelectedFechadosFilter(false);
    setSelectedSeller(sellerId);
    setSelectedSellerSubdivision(subdivision || null);
    setSelectedSellerBrand(brand ?? null);
    setSelectedConversation(null);
    setSelectedServiceCategory(null);
    setViewingIntervencaoHumana(false);
    setSelectedTodasDemandasSubdivision(null);
    setSelectedDemandaKey(null);
    setPendingQuotes([]);
    setSelectedQuote(null);

    if (subdivision === 'pedidos-orcamentos') {
      try {
        setIsLoadingQuotes(true);
        const [pendentes, enviados] = await Promise.all([
          quoteService.list('pedidos-orcamentos'),
          quoteService.list('pedidos-orcamentos-enviados'),
        ]);
        setQuoteCards(pendentes);
        setSentQuoteCards(enviados);
      } catch (e) {
        console.error('Error loading quote cards', e);
        setQuoteCards([]);
        setSentQuoteCards([]);
      } finally {
        setIsLoadingQuotes(false);
      }
      setConversations([]);
      return;
    }

    try {
      setIsLoadingConversations(true);
      const sellerConversations = await attendanceService.getConversationsBySeller(sellerId);
      const readIds = markedAsReadIdsRef.current;
      const mapped = sellerConversations.map((c) => (readIds.has(String(c.id)) ? { ...c, unread: 0 } : c));
      const toSet = [...mapped].sort((a, b) => getConversationSortTimestamp(b) - getConversationSortTimestamp(a));
      setConversations(toSet);
      // Popular unreadBySubdivision a partir do backend (MessageRead persistido) para que reload mostre correto
      const sellerSubs = ['pedidos-orcamentos', 'perguntas-pos-orcamento', 'confirmacao-pix', 'tirar-pedido', 'informacoes-entrega', 'encomendas', 'cliente-pediu-humano'];
      const ref = pendingBySubdivisionAndAttendanceRef.current;
      sellerSubs.forEach((sub) => delete ref[`seller-${sellerId}-${sub}`]);
      setUnreadBySubdivision((prev) => {
        const next = { ...prev };
        sellerSubs.forEach((sub) => { next[`seller-${sellerId}-${sub}`] = 0; });
        return next;
      });
      for (const c of toSet) {
        const n = (c as { unread?: number }).unread ?? 0;
        if (n <= 0) continue;
        const subKey = `seller-${sellerId}-${(c as any).sellerSubdivision ?? 'pedidos-orcamentos'}`;
        incrementSubdivision(subKey, n, String(c.id));
      }
    } catch (error: any) {
      console.error('Error loading seller conversations:', error);
      toast.error('Erro ao carregar conversas do vendedor');
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const fetchAbertosConversations = async (conversationToPrepend?: { id: string } & Record<string, unknown>) => {
    const toPrepend = conversationToPrepend ?? pendingChamarConversationRef.current;
    if (toPrepend) pendingChamarConversationRef.current = null;
    setIsLoadingConversations(true);
    try {
      const interventionTypes = ['outros-assuntos', 'protese-capilar', 'demanda-telefone-fixo'] as const;
      const [unassigned, attributed, ...interventionLists] = await Promise.all([
        attendanceService.getUnassignedAttendances('todos'),
        attendanceService.getAttributedAttendances(),
        attendanceService.getInterventionByType('outros-assuntos'),
        attendanceService.getInterventionByType('protese-capilar'),
        attendanceService.getInterventionByType('demanda-telefone-fixo'),
      ]);
      const interventionMerged = interventionLists.flatMap((list, i) =>
        list.map((c) => ({
          ...c,
          interventionType: (c as any).interventionType ?? interventionTypes[i],
          attributionSource: { type: 'intervention' as const, label: 'Outros assuntos', interventionType: 'outros-assuntos' as const },
        }))
      );
      const seen = new Set<string>();
      let merged = [...unassigned, ...attributed, ...interventionMerged].filter((c) =>
        seen.has(String(c.id)) ? false : (seen.add(String(c.id)), true)
      );
      if (toPrepend && !seen.has(String(toPrepend.id))) {
        merged = [toPrepend as Conversation, ...merged];
      }
      const readIds = markedAsReadIdsRef.current;
      const toSet = merged
        .map((c) => (readIds.has(String(c.id)) ? { ...c, unread: 0 } : c))
        .sort((a, b) => getConversationSortTimestamp(b) - getConversationSortTimestamp(a));
      setConversations(toSet);
      const totalUnread = toSet.reduce((sum, c) => sum + ((c as { unread?: number }).unread ?? 0), 0);
      setTotalUnreadAbertos(totalUnread);
    } catch (e: any) {
      console.error('Error fetching abertos conversations', e);
      const msg = e?.response?.data?.error || e?.message || 'Sem conexão com o servidor';
      toast.error(`Erro ao carregar atendimentos abertos: ${typeof msg === 'string' ? msg : 'Tente novamente'}`);
      setConversations([]);
      setTotalUnreadAbertos(0);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const fetchUnassignedConversations = async (
    filter:
      | 'todos'
      | 'triagem'
      | 'encaminhados-ecommerce'
      | 'encaminhados-balcao'
      | 'ai-nao-classificados'
      | 'ai-flash-day'
      | 'ai-locacao-estudio'
      | 'ai-captacao-videos' = 'todos'
  ) => {
    setIsLoadingConversations(true);
    try {
      const fetchedConversations = await attendanceService.getUnassignedAttendances(filter);
      const routedIds = routedAttendanceIdsRef.current;
      const readIds = markedAsReadIdsRef.current;
      const toSet = (routedIds.size > 0
        ? fetchedConversations.filter((c) => !routedIds.has(String(c.id)))
        : fetchedConversations
      ).map((c) => readIds.has(String(c.id)) ? { ...c, unread: 0 } : c);
      setConversations(toSet);

      const NAO_ATRIB_KEYS = [
        'triagem',
        'ai-nao-classificados',
        'encaminhados-ecommerce',
        'encaminhados-balcao',
        'ai-flash-day',
        'ai-locacao-estudio',
        'ai-captacao-videos',
      ] as const;
      const ref = pendingBySubdivisionAndAttendanceRef.current;
      for (const k of NAO_ATRIB_KEYS) delete ref[k];
      setUnreadBySubdivision((prev) => {
        const next = { ...prev };
        for (const k of NAO_ATRIB_KEYS) next[k] = 0;
        return next;
      });
      for (const c of toSet) {
        const n = (c as { unread?: number }).unread ?? 0;
        if (n <= 0) continue;
        const subKey =
          (c as { unassignedSource?: string }).unassignedSource ??
          (filter === 'todos' ? 'ai-nao-classificados' : filter);
        incrementSubdivision(subKey, n, String(c.id));
      }

      if (filter === 'triagem' || filter === 'ai-nao-classificados') {
        setUnassignedConversationsCache((prevCache) => {
          const updatedCache = toSet.map((backendConv) => {
            const cached = prevCache.find((c) => c.id === backendConv.id);
            if (cached && cached.unread >= (backendConv as any).unread) return cached;
            return backendConv;
          });
          return updatedCache;
        });
      }
    } catch (error) {
      console.error('Error fetching unassigned conversations:', error);
      toast.error('Erro ao carregar conversas não atribuídas.');
      setConversations([]);
      if (filter === 'triagem' || filter === 'ai-nao-classificados') {
        setUnassignedConversationsCache([]);
      }
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const fetchFollowUpConversations = async (node: FollowUpNode) => {
    setIsLoadingConversations(true);
    try {
      const list = await attendanceService.getFollowUpAttendances(node);
      const readIds = markedAsReadIdsRef.current;
      const toSet = list
        .map((c) => (readIds.has(String(c.id)) ? { ...c, unread: 0 } : c))
        .sort((a, b) => getConversationSortTimestamp(b) - getConversationSortTimestamp(a));
      setConversations(toSet);
    } catch (error) {
      console.error('Error fetching follow-up conversations:', error);
      toast.error('Erro ao carregar conversas de follow-up.');
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const fetchInterventionDemandaTelefoneFixo = async () => {
    setIsLoadingConversations(true);
    try {
      const list = await attendanceService.getInterventionDemandaTelefoneFixo();
      setConversations(list);
    } catch (e) {
      console.error('Error fetching demanda telefone fixo', e);
      toast.error('Erro ao carregar Demanda telefone fixo.');
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const fetchInterventionByType = async (interventionType: string, label: string) => {
    setIsLoadingConversations(true);
    try {
      const list = await attendanceService.getInterventionByType(interventionType);
      setConversations(list);
    } catch (e) {
      console.error(`Error fetching ${interventionType}`, e);
      toast.error(`Erro ao carregar ${label}.`);
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const fetchAttributedConversations = async (filterSellerIds?: Set<string>, includeInterventionType?: string) => {
    setIsLoadingConversations(true);
    try {
      let list = await attendanceService.getAttributedAttendances();
      if (filterSellerIds && filterSellerIds.size > 0) {
        list = list.filter((c) => {
          const att = (c as any).attributionSource;
          const sid = (c as any).sellerId ?? att?.sellerId;
          const isIntervention = att?.type === 'intervention' && att?.interventionType;
          if (includeInterventionType && isIntervention && att.interventionType === includeInterventionType) {
            return true;
          }
          return sid && filterSellerIds.has(sid);
        });
      } else if (includeInterventionType) {
        list = list.filter((c) => {
          const att = (c as any).attributionSource;
          return att?.type === 'intervention' && att?.interventionType === includeInterventionType;
        });
      }
      setConversations(list);
      // Popular unreadBySubdivision a partir do backend (MessageRead persistido) para que reload mostre correto
      const ATRIB_KEYS = ['outros-assuntos'] as const;
      const sellerSubs = ['pedidos-orcamentos', 'perguntas-pos-orcamento', 'confirmacao-pix', 'tirar-pedido', 'informacoes-entrega', 'encomendas', 'cliente-pediu-humano'];
      const ref = pendingBySubdivisionAndAttendanceRef.current;
      for (const k of ATRIB_KEYS) delete ref[k];
      supervisorSellers.forEach((s) => { sellerSubs.forEach((sub) => delete ref[`seller-${s.id}-${sub}`]); });
      setUnreadBySubdivision((prev) => {
        const next = { ...prev };
        for (const k of ATRIB_KEYS) next[k] = 0;
        supervisorSellers.forEach((s) => { sellerSubs.forEach((sub) => { next[`seller-${s.id}-${sub}`] = 0; }); });
        return next;
      });
      for (const c of list) {
        const n = (c as { unread?: number }).unread ?? 0;
        if (n <= 0) continue;
        const att = (c as any).attributionSource;
        const subKey = att?.interventionType
          ? (att.interventionType === 'demanda-telefone-fixo' ? 'demanda-telefone-fixo' : att.interventionType)
          : `seller-${att?.sellerId ?? '?'}-${(c as any).sellerSubdivision ?? 'pedidos-orcamentos'}`;
        incrementSubdivision(subKey, n, String(c.id));
      }
    } catch (e) {
      console.error('Error fetching attributed', e);
      toast.error('Erro ao carregar atribuídos.');
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const fetchFechadosConversations = async () => {
    setIsLoadingFechados(true);
    setIsLoadingConversations(true);
    try {
      const list = await attendanceService.getFechadosAttendances();
      setFechadosConversations(list);
      setConversations(list);
    } catch (e) {
      console.error('Error fetching fechados', e);
      toast.error('Erro ao carregar atendimentos fechados.');
      setFechadosConversations([]);
      setConversations([]);
    } finally {
      setIsLoadingFechados(false);
      setIsLoadingConversations(false);
    }
  };

  // Efeito para carregar conversas não atribuídas ou atribuídas quando o filtro é selecionado
  useEffect(() => {
    if (selectedAttendanceFilter === 'abertos') {
      setSelectedSeller(null);
      setSelectedSellerBrand(null);
      setSelectedTodasDemandasSubdivision(null);
      setSelectedFechadosFilter(false);
      setViewingIntervencaoHumana(false);
      setSelectedServiceCategory(null);
      setSearchTerm('');
      setConversations([]);
      fetchAbertosConversations();
    } else if (selectedAttendanceFilter === 'nao-atribuidos') {
      setSelectedSeller(null);
      setSelectedSellerBrand(null);
      setSelectedTodasDemandasSubdivision(null);
      setSelectedFechadosFilter(false);
      setSearchTerm('');
      setConversations([]);
      fetchUnassignedConversations(selectedNaoAtribuidosFilter);
    } else if (selectedFollowUpNode) {
      setSelectedSeller(null);
      setSelectedSellerBrand(null);
      setSelectedServiceCategory(null);
      setViewingIntervencaoHumana(false);
      setSelectedTodasDemandasSubdivision(null);
      setSearchTerm('');
      setConversations([]);
      fetchFollowUpConversations(selectedFollowUpNode);
    } else if (!selectedSeller && selectedAttendanceFilter === 'tudo' && !selectedTodasDemandasSubdivision && selectedServiceCategory) {
      setSearchTerm('');
      fetchServiceConversations(selectedServiceCategory);
    } else if (!selectedSeller && selectedAttendanceFilter === 'tudo' && !selectedTodasDemandasSubdivision && !selectedServiceCategory && viewingIntervencaoHumana) {
      setSearchTerm('');
      fetchAllInterventionConversations();
    } else if (selectedFechadosFilter) {
      setSelectedSeller(null);
      setSelectedSellerBrand(null);
      setSelectedTodasDemandasSubdivision(null);
      setSearchTerm('');
      fetchFechadosConversations();
    } else if (!selectedSeller && selectedAttendanceFilter === 'tudo' && !selectedTodasDemandasSubdivision && !selectedServiceCategory) {
      setSearchTerm('');
      fetchAttributedConversations();
    }
  }, [selectedAttendanceFilter, selectedNaoAtribuidosFilter, selectedTodasDemandasSubdivision, selectedFechadosFilter, selectedServiceCategory, viewingIntervencaoHumana, selectedFollowUpNode]);

  // Clear search when seller changes
  useEffect(() => {
    setSearchTerm('');
  }, [selectedSeller]);

  // Reset bulk select ao trocar de view
  useEffect(() => {
    if (isPedidosOrcamentosView || selectedTodasDemandasSubdivision || selectedFechadosFilter) {
      setIsBulkSelectMode(false);
      setSelectedAttendancesForBulk(new Set());
    }
  }, [isPedidosOrcamentosView, selectedTodasDemandasSubdivision, selectedFechadosFilter]);

  // Detectar scroll na coluna Entrada e aumentar largura quando a barra aparecer
  const checkEntryNavScroll = useCallback(() => {
    const el = entryNavRef.current;
    if (!el) return;
    const hasScroll = el.scrollHeight > el.clientHeight;
    setEntryPanelHasScroll((prev) => (prev !== hasScroll ? hasScroll : prev));
  }, []);

  useEffect(() => {
    const run = () => {
      requestAnimationFrame(() => {
        checkEntryNavScroll();
      });
    };
    run();
    const t = setTimeout(run, 100);
    const onResize = () => run();
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [
    checkEntryNavScroll,
    expandedTodasDemandas,
    selectedServiceCategory,
    supervisorSellers,
  ]);

  /** Atualiza posição do indicador deslizante quando a divisão selecionada muda */
  const updateSlidingIndicator = useCallback(() => {
    const container = entryNavInnerRef.current;
    const active = container?.querySelector<HTMLElement>('[data-division-active]');
    if (!container || !active) {
      setSlidingIndicatorRect(null);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    /* Usar getBoundingClientRect: as coordenadas já refletem o scroll (viewport).
       A diferença activeRect - containerRect dá a posição relativa ao container. */
    const top = activeRect.top - containerRect.top;
    const height = activeRect.height;
    const left = activeRect.left - containerRect.left;
    const width = activeRect.width;
    setSlidingIndicatorRect({ top, height, left, width });
  }, []);

  useLayoutEffect(() => {
    updateSlidingIndicator();
    const nav = entryNavRef.current;
    if (!nav) return;
    const handleScroll = () => requestAnimationFrame(updateSlidingIndicator);
    nav.addEventListener('scroll', handleScroll);
    return () => nav.removeEventListener('scroll', handleScroll);
  }, [
    updateSlidingIndicator,
    selectedAttendanceFilter,
    selectedNaoAtribuidosFilter,
    selectedServiceCategory,
    viewingIntervencaoHumana,
    selectedTodasDemandasSubdivision,
    selectedFollowUpNode,
    selectedFechadosFilter,
    selectedSeller,
    selectedSellerSubdivision,
    expandedTodasDemandas,
  ]);

  /** Atualiza posição do indicador deslizante na barra lateral (abas Chat, Estatísticas, Contatos) */
  const updateSidebarTabIndicator = useCallback(() => {
    const container = sidebarNavRef.current;
    const active = container?.querySelector<HTMLElement>('[data-sidebar-tab-active]');
    if (!container || !active) {
      setSidebarTabIndicatorRect(null);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const top = activeRect.top - containerRect.top;
    const height = activeRect.height;
    const left = activeRect.left - containerRect.left;
    const width = activeRect.width;
    setSidebarTabIndicatorRect({ top, height, left, width });
  }, []);

  useLayoutEffect(() => {
    const container = sidebarNavRef.current;
    if (!container) return;
    updateSidebarTabIndicator();
    /* Durante a transição da barra (duration-300), atualizar a cada frame para o indicador crescer dinamicamente. */
    const transitionMs = 320;
    const start = performance.now();
    let rafId: number;
    const tick = () => {
      updateSidebarTabIndicator();
      if (performance.now() - start < transitionMs) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    const ro = new ResizeObserver(() => updateSidebarTabIndicator());
    ro.observe(container);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [updateSidebarTabIndicator, activeSupervisorTab, sidebarOpen]);

  // Removido useEffect que causava duplicação - o total é calculado manualmente quando necessário

  // Use refs to access current values in Socket.IO handlers without causing re-registration
  const selectedConversationRef = useRef(selectedConversation);
  const selectedAttendanceFilterRef = useRef(selectedAttendanceFilter);
  const selectedSellerRef = useRef(selectedSeller);
  const selectedSellerSubdivisionRef = useRef(selectedSellerSubdivision);
  const viewingIntervencaoHumanaRef = useRef(viewingIntervencaoHumana);
  const selectedConversationDataRef = useRef(selectedConversationData);
  const conversationsRef = useRef(conversations);
  const unassignedConversationsCacheRef = useRef(unassignedConversationsCache);
  const lastFetchedConversationRef = useRef<string | null>(null);
  const isLoadingMessagesRef = useRef(false); // Proteção contra múltiplas chamadas simultâneas
  const markAsReadInProgressRef = useRef<Set<string>>(new Set()); // Proteção contra múltiplas chamadas de markAsRead
  const selectedNaoAtribuidosFilterRef = useRef(selectedNaoAtribuidosFilter);
  const selectedServiceCategoryRef = useRef(selectedServiceCategory);
  const selectedFollowUpNodeRef = useRef(selectedFollowUpNode);
  const supervisorSellersRef = useRef(supervisorSellers);
  /** IDs removidos via fallback (message_received + sellerId). Evita que fetch em flight re-adicione. */
  const recentlyRemovedViaFallbackRef = useRef<Set<string>>(new Set());
  /** IDs roteados nesta sessão — nunca exibir em "Não Atribuídos" (Todos/Triagem/etc.), mesmo que a API devolva. */
  const routedAttendanceIdsRef = useRef<Set<string>>(new Set());
  /** IDs marcados como lido nesta sessão — forçar unread=0 no refetch para evitar badge voltar */
  const markedAsReadIdsRef = useRef<Set<string>>(new Set());

  // Update refs when values change
  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
    if (selectedConversation) setMobileChatLayer('chat');
  }, [selectedConversation]);
  
  useEffect(() => {
    selectedAttendanceFilterRef.current = selectedAttendanceFilter;
  }, [selectedAttendanceFilter]);

  useEffect(() => {
    selectedSellerRef.current = selectedSeller;
  }, [selectedSeller]);

  useEffect(() => {
    selectedSellerSubdivisionRef.current = selectedSellerSubdivision;
  }, [selectedSellerSubdivision]);

  useEffect(() => {
    viewingIntervencaoHumanaRef.current = viewingIntervencaoHumana;
  }, [viewingIntervencaoHumana]);

  useEffect(() => {
    selectedConversationDataRef.current = selectedConversationData;
  }, [selectedConversationData]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    unassignedConversationsCacheRef.current = unassignedConversationsCache;
  }, [unassignedConversationsCache]);

  useEffect(() => {
    selectedNaoAtribuidosFilterRef.current = selectedNaoAtribuidosFilter;
  }, [selectedNaoAtribuidosFilter]);

  useEffect(() => {
    selectedServiceCategoryRef.current = selectedServiceCategory;
  }, [selectedServiceCategory]);

  useEffect(() => {
    selectedFollowUpNodeRef.current = selectedFollowUpNode;
  }, [selectedFollowUpNode]);

  useEffect(() => {
    supervisorSellersRef.current = supervisorSellers;
  }, [supervisorSellers]);

  useEffect(() => {
    const nao = unreadBySubdivision['ai-nao-classificados'] ?? 0;
    const flash = unreadBySubdivision['ai-flash-day'] ?? 0;
    const loc = unreadBySubdivision['ai-locacao-estudio'] ?? 0;
    const cap = unreadBySubdivision['ai-captacao-videos'] ?? 0;
    const triLegacy = unreadBySubdivision['triagem'] ?? 0;
    const eco = unreadBySubdivision['encaminhados-ecommerce'] ?? 0;
    const bal = unreadBySubdivision['encaminhados-balcao'] ?? 0;
    setTotalUnreadUnassigned(nao + flash + loc + cap + triLegacy + eco + bal);
  }, [unreadBySubdivision]);

  /** Contagem de atendimentos abertos na subdivisão (para exibir em todas as subdivisões da sidebar). */
  const getActiveCount = useCallback((key: string): number => {
    if (key === 'todos') {
      return (activeCountBySubdivision['triagem'] ?? 0) + (activeCountBySubdivision['encaminhados-ecommerce'] ?? 0) + (activeCountBySubdivision['encaminhados-balcao'] ?? 0);
    }
    if (key === 'abertos') {
      return activeCountBySubdivision['abertos'] ?? 0;
    }
    if (key === 'attributed') {
      return activeCountBySubdivision['attributed'] ?? 0;
    }
    if (key === 'todas-demandas-total') {
      const pedidosOrc = activeCountBySubdivision['pedidos-orcamentos'] ?? 0;
      const rest = supervisorSellers.reduce((sum, s) => {
        const subs = ['perguntas-pos-orcamento', 'confirmacao-pix', 'tirar-pedido', 'informacoes-entrega', 'encomendas', 'cliente-pediu-humano'];
        return sum + subs.reduce((s2, sub) => s2 + (activeCountBySubdivision[`seller-${s.id}-${sub}`] ?? 0), 0);
      }, 0);
      return pedidosOrc + rest;
    }
    return activeCountBySubdivision[key] ?? 0;
  }, [activeCountBySubdivision, supervisorSellers]);

  /** Chave que muda ao trocar divisão/subdivisão - usada para animação roll na lista de conversas */
  const divisionViewKey = useMemo(
    () =>
      [
        selectedAttendanceFilter,
        selectedNaoAtribuidosFilter,
        selectedServiceCategory,
        viewingIntervencaoHumana,
        selectedTodasDemandasSubdivision,
        selectedFollowUpNode,
        selectedFechadosFilter,
        selectedSeller,
        selectedSellerSubdivision,
      ].join('|'),
    [
      selectedAttendanceFilter,
      selectedNaoAtribuidosFilter,
      selectedServiceCategory,
      viewingIntervencaoHumana,
      selectedTodasDemandasSubdivision,
      selectedFollowUpNode,
      selectedFechadosFilter,
      selectedSeller,
      selectedSellerSubdivision,
    ]
  );

  const fetchSubdivisionCounts = useCallback(async (options?: { bust?: boolean }) => {
    if (!user?.id || user?.role !== 'SUPERVISOR') return;
    try {
      const counts = await attendanceService.getSubdivisionCounts(options);
      setActiveCountBySubdivision(counts);
    } catch (e) {
      console.warn('Erro ao buscar contagens por subdivisão:', e);
    }
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (!user?.id || user?.role !== 'SUPERVISOR') return;
    fetchSubdivisionCounts();
    // Interval maior para reduzir carga no backend (consulta pesada)
    const interval = setInterval(fetchSubdivisionCounts, 30000);
    return () => clearInterval(interval);
  }, [user?.id, user?.role, fetchSubdivisionCounts, scheduleStatsRealtimeRefresh]);

  // Socket.IO: Connect and listen for real-time updates
  useEffect(() => {
    // Connect to Socket.IO
    if (user?.id && user?.role === 'SUPERVISOR') {
      console.log('🔌 Iniciando configuração de Socket.IO listeners');
      
      socketService.connect();

      // Join supervisors room (will wait for connection if not connected yet)
      socketService.joinRoom('supervisors');

      // Listen for new unassigned messages (for supervisors)
      const handleNewUnassignedMessage = (data: {
        attendanceId: string;
        messageId?: string;
        clientPhone: string;
        clientName: string;
        lastMessage: string;
        lastMessageTime: string;
        createdAt: string;
        updatedAt: string;
        unassignedFilter?:
          | 'triagem'
          | 'ai-nao-classificados'
          | 'encaminhados-ecommerce'
          | 'encaminhados-balcao'
          | 'ai-flash-day'
          | 'ai-locacao-estudio'
          | 'ai-captacao-videos';
      }) => {
        console.log('New unassigned message received via Socket.IO', data);

        const messageKey = data.messageId 
          ? `msg-${data.messageId}` 
          : `${data.attendanceId}-${data.lastMessageTime}`;
        
        if (processedMessagesRef.current.has(messageKey)) {
          console.log('⚠️ Duplicate message detected, skipping:', messageKey);
          return;
        }
        if (
          recentlyRemovedViaFallbackRef.current.has(String(data.attendanceId)) ||
          routedAttendanceIdsRef.current.has(String(data.attendanceId))
        ) {
          console.log('⚠️ Skipping new_unassigned for routed attendance:', data.attendanceId);
          return;
        }
        
        processedMessagesRef.current.add(messageKey);
        if (processedMessagesRef.current.size > 100) {
          const keysArray = Array.from(processedMessagesRef.current);
          processedMessagesRef.current = new Set(keysArray.slice(-50));
        }

        const isConversationOpen = selectedConversationRef.current === data.attendanceId;
        const filter = (data as any).unassignedFilter ?? 'ai-nao-classificados';
        const currentSubFilter = selectedNaoAtribuidosFilterRef.current;
        const matchesFilter = currentSubFilter === 'todos' || filter === currentSubFilter;
        
        if (selectedAttendanceFilterRef.current === 'nao-atribuidos' && matchesFilter) {
          // Use startTransition for smooth update
          startTransition(() => {
            setConversations((prev) => {
              // Check if conversation already exists
              const exists = prev.some((conv) => conv.id === data.attendanceId);
              let updatedConversations;
              
              if (exists) {
                // Update existing conversation (avoid duplicates)
                updatedConversations = prev.map((conv) =>
                  conv.id === data.attendanceId
                    ? {
                        ...conv,
                        lastMessage: data.lastMessage,
                        lastMessageTime: data.lastMessageTime,
                        updatedAt: data.updatedAt,
                        // Store media type for display formatting
                        lastMessageMediaType: (data as any).lastMessageMediaType,
                        // Só incrementa não lidas se a conversa não estiver aberta
                        unread: isConversationOpen ? conv.unread : conv.unread + 1,
                      }
                    : conv
                );
              } else {
                // Check if conversation already exists in the list (avoid duplicates)
                const alreadyExists = prev.some((conv) => conv.id === data.attendanceId);
                if (!alreadyExists) {
                  // Add new conversation at the beginning
                  const newConversation: Conversation = {
                    id: data.attendanceId,
                    clientPhone: data.clientPhone,
                    clientName: data.clientName,
                    lastMessage: data.lastMessage,
                    lastMessageTime: data.lastMessageTime,
                    unread: isConversationOpen ? 0 : 1,
                    state: 'OPEN',
                    lastMessageMediaType: (data as any).lastMessageMediaType,
                    handledBy: 'AI',
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                    unassignedSource: filter as Conversation['unassignedSource'],
                  };
                  updatedConversations = [newConversation, ...prev];
                } else {
                  updatedConversations = prev;
                }
              }
              
              return updatedConversations;
            });
          });
        } else if (!isConversationOpen && (filter === 'triagem' || filter === 'ai-nao-classificados')) {
          // Se não está vendo a lista e mensagem é de não classificados (triagem legado), atualizar cache
          startTransition(() => {
            setUnassignedConversationsCache((prev) => {
                const exists = prev.some((conv) => conv.id === data.attendanceId);
                let updated;
                
                if (exists) {
                  updated = prev.map((conv) =>
                    conv.id === data.attendanceId
                      ? { 
                          ...conv, 
                          unread: conv.unread + 1, 
                          lastMessage: data.lastMessage, 
                          lastMessageTime: data.lastMessageTime,
                          updatedAt: data.updatedAt,
                          lastMessageMediaType: (data as any).lastMessageMediaType,
                        }
                      : conv
                  );
                } else {
                  const newConversation: Conversation = {
                    id: data.attendanceId,
                    clientPhone: data.clientPhone,
                    clientName: data.clientName,
                    lastMessage: data.lastMessage,
                    lastMessageTime: data.lastMessageTime,
                    unread: 1,
                    state: 'OPEN',
                    lastMessageMediaType: (data as any).lastMessageMediaType,
                    handledBy: 'AI',
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                  };
                  updated = [newConversation, ...prev];
                }
                return updated;
              });
            });
        }
        // Sempre incrementar badge do dropdown quando há nova mensagem e a conversa não está aberta
        // (antes só incrementava com !matchesFilter, então em "Todos" o badge nunca aparecia)
        if (!isConversationOpen) {
          markedAsReadIdsRef.current.delete(data.attendanceId); // Permitir badge voltar com nova mensagem
          incrementSubdivision(filter, 1, data.attendanceId);
        }

        // Toast apenas quando o usuário está em "Não atribuídos" e a mensagem bate no filtro.
        // Se estiver em outra divisão, não exibir nada; a msg só deve aparecer ao clicar na conversa.
        const showToast =
          selectedAttendanceFilterRef.current === 'nao-atribuidos' &&
          matchesFilter &&
          selectedConversationRef.current !== data.attendanceId;
        if (showToast) {
          setTimeout(() => {
            toast.success(`Nova mensagem de ${data.clientName}`, {
              icon: '📩',
              duration: 2000,
              position: 'top-right',
            });
          }, 150);
        }
        fetchSubdivisionCounts();
      };

      // Listen for general message received
      const handleMessageReceived = (data: { 
        attendanceId: string; 
        messageId: string; 
        clientPhone: string; 
        isUnassigned: boolean;
        message: {
          id: string;
          content: string;
          origin: string;
          sentAt: string;
          metadata?: Record<string, any>;
        };
      }) => {
        if (isLegacyRelocationSystemMessage(data?.message as any)) return;
        const msgId = data?.message?.id;
        if (msgId && processedMessageReceivedRef.current.has(msgId)) {
          return;
        }
        if (msgId) {
          processedMessageReceivedRef.current.add(msgId);
          if (processedMessageReceivedRef.current.size > 200) {
            const arr = Array.from(processedMessageReceivedRef.current);
            processedMessageReceivedRef.current = new Set(arr.slice(-100));
          }
        }
        console.log('Message received via Socket.IO', data);
        console.log('📨 Message details:', {
          messageId: data.message.id,
          origin: data.message.origin,
          attendanceId: data.attendanceId,
          selectedConversation: selectedConversationRef.current,
          isMatch: selectedConversationRef.current === data.attendanceId,
        });

        if (data.isUnassigned && data.message.origin === 'CLIENT') {
          console.log('⚠️ Skipping unread counter increment - already handled by handleNewUnassignedMessage');
        }

        const sellerId = (data as any).sellerId;
        const sellerSubdivision = (data as any).sellerSubdivision || 'pedidos-orcamentos';
        
        // FALLBACK: Se mensagem veio com sellerId mas conversa está em triagem, remover da triagem
        // (Isso acontece quando attendance:routed é bloqueado pelo Cloudflare Tunnel)
        // IMPORTANTE: Só fazer isso se estamos visualizando não atribuídos!
        const aid = String(data.attendanceId);
        let didFallbackRemove = false;
        if (!data.isUnassigned && sellerId && data.message.origin === 'CLIENT') {
          // "Não Atribuídos" é quando selectedAttendanceFilter === 'nao-atribuidos'
          // "Atribuídos" é quando selectedAttendanceFilter === 'tudo' (mas sem outras seleções)
          const isViewingNaoAtribuidos = selectedAttendanceFilterRef.current === 'nao-atribuidos';
          const isInTriagem =
            conversationsRef.current.some((c) => String(c.id) === aid) ||
            unassignedConversationsCacheRef.current.some((c) => String(c.id) === aid);

          console.log('🔍 FALLBACK Check:', {
            attendanceId: data.attendanceId,
            sellerId,
            currentFilter: selectedAttendanceFilterRef.current,
            isViewingNaoAtribuidos,
            isInTriagem,
            willRemove: isInTriagem && isViewingNaoAtribuidos,
          });

          if (isInTriagem && isViewingNaoAtribuidos) {
            didFallbackRemove = true;
            recentlyRemovedViaFallbackRef.current.add(aid);
            routedAttendanceIdsRef.current.add(aid);
            setTimeout(() => recentlyRemovedViaFallbackRef.current.delete(aid), 8000);

            console.log('🔄 FALLBACK: Removendo da triagem (message_received com sellerId)', {
              attendanceId: data.attendanceId,
              sellerId,
            });

            startTransition(() => {
              setConversations((prev) => prev.filter((c) => String(c.id) !== aid));
              setUnassignedConversationsCache((prev) => prev.filter((c) => String(c.id) !== aid));
            });

            // Limpar seleção se for a conversa ativa
            if (String(selectedConversationRef.current) === aid) {
              setSelectedConversation(null);
              setMessages([]);
              setSelectedConversationData(null);
            }

            // Refetch "Não Atribuídos" para garantir que some de Todos/todas subdivisões
            if (selectedAttendanceFilterRef.current === 'nao-atribuidos') {
              fetchUnassignedConversations(selectedNaoAtribuidosFilterRef.current).catch((e) =>
                console.error('Error refetching unassigned after fallback route', e)
              );
            }
          }
        }

        // Não incrementar badge azul (unread) para pedidos-orcamentos: essa subdivisão usa apenas o badge verde (orçamentos não visualizados)
        if (
          !data.isUnassigned &&
          sellerId &&
          sellerSubdivision !== 'pedidos-orcamentos' &&
          data.message.origin === 'CLIENT' &&
          String(selectedConversationRef.current) !== aid &&
          (selectedSellerRef.current !== sellerId || selectedSellerSubdivisionRef.current !== sellerSubdivision)
        ) {
          markedAsReadIdsRef.current.delete(data.attendanceId); // Permitir badge voltar com nova mensagem
          incrementSubdivision(`seller-${sellerId}-${sellerSubdivision}`, 1, data.attendanceId);
        }

        // Evitar processar resto do handler (adicionar à lista de mensagens, etc.) após remoção por fallback
        if (didFallbackRemove) return;

        // Mensagem fromMe (dono enviando do celular): atualizar timer de 1h desligada
        if (data.message.origin === 'SELLER' && (data.message.metadata?.fromMe || (data as any).fromMe) && data.attendanceId) {
          fetchInactivityTimer(data.attendanceId);
        }

        // Start typing indicator when client sends a message (for AI response)
        // Padrão: usar handledBy do payload (backend), depois conversation. Para não-atribuídos/intervenção, assumir AI.
        if (data.message.origin === 'CLIENT' && selectedConversationRef.current === data.attendanceId) {
          const conversationData = selectedConversationDataRef.current;
          const conversation = conversationsRef.current.find(conv => conv.id === data.attendanceId);
          const handledBy =
            (data as any).handledBy ??
            conversationData?.handledBy ??
            conversation?.handledBy ??
            (data.isUnassigned ? 'AI' : undefined);
          const effectiveHandledBy = handledBy ?? (data.isUnassigned ? 'AI' : null);
          if (effectiveHandledBy === 'AI') {
            setIsAITyping((prev) => ({ ...prev, [data.attendanceId]: true }));
            if (typingTimeoutRef.current[data.attendanceId]) {
              clearTimeout(typingTimeoutRef.current[data.attendanceId]);
            }
          } else {
            // HUMAN ou outro: desligar typing
            setIsAITyping((prev) => ({ ...prev, [data.attendanceId]: false }));
            if (typingTimeoutRef.current[data.attendanceId]) {
              clearTimeout(typingTimeoutRef.current[data.attendanceId]);
            }
          }

          // Stop client typing indicator when client sends a message
          setIsClientTyping((prev) => ({ ...prev, [data.attendanceId]: false }));
          if (clientTypingTimeoutRef.current[data.attendanceId]) {
            clearTimeout(clientTypingTimeoutRef.current[data.attendanceId]);
          }
        }

        // Stop typing indicator when AI message arrives
        if (data.message.origin === 'AI' && selectedConversationRef.current === data.attendanceId) {
          // Check if this is a fragment (has isFragment metadata)
          const isFragment = data.message.metadata?.isFragment === true;
          
          if (!isFragment) {
            // First AI message or non-fragment message - stop typing immediately
            setIsAITyping((prev) => ({ ...prev, [data.attendanceId]: false }));
            if (typingTimeoutRef.current[data.attendanceId]) {
              clearTimeout(typingTimeoutRef.current[data.attendanceId]);
            }
          } else {
            // Fragment message - keep typing active, but set timeout to stop after delay
            // This handles the case where fragments might have delays between them
            setIsAITyping((prev) => ({ ...prev, [data.attendanceId]: true }));
            
            // Clear existing timeout
            if (typingTimeoutRef.current[data.attendanceId]) {
              clearTimeout(typingTimeoutRef.current[data.attendanceId]);
            }
            
            // Set timeout to stop typing after 1.5 seconds (slightly longer than fragment delay)
            typingTimeoutRef.current[data.attendanceId] = setTimeout(() => {
              setIsAITyping((prev) => {
                const updated = { ...prev };
                delete updated[data.attendanceId];
                return updated;
              });
            }, 1500);
          }
        }

        // Marcar azul como lido quando IA responde; vermelho não é alterado
        // Só chamar markAsRead na API quando o atendimento NÃO está atribuído a vendedor (backend retorna 403 nesse caso)
        if (data.message.origin === 'AI') {
          markBlueAsReadForConversation(data.attendanceId);
          markedAsReadIdsRef.current.add(data.attendanceId);
          if (!data.sellerId) {
            attendanceService.markAsRead(data.attendanceId).catch((e) =>
              console.error('Error marking as read on AI reply:', e)
            );
          }
          startTransition(() => {
            setConversations((prev) =>
              prev.map((c) => (c.id === data.attendanceId ? { ...c, unread: 0 } : c))
            );
            if (
              selectedAttendanceFilterRef.current === 'nao-atribuidos' &&
              (selectedNaoAtribuidosFilterRef.current === 'triagem' ||
                selectedNaoAtribuidosFilterRef.current === 'ai-nao-classificados')
            ) {
              setUnassignedConversationsCache((prevCache) =>
                prevCache.map((c) => (c.id === data.attendanceId ? { ...c, unread: 0 } : c))
              );
            }
          });
        }

        // If this message is for the currently selected conversation, add it to messages
        // Usar String() para evitar mistura quando um id é string e outro número
        const isConversationSelected = String(selectedConversationRef.current) === String(data.attendanceId);
        const isClient = data.message.origin === 'CLIENT';
        const isFromSeller = data.message.origin === 'SELLER';
        const isFromAI = data.message.origin === 'AI';
        
        // Mensagens AI/SELLER só processar se a conversa estiver selecionada
        if (!isConversationSelected && !isClient) {
          return;
        }
        
        // Adicionar mensagem - usar startTransition apenas para mensagens do cliente
        // Mensagens da IA devem aparecer imediatamente (sem startTransition) para melhor UX
        const processMessage = () => {
          
          // Determine sender name (fallback: clientName da conversa em vez de "Cliente" genérico)
          let sender = 'Cliente';
          if (isFromSeller) {
            sender = data.message.metadata?.ownerPushName || data.message.metadata?.senderName || data.sender || user?.name || 'Vendedor';
          } else if (isFromAI) {
            sender = 'AI';
          } else if (isClient && data.message.metadata?.pushName) {
            sender = data.message.metadata.pushName;
          } else if (isClient) {
            const conv = conversationsRef.current.find((c) => String(c.id) === String(data.attendanceId));
            sender = conv?.clientName || 'Cliente';
          }

          // Format time - use metadata.sentAt if available (ISO string), otherwise use sentAt
          // Always prioritize ISO timestamp from metadata for accurate sorting
          const timestamp = data.message.metadata?.sentAt || data.message.sentAt;
          const timestampDate = new Date(timestamp);
          
          // Validate timestamp
          if (isNaN(timestampDate.getTime())) {
            console.error('Invalid timestamp received via Socket.IO:', timestamp, data.message);
          }
          
          // IMPORTANT: Format in Brazil timezone (America/Sao_Paulo) for consistent display
          // timestampDate is in UTC (from ISO string), need to convert to Brazil timezone
          const formatter = new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          const parts = formatter.formatToParts(timestampDate);
          const hours = parts.find(p => p.type === 'hour')?.value || '00';
          const minutes = parts.find(p => p.type === 'minute')?.value || '00';
          const time = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
          
          // CRITICAL: Store ISO timestamp for sorting, not just HH:MM
          // This ensures messages are sorted correctly by actual timestamp
          const isoTimestamp = timestampDate.toISOString();

          const newMessage: Message = {
            id: data.message.id,
            sender,
            content: data.message.content,
            time,
            sentAt: time, // Display time (HH:MM for UI)
            isClient,
            origin: data.message.origin as Message['origin'],
            avatar: isClient 
              ? `https://ui-avatars.com/api/?name=${encodeURIComponent(sender)}&background=F07000&color=fff`
              : undefined,
            hasLink: data.message.content.includes('http'),
            metadata: {
              ...(data.message.metadata || {}),
              // CRITICAL: Always store full ISO timestamp for sorting
              // This is what the sort function uses to determine order
              sentAt: isoTimestamp,
              createdAt: isoTimestamp,
            },
          };

          // Evitar bloco fantasma: não adicionar mensagens sem conteúdo e sem mídia (evita balão só com horário ao assumir atendimento)
          const hasContent = newMessage.content != null && String(newMessage.content).trim() !== '';
          const hasMedia = !!(newMessage.metadata?.mediaUrl);
          if (!hasContent && !hasMedia) {
            return;
          }
          
          // CORREÇÃO ISOLAMENTO: Só adicionar ao painel de mensagens se for da conversa SELECIONADA.
          // Mensagens de outras conversas (ex.: Marcos) não devem aparecer no chat do Juan.
          if (isConversationSelected) {
            // Check if user is at bottom before adding message
            const wasAtBottom = isAtBottom();
            
            // Add new message to messages list (otimizado: sem logs e ordenação mais eficiente)
            setMessages((prev) => {
              // Garantir que só adicionamos se a conversa selecionada for esta
              if (String(selectedConversationRef.current) !== String(data.attendanceId)) {
                return prev;
              }
              
              // Verificar duplicação por ID
              const existingIndex = prev.findIndex((m) => m.id === data.message.id);
              if (existingIndex >= 0) {
                // Atualizar mensagem existente (ex.: mediaUrl após download em background; content de [Processando imagem...] para [Imagem])
                return prev.map((m, i) =>
                  i === existingIndex
                    ? {
                        ...m,
                        ...(data.message.content != null && data.message.content !== m.content ? { content: data.message.content } : {}),
                        metadata: {
                          ...m.metadata,
                          ...(data.message.metadata || {}),
                          sentAt: m.metadata?.sentAt ?? data.message.metadata?.sentAt,
                          createdAt: m.metadata?.createdAt ?? data.message.metadata?.createdAt,
                        },
                      }
                    : m
                );
              }
              
              // Proteção adicional: verificar se já existe mensagem com mesmo conteúdo e timestamp muito próximo
              // (evita duplicação quando mensagem chega via Socket.IO e depois via API)
              // IMPORTANTE: Só verificar duplicação por conteúdo para mensagens do CLIENTE
              // Mensagens da IA sempre têm IDs únicos e não devem ser bloqueadas por conteúdo
              if (isClient) {
                const isDuplicate = prev.some((m) => {
                  if (m.content === newMessage.content && m.isClient === newMessage.isClient) {
                    const mTime = new Date(m.metadata?.sentAt || m.sentAt || 0).getTime();
                    const newTime = new Date(newMessage.metadata?.sentAt || newMessage.sentAt || 0).getTime();
                    // Se timestamps estão muito próximos (menos de 2 segundos), considerar duplicata
                    return Math.abs(mTime - newTime) < 2000;
                  }
                  return false;
                });
                
                if (isDuplicate) {
                  return prev;
                }
              }
              
              // Para mensagens da IA, sempre ordenar (igual ao vendedor) para garantir ordem correta
              // Para outras mensagens, tentar otimização
              const updated = [...prev, newMessage];
              if (!isFromAI) {
                // Otimização apenas para mensagens não-AI: Se a mensagem nova é mais recente que a última, apenas adicionar ao final
                const lastMsg = prev[prev.length - 1];
                if (lastMsg) {
                  const lastTime = new Date(lastMsg.metadata?.sentAt || lastMsg.sentAt || 0).getTime();
                  const newTime = new Date(newMessage.metadata?.sentAt || newMessage.sentAt || 0).getTime();
                  if (newTime >= lastTime) {
                    // Nova mensagem é mais recente ou igual, apenas adicionar ao final
                    return [...prev, newMessage];
                  }
                }
              }
              
              // Ordenar todas as mensagens (igual ao vendedor)
              return updated.sort((a, b) => {
                const getTimestamp = (msg: Message): number => {
                  const ts = msg.metadata?.sentAt || msg.sentAt || msg.createdAt;
                  if (!ts) return 0;
                  const timestamp = new Date(ts).getTime();
                  return isNaN(timestamp) ? 0 : timestamp;
                };
                const timeA = getTimestamp(a);
                const timeB = getTimestamp(b);
                if (timeA !== timeB) return timeA - timeB;
                const originOrder = (o: string) => (o === 'CLIENT' ? 0 : o === 'AI' ? 1 : 2);
                return (originOrder(a.origin || '') - originOrder(b.origin || '')) || (String(a.id).localeCompare(String(b.id)));
              });
            });
            
            // Auto-scroll to bottom if user was already at the bottom
            if (wasAtBottom) {
              setTimeout(() => {
                scrollToBottom();
              }, 50);
            }
          }
        };
        
        // Para mensagens da IA, executar imediatamente (sem startTransition) para aparecer mais rápido
        // Para mensagens do cliente/vendedor, usar startTransition para melhor performance
        if (isFromAI) {
          processMessage();
        } else {
          startTransition(processMessage);
        }

        // Update conversations list silently (without loading animation)
        // NOTA: Para mensagens não atribuídas, não atualizar aqui porque já é atualizado por handleNewUnassignedMessage
        // Isso evita duplicação de contadores
        if (data.isUnassigned) {
          const isConversationOpen = selectedConversationRef.current === data.attendanceId;
          if (selectedAttendanceFilterRef.current === 'nao-atribuidos') {
            setConversations((prev) => {
              const exists = prev.some((conv) => conv.id === data.attendanceId);
              if (!exists) return prev;
              return prev.map((conv) =>
                conv.id === data.attendanceId
                  ? {
                      ...conv,
                      lastMessage: data.message.content,
                      lastMessageTime: data.message.sentAt,
                      updatedAt: new Date().toISOString(),
                      lastMessageMediaType: data.message.metadata?.mediaType,
                    }
                  : conv
              );
            });
            if (
              selectedNaoAtribuidosFilterRef.current === 'triagem' ||
              selectedNaoAtribuidosFilterRef.current === 'ai-nao-classificados'
            ) {
              setUnassignedConversationsCache((prev) =>
                prev.map((c) =>
                  c.id === data.attendanceId
                    ? {
                        ...c,
                        lastMessage: data.message.content,
                        lastMessageTime: data.message.sentAt,
                        updatedAt: new Date().toISOString(),
                        lastMessageMediaType: data.message.metadata?.mediaType,
                      }
                    : c
                )
              );
            }
          }
        }
        
        fetchSubdivisionCounts();
        // Quando cliente responde, o follow-up é resetado no backend. Se estamos em follow-up, recarregar a lista
        // para o card aparecer na coluna correta (ex.: Aguardando 1º) imediatamente.
        if (isClient && selectedFollowUpNodeRef.current) {
          fetchFollowUpConversations(selectedFollowUpNodeRef.current).catch((e) =>
            console.error('Error refreshing follow-up after client message', e)
          );
        }
      };

      // Listen for sent messages (confirmation from server)
      const handleMessageSent = (data: {
        attendanceId: string;
        messageId: string;
        clientPhone?: string;
        isUnassigned?: boolean;
        message: {
          id: string;
          content: string;
          origin: string;
          sentAt: string;
          metadata?: Record<string, any>;
        };
      }) => {
        if (isLegacyRelocationSystemMessage(data?.message as any)) return;
        console.log('Message sent confirmation via Socket.IO', data);

        // Refresh inactivity timer when human sends a message (backend already updated assumedAt)
        if (data.message.origin === 'SELLER' && data.attendanceId) {
          fetchInactivityTimer(data.attendanceId);
        }

        // Stop typing indicator when AI message is sent (confirmation)
        if (data.message.origin === 'AI' && selectedConversationRef.current === data.attendanceId) {
          const isFragment = data.message.metadata?.isFragment === true;
          
          if (!isFragment) {
            // Non-fragment message - stop typing
            setIsAITyping((prev) => ({ ...prev, [data.attendanceId]: false }));
            if (typingTimeoutRef.current[data.attendanceId]) {
              clearTimeout(typingTimeoutRef.current[data.attendanceId]);
            }
          } else {
            // Fragment - keep typing active for a bit longer
            setIsAITyping((prev) => ({ ...prev, [data.attendanceId]: true }));
            
            // Clear existing timeout
            if (typingTimeoutRef.current[data.attendanceId]) {
              clearTimeout(typingTimeoutRef.current[data.attendanceId]);
            }
            
            // Set timeout to stop typing after fragment delay
            typingTimeoutRef.current[data.attendanceId] = setTimeout(() => {
              setIsAITyping((prev) => {
                const updated = { ...prev };
                delete updated[data.attendanceId];
                return updated;
              });
            }, 1200); // Slightly longer than 1 second fragment delay
          }
        }

        const isFromAI = data.message.origin === 'AI';
        const isFromSeller = data.message.origin === 'SELLER';

        // Marcar azul como lido quando IA responde; vermelho não é alterado
        if (isFromAI) {
          markBlueAsReadForConversation(data.attendanceId);
        }

        // Mensagens AI já são adicionadas/atualizadas via message_received; evitar processar em dobro
        if (data.message.origin === 'AI') return;
        
        // Determine sender name
        let sender = user?.name || 'Você';
        if (isFromAI) {
          sender = 'AI';
        } else if (isFromSeller) {
          // Use sender name from message if available, otherwise use user name
          sender = data.message.metadata?.senderName || user?.name || 'Vendedor';
        }

        // If this message is for the currently selected conversation, update it
        if (selectedConversationRef.current === data.attendanceId) {
          // Format time - use metadata.sentAt if available (ISO string), otherwise use sentAt
          // Always prioritize ISO timestamp from metadata for accurate sorting
          const timestamp = data.message.metadata?.sentAt || data.message.sentAt;
          const sentDate = new Date(timestamp);
          
          // Validate timestamp
          if (isNaN(sentDate.getTime())) {
            console.error('Invalid timestamp received in handleMessageSent:', timestamp, data.message);
          }
          
          // IMPORTANT: Format in Brazil timezone (America/Sao_Paulo) for consistent display
          // sentDate is in UTC (from ISO string), need to convert to Brazil timezone
          const formatter = new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          const parts = formatter.formatToParts(sentDate);
          const hours = parts.find(p => p.type === 'hour')?.value || '00';
          const minutes = parts.find(p => p.type === 'minute')?.value || '00';
          const time = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
          
          // CRITICAL: Store ISO timestamp for sorting, not just HH:MM
          const isoTimestamp = sentDate.toISOString();

          const sentMessage: Message = {
            id: data.message.id,
            sender,
            content: data.message.content,
            time,
            sentAt: time, // Display time (HH:MM for UI)
            isClient: false,
            origin: data.message.origin as Message['origin'],
            avatar: undefined,
            hasLink: data.message.content.includes('http'),
            metadata: {
              ...(data.message.metadata || {}),
              // CRITICAL: Always store full ISO timestamp for sorting
              sentAt: isoTimestamp,
              createdAt: isoTimestamp,
            },
          };
          
          console.log('📤 Message sent via Socket.IO with timestamp:', {
            messageId: data.message.id,
            displayTime: time,
            isoTimestamp: isoTimestamp,
            mediaType: data.message.metadata?.mediaType,
          });

          // Update message if it exists (replace temp message) or add if it doesn't (use startTransition for smooth update)
          startTransition(() => {
            setMessages((prev) => {
              // First check if message already exists with the real ID (avoid duplicates)
              const existingIndex = prev.findIndex((m) => m.id === data.message.id);
              if (existingIndex >= 0) {
                // Message already exists, just update it (don't duplicate)
                return prev.map((msg) => (msg.id === data.message.id ? sentMessage : msg));
              }
              
              // Check if there's a temp message with same content to replace
              const tempIndex = prev.findIndex(
                (m) => m.id.startsWith('temp-') && m.content === data.message.content
              );
              if (tempIndex >= 0) {
                // Replace temp message with real message
                return prev.map((msg, idx) => (idx === tempIndex ? sentMessage : msg));
              }
              
              // Only add if message doesn't exist at all (shouldn't happen, but safety check)
              // Check one more time to be absolutely sure we don't duplicate
              if (!prev.some(m => m.id === data.message.id)) {
                const updated = [...prev, sentMessage];
                // Sort by metadata.sentAt (ISO timestamp) - CRITICAL for correct chronological order
                return updated.sort((a, b) => {
                  const getTimestamp = (msg: Message): number => {
                    // Always use metadata.sentAt (ISO string) if available
                    const ts = msg.metadata?.sentAt || msg.sentAt || msg.createdAt;
                    if (!ts) {
                      console.warn('Message missing timestamp in handleMessageSent:', msg.id);
                      return 0;
                    }
                    const date = new Date(ts);
                    const timestamp = date.getTime();
                    if (isNaN(timestamp)) {
                      console.error('Invalid timestamp in message (handleMessageSent):', msg.id, ts);
                      return 0;
                    }
                    return timestamp;
                  };
                  const timeA = getTimestamp(a);
                  const timeB = getTimestamp(b);
                  if (timeA !== timeB) return timeA - timeB;
                  const originOrder = (o: string) => (o === 'CLIENT' ? 0 : o === 'AI' ? 1 : 2);
                  return (originOrder(a.origin || '') - originOrder(b.origin || '')) || (String(a.id).localeCompare(String(b.id)));
                });
              }
              
              // If we get here, message already exists somehow, return unchanged
              return prev;
            });
          });

          // Auto-scroll to bottom if user was at bottom
          const wasAtBottom = isAtBottom();
          if (wasAtBottom) {
            setTimeout(() => {
              scrollToBottom();
            }, 50);
          }
        }

        startTransition(() => {
          const unreadIfAI = isFromAI ? { unread: 0 } : {};
          if (data.isUnassigned && selectedAttendanceFilterRef.current === 'nao-atribuidos') {
            setConversations((prev) =>
              prev.map((conv) =>
                conv.id === data.attendanceId
                  ? {
                      ...conv,
                      lastMessage: data.message.content,
                      lastMessageTime: data.message.sentAt,
                      updatedAt: new Date().toISOString(),
                      lastMessageMediaType: data.message.metadata?.mediaType,
                      ...unreadIfAI,
                    }
                  : conv
              )
            );
            if (
              selectedNaoAtribuidosFilterRef.current === 'triagem' ||
              selectedNaoAtribuidosFilterRef.current === 'ai-nao-classificados'
            ) {
              setUnassignedConversationsCache((prevCache) =>
                prevCache.map((conv) =>
                  conv.id === data.attendanceId
                    ? {
                        ...conv,
                        lastMessage: data.message.content,
                        lastMessageTime: data.message.sentAt,
                        updatedAt: new Date().toISOString(),
                        lastMessageMediaType: data.message.metadata?.mediaType,
                        ...unreadIfAI,
                      }
                    : conv
                )
              );
            }
          } else {
            setConversations((prev) =>
              prev.map((conv) =>
                conv.id === data.attendanceId
                  ? {
                      ...conv,
                      lastMessage: data.message.content,
                      lastMessageTime: data.message.sentAt,
                      lastMessageMediaType: data.message.metadata?.mediaType,
                      updatedAt: new Date().toISOString(),
                      ...unreadIfAI,
                    }
                  : conv
              )
            );
          }
        });
      };

      // Listen for attendance routing events
      const handleAttendanceRouted = async (data: {
        attendanceId: string;
        sellerId: string;
        previousSellerId?: string | null;
        supervisorId: string;
        vehicleBrand: string;
        routedAt: string;
        source?: string;
      }) => {
        try {
          // DEDUPLICAÇÃO: Evitar processar o mesmo roteamento múltiplas vezes
          const routedKey = `routed-${data.attendanceId}-${data.sellerId}-${data.vehicleBrand}`;
          if (processedRoutedAttendancesRef.current.has(routedKey)) {
            console.log('⚠️ Duplicate attendance:routed event detected, skipping:', routedKey);
            return;
          }
          processedRoutedAttendancesRef.current.add(routedKey);
          if (processedRoutedAttendancesRef.current.size > 100) {
            const arr = Array.from(processedRoutedAttendancesRef.current);
            processedRoutedAttendancesRef.current = new Set(arr.slice(-50));
          }

          console.log('🚗 Attendance routed via Socket.IO', {
            attendanceId: data.attendanceId,
            sellerId: data.sellerId,
            vehicleBrand: data.vehicleBrand,
            source: data.source,
            sellerSubdivision: (data as any).sellerSubdivision,
            currentConversationsCount: conversationsRef.current.length,
            currentTriagemCacheCount: unassignedConversationsCacheRef.current.length,
          });

        const sellerSubdivision = (data as any).sellerSubdivision || 'pedidos-orcamentos';
        const isFromIdentificaMarca = data.source === 'identificamarca';
        const isFromRoteiamarca = data.source === 'roteiamarca';
        
        if (selectedSellerRef.current !== data.sellerId || selectedSellerSubdivisionRef.current !== sellerSubdivision) {
          // IMPORTANTE: NÃO incrementar contador azul (mensagens não lidas) quando é apenas roteamento
          // O contador azul só deve ser incrementado quando há nova mensagem do cliente
          // incrementSubdivision(`seller-${data.sellerId}-${sellerSubdivision}`, 1, data.attendanceId);
          
          const divisionKey = (data.vehicleBrand || '').toUpperCase() || 'OTHER';
          
          // Se veio da identificamarca ou roteiamarca: badge vermelho APENAS na marca (não na subdivisão)
          if (isFromIdentificaMarca || isFromRoteiamarca) {
            const ref = redPendingByAttendanceRef.current;
            if (!ref[data.attendanceId]) ref[data.attendanceId] = [];
            // Armazena apenas divisionKey, sem subdivisionKey para não decrementar subdivisão depois
            ref[data.attendanceId].push({ divisionKey, subdivisionKey: '' });
            setRedByDivision((prev) => {
              const next = { ...prev };
              next[divisionKey] = (next[divisionKey] ?? 0) + 1;
              return next;
            });
            // NÃO incrementar redBySubdivision para identificamarca/roteiamarca
            setRedConversationIds((prev) => ({ ...prev, [data.attendanceId]: true }));
          } else {
            // Comportamento padrão: badge vermelho na marca E na subdivisão E em "Atribuídos"
            const sellerSubKey = `seller-${data.sellerId}-${sellerSubdivision}`;
            incrementRed(divisionKey, sellerSubKey, data.attendanceId);
            incrementRed('attributed', sellerSubKey, data.attendanceId);
          }
        }

        // SEMPRE remover da lista de conversas e cache (independente da tela atual)
        const routedAid = String(data.attendanceId);
        recentlyRemovedViaFallbackRef.current.add(routedAid);
        routedAttendanceIdsRef.current.add(routedAid);
        setTimeout(() => recentlyRemovedViaFallbackRef.current.delete(routedAid), 8000);
        startTransition(() => {
          setConversations((prev) => {
            const filtered = prev.filter((conv) => String(conv.id) !== routedAid);
            console.log(`🗑️ Removido da lista de conversas: ${prev.length} → ${filtered.length}`);
            return filtered;
          });
          setUnassignedConversationsCache((prev) => {
            const filtered = prev.filter((conv) => String(conv.id) !== routedAid);
            console.log(`🗑️ Removido do cache triagem: ${prev.length} → ${filtered.length}`);
            return filtered;
          });
        });

        // Se estiver vendo a triagem e a conversa foi removida, limpar seleção
        if (String(selectedConversationRef.current) === routedAid) {
          console.log('🧹 Limpando seleção pois a conversa foi roteada');
          setSelectedConversation(null);
          setMessages([]);
          setSelectedConversationData(null);
        }

        // If viewing a specific seller's conversations, reload them to include the new routed attendance
        // Use a ref to get current value without adding to dependencies
        const currentSelectedSeller = selectedSellerRef.current;
        if (currentSelectedSeller && currentSelectedSeller === data.sellerId) {
          try {
            const sellerConversations = await attendanceService.getConversationsBySeller(data.sellerId);
            setConversations(sellerConversations);
          } catch (error) {
            console.error('Error reloading seller conversations after routing:', error);
          }
        } else if (currentSelectedSeller && data.previousSellerId && currentSelectedSeller === data.previousSellerId) {
          // Se estou olhando o vendedor antigo, recarregar lista dele para remover o atendimento
          try {
            const sellerConversations = await attendanceService.getConversationsBySeller(currentSelectedSeller as any);
            setConversations(sellerConversations);
          } catch (error) {
            console.error('Error reloading previous seller conversations after routing:', error);
          }
        } else if (selectedAttendanceFilterRef.current === 'nao-atribuidos') {
          // Refetch "Não Atribuídos" (Todos/Triagem/etc.) para garantir que o roteado
          // suma de todas as subdivisões, incluindo "Todos" (evita badge Triagem em Todos)
          try {
            await fetchUnassignedConversations(selectedNaoAtribuidosFilterRef.current);
          } catch (e) {
            console.error('Error refetching unassigned after route', e);
          }
        }

          // Show notification
          toast.success(`Atendimento roteado para vendedor ${data.vehicleBrand}`, {
            icon: '✅',
            duration: 3000,
            position: 'top-right',
          });
          fetchSubdivisionCounts();
          scheduleStatsRealtimeRefresh();
        } catch (err) {
          console.error('❌ ERROR in handleAttendanceRouted:', err);
        }
      };

      // Listen for client typing updates
      const handleClientTyping = (data: {
        attendanceId: string;
        clientPhone: string;
        isTyping: boolean;
      }) => {
        console.log('🔵🔵🔵 CLIENT TYPING EVENT RECEIVED!', {
          data,
          selectedConversation: selectedConversationRef.current,
          isSelected: selectedConversationRef.current === data.attendanceId,
          fullData: JSON.stringify(data),
        });

        // Only show typing indicator if this is the selected conversation
        // Convert both to strings for comparison (in case one is number and other is string)
        const currentConv = selectedConversationRef.current ? String(selectedConversationRef.current) : null;
        const receivedId = String(data.attendanceId);
        
        console.log('🔵 Client typing event received', {
          currentConv,
          receivedId,
          areEqual: currentConv === receivedId,
          isTyping: data.isTyping,
          currentType: typeof selectedConversationRef.current,
          receivedType: typeof data.attendanceId,
        });

        if (currentConv && currentConv === receivedId) {
          console.log('✅ MATCH! Updating typing state for selected conversation', {
            attendanceId: data.attendanceId,
            isTyping: data.isTyping,
            currentState: isClientTyping[data.attendanceId],
          });

          setIsClientTyping((prev) => {
            const updated = { ...prev, [data.attendanceId]: data.isTyping };
            console.log('📝 State updated!', {
              before: prev,
              after: updated,
              key: data.attendanceId,
              newValue: updated[data.attendanceId],
            });
            return updated;
          });

          // Clear existing timeout
          if (clientTypingTimeoutRef.current[data.attendanceId]) {
            clearTimeout(clientTypingTimeoutRef.current[data.attendanceId]);
          }

          // If client stopped typing, set timeout to hide indicator after a delay
          // (in case typing indicator doesn't come through)
          if (!data.isTyping) {
            clientTypingTimeoutRef.current[data.attendanceId] = setTimeout(() => {
              console.log('⏱️ Hiding typing indicator after timeout');
              setIsClientTyping((prev) => {
                const updated = { ...prev };
                delete updated[data.attendanceId];
                return updated;
              });
            }, 2000); // Hide after 2 seconds of no typing
          }
        } else {
          console.log('⚠️ Ignoring typing update - not selected conversation', {
            receivedAttendanceId: data.attendanceId,
            selectedConversation: selectedConversationRef.current,
          });
        }
      };

      socketService.on('new_unassigned_message', handleNewUnassignedMessage);
      socketService.on('message_received', handleMessageReceived);
      socketService.on('message_sent', handleMessageSent);
      socketService.on('attendance:routed', handleAttendanceRouted);
      socketService.on('client:typing', handleClientTyping);

      const handleMovedToIntervention = async (data: {
        attendanceId?: string;
        interventionType?: string;
        interventionData?: Record<string, unknown>;
        aiDisabledUntil?: string;
      }) => {
        try {
          if (!data || !data.attendanceId) return;
          const type = data.interventionType;
          const isDemandaTelefoneFixo = type === 'demanda-telefone-fixo';
          const isProteseCapilar = type === 'protese-capilar';
          const isOutrosAssuntos = type === 'outros-assuntos';
          const isEncaminhadosEcommerce = type === 'encaminhados-ecommerce';
          const isEncaminhadosBalcao = type === 'encaminhados-balcao';
          const isCasosGerentes = type === 'casos_gerentes';
          if (!isDemandaTelefoneFixo && !isProteseCapilar && !isOutrosAssuntos && !isEncaminhadosEcommerce && !isEncaminhadosBalcao && !isCasosGerentes) return;

          const aid = String(data.attendanceId);
          const isViewing = String(selectedConversationRef.current) === aid;

          const removeFromUnassigned = () => {
            setConversations((prev) => prev.filter((c) => String(c.id) !== aid));
            setUnassignedConversationsCache((prev) => prev.filter((c) => String(c.id) !== aid));
          };

          const updateCardData = () => {
            setSelectedConversationData((prev) => {
              if (!prev || String(prev.id) !== aid) return prev;
              return {
                ...prev,
                interventionType: type ?? prev.interventionType,
                interventionData: (data.interventionData && Object.keys(data.interventionData).length > 0)
                  ? data.interventionData
                  : (prev.interventionData ?? {}),
                ...(isOutrosAssuntos
                  ? {
                      aiContext: {
                        ...(prev.aiContext ?? {}),
                        ai_subdivision: undefined,
                      },
                    }
                  : {}),
              };
            });
          };

          if (isCasosGerentes) {
            startTransition(() => {
              setConversations((prev) =>
                prev.map((c) =>
                  String(c.id) === aid
                    ? {
                        ...c,
                        interventionType: type,
                        interventionData: data.interventionData ?? (c as any).interventionData,
                        attributionSource:
                          (c as any).attributionSource != null
                            ? { ...(c as any).attributionSource, interventionType: type, label: 'Casos gerentes' }
                            : { type: 'intervention' as const, label: 'Casos gerentes', interventionType: type },
                      }
                    : c
                )
              );
              updateCardData();
            });
            return;
          }

          if (isDemandaTelefoneFixo || isProteseCapilar || isOutrosAssuntos) {
            const relKey = `relocation-${aid}-${type}`;
            if (processedRelocationsRef.current.has(relKey) && !isViewing) return;
            if (isViewing) {
              startTransition(() => {
                if (selectedAttendanceFilterRef.current === 'nao-atribuidos') removeFromUnassigned();
                setSelectedAttendanceFilter('tudo');
                setSelectedServiceCategory(null);
                setViewingIntervencaoHumana(true);
                setCustomerSidebarOpen(true);
                updateCardData();
              });
              fetchAllInterventionConversations();
              scheduleStatsRealtimeRefresh();
              void attendanceService.getAIStatus(aid).then((s) => {
                setAiStatus((prev) => ({ ...prev, [aid]: { disabled: s.aiDisabled } }));
              }).catch(() => {});
              return;
            }
            if (!isViewing) {
              incrementSubdivision(type, 1, aid);
              incrementRed('intervencao-humana', type, aid);
            }
            processedRelocationsRef.current.add(relKey);
            startTransition(() => {
              if (selectedAttendanceFilterRef.current === 'nao-atribuidos') removeFromUnassigned();
              if (viewingIntervencaoHumanaRef.current) {
                fetchAllInterventionConversations();
              }
            });
            if (processedRelocationsRef.current.size > 100) {
              const arr = Array.from(processedRelocationsRef.current);
              processedRelocationsRef.current = new Set(arr.slice(-50));
            }
            try {
              await attendanceService.relocationSeen(aid, false, type);
            } catch (e) {
              console.error('relocation-seen error', e);
              processedRelocationsRef.current.delete(relKey);
            }
            scheduleStatsRealtimeRefresh();
            void attendanceService.getAIStatus(aid).then((s) => {
              setAiStatus((prev) => ({ ...prev, [aid]: { disabled: s.aiDisabled } }));
            }).catch(() => {});
            return;
          }

          if (isEncaminhadosEcommerce || isEncaminhadosBalcao) {
            const subFilter = isEncaminhadosEcommerce ? 'encaminhados-ecommerce' : 'encaminhados-balcao';
            const dedupeKey = `relocation-${aid}-${type}`;
            if (processedRelocationsRef.current.has(dedupeKey)) return;
            processedRelocationsRef.current.add(dedupeKey);
            setTimeout(() => processedRelocationsRef.current.delete(dedupeKey), 2500);

            if (!isViewing) {
              incrementSubdivision(subFilter, 1, aid);
              incrementRed('nao-atribuidos', subFilter, aid);
            }

            if (isViewing) {
              startTransition(() => {
                if (selectedAttendanceFilterRef.current === 'nao-atribuidos') removeFromUnassigned();
                setSelectedAttendanceFilter('nao-atribuidos');
                setSelectedNaoAtribuidosFilter(subFilter);
                updateCardData();
              });
              fetchUnassignedConversations(subFilter);
            } else {
              startTransition(() => {
                if (selectedAttendanceFilterRef.current === 'nao-atribuidos') removeFromUnassigned();
                if (selectedNaoAtribuidosFilterRef.current === subFilter) fetchUnassignedConversations(subFilter);
              });
            }
          }
          fetchSubdivisionCounts();
          scheduleStatsRealtimeRefresh();
        } catch (err) {
          console.error('handleMovedToIntervention error', err);
        }
      };

      socketService.on('attendance:moved-to-intervention', handleMovedToIntervention);

      const handleAiSubdivisionUpdated = (data: {
        attendanceId?: string;
        unassignedSource?: string;
        aiContext?: {
          ai_subdivision?: string;
          interesseConversationSummary?: string;
          interesseClientQuestions?: string | string[];
        };
      }) => {
        try {
          if (!data?.attendanceId) return;
          const aid = String(data.attendanceId);
          setSelectedConversationData((prev) => {
            if (!prev || String(prev.id) !== aid) return prev;
            return {
              ...prev,
              ...(data.unassignedSource
                ? { unassignedSource: data.unassignedSource as Conversation['unassignedSource'] }
                : {}),
              aiContext: {
                ...(prev.aiContext ?? {}),
                ...(data.aiContext ?? {}),
              },
            };
          });
          const patch = {
            ...(data.unassignedSource ? { unassignedSource: data.unassignedSource as Conversation['unassignedSource'] } : {}),
            ...(data.aiContext ? { aiContext: data.aiContext } : {}),
          };
          setConversations((prev) =>
            prev.map((c) => (String(c.id) === aid ? { ...c, ...patch } : c))
          );
          setUnassignedConversationsCache((prev) =>
            prev.map((c) => (String(c.id) === aid ? { ...c, ...patch } : c))
          );
        } catch (e) {
          console.error('handleAiSubdivisionUpdated error', e);
        }
      };
      socketService.on('attendance:ai-subdivision-updated', handleAiSubdivisionUpdated);

      // Listen for attendance control events
      const handleAttendanceAssumed = (data: { attendanceId: string; handledBy: 'HUMAN'; assumedBy: string; assumedAt: string }) => {
        console.log('Attendance assumed via Socket.IO', data);
        
        // Stop AI typing indicator when human assumes attendance
        setIsAITyping((prev) => ({ ...prev, [data.attendanceId]: false }));
        if (typingTimeoutRef.current[data.attendanceId]) {
          clearTimeout(typingTimeoutRef.current[data.attendanceId]);
        }
        
        // Update conversation state
        setConversations((prev) =>
          prev.map((conv) =>
            conv.id === data.attendanceId
              ? { ...conv, handledBy: 'HUMAN' }
              : conv
          )
        );
        
        // Update selected conversation data if it's the current one
        if (selectedConversationRef.current === data.attendanceId && selectedConversationData?.id === data.attendanceId) {
          setSelectedConversationData((prev) =>
            prev ? { ...prev, handledBy: 'HUMAN' } : prev
          );
        }
        fetchSubdivisionCounts();
        scheduleStatsRealtimeRefresh();
      };

      const handleAttendanceReturnedToAI = (data: { attendanceId: string; handledBy: 'AI'; returnedBy: string; returnedAt: string }) => {
        console.log('Attendance returned to AI via Socket.IO', data);
        
        // Update conversation state
        setConversations((prev) =>
          prev.map((conv) =>
            conv.id === data.attendanceId
              ? { ...conv, handledBy: 'AI' }
              : conv
          )
        );
        
        // Update selected conversation data if it's the current one
        if (selectedConversationRef.current === data.attendanceId && selectedConversationData?.id === data.attendanceId) {
          setSelectedConversationData((prev) =>
            prev ? { ...prev, handledBy: 'AI' } : prev
          );
        }
        fetchSubdivisionCounts();
        scheduleStatsRealtimeRefresh();
      };

      // Handler para quando atendimento é movido para Fechados
      const handleMovedToFechados = (data: { attendanceId: string; reason: string; closedAt: string; interventionType?: string }) => {
        console.log('Attendance moved to Fechados via Socket.IO', data);

        // Encontrar o atendimento antes de remover para obter informações
        const attendanceToRemove = conversations.find((conv) => conv.id === data.attendanceId);
        const interventionType = data.interventionType || attendanceToRemove?.interventionType;

        // Remover da lista atual de conversas (qualquer que seja a visualização atual)
        setConversations((prev) => {
          const filtered = prev.filter((conv) => conv.id !== data.attendanceId);
          if (filtered.length !== prev.length) {
            console.log(`Removed attendance ${data.attendanceId} from conversations list (moved to Fechados)`);
            if (selectedAttendanceFilterRef.current === 'abertos' && attendanceToRemove) {
              const prevUnread = (attendanceToRemove as { unread?: number }).unread ?? 0;
              setTotalUnreadAbertos((u) => Math.max(0, u - prevUnread));
            }
          }
          return filtered;
        });

        // Remover do cache de não atribuídos
        setUnassignedConversationsCache((prev) => {
          const filtered = prev.filter((conv) => conv.id !== data.attendanceId);
          if (filtered.length !== prev.length) {
            console.log(`Removed attendance ${data.attendanceId} from unassigned cache`);
          }
          return filtered;
        });

        // Decrementar contadores manualmente para atualização instantânea
        if (interventionType === 'encaminhados-ecommerce') {
          setActiveCountBySubdivision((prev) => {
            const current = prev['encaminhados-ecommerce'] || 0;
            if (current > 0) {
              return { ...prev, 'encaminhados-ecommerce': current - 1 };
            }
            return prev;
          });
          // Remover badge vermelho se existir
          setRedBySubdivision((prev) => {
            const current = prev['encaminhados-ecommerce'] || 0;
            if (current > 0) {
              return { ...prev, 'encaminhados-ecommerce': Math.max(0, current - 1) };
            }
            return prev;
          });
        } else if (interventionType === 'encaminhados-balcao') {
          setActiveCountBySubdivision((prev) => {
            const current = prev['encaminhados-balcao'] || 0;
            if (current > 0) {
              return { ...prev, 'encaminhados-balcao': current - 1 };
            }
            return prev;
          });
          setRedBySubdivision((prev) => {
            const current = prev['encaminhados-balcao'] || 0;
            if (current > 0) {
              return { ...prev, 'encaminhados-balcao': Math.max(0, current - 1) };
            }
            return prev;
          });
        }

        // Se estava selecionado, desselecionar
        if (selectedConversationRef.current === data.attendanceId) {
          setSelectedConversation(null);
          setMessages([]);
          setSelectedConversationData(null);
        }

        // Atualizar contagens (busca do servidor para garantir sincronização)
        fetchSubdivisionCounts();
        scheduleStatsRealtimeRefresh();

        // Se a visualização atual for Fechados, recarregar
        if (selectedFechadosFilter) {
          fetchFechadosConversations();
        }
      };

      // Handler para quando atendimento é reaberto (sai de Fechados): atualizar listas no supervisor
      const handleReopenedOrRemovedFromFechados = () => {
        fetchSubdivisionCounts();
        scheduleStatsRealtimeRefresh();
        fetchFechadosConversations();
        const cat = selectedServiceCategoryRef.current;
        const sellers = supervisorSellersRef.current;
        const filterIds = cat
          ? new Set(sellers.filter((s) => s.brands?.some((b) => CATEGORY_TO_BRANDS[cat]?.includes(String(b).toUpperCase() as VehicleBrand))).map((s) => s.id))
          : undefined;
        fetchAttributedConversations(filterIds?.size ? filterIds : undefined);
      };
      socketService.on('attendance:reopened', handleReopenedOrRemovedFromFechados);
      socketService.on('attendance:removed-from-fechados', handleReopenedOrRemovedFromFechados);

      // Handler para quando atendimento é removido (ex: merge)
      const handleAttendanceRemoved = (data: { attendanceId: string; reason: string; mergedInto?: string }) => {
        console.log('Attendance removed via Socket.IO', data);

        // Remover da lista atual de conversas
        setConversations((prev) => {
          const filtered = prev.filter((conv) => conv.id !== data.attendanceId);
          if (filtered.length !== prev.length) {
            console.log(`Removed attendance ${data.attendanceId} from conversations list`);
          }
          return filtered;
        });

        // Remover do cache de não atribuídos
        setUnassignedConversationsCache((prev) => prev.filter((conv) => conv.id !== data.attendanceId));

        // Se estava selecionado, desselecionar
        if (selectedConversationRef.current === data.attendanceId) {
          setSelectedConversation(null);
          setMessages([]);
          setSelectedConversationData(null);
        }

        // Atualizar contagens
        fetchSubdivisionCounts();
        scheduleStatsRealtimeRefresh();
      };

      socketService.on('attendance_assumed', handleAttendanceAssumed);
      socketService.on('attendance_returned_to_ai', handleAttendanceReturnedToAI);
      socketService.on('attendance:moved-to-fechados', handleMovedToFechados);
      socketService.on('attendance:removed', handleAttendanceRemoved);

      // Handler para quando um pedido de orçamento é criado
      const handleQuoteCreated = async (data: {
        quoteId: string;
        attendanceId: string;
        sellerId: string | null;
        sellerSubdivision: string;
        clientPhone: string;
        clientName?: string;
        status: string;
      }) => {
        try {
          const [pendentes, enviados] = await Promise.all([
            quoteService.list('pedidos-orcamentos').catch(() => []),
            quoteService.list('pedidos-orcamentos-enviados').catch(() => []),
          ]);
          setQuoteCards(pendentes);
          setSentQuoteCards(enviados);
        } catch (e) {
          console.warn('Erro ao recarregar pedidos de orçamento (badge)', e);
        }
        if (selectedTodasDemandasSubdivision !== null) {
          try {
            const allSubdivisions = ['pedidos-orcamentos', 'perguntas-pos-orcamento', 'confirmacao-pix', 'tirar-pedido', 'informacoes-entrega', 'encomendas', 'cliente-pediu-humano'];
            const allQuotes: Array<QuoteRequest & { sellerSubdivision?: string }> = [];
            for (const subdivision of allSubdivisions) {
              try {
                const quotes = await quoteService.list(subdivision);
                const quotesWithSubdivision = quotes.map(q => ({ ...q, sellerSubdivision: subdivision }));
                allQuotes.push(...quotesWithSubdivision);
              } catch (e) {
                console.warn(`Erro ao carregar pendências da subdivisão ${subdivision}:`, e);
              }
            }
            allQuotes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            setPendingQuotes(allQuotes);
          } catch (error) {
            console.error('Erro ao recarregar pedidos após criação:', error);
          }
        }
        fetchSubdivisionCounts();
      };

      const handleQuoteUpdated = async () => {
        try {
          const [pendentes, enviados] = await Promise.all([
            quoteService.list('pedidos-orcamentos').catch(() => []),
            quoteService.list('pedidos-orcamentos-enviados').catch(() => []),
          ]);
          setQuoteCards(pendentes);
          setSentQuoteCards(enviados);
        } catch (e) {
          console.warn('Erro ao recarregar pedidos de orçamento (badge)', e);
        }
        if (selectedTodasDemandasSubdivision !== null) {
          try {
            const allSubdivisions = ['pedidos-orcamentos', 'perguntas-pos-orcamento', 'confirmacao-pix', 'tirar-pedido', 'informacoes-entrega', 'encomendas', 'cliente-pediu-humano'];
            const allQuotes: Array<QuoteRequest & { sellerSubdivision?: string }> = [];
            for (const subdivision of allSubdivisions) {
              try {
                const quotes = await quoteService.list(subdivision);
                const quotesWithSubdivision = quotes.map(q => ({ ...q, sellerSubdivision: subdivision }));
                allQuotes.push(...quotesWithSubdivision);
              } catch (e) {
                console.warn(`Erro ao carregar pendências da subdivisão ${subdivision}:`, e);
              }
            }
            allQuotes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            setPendingQuotes(allQuotes);
          } catch (error) {
            console.error('Erro ao recarregar pedidos após atualização:', error);
          }
        }
        fetchSubdivisionCounts();
      };

      socketService.on('quote:created', handleQuoteCreated);
      socketService.on('quote:updated', handleQuoteUpdated);

      // Atualização em tempo real da disponibilidade dos vendedores
      const handleSellerAvailabilityUpdated = (data: { sellerId: string; isUnavailable: boolean; unavailableUntil: string | null }) => {
        setSupervisorSellers((prev) =>
          prev.map((s) =>
            s.id === data.sellerId ? { ...s, isUnavailable: data.isUnavailable, unavailableUntil: data.unavailableUntil } : s
          )
        );
      };
      socketService.on('seller:availability_updated', handleSellerAvailabilityUpdated);

      // Quando vendedor marca como lido: atualizar painel Atribuídos em tempo real
      const handleMarkedReadBySeller = (data: { attendanceId: string; sellerId: string; sellerSubdivision?: string }) => {
        const aid = String(data.attendanceId);
        markedAsReadIdsRef.current.add(aid);
        setConversations((prev) =>
          prev.map((c) => (String(c.id) === aid ? { ...c, unread: 0 } : c))
        );
        const subdiv = data.sellerSubdivision ?? 'pedidos-orcamentos';
        decrementSubdivisionForConversation(`seller-${data.sellerId}-${subdiv}`, aid);
        decrementRedForConversation(aid);
      };
      socketService.on('attendance:marked-read-by-seller', handleMarkedReadBySeller);

      const handleSubdivisionCountsChanged = () => {
        fetchSubdivisionCounts({ bust: true });
        // Sincroniza também a lista visível para evitar divergência
        // (contador muda e card permanece na coluna antiga).
        // Priorizar follow-up quando em visualização de follow-up (ref para valor atual)
        const followUpNode = selectedFollowUpNodeRef.current;
        if (followUpNode) {
          fetchFollowUpConversations(followUpNode).catch((e) =>
            console.error('Error refreshing follow-up after subdivision_counts_changed', e)
          );
        } else if (selectedAttendanceFilterRef.current === 'abertos') {
          fetchAbertosConversations().catch((e) =>
            console.error('Error refreshing abertos after subdivision_counts_changed', e)
          );
        } else if (selectedAttendanceFilterRef.current === 'nao-atribuidos') {
          fetchUnassignedConversations(selectedNaoAtribuidosFilterRef.current).catch((e) =>
            console.error('Error refreshing nao-atribuidos after subdivision_counts_changed', e)
          );
        }
      };
      socketService.on('subdivision_counts_changed', handleSubdivisionCountsChanged);

      // Cleanup on unmount
      return () => {
        console.log('🧹 Cleaning up socket listeners');
        socketService.off('subdivision_counts_changed', handleSubdivisionCountsChanged);
        socketService.off('attendance:marked-read-by-seller', handleMarkedReadBySeller);
        socketService.off('new_unassigned_message', handleNewUnassignedMessage);
        socketService.off('message_received', handleMessageReceived);
        socketService.off('message_sent', handleMessageSent);
        socketService.off('attendance:routed', handleAttendanceRouted);
        socketService.off('client:typing', handleClientTyping);
        socketService.off('attendance:moved-to-intervention', handleMovedToIntervention);
        socketService.off('attendance:ai-subdivision-updated', handleAiSubdivisionUpdated);
        socketService.off('attendance_assumed', handleAttendanceAssumed);
        socketService.off('attendance_returned_to_ai', handleAttendanceReturnedToAI);
        socketService.off('attendance:moved-to-fechados', handleMovedToFechados);
        socketService.off('attendance:reopened', handleReopenedOrRemovedFromFechados);
        socketService.off('attendance:removed-from-fechados', handleReopenedOrRemovedFromFechados);
        socketService.off('attendance:removed', handleAttendanceRemoved);
        socketService.off('quote:created', handleQuoteCreated);
        socketService.off('quote:updated', handleQuoteUpdated);
        socketService.off('seller:availability_updated', handleSellerAvailabilityUpdated);
        
        // Clear all typing timeouts on cleanup
        Object.values(typingTimeoutRef.current).forEach((timeout) => {
          if (timeout) clearTimeout(timeout);
        });
        Object.values(clientTypingTimeoutRef.current).forEach((timeout) => {
          if (timeout) clearTimeout(timeout);
        });
        
        console.log('✅ Socket listeners cleaned up');
      };
    }

    // Cleanup: disconnect when component unmounts
    return () => {
      // Don't disconnect here as other components might be using Socket.IO
      // socketService.disconnect();
    };
    // Removed selectedConversation and selectedAttendanceFilter from dependencies
    // to prevent re-registering listeners on every conversation change
    // Using refs instead to access current values
  }, [user?.id, user?.role, fetchSubdivisionCounts]);

  // Função para formatar conversas para exibição
  // Helper function to format lastMessage for display
  const formatLastMessage = (content: string, mediaType?: string): string => {
    if (content === '[Processando imagem...]') return 'Imagem';
    if (content === '[Processando áudio...]') return 'Áudio';
    if (content === '[Mídia]' || content === '[Enviando mídia...]') {
      if (mediaType === 'audio') return 'Áudio';
      if (mediaType === 'image') return 'Imagem';
      if (mediaType === 'video') return 'Vídeo';
      if (mediaType === 'document') return 'Documento';
      return 'Mídia';
    }
    return content;
  };

  const formatConversationsForDisplay = (convs: Conversation[]) => {
    return convs.map((conv) => {
      // Formatar data da última mensagem
      const lastMessageDate = new Date(conv.lastMessageTime);
      const now = new Date();
      const diffMs = now.getTime() - lastMessageDate.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let timeStr = '';
      if (diffMins < 60) {
        timeStr = `${diffMins}min`;
      } else if (diffHours < 24) {
        timeStr = `${diffHours}h`;
      } else {
        timeStr = `${diffDays}d`;
      }

      // Determinar status da conversa
      const status = conv.unread > 0 ? 'unread' : 'sent';

      // Gerar avatar do cliente
      const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(conv.clientName)}&background=F07000&color=fff`;

      return {
        id: conv.id,
        name: conv.clientName || conv.clientPhone,
        clientName: conv.clientName,
        clientPhone: conv.clientPhone,
        lastMessage: formatLastMessage(conv.lastMessage || 'Sem mensagens', (conv as any).lastMessageMediaType),
        time: timeStr,
        unread: conv.unread,
        status,
        avatar,
        lastMessageMediaType: (conv as any).lastMessageMediaType,
        attributionSource: (conv as any).attributionSource,
        unassignedSource: (conv as any).unassignedSource,
        sellerId: (conv as any).sellerId,
        sellerSubdivision: (conv as any).sellerSubdivision,
        interventionType: (conv as any).interventionType,
        vehicleBrand: (conv as any).vehicleBrand,
        followUpPhase: (conv as any).followUpPhase,
        state: (conv as any).state,
        handledBy: (conv as any).handledBy,
        lastMessageTime: (conv as any).lastMessageTime,
        createdAt: (conv as any).createdAt,
      };
    });
  };

  // Get avatar for the selected conversation
  const getSelectedConversationAvatar = (): string => {
    if (!selectedConversation) return '';
    
    const found = formatConversationsForDisplay(conversations).find(c => c.id === selectedConversation);
    return found?.avatar || '';
  };

  // Get name for the selected conversation
  const getSelectedConversationName = (): string => {
    if (!selectedConversation) return '';
    
    const found = formatConversationsForDisplay(conversations).find(c => c.id === selectedConversation);
    return found?.name || '';
  };

  const selectedConvAvatar = getSelectedConversationAvatar();
  const selectedConvName = getSelectedConversationName();

  // Function to check if user is at the bottom of the chat
  const isAtBottom = (): boolean => {
    if (!messagesContainerRef.current) return false;
    const container = messagesContainerRef.current;
    const threshold = 100; // 100px threshold to consider "at bottom"
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  };

  // Function to scroll to bottom smoothly
  const scrollToBottom = (): void => {
    if (messagesContainerRef.current) {
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTo({
            top: messagesContainerRef.current.scrollHeight,
            behavior: 'smooth',
          });
        }
      });
    }
  };

  // Function to scroll to bottom instantly (for initial load)
  const scrollToBottomInstant = (): void => {
    if (messagesContainerRef.current) {
      const container = messagesContainerRef.current;
      // Use both requestAnimationFrame and direct assignment for reliability
      requestAnimationFrame(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
      });
      // Also set directly as fallback
      container.scrollTop = container.scrollHeight;
    }
  };

  // Format phone number for display
  const formatPhoneNumber = (phone: string): string => {
    // Remove @s.whatsapp.net and extract only digits
    const digits = phone.replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    
    // Format based on length (Brazilian format)
    if (digits.length === 11) {
      // (XX) XXXXX-XXXX
      return digits.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    } else if (digits.length === 10) {
      // (XX) XXXX-XXXX
      return digits.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
    }
    
    // Return original if can't format
    return phone.replace('@s.whatsapp.net', '');
  };

  // Format timer (seconds to MM:SS)
  const formatTimer = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Fetch inactivity timer from backend for a conversation (valor inicial)
  const fetchInactivityTimer = async (conversationId: string) => {
    try {
      const timerData = await attendanceService.getInactivityTimer(conversationId);
      setInactivityTimer((prev) => ({ 
        ...prev, 
        [conversationId]: timerData.remainingSeconds 
      }));
    } catch (error) {
      console.error('Error fetching inactivity timer:', error);
      // If error, set to 0 to hide timer
      setInactivityTimer((prev) => ({ ...prev, [conversationId]: 0 }));
    }
  };

  // Chat ao vivo: fade-in quando mensagens carregam (evita piscar)
  useEffect(() => {
    if (messages.length > 0 && selectedConversation) {
      setChatMessagesFadeIn(true);
    }
  }, [messages.length, selectedConversation]);

  // Clear typing indicator when conversation changes
  useEffect(() => {
    // Clear typing state for all conversations when switching
    setIsAITyping({});
    
    // Clear all typing timeouts
    Object.values(typingTimeoutRef.current).forEach((timeout) => {
      if (timeout) clearTimeout(timeout);
    });
    typingTimeoutRef.current = {};
  }, [selectedConversation]);

  // Rebuscar timer imediatamente ao selecionar conversa (evita mostrar 0 ao voltar)
  useEffect(() => {
    if (selectedConversation) {
      const conv = conversations.find(c => c.id === selectedConversation);
      if (conv?.handledBy === 'HUMAN') {
        fetchInactivityTimer(selectedConversation as string);
      }
    }
  }, [selectedConversation]);

  // Manage inactivity timer for assumed attendances - usa backend só para valor inicial e faz contagem local
  useEffect(() => {
    // Find all conversations handled by HUMAN
    const humanHandledConversations = conversations.filter(conv => conv.handledBy === 'HUMAN');
    
    // Start/update timers for human-handled conversations
    humanHandledConversations.forEach(conv => {
      // If timer interval doesn't exist for this conversation, initialize it
      if (!inactivityTimerIntervalRef.current[conv.id]) {
        // Fetch immediately o valor inicial
        fetchInactivityTimer(conv.id);
        // Depois, faz apenas contagem regressiva local a cada segundo
        inactivityTimerIntervalRef.current[conv.id] = setInterval(() => {
          setInactivityTimer((prev) => {
            const current = prev[conv.id] ?? 0;
            if (current <= 0) {
              return prev;
            }
            return {
              ...prev,
              [conv.id]: current - 1,
            };
          });
        }, 1000);
      }
    });
    
    // Clean up timers for conversations no longer handled by HUMAN
    Object.keys(inactivityTimerIntervalRef.current).forEach(convId => {
      const conv = conversations.find(c => c.id === convId);
      if (!conv || conv.handledBy !== 'HUMAN') {
        // Clear timer interval
        if (inactivityTimerIntervalRef.current[convId]) {
          clearInterval(inactivityTimerIntervalRef.current[convId]);
          delete inactivityTimerIntervalRef.current[convId];
        }
        // Remove from state
        setInactivityTimer((prev) => {
          const updated = { ...prev };
          delete updated[convId];
          return updated;
        });
      }
    });
    
    // Cleanup on unmount
    return () => {
      Object.values(inactivityTimerIntervalRef.current).forEach((interval) => {
        if (interval) clearInterval(interval);
      });
      inactivityTimerIntervalRef.current = {};
    };
  }, [conversations]);

  // Note: Inactivity check is handled by backend job (runs every 15 minutes)
  // Frontend will receive Socket.IO event when attendance is automatically returned

  // Load messages and conversation data when a conversation is selected
  useEffect(() => {
    // CORREÇÃO CRÍTICA: Limpar mensagens imediatamente quando o atendimento muda
    // Isso evita que mensagens do atendimento anterior sejam exibidas enquanto carrega o novo
    if (selectedConversation) {
      // Limpar mensagens apenas se mudou de atendimento
      const prevConvId = lastFetchedConversationRef.current;
      if (prevConvId && prevConvId !== selectedConversation) {
        console.log('🔄 Attendance changed, clearing messages immediately:', {
          from: prevConvId,
          to: selectedConversation,
        });
        setMessages([]);
        setIsLoadingMessages(true); // Evita piscar "Nenhuma mensagem" antes do spinner (loadMessages tem delay de 50ms)
        setChatMessagesFadeIn(false);
        processedMessageReceivedRef.current.clear();
      }
    }
    
    const getMessageTimestamp = (msg: Message): number => {
      if (msg.metadata?.sentAt) {
        const t = new Date(msg.metadata.sentAt).getTime();
        if (!isNaN(t)) return t;
      }
      const ts = msg.sentAt || (msg.metadata as any)?.createdAt;
      if (ts) {
        const t = new Date(ts).getTime();
        if (!isNaN(t)) return t;
      }
      return 0;
    };

    const loadMessages = async () => {
      if (!selectedConversation) {
        setMessages([]);
        setSelectedConversationData(null);
        lastFetchedConversationRef.current = null;
        processedMessageReceivedRef.current.clear();
        isLoadingMessagesRef.current = false;
        return;
      }

      // Proteção: evitar múltiplas chamadas simultâneas
      if (isLoadingMessagesRef.current) {
        console.log('⚠️ loadMessages já está em execução, ignorando chamada duplicada');
        return;
      }

      const convId = selectedConversation as string;
      const isRefetch = lastFetchedConversationRef.current === convId;

      if (!isRefetch) setSidebarDetailsReady(false);
      isLoadingMessagesRef.current = true;
      setIsLoadingMessages(true);
      if (!isRefetch) {
        setMessagesOffset(0);
        processedMessageReceivedRef.current.clear();
        // CORREÇÃO: Limpar mensagens ao trocar de atendimento para evitar mistura
        setMessages([]);
      }
      try {
        const response = await attendanceService.getAttendanceMessages(convId, 15, 0);
        const visibleMessages = response.messages.filter((m: Message) => !isLegacyRelocationSystemMessage(m as any));
        const sortedFromApi = [...visibleMessages].sort((a: Message, b: Message) => {
          const timeA = getMessageTimestamp(a);
          const timeB = getMessageTimestamp(b);
          if (timeA !== timeB) return timeA - timeB;
          const originOrder = (o: string) => (o === 'CLIENT' ? 0 : o === 'AI' ? 1 : 2);
          return (originOrder(a.origin || '') - originOrder(b.origin || '')) || (String(a.id).localeCompare(String(b.id)));
        });

        sortedFromApi.forEach((m) => processedMessageReceivedRef.current.add(m.id));
        if (processedMessageReceivedRef.current.size > 200) {
          const arr = Array.from(processedMessageReceivedRef.current);
          processedMessageReceivedRef.current = new Set(arr.slice(-100));
        }

        // CORREÇÃO: Sempre fazer merge, mesmo quando não é refetch
        // Isso garante que mensagens recebidas via Socket.IO antes da seleção sejam incluídas
        setMessages((prev) => {
          // CORREÇÃO CRÍTICA: Verificar se o atendimento mudou durante o carregamento
          // Se mudou, limpar tudo e usar apenas mensagens da API
          if (lastFetchedConversationRef.current !== convId && lastFetchedConversationRef.current !== null) {
            console.warn('⚠️ Attendance changed during load, clearing local messages');
            return sortedFromApi;
          }
          
          const apiIds = new Set(sortedFromApi.map((m) => m.id));
          // CORREÇÃO: Se a API retornou vazio, limpar tudo (pode ser troca de atendimento)
          // Caso contrário, manter apenas mensagens locais que não estão na API
          // Isso inclui mensagens do cliente que chegaram via Socket.IO antes da seleção
          const onlyLocal = sortedFromApi.length === 0 
            ? [] 
            : prev.filter((m) => {
                // Manter apenas mensagens que não estão na API e que pertencem a este atendimento
                // Verificar se a mensagem pertence a este atendimento comparando IDs ou conteúdo
                return !apiIds.has(m.id);
              });
          const merged = [...sortedFromApi, ...onlyLocal].sort((a, b) => {
            const timeA = getMessageTimestamp(a);
            const timeB = getMessageTimestamp(b);
            if (timeA !== timeB) return timeA - timeB;
            const originOrder = (o: string) => (o === 'CLIENT' ? 0 : o === 'AI' ? 1 : 2);
            return (originOrder(a.origin || '') - originOrder(b.origin || '')) || (String(a.id).localeCompare(String(b.id)));
          });
          return merged;
        });

        lastFetchedConversationRef.current = convId;
        setHasMoreMessages(response.pagination?.hasMore || false);
        setMessagesOffset(15);
        
        // Merge API data (evita reorganização: não substitui, só enriquece campos que vêm do attendance)
        const conv = conversations.find(c => c.id === selectedConversation);
        if (conv && response.attendance) {
          setSelectedConversationData((prev) => {
            const base = prev ?? conv;
            return {
              ...base,
              ...(response.attendance!.clientPhone != null && { clientPhone: response.attendance!.clientPhone }),
              ...(response.attendance!.clientName != null && { clientName: response.attendance!.clientName }),
              ...(response.attendance!.interventionData != null && { interventionData: response.attendance!.interventionData }),
              ...(response.attendance!.interventionType != null && { interventionType: response.attendance!.interventionType }),
              ...(response.attendance!.aiContext != null && { aiContext: response.attendance!.aiContext }),
              ...(response.attendance!.state != null && { state: response.attendance!.state }),
              ...(response.attendance!.handledBy != null && { handledBy: response.attendance!.handledBy }),
              ...(response.attendance!.lastMessageTime != null && { lastMessageTime: response.attendance!.lastMessageTime }),
              ...(response.attendance!.createdAt != null && { createdAt: response.attendance!.createdAt }),
            };
          });
          setSidebarDetailsReady(true);
        }

        if (response.attendance?.interventionType) {
          markRelocationAsReadByAttendance(selectedConversation as string).catch(() => {});
        }

        // Mark messages as read when conversation is opened (supervisor NÃO pode marcar como lido atendimento atribuído a vendedor)
        const convIdForMarkRead = selectedConversation as string;
        const isAttributedToSeller = (conv as any)?.sellerId || (conv as any)?.attributionSource?.sellerId;
        if (!isAttributedToSeller && !markAsReadInProgressRef.current.has(convIdForMarkRead)) {
          markAsReadInProgressRef.current.add(convIdForMarkRead);
          const prevUnread = conv ? ((conv as { unread?: number }).unread ?? 0) : 0;
          try {
            await attendanceService.markAsRead(convIdForMarkRead);
            markedAsReadIdsRef.current.add(convIdForMarkRead);
            
            // Update local state to reflect read status
            if (conv && conv.unread > 0) {
              setConversations((prev) => {
                const updated = prev.map((c) =>
                  c.id === selectedConversation ? { ...c, unread: 0 } : c
                );
                if (selectedAttendanceFilter === 'nao-atribuidos') {
                  setUnassignedConversationsCache((prevCache) =>
                    prevCache.map((c) => (c.id === selectedConversation ? { ...c, unread: 0 } : c))
                  );
                }
                return updated;
              });
            }
            // Decrementar badge de Abertos ao marcar como lido (qualquer subdivisão: AI, Intervenção, Atribuídos, etc.)
            if (prevUnread > 0) {
              setTotalUnreadAbertos((u) => Math.max(0, u - prevUnread));
            }
          } catch (error: any) {
            console.error('Error marking as read:', error);
          } finally {
            // Remover após um delay para permitir novas chamadas se necessário
            setTimeout(() => {
              markAsReadInProgressRef.current.delete(convIdForMarkRead);
            }, 1000);
          }
        }

        // Decrement badge only when opening a conversation with pending notifications (never when opening subdivision)
        let subdivisionKey: string | null = null;
        if (viewingIntervencaoHumana) {
          const it = (conv as any)?.interventionType || (conv as any)?.attributionSource?.interventionType;
          if (it) subdivisionKey = it;
        } else if (selectedSeller) {
          const subdivision = selectedSellerSubdivision || (conv as any)?.sellerSubdivision || 'pedidos-orcamentos';
          subdivisionKey = `seller-${selectedSeller}-${subdivision}`;
        } else if (selectedAttendanceFilter === 'nao-atribuidos') {
          if (selectedNaoAtribuidosFilter === 'todos' && (conv as any)?.unassignedSource) {
            subdivisionKey = (conv as any).unassignedSource;
          } else if (selectedNaoAtribuidosFilter !== 'todos') {
            subdivisionKey = selectedNaoAtribuidosFilter;
          }
        } else if (selectedAttendanceFilter === 'tudo' && (conv as any)?.attributionSource) {
          const att = (conv as any).attributionSource;
          if (att.interventionType === 'demanda-telefone-fixo') {
            subdivisionKey = 'demanda-telefone-fixo';
          } else if (att.interventionType) {
            subdivisionKey = att.interventionType;
          } else if (att.sellerId) {
            const subdivision = (conv as any)?.sellerSubdivision || 'pedidos-orcamentos';
            subdivisionKey = `seller-${att.sellerId}-${subdivision}`;
          }
        }
        if (subdivisionKey) {
          decrementSubdivisionForConversation(subdivisionKey, convId);
        }
        decrementRedForConversation(convId);

        // Auto-scroll to bottom after messages are loaded and rendered
        // Use instant scroll for initial load, then smooth scroll to ensure it's at bottom
        // Multiple attempts to ensure scroll reaches bottom
        setTimeout(() => {
          scrollToBottomInstant();
        }, 50);
        setTimeout(() => {
          scrollToBottomInstant();
        }, 150);
        setTimeout(() => {
          scrollToBottomInstant();
        }, 250);
        setTimeout(() => {
          scrollToBottom();
        }, 400);
      } catch (error: any) {
        console.error('Error loading messages:', error);
        toast.error('Erro ao carregar mensagens');
        setMessages([]);
        setSelectedConversationData(null);
        setSidebarDetailsReady(false);
      } finally {
        isLoadingMessagesRef.current = false;
        setIsLoadingMessages(false);
        // Ensure scroll happens after loading state is cleared
        setTimeout(() => {
          scrollToBottomInstant();
        }, 200);
      }
    };

    // Proteção: evitar chamar loadMessages se já estiver carregando ou se a conversa não mudou
    // Só recarregar se realmente mudou a conversa ou se for um refresh explícito
    const convId = selectedConversation as string | null;
    const hasConversationChanged = lastFetchedConversationRef.current !== convId;
    const isExplicitRefresh = refreshMessagesTrigger > 0;
    
    // Se não há conversa selecionada, limpar estado imediatamente
    if (!convId) {
      setMessages([]);
      setSelectedConversationData(null);
      setSidebarDetailsReady(false);
      setChatMessagesFadeIn(false);
      lastFetchedConversationRef.current = null;
      processedMessageReceivedRef.current.clear();
      isLoadingMessagesRef.current = false;
      markAsReadInProgressRef.current.clear();
      return;
    }
    
    // Só carregar se realmente mudou a conversa ou se for um refresh explícito
    // E se não estiver já carregando
    if (!isLoadingMessagesRef.current && (hasConversationChanged || isExplicitRefresh)) {
      setIsLoadingMessages(true); // Imediato: evita piscar "Nenhuma mensagem" nos 50ms antes de loadMessages
      // Usar um pequeno delay para evitar múltiplas chamadas rápidas
      const timeoutId = setTimeout(() => {
        // Verificar novamente antes de executar (pode ter mudado durante o timeout)
        const currentConvId = selectedConversation as string | null;
        if (currentConvId && 
            !isLoadingMessagesRef.current && 
            lastFetchedConversationRef.current !== currentConvId) {
          loadMessages();
        }
      }, 50); // 50ms de debounce
      
      return () => {
        clearTimeout(timeoutId);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversation, refreshMessagesTrigger]); // Removido selectedAttendanceFilter para evitar loops

  // Load contact-wide history for the right sidebar
  useEffect(() => {
    const loadContactHistory = async () => {
      if (!selectedConversation || typeof selectedConversation === 'number') {
        setContactHistory([]);
        return;
      }
      try {
        setIsLoadingContactHistory(true);
        const response = await attendanceService.getContactHistory(selectedConversation as string, 250);
        setContactHistory(response.history || []);
      } catch (error) {
        console.error('Error loading contact history:', error);
        setContactHistory([]);
      } finally {
        setIsLoadingContactHistory(false);
      }
    };
    void loadContactHistory();
  }, [selectedConversation, refreshMessagesTrigger]);

  // Refetch messages when user returns to tab (fallback se perder eventos socket)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && selectedConversation) {
        setRefreshMessagesTrigger((t) => t + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [selectedConversation]);

  // Buscar status da IA ao selecionar conversa (para esconder "digitando" quando IA desativada)
  useEffect(() => {
    if (!selectedConversation || typeof selectedConversation === 'number') return;
    const convId = selectedConversation as string;
    attendanceService.getAIStatus(convId).then((data) => {
      setAiStatus((prev) => ({ ...prev, [convId]: { disabled: data.aiDisabled } }));
    }).catch(() => {
      setAiStatus((prev) => ({ ...prev, [convId]: { disabled: false } }));
    });
  }, [selectedConversation]);

  // Function to load more messages
  const loadMoreMessages = async () => {
    if (!selectedConversation || typeof selectedConversation === 'number' || isLoadingMoreMessages || !hasMoreMessages) {
      return;
    }

    const currentAttendanceId = selectedConversation as string;
    setIsLoadingMoreMessages(true);
    try {
      const response = await attendanceService.getAttendanceMessages(
        currentAttendanceId,
        15,
        messagesOffset
      );
      
      // CORREÇÃO: Verificar se ainda estamos no mesmo atendimento antes de adicionar mensagens
      // Prepend older messages to the beginning of the list and sort by timestamp
      setMessages((prev) => {
        // Se o atendimento mudou durante o carregamento, não adicionar mensagens
        if (selectedConversation !== currentAttendanceId) {
          return prev;
        }
        const prevIds = new Set(prev.map((m) => m.id));
        const visibleMessages = response.messages.filter((m: Message) => !isLegacyRelocationSystemMessage(m as any));
        const olderOnly = visibleMessages.filter((m: Message) => !prevIds.has(m.id));
        const allMessages = [...olderOnly, ...prev];
        // Sort by metadata.sentAt (ISO timestamp) - CRITICAL for correct chronological order
        return allMessages.sort((a: Message, b: Message) => {
          const getTimestamp = (msg: Message): number => {
            // Always use metadata.sentAt (ISO string with full date/time)
            if (msg.metadata?.sentAt) {
              const timestamp = new Date(msg.metadata.sentAt).getTime();
              if (isNaN(timestamp)) {
                console.error('Invalid timestamp in metadata.sentAt:', msg.metadata.sentAt, msg.id);
                return 0;
              }
              return timestamp;
            }
            // Fallback to sentAt or createdAt if metadata.sentAt is missing
            const ts = msg.sentAt || (msg.metadata as any)?.createdAt;
            if (ts) {
              const timestamp = new Date(ts).getTime();
              if (!isNaN(timestamp)) {
                return timestamp;
              }
            }
            console.error('Message missing timestamp:', msg.id, msg);
            return 0;
          };
          const timeA = getTimestamp(a);
          const timeB = getTimestamp(b);
          if (timeA !== timeB) return timeA - timeB;
          const originOrder = (o: string) => (o === 'CLIENT' ? 0 : o === 'AI' ? 1 : 2);
          return (originOrder(a.origin || '') - originOrder(b.origin || '')) || (String(a.id).localeCompare(String(b.id)));
        });
      });
      setHasMoreMessages(response.pagination?.hasMore || false);
      setMessagesOffset((prev) => prev + 15);
    } catch (error: any) {
      console.error('Error loading more messages:', error);
      toast.error('Erro ao carregar mais mensagens');
    } finally {
      setIsLoadingMoreMessages(false);
    }
  };

  const handleSendAudioRecording = async (audioBlob: Blob) => {
    try {
      const ext = audioBlob.type.includes('mp4') || audioBlob.type.includes('m4a') ? 'm4a' : 'webm';
      const audioFile = new File([audioBlob], `audio-${Date.now()}.${ext}`, { type: audioBlob.type });
      await handleSendMedia(audioFile);
      setShowAudioRecorder(false);
    } catch (error: any) {
      console.error('Error sending audio recording:', error);
      toast.error('Erro ao enviar áudio');
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    setMessageInput((prev) => prev + emoji);
    setShowEmojiPicker(false);
  };

  const handlePerguntarSubmit = async () => {
    if (!selectedQuoteForPerguntar || !perguntarText.trim()) return;
    try {
      setIsSendingPerguntar(true);
      await quoteService.perguntar(selectedQuoteForPerguntar, perguntarText.trim());
      setSelectedQuoteForPerguntar(null);
      setPerguntarText('');
      toast.success('Pergunta enviada ao cliente');
      const [pendentes, enviados] = await Promise.all([
        quoteService.list('pedidos-orcamentos').catch(() => []),
        quoteService.list('pedidos-orcamentos-enviados').catch(() => []),
      ]);
      setQuoteCards(pendentes);
      setSentQuoteCards(enviados);
      if (selectedQuote?.id === selectedQuoteForPerguntar) {
        const updated = pendentes.find((q) => q.id === selectedQuoteForPerguntar) ?? enviados.find((q) => q.id === selectedQuoteForPerguntar);
        if (updated) setSelectedQuote(updated);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Erro ao enviar pergunta');
    } finally {
      setIsSendingPerguntar(false);
    }
  };

  const handleEnviarOrcamentoSupervisor = async (quote: QuoteRequest) => {
    if (!quoteResponseText.trim() && !quoteResponseImage) {
      toast.error('Digite o conteúdo do orçamento ou selecione uma imagem');
      return;
    }
    try {
      setIsSendingQuote(true);
      let mediaUrl: string | undefined;
      let mimeType: string | undefined;
      if (quoteResponseImage) {
        try {
          const uploadResult = await mediaService.uploadMedia(quoteResponseImage);
          mediaUrl = uploadResult.mediaUrl;
          mimeType = uploadResult.mimeType;
        } catch (uploadError: any) {
          toast.error('Erro ao fazer upload da imagem');
          setIsSendingQuote(false);
          return;
        }
      }
      await quoteService.enviarOrcamento(quote.id, quoteResponseText.trim(), mediaUrl, mimeType);
      toast.success('Orçamento enviado com sucesso!');
      setQuoteResponseText('');
      setQuoteResponseImage(null);
      setSelectedQuote(null);
      const [pendentes, enviados] = await Promise.all([
        quoteService.list('pedidos-orcamentos').catch(() => []),
        quoteService.list('pedidos-orcamentos-enviados').catch(() => []),
      ]);
      setQuoteCards(pendentes);
      setSentQuoteCards(enviados);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Erro ao enviar orçamento');
    } finally {
      setIsSendingQuote(false);
    }
  };

  const handleDeletarOrcamentoSupervisor = async (quoteId: string) => {
    if (!confirm('Tem certeza que deseja deletar este pedido de orçamento?')) return;
    try {
      setIsDeletingQuote(quoteId);
      await quoteService.deletar(quoteId);
      toast.success('Pedido de orçamento deletado');
      const [pendentes, enviados] = await Promise.all([
        quoteService.list('pedidos-orcamentos').catch(() => []),
        quoteService.list('pedidos-orcamentos-enviados').catch(() => []),
      ]);
      setQuoteCards(pendentes);
      setSentQuoteCards(enviados);
      if (selectedQuote?.id === quoteId) setSelectedQuote(null);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Erro ao deletar pedido');
    } finally {
      setIsDeletingQuote(null);
    }
  };

  const handleSendMedia = async (file: File) => {
    if (!selectedConversation) return;

    const tempId = `temp-${Date.now()}`;
    
    // Otimistic update: adicionar mensagem imediatamente ao estado
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    
    // CRITICAL: Store ISO timestamp for sorting
    const isoTimestamp = now.toISOString();

    const optimisticMessage: Message = {
      id: tempId,
      sender: user?.name || 'Você',
      content: '[Enviando mídia...]',
      time,
      sentAt: time, // Display time (HH:MM for UI)
      isClient: false,
      avatar: undefined,
      metadata: {
        // CRITICAL: Store full ISO timestamp for sorting
        sentAt: isoTimestamp,
        createdAt: isoTimestamp,
      },
    };

    // Adicionar mensagem otimisticamente
    setMessages((prev) => [...prev, optimisticMessage]);
    
    // Auto-scroll to bottom after sending message
    setTimeout(() => {
      scrollToBottom();
    }, 50);

    try {
      // Enviar mídia via API
      const response = await attendanceService.sendMessageWithMedia(
        selectedConversation as string,
        file,
        messageInput.trim() || undefined
      );
      
      setMessageInput('');
      
      // Substituir mensagem temporária pela mensagem real do servidor
      if (response.success && response.message) {
        const sentDate = new Date(response.message.sentAt);
        const formatter = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const parts = formatter.formatToParts(sentDate);
        const sentTime = `${(parts.find((p) => p.type === 'hour')?.value || '00').padStart(2, '0')}:${(parts.find((p) => p.type === 'minute')?.value || '00').padStart(2, '0')}`;
        const isoTimestamp = sentDate.toISOString();

        const realMessage: Message = {
          id: response.message.id,
          sender: user?.name || 'Você',
          content: response.message.content,
          time: sentTime,
          sentAt: sentTime,
          isClient: false,
          avatar: undefined,
          hasLink: response.message.content.includes('http'),
          metadata: {
            ...(response.message.metadata || {}),
            sentAt: isoTimestamp,
            createdAt: isoTimestamp,
          },
        };

        setMessages((prev) =>
          prev.map((msg) => (msg.id === tempId ? realMessage : msg))
        );

        setConversations((prev) =>
          prev.map((conv) =>
            conv.id === selectedConversation
              ? {
                  ...conv,
                  lastMessage: response.message.content,
                  lastMessageTime: response.message.sentAt,
                  updatedAt: new Date().toISOString(),
                  lastMessageMediaType: response.message.metadata?.mediaType,
                }
              : conv
          )
        );

        if (selectedConversation) {
          fetchInactivityTimer(selectedConversation as string);
        }
      }
    } catch (error: any) {
      console.error('Error sending media:', error);
      // Remover mensagem temporária em caso de erro
      setMessages((prev) => prev.filter((msg) => msg.id !== tempId));
      alert('Erro ao enviar mídia. Tente novamente.');
    }
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !selectedConversation) return;

    const content = messageInput.trim();
    const tempId = `temp-${Date.now()}`;
    
    // Otimistic update: adicionar mensagem imediatamente ao estado
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    // Brazilian format - 24 hours
    const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    
    // CRITICAL: Store ISO timestamp for sorting
    const isoTimestamp = now.toISOString();

    const optimisticMessage: Message = {
      id: tempId,
      sender: user?.name || 'Você',
      content,
      time,
      sentAt: time, // Display time (HH:MM for UI)
      isClient: false,
      avatar: undefined,
      hasLink: content.includes('http'),
      metadata: {
        // CRITICAL: Store full ISO timestamp for sorting
        sentAt: isoTimestamp,
        createdAt: isoTimestamp,
      },
    };

    // Adicionar mensagem otimisticamente
    setMessages((prev) => [...prev, optimisticMessage]);
    setMessageInput('');
    
    // Auto-scroll to bottom after sending message
    setTimeout(() => {
      scrollToBottom();
    }, 50);

    try {
      // Enviar mensagem via API
      const response = await attendanceService.sendMessage(selectedConversation as string, content);
      
      // Substituir mensagem temporária pela mensagem real do servidor
      if (response.success && response.message) {
        const sentDate = new Date(response.message.sentAt);
        const formatter = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const parts = formatter.formatToParts(sentDate);
        const sentTime = `${(parts.find((p) => p.type === 'hour')?.value || '00').padStart(2, '0')}:${(parts.find((p) => p.type === 'minute')?.value || '00').padStart(2, '0')}`;
        const isoTimestamp = sentDate.toISOString();

        const realMessage: Message = {
          id: response.message.id,
          sender: user?.name || 'Você',
          content: response.message.content,
          time: sentTime,
          sentAt: sentTime,
          isClient: false,
          avatar: undefined,
          hasLink: response.message.content.includes('http'),
          metadata: {
            ...(response.message.metadata || {}),
            sentAt: isoTimestamp,
            createdAt: isoTimestamp,
          },
        };

        setMessages((prev) =>
          prev.map((msg) => (msg.id === tempId ? realMessage : msg))
        );

        setConversations((prev) =>
          prev.map((conv) =>
            conv.id === selectedConversation
              ? {
                  ...conv,
                  lastMessage: content,
                  lastMessageTime: response.message.sentAt,
                  updatedAt: new Date().toISOString(),
                  lastMessageMediaType: response.message.metadata?.mediaType,
                }
              : conv
          )
        );

        if (selectedConversation) {
          fetchInactivityTimer(selectedConversation as string);
        }
      }
    } catch (error: any) {
      console.error('Error sending message:', error);
      
      // Remover mensagem otimista em caso de erro
      setMessages((prev) => prev.filter((msg) => msg.id !== tempId));
      
      toast.error(error.response?.data?.error || 'Erro ao enviar mensagem');
      
      // Restaurar input
      setMessageInput(content);
    }
  };

  const isOpenTreeActive =
    (selectedAttendanceFilter === 'abertos' ||
      selectedAttendanceFilter === 'nao-atribuidos' ||
      viewingIntervencaoHumana ||
      !!selectedServiceCategory) &&
    !selectedFechadosFilter;
  const isAiNodeActive =
    selectedAttendanceFilter === 'nao-atribuidos' &&
    (selectedNaoAtribuidosFilter === 'todos' ||
      [
        'ai-nao-classificados',
        'ai-flash-day',
        'ai-locacao-estudio',
        'ai-captacao-videos',
      ].includes(selectedNaoAtribuidosFilter)) &&
    !selectedFechadosFilter;
  const isInterventionNodeActive = (viewingIntervencaoHumana || !!selectedServiceCategory) && !selectedFechadosFilter;
  const isFirstBranchActive = isAiNodeActive || isInterventionNodeActive;
  const firstBranchLineClass = isOpenTreeActive
    ? 'border-sky-400 dark:border-sky-500'
    : 'border-slate-200 dark:border-slate-700';
  const firstBranchSymbolClass = isFirstBranchActive
    ? 'text-sky-600 dark:text-sky-400'
    : 'text-slate-300 dark:text-slate-600';
  const secondBranchLineClass = selectedServiceCategory
    ? 'border-sky-400 dark:border-sky-500'
    : 'border-slate-200 dark:border-slate-700';
  const isFechadosActive = selectedFechadosFilter;
  const isFollowUpPathActive =
    selectedFollowUpNode === 'follow-up' ||
    selectedFollowUpNode === 'inativo-1h' ||
    selectedFollowUpNode === 'inativo-12h' ||
    selectedFollowUpNode === 'inativo-24h';
  const isFollowUp1hPathActive =
    selectedFollowUpNode === 'inativo-1h' ||
    selectedFollowUpNode === 'inativo-12h' ||
    selectedFollowUpNode === 'inativo-24h';
  const isFollowUp12hPathActive =
    selectedFollowUpNode === 'inativo-12h' ||
    selectedFollowUpNode === 'inativo-24h';
  const isFollowUp24hPathActive = selectedFollowUpNode === 'inativo-24h';
  const closedTreeLineClass = selectedFollowUpNode
    ? 'border-sky-400 dark:border-sky-500'
    : 'border-slate-200 dark:border-slate-700';
  const closedTreeSymbolDefault = 'text-slate-300 dark:text-slate-600';
  const closedTreeSymbolActive = 'text-sky-600 dark:text-sky-400';

  return (
    <div className="flex h-[100dvh] md:h-screen overflow-hidden bg-slate-100 dark:bg-slate-950 flex-col md:flex-row page-load-fade">
      {/* Sidebar Left - Desktop only */}
      <aside
        className={`hidden md:flex ${sidebarOpen ? 'w-56' : 'w-16'} transition-all duration-300 flex-col items-center py-4 bg-navy text-white flex-shrink-0 z-20`}
        style={{ backgroundColor: isDarkMode ? '#F07000' : '#003070' }}
      >
        <div className="mb-4 flex items-center justify-center w-full">
          {sidebarOpen ? (
            <div className="flex items-center justify-between gap-3 w-full px-3">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 bg-primary rounded flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: isDarkMode ? '#003070' : '#F07000' }}
                >
                  <span className="material-icons-round text-white">bolt</span>
                </div>
                <span className="text-lg font-bold tracking-tight">Joao Guerreiro</span>
              </div>
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="p-2 hover:bg-white/10 rounded-lg transition-colors flex-shrink-0"
                title="Retrair barra lateral"
              >
                <span className="material-icons-round">chevron_left</span>
              </button>
            </div>
          ) : (
            <button 
              className="w-10 h-10 bg-primary rounded flex items-center justify-center hover:opacity-80 transition-opacity" 
              style={{ backgroundColor: isDarkMode ? '#003070' : '#F07000' }}
              title="Perfil"
            >
              <span className="material-icons-round text-white">bolt</span>
            </button>
          )}
        </div>
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="mx-auto mb-3 p-2 hover:bg-white/10 rounded-lg transition-colors"
            title="Expandir barra lateral"
          >
            <span className="material-icons-round">chevron_right</span>
          </button>
        )}
        <nav ref={sidebarNavRef} className={`relative flex flex-col space-y-3 flex-grow ${sidebarOpen ? 'px-3 w-full' : 'px-0 items-center'}`}>
          {/* Indicador deslizante nas abas da barra lateral */}
          {sidebarTabIndicatorRect && (
            <div
              className="absolute rounded-lg bg-white/20 pointer-events-none z-0 transition-[top,height,left,width] duration-75 ease-out"
              style={{
                top: sidebarTabIndicatorRect.top,
                height: sidebarTabIndicatorRect.height,
                left: sidebarTabIndicatorRect.left,
                width: sidebarTabIndicatorRect.width,
              }}
            />
          )}
          <button
            type="button"
            data-sidebar-tab-active={activeSupervisorTab === 'chat' ? true : undefined}
            onClick={() => handleSupervisorTabChange('chat')}
            className={`relative z-10 p-2 rounded-lg transition-colors duration-300 ease-out flex items-center active:scale-95 hover:bg-white/10 ${
              sidebarOpen ? 'gap-3 w-full' : 'justify-center'
            }`}
          >
            <span className="material-icons-round">chat</span>
            {sidebarOpen && <span className="text-sm">Chat</span>}
          </button>
          <button
            type="button"
            data-sidebar-tab-active={activeSupervisorTab === 'estatisticas' ? true : undefined}
            onClick={() => handleSupervisorTabChange('estatisticas')}
            className={`relative z-10 p-2 rounded-lg transition-colors duration-300 ease-out flex items-center active:scale-95 hover:bg-white/10 ${
              sidebarOpen ? 'gap-3 w-full' : 'justify-center'
            }`}
          >
            <span className="material-icons-round">analytics</span>
            {sidebarOpen && <span className="text-sm">Estatísticas</span>}
          </button>
          <button
            type="button"
            data-sidebar-tab-active={activeSupervisorTab === 'contatos' ? true : undefined}
            onClick={() => handleSupervisorTabChange('contatos')}
            className={`relative z-10 p-2 rounded-lg transition-colors duration-300 ease-out flex items-center active:scale-95 hover:bg-white/10 ${
              sidebarOpen ? 'gap-3 w-full' : 'justify-center'
            }`}
          >
            <span className="material-icons-round">contacts</span>
            {sidebarOpen && <span className="text-sm">Contatos</span>}
          </button>
        </nav>
        <div className={`mt-auto w-full ${sidebarOpen ? 'px-3' : 'px-0'}`}>
          <button
            type="button"
            onClick={toggleTheme}
            className={`p-2 mt-2 rounded-lg transition-colors flex items-center bg-white/10 hover:bg-white/20 ${
              sidebarOpen ? 'gap-3 w-full' : 'justify-center w-full'
            }`}
            title={isDarkMode ? 'Trocar para modo claro' : 'Trocar para modo escuro'}
          >
            <span className="material-icons-round">{isDarkMode ? 'light_mode' : 'dark_mode'}</span>
            {sidebarOpen && <span className="text-sm">{isDarkMode ? 'Modo claro' : 'Modo escuro'}</span>}
          </button>
          {sidebarOpen && (
            <button 
              className="p-2 hover:bg-white/10 rounded-lg transition-colors flex items-center gap-3 w-full mt-3"
              title="Perfil"
            >
              <div className="w-8 h-8 bg-primary rounded-full border-2 border-white flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style={{ backgroundColor: '#F07000' }}>
                {user?.name?.charAt(0).toUpperCase() || 'U'}
              </div>
            </button>
          )}
        </div>
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around h-14 text-white safe-area-pb"
        style={{ backgroundColor: isDarkMode ? '#F07000' : '#003070' }}
      >
        {([
          { key: 'chat' as SupervisorTab, icon: 'chat', label: 'Chat' },
          { key: 'estatisticas' as SupervisorTab, icon: 'analytics', label: 'Estatísticas' },
          { key: 'contatos' as SupervisorTab, icon: 'contacts', label: 'Contatos' },
        ]).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => handleSupervisorTabChange(item.key)}
            className={`flex flex-col items-center justify-center flex-1 h-full transition-all duration-300 ease-out active:scale-95 ${activeSupervisorTab === item.key ? 'bg-white/20' : ''}`}
          >
            <span className="material-icons-round text-xl">{item.icon}</span>
            <span className="text-[10px] mt-0.5">{item.label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={toggleTheme}
          className="flex flex-col items-center justify-center flex-1 h-full transition-colors"
        >
          <span className="material-icons-round text-xl">{isDarkMode ? 'light_mode' : 'dark_mode'}</span>
          <span className="text-[10px] mt-0.5">Tema</span>
        </button>
      </nav>

      {/* Chat content wrapper - mobile slide transitions */}
      <div className="flex flex-1 min-h-0 overflow-hidden md:overflow-visible flex-col md:flex-row relative">
      {activeSupervisorTab === 'chat' && (
      <div key="chat-entry-conversations" className={`flex flex-1 md:flex-initial md:flex-shrink-0 min-h-0 flex-col md:flex-row ${hasUserSwitchedTabs ? 'chat-panels-slide-in' : 'animate-slideRollIn'}`}>
      <div className={`absolute md:relative inset-0 md:inset-auto flex ${entryPanelHasScroll ? 'md:w-[304px]' : 'md:w-72'} w-full min-w-full md:min-w-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col flex-shrink-0 transition-[transform,width] duration-300 ease-out h-full min-h-0 pb-14 md:pb-0 dark:[&_.text-slate-400]:text-slate-300 dark:[&_.text-slate-500]:text-slate-300 dark:[&_.text-slate-600]:text-slate-200 ${mobileChatLayer === 'entry' ? 'translate-x-0' : '-translate-x-full'} md:!translate-x-0 ${mobileChatLayer !== 'entry' ? 'pointer-events-none' : ''} md:pointer-events-auto`}>
        <div className="p-5 flex justify-between items-center flex-shrink-0">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">Entrada</h1>
        </div>
        <nav ref={entryNavRef} className="flex-grow overflow-y-auto px-2 custom-scrollbar scrollbar-left space-y-1 min-h-0">
          <div ref={entryNavInnerRef} className="scrollbar-left-inner space-y-1 min-h-0 relative">
          {/* Indicador deslizante - move suavemente entre as divisões selecionadas */}
          {slidingIndicatorRect && (
            <div
              className="absolute rounded-lg bg-slate-50 dark:bg-slate-800 pointer-events-none z-0 transition-[top,height,left,width] duration-300 ease-in-out"
              style={{
                top: slidingIndicatorRect.top,
                height: slidingIndicatorRect.height,
                left: slidingIndicatorRect.left,
                width: slidingIndicatorRect.width,
              }}
            />
          )}
          <div className="px-3 py-4 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Atendimentos</div>
          <div className="mb-6 space-y-1">
            <button
              type="button"
              data-division-active={selectedAttendanceFilter === 'abertos' ? true : undefined}
              onClick={() => {
                setSelectedAttendanceFilter('abertos');
                setViewingIntervencaoHumana(false);
                setSelectedServiceCategory(null);
                setSelectedConversation(null);
                setSelectedNaoAtribuidosFilter('todos');
                setSelectedFechadosFilter(false);
                setSelectedFollowUpNode(null);
                setSelectedTodasDemandasSubdivision(null);
                setSelectedSeller(null);
                setSelectedSellerBrand(null);
                setMobileChatLayer('conversations');
              }}
              className={`relative z-10 w-full flex items-center justify-between space-x-3 px-3 py-2 text-sm text-left rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] min-w-0 ${
                isOpenTreeActive
                  ? 'text-slate-900 dark:text-white font-medium'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
              style={isOpenTreeActive ? selectedNavTextStyle : {}}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="material-icons-round text-base flex-shrink-0 text-slate-600 dark:text-slate-400">folder_open</span>
                <div className="flex flex-col items-start min-w-0">
                  <span className="truncate">Abertos</span>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400">{getActiveCount('abertos')} atendimentos abertos</span>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {totalUnreadAbertos > 0 && (
                  <span className="bg-navy text-white text-[10px] font-semibold px-2 py-0.5 rounded-full min-w-[20px] text-center" style={{ backgroundColor: '#003070' }}>{totalUnreadAbertos > 99 ? '99+' : totalUnreadAbertos}</span>
                )}
              </div>
            </button>
                <div className={`ml-4 border-l pl-2 space-y-0.5 transition-colors duration-500 ease-in-out ${firstBranchLineClass}`}>
              {/* Seção AI - mesmo padrão de Intervenção Humana (parent + children com linhas de árvore) */}
              <div className="space-y-0.5">
                <button
                  type="button"
                  data-division-active={selectedAttendanceFilter === 'nao-atribuidos' && selectedNaoAtribuidosFilter === 'todos' ? true : undefined}
                  onClick={() => handleSelectNaoAtribuidos('todos')}
                  className={`relative z-10 w-full flex items-center justify-between px-3 py-2 text-sm text-left rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] ${
                    selectedAttendanceFilter === 'nao-atribuidos' && selectedNaoAtribuidosFilter === 'todos'
                      ? 'text-navy dark:text-white font-medium'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                  style={selectedAttendanceFilter === 'nao-atribuidos' && selectedNaoAtribuidosFilter === 'todos' ? selectedNavTextStyle : {}}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className={`font-mono text-xs transition-colors duration-500 ease-in-out ${isAiNodeActive ? firstBranchSymbolClass : 'text-slate-300 dark:text-slate-600'}`}>├─</span>
                    <span className="material-icons-round text-lg flex-shrink-0 text-slate-600 dark:text-slate-400">smart_toy</span>
                    <div className="flex flex-col items-start min-w-0">
                      <span className="truncate">AI</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">{getActiveCount('todos')} Atendimentos</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {getRedBadgeDivision('nao-atribuidos') > 0 && (
                      <span className="w-3 h-3 rounded-full bg-red-500 flex-shrink-0" title="Roteamento pendente" />
                    )}
                    {totalUnreadUnassigned > 0 && (
                      <span className="bg-navy text-white text-[10px] font-semibold px-2 py-0.5 rounded-full min-w-[20px] text-center" style={{ backgroundColor: '#003070' }}>{totalUnreadUnassigned > 99 ? '99+' : totalUnreadUnassigned}</span>
                    )}
                  </div>
                </button>

                {/* Subdivisões AI: Flash Day, Locação de estúdio, Captação de vídeos */}
                <div className={`ml-4 border-l pl-2 space-y-0.5 transition-colors duration-500 ease-in-out ${isAiNodeActive ? 'border-sky-400 dark:border-sky-500' : 'border-slate-200 dark:border-slate-700'}`}>
                {AI_SUBDIVISIONS.map(({ key, label, icon }, idx) => {
                  const isSelected = selectedAttendanceFilter === 'nao-atribuidos' && selectedNaoAtribuidosFilter === key;
                  const branch = idx < AI_SUBDIVISIONS.length - 1 ? '├─' : '└─';
                  const aiBranchClass = isSelected ? 'text-sky-600 dark:text-sky-400' : 'text-slate-300 dark:text-slate-600';
                  return (
                    <button
                      key={key}
                      type="button"
                      data-division-active={isSelected ? true : undefined}
                      onClick={() => handleSelectNaoAtribuidos(key)}
                      className={`relative z-10 w-full flex items-center justify-between px-3 py-2 text-sm text-left rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] ${
                        isSelected ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                      style={isSelected ? selectedNavTextStyle : {}}
                    >
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span className={`font-mono text-xs transition-colors duration-500 ease-in-out ${aiBranchClass}`}>{branch}</span>
                        <span className="material-icons-round text-base flex-shrink-0 text-slate-600 dark:text-slate-400">{icon}</span>
                        <div className="flex flex-col items-start min-w-0">
                          <span className="truncate">{label}</span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">{getActiveCount(key) ?? 0} Atendimentos</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
                </div>
              </div>

              {/* Intervenção humana - view que mostra todas as intervenções com badge do serviço em cada card */}
              <div className="space-y-0.5">
                <button
                  type="button"
                  data-division-active={viewingIntervencaoHumana && !selectedServiceCategory ? true : undefined}
                  onClick={() => {
                    setViewingIntervencaoHumana(true);
                    setSelectedServiceCategory(null);
                    setSelectedConversation(null);
                    setSelectedAttendanceFilter('tudo');
                    setSelectedFechadosFilter(false);
                    setSelectedFollowUpNode(null);
                    setSelectedTodasDemandasSubdivision(null);
                    setSelectedSeller(null);
                    setSelectedSellerBrand(null);
                    setMobileChatLayer('conversations');
                  }}
                  className={`relative z-10 w-full flex items-center justify-between px-3 py-2 text-sm text-left rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] ${
                    viewingIntervencaoHumana
                      ? 'text-navy dark:text-white font-medium'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                  style={viewingIntervencaoHumana ? selectedNavTextStyle : {}}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className={`font-mono text-xs transition-colors duration-500 ease-in-out ${isInterventionNodeActive ? firstBranchSymbolClass : 'text-slate-300 dark:text-slate-600'}`}>└─</span>
                    <span className="material-icons-round text-lg flex-shrink-0">engineering</span>
                    <div className="flex flex-col items-start min-w-0">
                      <span>Intervenção Humana</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">{getActiveCount('demanda-telefone-fixo') + getActiveCount('protese-capilar') + getActiveCount('outros-assuntos')} Atendimentos</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {getRedBadgeDivision('intervencao-humana') > 0 && (
                      <span className="w-3 h-3 rounded-full bg-red-500 flex-shrink-0" title="Roteamento pendente" />
                    )}
                    {(getSubdivisionBadge('demanda-telefone-fixo') + getSubdivisionBadge('protese-capilar') + getSubdivisionBadge('outros-assuntos')) > 0 && (
                      <span className="bg-navy text-white text-[10px] font-semibold px-2 py-0.5 rounded-full min-w-[20px] text-center" style={{ backgroundColor: '#003070' }}>
                        {getSubdivisionBadge('demanda-telefone-fixo') + getSubdivisionBadge('protese-capilar') + getSubdivisionBadge('outros-assuntos')}
                      </span>
                    )}
                  </div>
                </button>

                <div className={`ml-4 border-l pl-2 space-y-0.5 transition-colors duration-500 ease-in-out ${secondBranchLineClass}`}>
                  {SERVICE_CATEGORIES.map(({ key, label, icon }, idx) => {
                    const sellers = getSellersByServiceCategory(key);
                    const sellersActiveCount = sellers.reduce((sum, s) => sum + (getActiveCount(`seller-${s.id}`) || 0), 0);
                    const types = SERVICE_TO_INTERVENTION[key];
                    const interventionActiveCount = Array.isArray(types)
                      ? types.reduce((sum, t) => sum + (getActiveCount(t) || 0), 0)
                      : (getActiveCount(types) || 0);
                    const activeCount = sellersActiveCount + interventionActiveCount;
                    const isSelected = selectedServiceCategory === key;
                    const branch = idx < SERVICE_CATEGORIES.length - 1 ? '├─' : '└─';
                    const serviceBranchClass = isSelected ? 'text-sky-600 dark:text-sky-400' : 'text-slate-300 dark:text-slate-600';

                    return (
                      <button
                        key={key}
                        type="button"
                        data-division-active={isSelected ? true : undefined}
                        onClick={() => handleSelectServiceCategory(key)}
                        className={`relative z-10 w-full flex items-center justify-between px-3 py-2 text-sm text-left rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] ${
                          isSelected
                            ? 'text-slate-900 dark:text-white'
                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <span className={`font-mono text-xs transition-colors duration-500 ease-in-out ${serviceBranchClass}`}>{branch}</span>
                          <span className="material-icons-round text-base flex-shrink-0 text-slate-600 dark:text-slate-400">{icon}</span>
                          <div className="flex flex-col items-start min-w-0">
                            <span>{label}</span>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400">{activeCount} Atendimentos</span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="pt-6 mb-4">
            <div className="border-t border-slate-200 dark:border-slate-700" />
          </div>

          {/* Follow up - raiz da árvore */}
          <button
            type="button"
            data-division-active={selectedFollowUpNode === 'follow-up' ? true : undefined}
            onClick={() => handleSelectFollowUpNode('follow-up')}
            className={`relative z-10 w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] ${
              selectedFollowUpNode === 'follow-up'
                ? 'text-slate-900 dark:text-white font-medium'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
            style={selectedFollowUpNode === 'follow-up' ? selectedNavTextStyle : {}}
          >
            <div className="flex flex-col items-start min-w-0 flex-1">
              <div className="flex items-center gap-2 w-full">
                <span className="material-icons-round text-base text-slate-500 dark:text-slate-300">schedule</span>
                <span className="truncate">Follow up</span>
              </div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 ml-6">
                {activeCountBySubdivision['follow-up'] ?? 0} Atendimentos em follow up
              </span>
            </div>
          </button>

          <div className={`ml-4 border-l pl-2 space-y-0.5 transition-colors duration-500 ease-in-out ${closedTreeLineClass}`}>
              <button
                type="button"
                data-division-active={selectedFollowUpNode === 'inativo-1h' ? true : undefined}
                onClick={() => handleSelectFollowUpNode('inativo-1h')}
                className={`relative z-10 w-full px-3 py-2 text-sm rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] text-left ${
                  selectedFollowUpNode === 'inativo-1h'
                    ? 'text-slate-900 dark:text-white font-medium'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
                style={selectedFollowUpNode === 'inativo-1h' ? selectedNavTextStyle : {}}
              >
                <div className="flex flex-col items-start min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`font-mono text-xs transition-colors duration-500 ease-in-out ${isFollowUp1hPathActive ? closedTreeSymbolActive : closedTreeSymbolDefault}`}>└─</span>
                    <span className="material-icons-round text-base text-slate-500 dark:text-slate-300">hourglass_top</span>
                    <span className="truncate">Aguardando 1º Follow up</span>
                  </div>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 pl-5">
                    {activeCountBySubdivision['inativo-1h'] ?? 0} Atendimentos nessa fase
                  </span>
                </div>
              </button>

              <div className={`ml-4 border-l pl-2 space-y-0.5 transition-colors duration-500 ease-in-out ${isFollowUp1hPathActive ? 'border-sky-400 dark:border-sky-500' : 'border-slate-200 dark:border-slate-700'}`}>
                <button
                  type="button"
                  data-division-active={selectedFollowUpNode === 'inativo-12h' ? true : undefined}
                  onClick={() => handleSelectFollowUpNode('inativo-12h')}
                  className={`relative z-10 w-full px-3 py-2 text-sm rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] text-left ${
                    selectedFollowUpNode === 'inativo-12h'
                      ? 'text-slate-900 dark:text-white font-medium'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                  style={selectedFollowUpNode === 'inativo-12h' ? selectedNavTextStyle : {}}
                >
                  <div className="flex flex-col items-start min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`font-mono text-xs transition-colors duration-500 ease-in-out ${isFollowUp12hPathActive ? closedTreeSymbolActive : closedTreeSymbolDefault}`}>└─</span>
                      <span className="material-icons-round text-base text-slate-500 dark:text-slate-300">update</span>
                      <span className="truncate">Aguardando 2º Follow up</span>
                    </div>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 pl-5">
                      {activeCountBySubdivision['inativo-12h'] ?? 0} Atendimentos nessa fase
                    </span>
                  </div>
                </button>

                <div className={`ml-4 border-l pl-2 transition-colors duration-500 ease-in-out ${isFollowUp12hPathActive ? 'border-sky-400 dark:border-sky-500' : 'border-slate-200 dark:border-slate-700'}`}>
                  <button
                    type="button"
                    data-division-active={selectedFollowUpNode === 'inativo-24h' ? true : undefined}
                    onClick={() => handleSelectFollowUpNode('inativo-24h')}
                    className={`relative z-10 w-full px-3 py-2 text-sm rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] text-left ${
                      selectedFollowUpNode === 'inativo-24h'
                        ? 'text-slate-900 dark:text-white font-medium'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                    style={selectedFollowUpNode === 'inativo-24h' ? selectedNavTextStyle : {}}
                  >
                    <div className="flex flex-col items-start min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`font-mono text-xs transition-colors duration-500 ease-in-out ${isFollowUp24hPathActive ? closedTreeSymbolActive : closedTreeSymbolDefault}`}>└─</span>
                        <span className="material-icons-round text-base text-slate-500 dark:text-slate-300">timer</span>
                        <span className="truncate">Aguardando</span>
                      </div>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 pl-5">
                        {activeCountBySubdivision['inativo-24h'] ?? 0} Atendimentos nessa fase
                      </span>
                    </div>
                  </button>
                </div>
              </div>
            </div>

          <div className="pt-6 mb-4">
            <div className="border-t border-slate-200 dark:border-slate-700" />
          </div>

          {/* Fechados - fora da árvore */}
          <button
            type="button"
            data-division-active={isFechadosActive ? true : undefined}
            onClick={() => {
              setSelectedConversation(null);
              setSelectedSeller(null);
              setSelectedSellerBrand(null);
              setSelectedServiceCategory(null);
              setViewingIntervencaoHumana(false);
              setSelectedTodasDemandasSubdivision(null);
              setSelectedDemandaKey(null);
              setSelectedAttendanceFilter('tudo');
              setExpandedTodasDemandas(false);
              setSelectedFechadosFilter(true);
              setSelectedFollowUpNode(null);
              setPendingQuotes([]);
              setMobileChatLayer('conversations');
            }}
            className={`relative z-10 w-full flex items-center justify-center px-3 py-2 text-sm rounded-lg transition-colors duration-500 ease-in-out active:scale-[0.99] ${
              isFechadosActive
                ? 'text-navy dark:text-white font-medium'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
            style={isFechadosActive ? selectedNavTextStyle : {}}
          >
            <div className="flex items-center gap-2">
              <span className="material-icons-round text-lg text-slate-400 flex-shrink-0">archive</span>
              <div className="flex flex-col items-center">
                <span>Fechados</span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400">{activeCountBySubdivision['fechados'] ?? 0} atendimentos</span>
              </div>
            </div>
          </button>

          </div>
        </nav>
      </div>

      {/* Conversations List */}
      <div className={`absolute md:relative inset-0 md:inset-auto flex w-full min-w-full md:min-w-0 md:w-80 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col flex-shrink-0 flex-1 md:flex-initial min-h-0 dark:[&_.text-slate-400]:text-slate-300 dark:[&_.text-slate-500]:text-slate-300 dark:[&_.text-slate-600]:text-slate-200 transition-[transform] duration-300 ease-out ${mobileChatLayer === 'entry' ? 'translate-x-full' : mobileChatLayer === 'conversations' ? 'translate-x-0' : '-translate-x-full'} md:!translate-x-0 ${mobileChatLayer !== 'conversations' ? 'pointer-events-none' : ''} md:pointer-events-auto`}>
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center space-x-2 min-w-0">
              <button
                type="button"
                onClick={() => setMobileChatLayer('entry')}
                className="md:hidden p-1 -ml-1 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 flex-shrink-0"
              >
                <span className="material-icons-round text-lg">arrow_back</span>
              </button>
              <span className="material-icons-round text-slate-400 flex-shrink-0 hidden md:inline">sort</span>
              <span className="font-bold text-sm truncate text-slate-900 dark:text-white">{isPedidosOrcamentosView ? 'Pedidos de Orçamentos' : getConversationsHeaderTitle()}</span>
            </div>
            {!isPedidosOrcamentosView && !selectedTodasDemandasSubdivision && !selectedFechadosFilter && (
              !isBulkSelectMode ? (
                <button
                  type="button"
                  onClick={() => { setIsBulkSelectMode(true); setSelectedAttendancesForBulk(new Set()); }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex-shrink-0"
                  title="Selecionar e fechar vários atendimentos"
                >
                  <span className="material-icons-round text-sm">checklist</span>
                  Selecionar
                </button>
              ) : (
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => { setIsBulkSelectMode(false); setSelectedAttendancesForBulk(new Set()); }}
                    className="px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                  >
                    Cancelar
                  </button>
                  {selectedAttendancesForBulk.size > 0 && (
                    <button
                      type="button"
                      disabled={isClosingBulk}
                      onClick={async () => {
                        const ids = Array.from(selectedAttendancesForBulk);
                        if (!ids.length || !confirm(`Fechar ${ids.length} atendimento(s) selecionado(s)?`)) return;
                        setIsClosingBulk(true);
                        let successCount = 0;
                        let errorCount = 0;
                        for (const id of ids) {
                          try {
                            await attendanceService.closeAttendance(id);
                            successCount++;
                            setConversations((prev) => prev.filter((c) => c.id !== id));
                            setSelectedAttendancesForBulk((prev) => {
                              const next = new Set(prev);
                              next.delete(id);
                              return next;
                            });
                          } catch (e: any) {
                            errorCount++;
                            console.error('Error closing attendance', id, e);
                          }
                        }
                        setIsClosingBulk(false);
                        if (successCount > 0) toast.success(`${successCount} atendimento(s) fechado(s).`);
                        if (errorCount > 0) toast.error(`Erro ao fechar ${errorCount} atendimento(s).`);
                        if (successCount === ids.length) setIsBulkSelectMode(false);
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                      style={{ backgroundColor: '#003070' }}
                    >
                      <span className="material-icons-round text-sm">done_all</span>
                      Fechar {selectedAttendancesForBulk.size}
                    </button>
                  )}
                </div>
              )
            )}
          </div>
          {isPedidosOrcamentosView && !viewingFromDemandasCard && (
            <div className="flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
              <button
                type="button"
                onClick={() => { setQuoteSubTab('pendentes'); setSelectedQuote(null); }}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  quoteSubTab === 'pendentes'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Pendentes
              </button>
              <button
                type="button"
                onClick={() => { setQuoteSubTab('enviados'); setSelectedQuote(null); }}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  quoteSubTab === 'enviados'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Orçamentos enviados
              </button>
            </div>
          )}
        </div>
        <div className="p-3">
          <div className="relative">
            <span className="material-icons-round absolute left-3 top-2.5 text-slate-400 text-sm">search</span>
            <input
              className="w-full pl-9 pr-4 py-2 text-xs bg-slate-50 dark:bg-slate-800 border-none rounded-lg focus:ring-1 focus:ring-accent outline-none"
              placeholder={isPedidosOrcamentosView || selectedTodasDemandasSubdivision ? "Buscar pedidos..." : "Buscar conversas..."}
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
        <div className="flex-grow overflow-y-auto custom-scrollbar pb-14 md:pb-0 overflow-x-hidden">
          <div key={divisionViewKey} className="animate-slideRollIn min-h-full">
          {isPedidosOrcamentosView ? (
            (() => {
              const isEnviados = !viewingFromDemandasCard && quoteSubTab === 'enviados';
              const rawList = isEnviados ? sentQuoteCards : quoteCards;
              const list = selectedSeller
                ? rawList.filter((q) => q.sellerId === selectedSeller)
                : rawList;
              return isLoadingQuotes ? (
                <div className="flex items-center justify-center h-32 animate-slideRollIn">
                  <span className="material-icons-round animate-spin text-slate-400">refresh</span>
                  <span className="ml-2 text-sm text-slate-400">Carregando pedidos...</span>
                </div>
              ) : list.length === 0 ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-center px-4">
                    <span className="material-icons-round text-5xl text-slate-300 mb-3 block">description</span>
                    <p className="text-sm text-slate-400">
                      {isEnviados ? 'Nenhum orçamento enviado' : 'Nenhum pedido encontrado'}
                    </p>
                  </div>
                </div>
              ) : (
                list.map((quote) => {
                  const quoteDate = new Date(quote.createdAt);
                  const time = `${quoteDate.getHours().toString().padStart(2, '0')}:${quoteDate.getMinutes().toString().padStart(2, '0')}`;
                  const seller = supervisorSellers.find(s => s.id === quote.sellerId);
                  const sellerName = seller?.name || 'Vendedor';
                  const isSelected = selectedQuote?.id === quote.id;
                  const isUnviewed = !isEnviados && !viewedQuoteIds.has(quote.id);
                  return (
                    <div
                      key={quote.id}
                      className={`p-4 border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors ${
                        isSelected ? 'bg-green-50/50 dark:bg-green-900/10 border-l-4 border-green-500' : isUnviewed ? 'border-l-4 border-green-500 bg-green-50/30 dark:bg-green-900/5' : ''
                      }`}
                      onClick={() => {
                        // Supervisor NÃO marca como visualizado — só o vendedor limpa o badge verde
                        setSelectedQuote(quote);
                      }}
                    >
                      <div className="flex items-start justify-between mb-1">
                        <div className="flex items-center space-x-3 min-w-0 flex-1">
                          <div className="relative flex-shrink-0">
                            <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/20 rounded-full flex items-center justify-center">
                              <span className="material-icons-round text-orange-600 dark:text-orange-400 text-lg">description</span>
                            </div>
                            {isUnviewed && (
                              <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-green-500 border-2 border-white dark:border-slate-900" title="Não visualizado" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h4 className="text-sm font-bold truncate text-slate-900 dark:text-white">{quote.clientName || quote.clientPhone}</h4>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate block">{sellerName}</span>
                            <p className="text-[10px] text-slate-500 dark:text-slate-300 truncate">Pedido de orçamento</p>
                          </div>
                        </div>
                        <div className="flex flex-col items-end flex-shrink-0">
                          {isUnviewed && (
                            <span className="text-[9px] font-medium text-green-600 dark:text-green-400 mb-0.5">Novo</span>
                          )}
                          <span className="text-[10px] text-slate-400">{time}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              );
            })()
          ) : selectedTodasDemandasSubdivision ? (
            isLoadingPendingQuotes ? (
              <div className="flex items-center justify-center h-32 animate-slideRollIn">
                <span className="material-icons-round animate-spin text-slate-400">refresh</span>
                <span className="ml-2 text-sm text-slate-400">Carregando pendências...</span>
              </div>
            ) : pendingQuotes.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <div className="text-center px-4">
                  <span className="material-icons-round text-5xl text-slate-300 mb-3 block">description</span>
                  <p className="text-sm text-slate-400">
                    {selectedTodasDemandasSubdivision === '__all__'
                      ? 'Nenhuma pendência no momento'
                      : 'Nenhuma pendência nesta categoria no momento'}
                  </p>
                </div>
              </div>
            ) : (
              (() => {
                const filteredQuotes = pendingQuotes.filter((quote) => {
                  // Filter by search term (client name or phone)
                  if (!searchTerm.trim()) return true;
                  const searchLower = searchTerm.toLowerCase().trim();
                  const clientName = (quote.clientName || '').toLowerCase();
                  const clientPhone = (quote.clientPhone || '').toLowerCase();
                  return clientName.includes(searchLower) || clientPhone.includes(searchLower);
                });

                if (filteredQuotes.length === 0 && searchTerm.trim()) {
                  return (
                    <div className="flex items-center justify-center py-12">
                      <div className="text-center px-4">
                        <span className="material-icons-round text-5xl text-slate-300 mb-3 block">search_off</span>
                        <p className="text-sm text-slate-400">
                          Nenhuma pendência encontrada para "{searchTerm}"
                        </p>
                      </div>
                    </div>
                  );
                }

                return filteredQuotes.map((quote) => {
                  const quoteDate = new Date(quote.createdAt);
                  const hours = quoteDate.getHours();
                  const minutes = quoteDate.getMinutes();
                  const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
                  
                  // Get seller info
                  const seller = supervisorSellers.find(s => s.id === quote.sellerId);
                  const sellerName = seller?.name || 'Vendedor';
                  
                  // Get subdivision label
                  const subdivLabels: Record<string, string> = {
                    'pedidos-orcamentos': 'Pedidos de Orçamentos',
                    'perguntas-pos-orcamento': 'Perguntas Pós Orçamento',
                    'confirmacao-pix': 'Confirmação Pix',
                    'tirar-pedido': 'Tirar Pedido',
                    'informacoes-entrega': 'Informações sobre Entrega',
                    'encomendas': 'Encomendas',
                    'cliente-pediu-humano': 'Cliente pediu Humano',
                  };
                  const subdivisionLabel = subdivLabels[selectedTodasDemandasSubdivision === '__all__' ? (quote as any).sellerSubdivision || 'pedidos-orcamentos' : (selectedTodasDemandasSubdivision || 'pedidos-orcamentos')] || 'Pendência';

                  return (
                    <div
                      key={quote.id}
                      className={`p-4 border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors ${selectedQuote?.id === quote.id ? 'bg-green-50/50 dark:bg-green-900/10 border-l-4 border-green-500' : ''}`}
                      onClick={() => {
                        // Mostrar detalhe do pedido (não abrir conversa diretamente)
                        setSelectedQuote(quote);
                        setSelectedConversation(null);
                      }}
                    >
                      <div className="flex items-start justify-between mb-1">
                        <div className="flex items-center space-x-3 min-w-0 flex-1">
                          <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/20 rounded-full flex items-center justify-center flex-shrink-0">
                            <span className="material-icons-round text-orange-600 dark:text-orange-400 text-lg">description</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <h4 className="text-sm font-bold truncate text-slate-900 dark:text-white">{quote.clientName || quote.clientPhone}</h4>
                            <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 truncate max-w-[140px]" title={`${sellerName} • ${subdivisionLabel}`}>
                              {sellerName} • {subdivisionLabel}
                            </span>
                            <p className="text-[10px] mt-0.5 text-slate-500 truncate">
                              {subdivisionLabel}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-col items-end space-y-1 flex-shrink-0">
                          <span className="text-[10px] text-slate-400">{time}</span>
                        </div>
                      </div>
                    </div>
                  );
                });
              })()
            )
          ) : isLoadingConversations ? (
            <div className="flex items-center justify-center h-32 animate-slideRollIn">
              <span className="material-icons-round animate-spin text-slate-400">refresh</span>
              <span className="ml-2 text-sm text-slate-400">Carregando conversas...</span>
            </div>
          ) : (
            <div key={`${divisionViewKey}-loaded`} className="animate-slideRollIn min-h-full">
            {(selectedSeller || selectedServiceCategory || (viewingIntervencaoHumana && !selectedServiceCategory) || selectedAttendanceFilter === 'abertos' || selectedAttendanceFilter === 'nao-atribuidos' || selectedAttendanceFilter === 'tudo' || !!selectedFollowUpNode) && conversations.length > 0 ? (
            (() => {
              const filteredConversations = formatConversationsForDisplay(conversations)
                .filter((conv) => {
                  // Em "Não atribuídos": só exibir conversas realmente não atribuídas.
                  // Excluir se: attributionSource | sellerId | sellerSubdivision (API de vendedor retorna isso; unassigned não).
                  // Isso evita exibir itens atribuídos que ainda estão no state (ex.: race ao trocar de filtro).
                  if (selectedAttendanceFilter === 'nao-atribuidos') {
                    const attr = (conv as any).attributionSource;
                    const sid = (conv as any).sellerId;
                    const subdiv = (conv as any).sellerSubdivision;
                    if (attr || sid || subdiv) return false; // atribuído → não exibir
                  }
                  // Filter by search term (client name)
                  if (!searchTerm.trim()) return true;
                  const searchLower = searchTerm.toLowerCase().trim();
                  return conv.name.toLowerCase().includes(searchLower);
                });
              
              // Show filtered results or empty state
              if (filteredConversations.length === 0 && searchTerm.trim()) {
                return (
                  <div className="flex items-center justify-center py-12">
                    <div className="text-center px-4">
                      <span className="material-icons-round text-5xl text-slate-300 mb-3 block">search_off</span>
                      <p className="text-sm text-slate-400">
                        Nenhuma conversa encontrada para "{searchTerm}"
                      </p>
                    </div>
                  </div>
                );
              }
              
              return filteredConversations.map((conv) => {
                const isBulkSelected = isBulkSelectMode && selectedAttendancesForBulk.has(String(conv.id));
                const isFinished = (conv as any).state === 'FINISHED';
                return (
              <div
                key={conv.id}
                className={`p-4 border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors flex items-start gap-3 ${
                  selectedConversation === conv.id ? 'bg-green-50/50 dark:bg-green-900/10 border-l-4 border-green-500' : ''
                } ${isBulkSelected ? 'ring-2 ring-green-500 ring-inset' : ''}`}
                onClick={async (e) => {
                  if (isBulkSelectMode) {
                    e.stopPropagation();
                    if (isFinished) return;
                    setSelectedAttendancesForBulk((prev) => {
                      const next = new Set(prev);
                      const id = String(conv.id);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                    return;
                  }
                  // Evitar sobrescrever selectedConversationData ao clicar na mesma conversa (itens da lista podem não ter handledBy)
                  if (selectedConversation === conv.id) return;
                  setSelectedConversation(conv.id);
                  setSelectedConversationData(conv as Conversation); // Dados imediatos para evitar "piscar" na sidebar

                  // Marcar conversa como lida no backend (supervisor NÃO pode marcar atendimento atribuído a vendedor)
                  const isAttributedToSeller = (conv as any)?.sellerId || (conv as any)?.attributionSource?.sellerId;
                  if (!isAttributedToSeller && conv.unread > 0 && typeof conv.id === 'string') {
                    try {
                      await attendanceService.markAsRead(conv.id);
                      markedAsReadIdsRef.current.add(conv.id);
                      
                      // Atualizar estado local e recalcular total baseado nas conversas atualizadas
                      setConversations((prev) => {
                        const updated = prev.map((c) =>
                          c.id === conv.id ? { ...c, unread: 0 } : c
                        );
                        if (selectedAttendanceFilter === 'nao-atribuidos') {
                          setUnassignedConversationsCache((prevCache) =>
                            prevCache.map((c) => (c.id === conv.id ? { ...c, unread: 0 } : c))
                          );
                        }
                        if (selectedAttendanceFilter === 'abertos') {
                          const prevUnread = (conv as { unread?: number }).unread ?? 0;
                          setTotalUnreadAbertos((u) => Math.max(0, u - prevUnread));
                        }
                        return updated;
                      });
                    } catch (error: any) {
                      console.error('Error marking as read:', error);
                      setConversations((prev) => {
                        const updated = prev.map((c) =>
                          c.id === conv.id ? { ...c, unread: 0 } : c
                        );
                        if (selectedAttendanceFilter === 'nao-atribuidos') {
                          setUnassignedConversationsCache((prevCache) =>
                            prevCache.map((c) => (c.id === conv.id ? { ...c, unread: 0 } : c))
                          );
                        }
                        if (selectedAttendanceFilter === 'abertos') {
                          const prevUnread = (conv as { unread?: number }).unread ?? 0;
                          setTotalUnreadAbertos((u) => Math.max(0, u - prevUnread));
                        }
                        return updated;
                      });
                    }
                  }
                }}
              >
                {isBulkSelectMode && !isFinished && (
                  <div
                    className="flex-shrink-0 mt-1 w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer"
                    style={{ borderColor: isBulkSelected ? '#22c55e' : '#94a3b8', backgroundColor: isBulkSelected ? '#22c55e' : 'transparent' }}
                  >
                    {isBulkSelected && <span className="material-icons-round text-white text-xs">check</span>}
                  </div>
                )}
                <div className="flex items-start justify-between mb-1 flex-1 min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <img alt={conv.name} className="w-10 h-10 rounded-full flex-shrink-0" src={conv.avatar} />
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-bold truncate text-slate-900 dark:text-white">{conv.name}</h4>
                      {(() => {
                        // View Follow-up: badge indicando fase (1º, 2º ou Aguardando)
                        if (selectedFollowUpNode && (conv as any).followUpPhase) {
                          const phase = (conv as any).followUpPhase;
                          const phaseColors: Record<string, string> = {
                            'Aguardando 1º Follow up': 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200',
                            'Aguardando 2º Follow up': 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200',
                            'Aguardando': 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400',
                          };
                          const color = phaseColors[phase] ?? 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400';
                          return (
                            <span className={`inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded truncate max-w-[140px] font-medium ${color}`} title={phase}>
                              {phase}
                            </span>
                          );
                        }
                        // View Abertos: badge indicando origem (AI, Intervenção, Vendedor)
                        if (selectedAttendanceFilter === 'abertos') {
                          const att = (conv as any).attributionSource;
                          const hasSeller = (conv as any).sellerId || att?.sellerId;
                          const hasIntervention = (conv as any).interventionType || att?.interventionType;
                          const unassignedSource = (conv as any).unassignedSource;
                          let badgeLabel = 'Não classificado';
                          let badgeColor = 'bg-slate-200 dark:bg-slate-600 text-slate-800 dark:text-slate-200';
                          if (hasSeller && att?.type === 'seller') {
                            badgeLabel = att?.label ?? 'Vendedor';
                            badgeColor = 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200';
                          } else if (hasIntervention || att?.type === 'intervention') {
                            badgeLabel = getServiceLabelFromConv(conv) ?? att?.label ?? 'Intervenção';
                            badgeColor = 'bg-sky-100 dark:bg-sky-900/40 text-sky-800 dark:text-sky-200';
                          } else if (unassignedSource === 'encaminhados-ecommerce') {
                            badgeLabel = 'E-commerce';
                            badgeColor = 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200';
                          } else if (unassignedSource === 'encaminhados-balcao') {
                            badgeLabel = 'Balcão';
                            badgeColor = 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200';
                          } else {
                            const aiSubLabel = getAiSubdivisionBadgeLabel(
                              unassignedSource,
                              (conv as { aiContext?: { ai_subdivision?: string } }).aiContext?.ai_subdivision
                            );
                            badgeLabel = aiSubLabel ?? 'AI';
                            badgeColor = 'bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200';
                          }
                          return (
                            <span className={`inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded truncate max-w-[140px] font-medium ${badgeColor}`} title={badgeLabel}>
                              {badgeLabel}
                            </span>
                          );
                        }
                        // View Intervenção humana: badge com nome do serviço em que o contato está classificado
                        if (viewingIntervencaoHumana) {
                          const serviceLabel = getServiceLabelFromConv(conv) ?? 'Não classificado';
                          return (
                            <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200 truncate max-w-[140px] font-medium" title={serviceLabel}>
                              {serviceLabel}
                            </span>
                          );
                        }
                        // View serviço: badge com nome do serviço para conversas de intervenção
                        if (selectedServiceCategory) {
                          const serviceLabel = getServiceLabelFromConv(conv, selectedServiceCategory);
                          if (serviceLabel) {
                            return (
                              <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200 truncate max-w-[140px] font-medium" title={serviceLabel}>
                                {serviceLabel}
                              </span>
                            );
                          }
                        }
                        // Se selecionou "Todas as Demandas", exibir vendedor + marca + subdivisão
                        if (selectedTodasDemandasSubdivision) {
                          const seller = supervisorSellers.find(s => s.id === (conv as any).sellerId);
                          const sellerName = seller?.name || 'Vendedor';
                          const sellerBrand = seller?.brands?.[0] ? getCategoryLabelForBrand(seller.brands[0] as VehicleBrand) : 'Serviço';
                          const subdivLabels: Record<string, string> = {
                            'pedidos-orcamentos': 'Pedidos de Orçamentos',
                            'perguntas-pos-orcamento': 'Perguntas Pós Orçamento',
                            'confirmacao-pix': 'Confirmação Pix',
                            'tirar-pedido': 'Tirar Pedido',
                            'informacoes-entrega': 'Informações sobre Entrega',
                            'encomendas': 'Encomendas',
                            'cliente-pediu-humano': 'Cliente pediu Humano',
                          };
                          const subdivLabel = subdivLabels[(conv as any).sellerSubdivision] || (conv as any).sellerSubdivision;
                          return (
                            <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 truncate max-w-[140px]" title={`${sellerName} • ${sellerBrand} • ${subdivLabel}`}>
                              {sellerName} • {sellerBrand} • {subdivLabel}
                            </span>
                          );
                        }

                        const attrLabel = (conv as any).attributionSource?.label;
                        const unassignedSrc = (conv as any).unassignedSource;
                        const inferredServiceLabel = getServiceLabelFromConv(conv, selectedServiceCategory);
                        const badgeLabel = inferredServiceLabel
                          ?? attrLabel
                          ?? (selectedAttendanceFilter === 'nao-atribuidos' && unassignedSrc
                            ? getAiSubdivisionBadgeLabel(
                                unassignedSrc,
                                (conv as { aiContext?: { ai_subdivision?: string } }).aiContext?.ai_subdivision
                              ) ?? 'AI'
                            : null);
                        if (!badgeLabel) return null;
                        return (
                          <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 truncate max-w-[140px]" title={badgeLabel}>
                            {badgeLabel}
                          </span>
                        );
                      })()}
                      <p className={`text-[10px] mt-0.5 ${conv.status === 'sent' ? 'text-green-600 dark:text-green-300 font-medium italic' : 'text-slate-500 dark:text-slate-300'} truncate w-32`}>
                        {formatLastMessage(conv.lastMessage, (conv as any).lastMessageMediaType)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end space-y-1 flex-shrink-0">
                    <span className="text-[10px] text-slate-400">{conv.time}</span>
                    <div className="flex items-center gap-1">
                      {(conv as any).attributionSource?.interventionType === 'casos_gerentes' && (
                        <span className="w-3 h-3 rounded-full flex-shrink-0" title="Casos gerentes" style={{ backgroundColor: '#7C3AED' }} />
                      )}
                      {hasRedOnConversation(String(conv.id)) && (
                        <span className="w-4 h-4 bg-red-500 text-white text-[10px] flex items-center justify-center rounded-full" title="Roteamento pendente">
                          1
                        </span>
                      )}
                      {conv.unread > 0 && (
                        <span className="w-4 h-4 bg-navy text-white text-[10px] flex items-center justify-center rounded-full" style={{ backgroundColor: '#003070' }}>
                          {conv.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
              });
            })()
          ) : (
            <div className="flex items-center justify-center py-12">
              <div className="text-center px-4">
                <span className="material-icons-round text-5xl text-slate-300 mb-3 block">chat_bubble_outline</span>
                <p className="text-sm text-slate-400">
                  {selectedTodasDemandasSubdivision === '__all__'
                    ? 'Nenhuma demanda no momento'
                    : selectedTodasDemandasSubdivision
                    ? 'Nenhuma demanda nesta categoria no momento'
                    : viewingIntervencaoHumana && !selectedServiceCategory
                    ? 'Nenhuma conversa de intervenção no momento'
                    : selectedServiceCategory && viewingIntervencaoHumana
                    ? `Nenhuma conversa de intervenção em ${SERVICE_CATEGORIES.find(c => c.key === selectedServiceCategory)?.label ?? selectedServiceCategory} no momento`
                    : selectedAttendanceFilter === 'abertos'
                    ? 'Nenhum atendimento aberto no momento'
                    : selectedAttendanceFilter === 'nao-atribuidos'
                    ? 'Nenhuma conversa em atendimento pela AI no momento'
                    : selectedFollowUpNode
                    ? `Nenhum cliente em ${FOLLOW_UP_LABELS[selectedFollowUpNode] ?? 'Follow UP'} no momento`
                    : selectedSeller
                    ? 'Nenhuma conversa encontrada para este vendedor'
                    : selectedServiceCategory
                    ? `Nenhum atendimento em ${SERVICE_CATEGORIES.find(c => c.key === selectedServiceCategory)?.label ?? selectedServiceCategory} no momento`
                    : selectedAttendanceFilter === 'tudo'
                    ? 'Nenhum atendimento atribuído no momento'
                    : 'Selecione um serviço ou filtro para ver as conversas'}
                </p>
              </div>
            </div>
          )}
            </div>
          )}
          </div>
        </div>
      </div>
      </div>
      )}

      {/* Main Chat Area - tab slide transitions on mobile and desktop. Mobile: fixed para preencher viewport do topo. */}
      <main className={`supervisor-main-mobile flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden relative isolate pb-14 md:pb-0 fixed md:relative inset-0 md:inset-auto z-40 md:z-auto ${activeSupervisorTab === 'chat' ? `transition-[transform] duration-300 ease-out ${mobileChatLayer === 'chat' ? 'translate-x-0' : 'translate-x-full'} md:!translate-x-0 ${mobileChatLayer !== 'chat' ? 'pointer-events-none' : ''} md:pointer-events-auto` : ''}`}>
        {/* Contatos section - slides na direção do indicador (vertical desktop, horizontal mobile) */}
        <div className={`absolute inset-0 w-full min-w-full md:min-w-0 flex flex-col min-h-0 supervisor-tab-panel ${getSupervisorTabSlideClass('contatos', activeSupervisorTab)} ${activeSupervisorTab !== 'contatos' ? 'pointer-events-none' : 'pointer-events-auto'}`}>
          <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-slate-100 dark:bg-slate-950 p-3 sm:p-5 pb-20 md:pb-5">
            <div className="max-w-5xl mx-auto space-y-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">Contatos</h2>
                    <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Todos os contatos que já interagiram.</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!contactsBulkSelectMode ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowImportModal(true)}
                        className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-white rounded-lg hover:opacity-90 transition-opacity text-xs sm:text-sm font-medium"
                        style={{ backgroundColor: '#1e293b' }}
                      >
                        <span className="material-icons-round text-base">upload_file</span>
                        <span className="hidden sm:inline">Importar contatos</span>
                        <span className="sm:hidden">Importar</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => { setContactsBulkSelectMode(true); setSelectedContactsForBulk(new Set()); }}
                        className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg border-2 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-opacity text-xs sm:text-sm font-medium"
                      >
                        <span className="material-icons-round text-base">checklist</span>
                        Selecionar
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => { setContactsBulkSelectMode(false); setSelectedContactsForBulk(new Set()); }}
                        className="flex items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs sm:text-sm font-medium"
                      >
                        Cancelar
                      </button>
                      {selectedContactsForBulk.size > 0 && (
                        <button
                          type="button"
                          disabled={isDeletingContactsBulk}
                          onClick={async () => {
                            if (!confirm(`Excluir ${selectedContactsForBulk.size} contato(s) selecionado(s)? Todos os atendimentos serão removidos. Esta ação não pode ser desfeita.`)) return;
                            const phones = Array.from(selectedContactsForBulk);
                            setIsDeletingContactsBulk(true);
                            let successCount = 0;
                            const norm = (p: string) => p.replace(/\D/g, '');
                            for (const clientPhone of phones) {
                              try {
                                await contactsService.deleteContact(clientPhone);
                                setContactsList((prev) => prev.filter((c) => norm(c.clientPhone) !== norm(clientPhone)));
                                successCount++;
                              } catch (e: any) {
                                toast.error(e?.response?.data?.error || `Erro ao excluir ${clientPhone}`);
                              }
                              setSelectedContactsForBulk((prev) => {
                                const next = new Set(prev);
                                next.delete(clientPhone);
                                return next;
                              });
                            }
                            setIsDeletingContactsBulk(false);
                            toast.success(`${successCount} contato(s) excluído(s)`);
                            if (successCount === phones.length) setContactsBulkSelectMode(false);
                          }}
                          className="flex items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs sm:text-sm font-medium"
                        >
                          {isDeletingContactsBulk ? (
                            <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                          ) : (
                            <span className="material-icons-round text-base">delete_outline</span>
                          )}
                          Excluir {selectedContactsForBulk.size} selecionado(s)
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 sm:items-stretch">
                <div className="relative flex-1 flex">
                  <span className="material-icons-round absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg pointer-events-none">search</span>
                  <input
                    type="text"
                    placeholder="Buscar por nome ou telefone..."
                    value={contactsSearch}
                    onChange={(e) => setContactsSearch(e.target.value)}
                    className="w-full h-11 pl-10 pr-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-sky-500/30 focus:border-sky-500 transition-all"
                  />
                </div>
                <div className="relative min-w-[180px] flex" ref={contactsSortDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setContactsSortDropdownOpen((o) => !o)}
                    className="w-full h-11 flex items-center justify-between gap-2 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/30 focus:border-sky-500 transition-all"
                  >
                    <span>{contactsSortOrder === 'recent' ? 'Mais recentes' : 'Ordem alfabética'}</span>
                    <span className={`material-icons-round text-lg text-slate-400 transition-transform ${contactsSortDropdownOpen ? 'rotate-180' : ''}`}>expand_more</span>
                  </button>
                  {contactsSortDropdownOpen && (
                    <div className="absolute left-0 right-0 top-full mt-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1 z-50 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => { setContactsSortOrder('recent'); setContactsSortDropdownOpen(false); }}
                        className={`w-full h-10 flex items-center justify-between px-4 text-left text-sm transition-colors ${contactsSortOrder === 'recent' ? 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                      >
                        Mais recentes
                        {contactsSortOrder === 'recent' && <span className="material-icons-round text-lg">check</span>}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setContactsSortOrder('alphabetical'); setContactsSortDropdownOpen(false); }}
                        className={`w-full h-10 flex items-center justify-between px-4 text-left text-sm transition-colors ${contactsSortOrder === 'alphabetical' ? 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                      >
                        Ordem alfabética
                        {contactsSortOrder === 'alphabetical' && <span className="material-icons-round text-lg">check</span>}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {contactsLoading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-500" />
                </div>
              ) : filteredContacts.length === 0 ? (
                <div className="text-center py-20 text-slate-400 dark:text-slate-500">
                  <span className="material-icons-round text-5xl mb-3 block">person_off</span>
                  <p className="text-sm">{contactsSearch ? 'Nenhum contato encontrado' : 'Nenhum contato registrado'}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 items-stretch">
                  {filteredContacts.map((contact) => {
                    const displayName = contact.clientName || contact.clientPhone || 'Sem nome';
                    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=F07000&color=fff&size=96`;
                    const isContactSelected = selectedContactsForBulk.has(contact.clientPhone);
                    return (
                      <div
                        key={contact.clientPhone}
                        onClick={() => {
                          if (contactsBulkSelectMode) {
                            setSelectedContactsForBulk((prev) => {
                              const next = new Set(prev);
                              if (next.has(contact.clientPhone)) next.delete(contact.clientPhone);
                              else next.add(contact.clientPhone);
                              return next;
                            });
                          }
                        }}
                        className={`rounded-2xl border-2 p-3 sm:p-5 shadow-sm hover:shadow-md transition-all flex flex-col sm:min-h-[180px] cursor-pointer ${
                          contactsBulkSelectMode
                            ? isContactSelected
                              ? 'border-red-500 ring-2 ring-red-500/30 bg-red-50/30 dark:bg-red-900/10'
                              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600'
                            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-sky-200 dark:hover:border-sky-800'
                        }`}
                      >
                        <div className="flex items-center gap-3 sm:items-start sm:gap-4 flex-1 min-h-0">
                          {contactsBulkSelectMode && (
                            <div className="flex-shrink-0 w-8 h-8 sm:w-10 sm:h-10 rounded-full border-2 flex items-center justify-center" style={{ borderColor: isContactSelected ? '#ef4444' : '#94a3b8', backgroundColor: isContactSelected ? '#ef4444' : 'transparent' }}>
                              {isContactSelected && <span className="material-icons-round text-white text-lg">check</span>}
                            </div>
                          )}
                          <img
                            src={avatarUrl}
                            alt={displayName}
                            className="w-11 h-11 sm:w-14 sm:h-14 rounded-full flex-shrink-0 object-cover ring-2 ring-slate-100 dark:ring-slate-800"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm sm:text-base font-semibold text-slate-900 dark:text-white truncate">
                              {displayName}
                            </p>
                            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-mono mt-0.5 truncate">
                              {contact.clientPhone.replace(/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/, '+$1 ($2) $3-$4')}
                            </p>
                            <div className="flex items-center gap-2 mt-1.5 sm:mt-2 flex-wrap">
                              <span className="text-[10px] sm:text-xs font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full">
                                {contact.totalAttendances} atend.
                              </span>
                              <span className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400">
                                {new Date(contact.lastContactAt).toLocaleDateString('pt-BR')}
                              </span>
                            </div>
                          </div>
                          {!contactsBulkSelectMode && (
                            <div className="sm:hidden flex items-center gap-1.5 flex-shrink-0">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleInitiateConversation(contact.clientPhone); }}
                                className="flex items-center justify-center w-10 h-10 rounded-xl bg-sky-500 text-white active:bg-sky-600"
                              >
                                <span className="material-icons-round text-lg">chat</span>
                              </button>
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!confirm('Excluir este contato? Todos os atendimentos serão removidos.')) return;
                                  try {
                                    const result = await contactsService.deleteContact(contact.clientPhone);
                                    const norm = (p: string) => p.replace(/\D/g, '');
                                    setContactsList((prev) => prev.filter((c) => norm(c.clientPhone) !== norm(contact.clientPhone)));
                                    toast.success(result.message);
                                  } catch (error: any) {
                                    toast.error(error.response?.data?.error || 'Erro ao excluir contato');
                                  }
                                }}
                                className="flex items-center justify-center w-10 h-10 rounded-xl text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 active:bg-red-100 dark:active:bg-red-900/30"
                                title="Excluir contato"
                              >
                                <span className="material-icons-round text-lg">delete_outline</span>
                              </button>
                            </div>
                          )}
                        </div>
                        {!contactsBulkSelectMode && (
                          <div className="hidden sm:flex mt-4 gap-2 flex-shrink-0">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleInitiateConversation(contact.clientPhone); }}
                              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-white bg-sky-500 hover:bg-sky-600 rounded-xl transition-colors"
                            >
                              <span className="material-icons-round text-lg">chat</span>
                              Chamar
                            </button>
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!confirm('Tem certeza que deseja excluir este contato? Todos os atendimentos serão removidos. Esta ação não pode ser desfeita.')) return;
                                try {
                                  const result = await contactsService.deleteContact(contact.clientPhone);
                                  const norm = (p: string) => p.replace(/\D/g, '');
                                  setContactsList((prev) => prev.filter((c) => norm(c.clientPhone) !== norm(contact.clientPhone)));
                                  toast.success(result.message);
                                } catch (error: any) {
                                  toast.error(error.response?.data?.error || 'Erro ao excluir contato');
                                }
                              }}
                              className="flex items-center justify-center gap-1.5 px-3 py-3 text-sm font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-xl transition-colors"
                              title="Excluir contato"
                            >
                              <span className="material-icons-round text-lg">delete_outline</span>
                              Excluir
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {showImportModal && (
              <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setShowImportModal(false)}>
                <div
                  className="bg-white dark:bg-slate-900 rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl w-full sm:max-w-md p-5 sm:p-6 space-y-4 max-h-[85vh] overflow-y-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">Importar contatos</h3>
                    <button type="button" onClick={() => setShowImportModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                      <span className="material-icons-round">close</span>
                    </button>
                  </div>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Selecione um arquivo CSV com números de telefone. Colunas aceitas: telefone, phone, numero, celular, whatsapp, fone. Separe por vírgula ou ponto-e-vírgula.
                  </p>
                  <a
                    href="data:text/csv;charset=utf-8,telefone%0A5521999999999%0A5521988888888"
                    download="modelo-contatos.csv"
                    className="inline-flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400 hover:underline"
                  >
                    <span className="material-icons-round text-sm">download</span>
                    Baixar modelo CSV
                  </a>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Arquivo CSV</label>
                    <input
                      ref={importFileInputRef}
                      type="file"
                      accept=".csv"
                      onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-white file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-sky-500 file:text-white file:text-sm"
                    />
                    {importFile && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">{importFile.name}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Número WhatsApp (Baileys)</label>
                    <select
                      value={importSelectedNumber}
                      onChange={(e) => setImportSelectedNumber(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-sky-500/30 focus:border-sky-500"
                    >
                      <option value="">Selecione o número...</option>
                      {baileysNumbers.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.label || n.phoneNumber} ({n.connectionStatus === 'CONNECTED' ? 'Conectado' : 'Desconectado'})
                        </option>
                      ))}
                    </select>
                    {baileysNumbers.length === 0 && (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Nenhum número Baileys cadastrado. Configure em WhatsApp.</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handleImportContacts}
                    disabled={importLoading || !importFile || !importSelectedNumber || baileysNumbers.length === 0}
                    className="w-full py-2.5 bg-sky-500 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {importLoading ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                    ) : (
                      <>
                        <span className="material-icons-round text-base">upload_file</span>
                        Importar
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Estatísticas section - slides na direção do indicador (vertical desktop, horizontal mobile) */}
        <div className={`absolute inset-0 w-full min-w-full md:min-w-0 flex flex-col min-h-0 supervisor-tab-panel ${getSupervisorTabSlideClass('estatisticas', activeSupervisorTab)} ${activeSupervisorTab !== 'estatisticas' ? 'pointer-events-none' : 'pointer-events-auto'}`}>
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto bg-slate-100 dark:bg-slate-950 relative flex flex-col pb-14 md:pb-0">
            <div
              className="pointer-events-none absolute inset-0 opacity-40 dark:opacity-20"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 20%, rgba(59,130,246,0.08), transparent 35%), radial-gradient(circle at 80% 0%, rgba(15,23,42,0.18), transparent 45%), repeating-linear-gradient(45deg, rgba(15,23,42,0.04) 0 1px, transparent 1px 10px)',
              }}
            />
            <div className="relative w-full p-3 sm:p-4 lg:p-5">
              <div className="w-full max-w-7xl mx-auto overflow-hidden space-y-4 sm:space-y-5">
                <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm shadow-sm p-3 sm:p-4">
                  <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
                    <div className="flex flex-col gap-3">
                      <div>
                        <h2 className="text-xl font-bold text-slate-900 dark:text-white">Estatísticas</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400">Indicadores de atendimentos com filtros por período.</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {([
                          { key: 'dia', label: 'Dia' },
                          { key: 'semana', label: 'Semana' },
                          { key: 'mes', label: 'Mês' },
                        ] as const).map((option) => (
                          <button
                            key={option.key}
                            type="button"
                            onClick={() => setStatsPeriod(option.key)}
                            className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                              statsPeriod === option.key
                                ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                        {statsPeriod === 'dia' && (
                          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                            <span>Dia</span>
                            <input
                              type="date"
                              value={statsDay}
                              onChange={(e) => setStatsDay(e.target.value)}
                              className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                            />
                          </label>
                        )}
                        {statsPeriod === 'semana' && (
                          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                            <span>Início da semana</span>
                            <input
                              type="date"
                              value={statsWeekStart}
                              onChange={(e) => setStatsWeekStart(e.target.value)}
                              className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                            />
                          </label>
                        )}
                        {statsPeriod === 'mes' && (
                          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                            <span>Mês</span>
                            <input
                              type="month"
                              value={statsMonth}
                              onChange={(e) => setStatsMonth(e.target.value)}
                              className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                            />
                          </label>
                        )}
                      </div>
                    </div>

                    {!isLoadingSupervisorStats && (
                      <div className="grid grid-cols-2 sm:flex sm:flex-nowrap items-stretch gap-2 sm:gap-3 w-full xl:min-w-[640px] sm:justify-end">
                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center shadow-sm sm:flex-1 sm:min-w-[72px] sm:max-w-[100px] sm:mr-6 xl:mr-8">
                          <p className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400">Atendimentos totais</p>
                          <p className="mt-1 text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{supervisorStats.totalAttendances ?? 0}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center shadow-sm sm:flex-1 sm:min-w-[72px] sm:max-w-[100px]">
                          <p className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400">Atendimentos hoje</p>
                          <p className="mt-1 text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{supervisorStats.dayAttendances ?? 0}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center shadow-sm sm:flex-1 sm:min-w-[72px] sm:max-w-[100px]">
                          <p className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400">Atendimentos na semana</p>
                          <p className="mt-1 text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{isLoadingWeekAttendances ? '...' : weekAttendances}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center shadow-sm sm:flex-1 sm:min-w-[72px] sm:max-w-[100px]">
                          <p className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400">Atendimentos no mês</p>
                          <p className="mt-1 text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{isLoadingMonthAttendances ? '...' : monthAttendances}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-center shadow-sm sm:flex-1 sm:min-w-[72px] sm:max-w-[100px] sm:ml-6 xl:ml-8 col-span-2 sm:col-span-1">
                          <p className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400">Atendimentos fechados</p>
                          <p className="mt-1 text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{activeCountBySubdivision['fechados'] ?? 0}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {isLoadingSupervisorStats ? (
                  <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/70 p-10 text-center text-slate-500 dark:text-slate-400">
                    Carregando estatísticas...
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-3 xl:gap-4 items-stretch">
                      <div className="space-y-3">
                        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/85 dark:bg-slate-900/70 backdrop-blur-sm shadow-sm p-3 sm:p-4">
                          <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-2">Flash Day</h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="rounded-xl border border-sky-200/70 dark:border-sky-900/60 bg-sky-50/60 dark:bg-sky-900/20 p-3">
                              <p className="text-xs text-sky-800 dark:text-sky-300">Quantidade de atendimentos Flash Day</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{aiFlashDayCount}</p>
                            </div>
                            <div className="rounded-xl border border-sky-200/70 dark:border-sky-900/60 bg-sky-50/40 dark:bg-sky-900/15 p-3">
                              <p className="text-xs text-sky-800 dark:text-sky-300">Percentual de agendamentos Flash Day</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{aiFlashDaySchedulingPercent.toFixed(1)}%</p>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/85 dark:bg-slate-900/70 backdrop-blur-sm shadow-sm p-3 sm:p-4">
                          <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-2">Locação de estúdio</h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="rounded-xl border border-amber-200/70 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-900/20 p-3">
                              <p className="text-xs text-amber-800 dark:text-amber-300">Quantidade de atendimentos Locação de estúdio</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{aiLocacaoEstudioCount}</p>
                            </div>
                            <div className="rounded-xl border border-amber-200/70 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-900/15 p-3">
                              <p className="text-xs text-amber-800 dark:text-amber-300">Percentual de agendamentos Locação de estúdio</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{aiLocacaoEstudioSchedulingPercent.toFixed(1)}%</p>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/85 dark:bg-slate-900/70 backdrop-blur-sm shadow-sm p-3 sm:p-4">
                          <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-2">Captação de vídeos</h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="rounded-xl border border-emerald-200/70 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-900/20 p-3">
                              <p className="text-xs text-emerald-800 dark:text-emerald-300">Quantidade de atendimentos Captação de vídeos</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{aiCaptacaoVideosCount}</p>
                            </div>
                            <div className="rounded-xl border border-emerald-200/70 dark:border-emerald-900/60 bg-emerald-50/40 dark:bg-emerald-900/15 p-3">
                              <p className="text-xs text-emerald-800 dark:text-emerald-300">Percentual de agendamentos Captação de vídeos</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{aiCaptacaoVideosSchedulingPercent.toFixed(1)}%</p>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/85 dark:bg-slate-900/70 backdrop-blur-sm shadow-sm p-3 sm:p-4">
                          <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-2">Intervenção humana (Outros assuntos)</h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="rounded-xl border border-fuchsia-200/70 dark:border-fuchsia-900/60 bg-fuchsia-50/60 dark:bg-fuchsia-900/20 p-3">
                              <p className="text-xs text-fuchsia-800 dark:text-fuchsia-300">Quantidade de atendimentos em intervenção humana</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{otherSubjectAttendances}</p>
                            </div>
                            <div className="rounded-xl border border-fuchsia-200/70 dark:border-fuchsia-900/60 bg-fuchsia-50/40 dark:bg-fuchsia-900/15 p-3">
                              <p className="text-xs text-fuchsia-800 dark:text-fuchsia-300">Percentual de atendimentos em intervenção humana</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{pieClassificationPercents.interv.toFixed(1)}%</p>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/85 dark:bg-slate-900/70 backdrop-blur-sm shadow-sm p-3 sm:p-4">
                          <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-2">Atendimentos não classificados</h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/60 bg-slate-50/60 dark:bg-slate-800/40 p-3">
                              <p className="text-xs text-slate-600 dark:text-slate-400">Quantidade de atendimentos não classificados</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{remainderUnclassifiedCount}</p>
                            </div>
                            <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/60 bg-slate-50/40 dark:bg-slate-800/30 p-3">
                              <p className="text-xs text-slate-600 dark:text-slate-400">Percentual de atendimentos não classificados</p>
                              <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{pieClassificationPercents.uncl.toFixed(1)}%</p>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/85 dark:bg-slate-900/70 backdrop-blur-sm shadow-sm p-3 sm:p-4 flex flex-col justify-center">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-white text-center mb-4">Percentuais por classificação</h3>
                        <div className="mx-auto w-48 h-48 rounded-full overflow-hidden border-8 border-slate-200 dark:border-slate-700 shadow-sm relative"
                          style={{
                            background: `radial-gradient(circle, rgba(0,0,0,0.08) 1px, transparent 1px), ${classificationChartBackground}`,
                            backgroundSize: '6px 6px, 100% 100%',
                          }}
                        />
                        <div className="mt-5 space-y-2 text-sm">
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><span className="w-3 h-3 rounded-full bg-sky-500" />Flash Day</span>
                            <span className="font-semibold text-slate-900 dark:text-white">{pieClassificationPercents.flash.toFixed(1)}%</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><span className="w-3 h-3 rounded-full bg-amber-500" />Locação de estúdio</span>
                            <span className="font-semibold text-slate-900 dark:text-white">{pieClassificationPercents.loc.toFixed(1)}%</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><span className="w-3 h-3 rounded-full bg-emerald-500" />Captação de vídeos</span>
                            <span className="font-semibold text-slate-900 dark:text-white">{pieClassificationPercents.cap.toFixed(1)}%</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><span className="w-3 h-3 rounded-full bg-fuchsia-500" />Intervenção humana</span>
                            <span className="font-semibold text-slate-900 dark:text-white">{pieClassificationPercents.interv.toFixed(1)}%</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><span className="w-3 h-3 rounded-full bg-slate-400" />Não classificados</span>
                            <span className="font-semibold text-slate-900 dark:text-white">{pieClassificationPercents.uncl.toFixed(1)}%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Chat section - slides na direção do indicador (vertical desktop, horizontal mobile) */}
        <div className={`supervisor-chat-panel-mobile absolute inset-0 w-full min-w-full md:min-w-0 flex flex-col min-h-0 md:flex-1 md:min-h-0 supervisor-tab-panel ${getSupervisorTabSlideClass('chat', activeSupervisorTab)} ${activeSupervisorTab !== 'chat' ? 'pointer-events-none' : 'pointer-events-auto'} bg-slate-100 dark:bg-slate-950 pb-14 md:pb-0`}>
        {(isPedidosOrcamentosView || selectedTodasDemandasSubdivision) && selectedQuote ? (
          <>
          <div className="flex-grow overflow-y-auto p-6 custom-scrollbar min-h-0">
            <button
              type="button"
              onClick={() => setSelectedQuote(null)}
              className="mb-4 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              <span className="material-icons-round text-base">arrow_back</span>
              Voltar
            </button>
            <div className="w-full">
              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div>
                    <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-1">
                      {selectedQuote.clientName || 'Cliente (nome não informado)'}
                    </h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Telefone: {formatPhoneNumber(selectedQuote.clientPhone)}
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                      {(() => {
                        const date = new Date(selectedQuote.createdAt);
                        const formatter = new Intl.DateTimeFormat('pt-BR', {
                          timeZone: 'America/Sao_Paulo',
                          dateStyle: 'long',
                          timeStyle: 'short',
                        });
                        return formatter.format(date);
                      })()}
                    </p>
                    {selectedSeller ? null : (() => {
                      const seller = supervisorSellers.find(s => s.id === selectedQuote.sellerId);
                      return seller ? (
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Vendedor: {seller.name}</p>
                      ) : null;
                    })()}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-xs px-3 py-1.5 rounded-full font-medium ${
                      selectedQuote.status === 'enviado' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                      selectedQuote.status === 'em_elaboracao' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' :
                      'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                    }`}>
                      {selectedQuote.status === 'pendente' ? 'Pendente' : selectedQuote.status === 'em_elaboracao' ? 'Em elaboração' : 'Enviado'}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        const attendanceId = selectedQuote.attendanceId;
                        const sellerId = selectedQuote.sellerId;
                        // Sair de Pedidos de Orçamentos e ir para Atribuídos (lista de conversas do vendedor), permitindo enviar msgs
                        setSelectedAttendanceFilter('tudo');
                        setSelectedTodasDemandasSubdivision(null);
                        setSelectedSeller(sellerId);
                        setSelectedSellerSubdivision(null);
                        setSelectedSellerBrand(null);
                        setSelectedServiceCategory(null);
                        setViewingIntervencaoHumana(false);
                        setSelectedDemandaKey(null);
                        setViewingFromDemandasCard(false);
                        setSelectedQuote(null);
                        setPendingQuotes([]);
                        try {
                          setIsLoadingConversations(true);
                          const sellerConversations = await attendanceService.getConversationsBySeller(sellerId);
                          const readIds = markedAsReadIdsRef.current;
                          const toSet = sellerConversations.map((c) => readIds.has(String(c.id)) ? { ...c, unread: 0 } : c);
                          setConversations(toSet);
                          setSelectedConversation(attendanceId);
                          setRefreshMessagesTrigger((prev) => prev + 1);
                        } catch (error: any) {
                          console.error('Error loading conversations for Ir para conversa:', error);
                          toast.error('Erro ao carregar conversas');
                          setSelectedConversation(attendanceId);
                          setRefreshMessagesTrigger((prev) => prev + 1);
                        } finally {
                          setIsLoadingConversations(false);
                        }
                      }}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-emerald-500 hover:bg-emerald-600 text-white transition-colors"
                    >
                      <span className="material-icons-round text-base">chat</span>
                      Ir para conversa
                    </button>
                  </div>
                </div>
                {selectedQuote.observations && (() => {
                  const obs = selectedQuote.observations;
                  const hasVehicleInfo = /Marca:|Modelo:|Ano:|Peça desejada:|Placa:|Resumo do atendimento:/i.test(obs);
                  const hasConversationSummary = /Resumo da conversa:/i.test(obs);
                  let vehicleSection = '';
                  let conversationSection = '';
                  let otherSection = '';
                  if (hasConversationSummary) {
                    const parts = obs.split(/Resumo da conversa:/i);
                    vehicleSection = parts[0]?.trim() || '';
                    conversationSection = parts[1]?.trim() || '';
                  } else {
                    if (hasVehicleInfo) vehicleSection = obs;
                    else otherSection = obs;
                  }
                  return (
                    <div className="mb-4 space-y-3">
                      {vehicleSection && hasVehicleInfo && (
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
                          <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3 uppercase tracking-wide">Informações do Veículo</div>
                          <div className="text-sm text-slate-700 dark:text-slate-300 space-y-2">
                            {vehicleSection.split('\n').map((line, idx) => {
                              if (line.match(/^(Marca|Modelo|Ano|Peça desejada|Placa|Resumo do atendimento):/i)) {
                                const [label, ...valueParts] = line.split(':');
                                const value = valueParts.join(':').trim();
                                if (!value) return null;
                                return (
                                  <div key={idx} className="flex">
                                    <span className="font-semibold text-slate-900 dark:text-white min-w-[120px]">{label}:</span>
                                    <span className="ml-3 text-slate-600 dark:text-slate-400">{value}</span>
                                  </div>
                                );
                              }
                              return null;
                            })}
                          </div>
                        </div>
                      )}
                      {conversationSection && (
                        <div className="p-4 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-200 dark:border-blue-800">
                          <div className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-3 uppercase tracking-wide flex items-center gap-2">
                            <span className="material-icons-round text-base">chat_bubble_outline</span>
                            Resumo da Conversa
                          </div>
                          <div className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line leading-relaxed">
                            {conversationSection}
                          </div>
                        </div>
                      )}
                      {otherSection && !hasVehicleInfo && !hasConversationSummary && (
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
                          <div className="text-sm text-slate-600 dark:text-slate-400 whitespace-pre-line">{otherSection}</div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {selectedQuote.items && selectedQuote.items.length > 0 && (
                  <div className="mb-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3 uppercase tracking-wide">Itens:</p>
                    <div className="space-y-2">
                      {selectedQuote.items.map((item, idx) => (
                        <div key={idx} className="text-sm text-slate-600 dark:text-slate-400">
                          {item.description || JSON.stringify(item)}
                          {item.quantity && ` (Qtd: ${item.quantity}${item.unit ? ` ${item.unit}` : ''})`}
                          {item.value && ` - R$ ${item.value.toFixed(2)}`}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedQuote.questionAnswers && selectedQuote.questionAnswers.length > 0 && (
                  <div className="mb-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3 uppercase tracking-wide">Perguntas e Respostas:</p>
                    <div className="space-y-2 text-sm">
                      {selectedQuote.questionAnswers.map((qa, i) => (
                        <div key={i} className="border-l-2 border-blue-300 dark:border-blue-700 pl-3 py-1">
                          <div className="font-medium text-slate-900 dark:text-white mb-1">P: {qa.question}</div>
                          <div className="text-slate-600 dark:text-slate-400">R: {qa.answer}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Supervisor: responder orçamento (pendentes) */}
                {selectedQuote.status === 'pendente' && (
                  <div className="mb-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wide">
                      Responder Orçamento
                    </label>
                    <textarea
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm resize-none mb-2"
                      placeholder="Digite o conteúdo do orçamento ou cole aqui..."
                      rows={4}
                      value={quoteResponseText}
                      onChange={(e) => setQuoteResponseText(e.target.value)}
                      onPaste={(e) => {
                        const items = e.clipboardData?.items;
                        if (!items) return;
                        for (const item of items) {
                          if (item.type.startsWith('image/')) {
                            e.preventDefault();
                            const file = item.getAsFile();
                            if (file) {
                              setQuoteResponseImage(file);
                              toast.success('Imagem colada da área de transferência (Ctrl+V)');
                            }
                            break;
                          }
                        }
                      }}
                    />
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-sm hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer transition-colors">
                        <span className="material-icons-round text-base">image</span>
                        Adicionar Imagem
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) setQuoteResponseImage(file);
                          }}
                        />
                      </label>
                      {quoteResponseImage && (
                        <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
                          <span className="material-icons-round text-sm">image</span>
                          {quoteResponseImage.name}
                          <button
                            type="button"
                            onClick={() => setQuoteResponseImage(null)}
                            className="text-red-500 hover:text-red-600"
                          >
                            <span className="material-icons-round text-sm">close</span>
                          </button>
                        </div>
                      )}
                      <span className="text-xs text-slate-500 dark:text-slate-400">ou Ctrl+V para colar imagem</span>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
                  {selectedQuote.status === 'pendente' && (
                    <>
                      <button
                        type="button"
                        onClick={() => { setSelectedQuoteForPerguntar(selectedQuote.id); setPerguntarText(''); }}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-sm hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                      >
                        <span className="material-icons-round text-base">help_outline</span>
                        Perguntar ao cliente
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEnviarOrcamentoSupervisor(selectedQuote)}
                        disabled={isSendingQuote || (!quoteResponseText.trim() && !quoteResponseImage)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ backgroundColor: '#003070' }}
                      >
                        <span className="material-icons-round text-base">{isSendingQuote ? 'hourglass_empty' : 'send'}</span>
                        {isSendingQuote ? 'Enviando...' : 'Enviar orçamento'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeletarOrcamentoSupervisor(selectedQuote.id)}
                        disabled={isDeletingQuote === selectedQuote.id}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm hover:bg-red-200 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
                      >
                        <span className="material-icons-round text-base">{isDeletingQuote === selectedQuote.id ? 'hourglass_empty' : 'delete'}</span>
                        {isDeletingQuote === selectedQuote.id ? 'Deletando...' : 'Deletar orçamento'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          {selectedQuoteForPerguntar && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
              <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl max-w-md w-full p-6">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-3">Perguntar ao cliente</h3>
                <textarea
                  className="w-full h-24 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm resize-none"
                  placeholder="Digite sua(s) pergunta(s)..."
                  value={perguntarText}
                  onChange={(e) => setPerguntarText(e.target.value)}
                />
                <div className="flex justify-end gap-2 mt-4">
                  <button
                    type="button"
                    onClick={() => { setSelectedQuoteForPerguntar(null); setPerguntarText(''); }}
                    className="px-4 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handlePerguntarSubmit}
                    disabled={!perguntarText.trim() || isSendingPerguntar}
                    className="px-4 py-2 rounded-lg text-white text-sm disabled:opacity-50"
                    style={{ backgroundColor: '#003070' }}
                  >
                    {isSendingPerguntar ? 'Enviando…' : 'Enviar'}
                  </button>
                </div>
              </div>
            </div>
          )}
          </>
        ) : selectedConversation ? (
          <div className="flex flex-col flex-1 min-h-0 min-w-0 animate-chatPaneEntrance">
            {/* Mobile header bar with back + info */}
            <div className="md:hidden flex items-center justify-between px-3 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
              <button
                onClick={() => { setSelectedConversation(null); setSelectedConversationData(null); setMobileChatLayer('conversations'); }}
                className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                <span className="material-icons-round text-lg">arrow_back</span>
                Voltar
              </button>
              <button
                onClick={() => setMobileCustomerInfoOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 rounded-lg"
              >
                <span className="material-icons-round text-base">info</span>
                Detalhes
              </button>
            </div>
            {/* Floating button for sidebar control - desktop */}
            <button
              onClick={() => setCustomerSidebarOpen(!customerSidebarOpen)}
              className="hidden md:block absolute top-4 right-4 z-50 p-2 bg-white dark:bg-slate-800 shadow-lg rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              title={customerSidebarOpen ? 'Fechar informações do cliente' : 'Abrir informações do cliente'}
            >
              <span className="material-icons-round text-slate-600 dark:text-slate-300">
                {customerSidebarOpen ? 'chevron_right' : 'chevron_left'}
              </span>
            </button>

            <div 
              ref={messagesContainerRef}
              className={`flex-1 overflow-y-auto py-4 custom-scrollbar min-h-0 bg-slate-50 dark:bg-slate-950 px-3 ${customerSidebarOpen ? 'md:px-4' : 'md:px-6'}`}
              style={{
                contain: 'layout style paint',
              }}
            >
              {messages.length === 0 ? (
                <div className="pt-4 pb-4" style={{ minHeight: 'min(200px, 30vh)' }}>
                  {isLoadingMessages ? (
                    <div className="flex items-center gap-3 text-slate-400">
                      <span className="material-icons-round animate-spin text-xl">refresh</span>
                      <span className="text-sm">Carregando mensagens...</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-start gap-2">
                      <span className="material-icons-round text-4xl text-slate-300">chat_bubble_outline</span>
                      <p className="text-sm text-slate-400">Nenhuma mensagem ainda</p>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  key={selectedConversation}
                  className="space-y-1.5 md:space-y-3 pb-4 transition-opacity duration-500 ease-out"
                  style={{ willChange: 'contents', opacity: chatMessagesFadeIn ? 1 : 0 }}
                >
                  {hasMoreMessages && (
                    <div className="flex justify-center py-4">
                      <button
                        onClick={loadMoreMessages}
                        disabled={isLoadingMoreMessages}
                        className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"
                      >
                        {isLoadingMoreMessages ? (
                          <>
                            <span className="material-icons-round animate-spin text-sm">refresh</span>
                            <span>Carregando...</span>
                          </>
                        ) : (
                          <>
                            <span className="material-icons-round text-sm">expand_more</span>
                            <span>Carregar mais mensagens</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                  {(() => {
                    // 1) Dedupe por id (mantém primeira ocorrência)
                    const byId = messages.filter(
                      (msg, index, self) => index === self.findIndex((m) => m.id === msg.id)
                    );
                    // 2) Ordenar por data (metadata.sentAt ou fallback)
                    const getTs = (msg: any) => {
                      const iso = msg.metadata?.sentAt;
                      if (iso) return new Date(iso).getTime();
                      return 0;
                    };
                    const sorted = [...byId].sort((a, b) => getTs(a) - getTs(b));
                    // Não exibir mensagens fantasma (sem conteúdo e sem mídia) - evita bloco só com horário ao assumir atendimento
                    const sortedNoGhost = sorted.filter((m: any) => {
                      const hasContent = m.content != null && String(m.content).trim() !== '';
                      const hasMedia = !!(m.metadata?.mediaUrl);
                      return hasContent || hasMedia;
                    });
                    // 3) Para mensagens do CLIENTE: mesmo conteúdo = mesma mensagem. Manter uma só, preferindo a que tem push name (ex.: "Marcos Alves") em vez de genérico "Cliente".
                    // EXCEÇÃO: mensagens com mídia (áudio, imagem, vídeo, documento) são únicas - não dedupe por conteúdo (múltiplos áudios/imagens = mensagens distintas)
                    const clientContentToLatest = new Map<string, { msg: any; ts: number; hasName: boolean }>();
                    const nonClient: any[] = [];
                    const hasRealSender = (m: any) => m.sender && String(m.sender).trim() !== '' && String(m.sender).toLowerCase() !== 'cliente';
                    const isMediaMessage = (m: any) => !!(m.metadata?.mediaUrl) || ['image', 'audio', 'video', 'document'].includes(m.metadata?.mediaType || '');
                    for (const msg of sortedNoGhost) {
                      const content = msg.content != null ? String(msg.content).trim() : '';
                      const hasMedia = isMediaMessage(msg);
                      if ((msg as any).isClient && content && !hasMedia) {
                        const ts = getTs(msg);
                        const hasName = hasRealSender(msg);
                        const existing = clientContentToLatest.get(content);
                        const keepThis =
                          !existing ||
                          (hasName && !existing.hasName) ||
                          (hasName === existing.hasName && ts > existing.ts);
                        if (keepThis) {
                          clientContentToLatest.set(content, { msg, ts, hasName });
                        }
                      } else if ((msg as any).isClient && hasMedia) {
                        nonClient.push(msg);
                      } else {
                        nonClient.push(msg);
                      }
                    }
                    const clientDeduped = Array.from(clientContentToLatest.values()).map((x) => x.msg);
                    const filtered = [...nonClient, ...clientDeduped].sort((a, b) => getTs(a) - getTs(b));
                    
                    if (messages.length !== filtered.length) {
                      console.warn('🚨 Mensagens duplicadas (incl. mesmo conteúdo cliente) removidas:', {
                        total: messages.length,
                        afterFilter: filtered.length,
                      });
                    }
                    
                    // Não agrupar fragmentos - exibir cada mensagem separadamente como no WhatsApp
                    return filtered.map((msg, index) => {
                      const key = msg.id;
                      const isSystem = !!(msg as any).isSystem;
                      if (isSystem) {
                        return (
                          <div key={key} className="flex justify-center py-2">
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs">
                              <span className="material-icons-round text-sm" style={{ color: '#94a3b8' }}>swap_horiz</span>
                              <span>{msg.content}</span>
                              <span className="text-[10px opacity-70 text-slate-600 dark:text-white">{msg.time}</span>
                            </div>
                          </div>
                        );
                      }
                      const prevMsg = index > 0 ? filtered[index - 1] : null;
                      // Agrupar visualmente mensagens consecutivas do mesmo remetente
                      // Mostrar nome/avatar apenas na primeira mensagem do bloco
                      // Reaparecer quando houver interrupção (mudança de remetente ou tipo)
                      const isFirstInGroup = !prevMsg ||
                        prevMsg.sender !== msg.sender ||
                        (prevMsg as any).isClient !== msg.isClient;
                      // Nota: Fragmentos são mensagens separadas (balões distintos), mas podem ser
                      // agrupados visualmente se forem do mesmo remetente consecutivo

                      return (
                      <React.Fragment key={key}>
                    <div className={`flex gap-1 md:gap-2.5 ${msg.isClient ? 'flex-col md:flex-row items-start' : 'flex-col md:flex-row-reverse items-end md:items-start'}`}>
                      {/* Avatar block: on mobile, label is centered above icon (client and AI) */}
                      {isFirstInGroup ? (
                        msg.isClient ? (
                          <div className="flex flex-col items-center md:block">
                            {isFirstInGroup && (
                              <span className="text-sm font-medium text-slate-600 dark:text-white mb-1 md:hidden text-center w-full">{msg.sender}</span>
                            )}
                            {msg.avatar ? (
                              <img 
                                alt={msg.sender} 
                                className="w-9 h-9 rounded-full flex-shrink-0" 
                                src={msg.avatar} 
                              />
                            ) : (
                              <div 
                                className="w-9 h-9 bg-orange-500 flex items-center justify-center rounded-full text-[10px] text-white font-medium flex-shrink-0"
                                style={{ backgroundColor: '#F07000' }}
                              >
                                {msg.sender.charAt(0).toUpperCase()}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col items-center md:block">
                            {/* Mobile: label centered above icon */}
                            {isFirstInGroup && (
                              <span className="text-sm font-medium text-slate-600 dark:text-white mb-1 md:hidden text-center w-full">{msg.sender === 'Altese AI' ? 'AI' : msg.sender}</span>
                            )}
                            <div 
                              className="w-9 h-9 bg-navy flex items-center justify-center rounded-full text-[10px] text-white font-medium flex-shrink-0" 
                              style={{ backgroundColor: '#003070' }}
                            >
                              {((msg.sender === 'Altese AI' ? 'AI' : msg.sender) || 'AI').substring(0, 2).toUpperCase() || 'AI'}
                            </div>
                          </div>
                        )
                      ) : (
                        // Spacer to maintain alignment when avatar is hidden - hidden on mobile to avoid vertical gap
                        <div className="hidden md:block w-9 h-9 flex-shrink-0" />
                      )}
                      <div className={`flex-1 min-w-0 ${msg.isClient ? '' : 'flex flex-col items-end'}`}>
                        {/* Show sender name only for first message in group - hidden on mobile (shown above icon) */}
                        {isFirstInGroup && (
                          <div className={`hidden md:flex items-center gap-1.5 mb-1 ${msg.isClient ? '' : 'flex-row-reverse'}`}>
                            <span className="text-sm font-medium text-slate-600 dark:text-white">{msg.sender === 'Altese AI' ? 'AI' : msg.sender}</span>
                          </div>
                        )}
                        <div 
                          className={`inline-block px-3.5 py-2.5 text-sm leading-relaxed max-w-[95%] ${customerSidebarOpen ? 'md:max-w-[85%]' : 'md:max-w-[90%]'} ${
                            (() => {
                              const origin = (msg as any).origin || (msg as any).metadata?.origin;
                              if (origin === 'AI') return 'bg-blue-600 dark:bg-orange-500 text-white rounded-2xl rounded-tr-md shadow-sm';
                              if (origin === 'SELLER') return 'bg-green-50 dark:bg-green-900/20 text-slate-800 dark:text-slate-100 rounded-2xl rounded-tr-md shadow-sm';
                              // CLIENT (ou fallback quando origin não disponível e isClient)
                              return 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-2xl rounded-tl-md shadow-sm border border-slate-100 dark:border-slate-700';
                            })()
                          }`}
                        >
                          {/* Render media player if message has media */}
                          {msg.metadata?.mediaUrl && msg.metadata?.mediaType && (
                            <div className="mb-2">
                              <MediaPlayer
                                mediaUrl={msg.metadata.mediaUrl}
                                mediaType={msg.metadata.mediaType}
                                caption={msg.content && msg.content !== '[Mídia]' && msg.content !== '[Enviando mídia...]' ? msg.content : undefined}
                                messageId={msg.id}
                              />
                            </div>
                          )}
                          
                          {/* Render text content: preserva \n e espaços em branco (whitespace-pre-wrap) */}
                          {!msg.metadata?.mediaUrl && (
                            <div className="whitespace-pre-wrap break-words">
                              {(() => {
                                const raw = msg.content === '[Processando imagem...]' ? '[Imagem]' : msg.content === '[Processando áudio...]' ? '[Áudio]' : (msg.content ?? '');
                                return String(raw)
                                  .replace(/\\n/g, '\n')
                                  .replace(/\r\n/g, '\n')
                                  .replace(/\r/g, '\n');
                              })()}
                            </div>
                          )}
                          
                          {msg.hasLink && !msg.metadata?.mediaUrl && (
                            <a 
                              className="block text-accent hover:underline mt-2 font-medium break-all text-xs" 
                              href="#" 
                              style={{ color: '#40B0E0' }}
                              onClick={(e) => {
                                e.preventDefault();
                                const urlMatch = msg.content.match(/https?:\/\/[^\s]+/);
                                if (urlMatch) {
                                  window.open(urlMatch[0], '_blank');
                                }
                              }}
                            >
                              {msg.content.match(/https?:\/\/[^\s]+/)?.[0] || 'https://www.altese.com.br/pecas/018900z'}
                            </a>
                          )}
                          {msg.attachments && (
                            <div className="flex flex-wrap gap-2 mt-3">
                              {msg.attachments.map((att, idx) => (
                                <button 
                                  key={idx} 
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white dark:bg-slate-700 rounded-lg text-xs border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors"
                                >
                                  <span className="material-icons-round text-sm text-slate-500 dark:text-slate-400">description</span>
                                  <span className="text-slate-700 dark:text-slate-200">{att}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          
                          {/* Timestamp inside message bubble - reduced size */}
                          <div className={`flex items-center mt-1.5 ${msg.isClient ? 'justify-start' : 'justify-end'}`}>
                            <span
                              className={`text-[9px] opacity-90 ${(() => {
                                const o = (msg as any).origin || (msg as any).metadata?.origin;
                                // IA (balão azul) → horário branco
                                if (o === 'AI') {
                                  return 'text-white';
                                }
                                // Vendedor/Supervisor (balão verde claro) → horário preto no claro e branco no dark
                                if (o === 'SELLER') {
                                  return 'text-slate-900 dark:text-white';
                                }
                                // Client ou outros: cinza suave no claro e branco no dark para legibilidade
                                return 'text-slate-500 dark:text-white opacity-90';
                              })()}`}
                            >
                              {msg.time}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                      </React.Fragment>
                    );
                    });
                  })()}
                  {/* Show typing indicator if AI is typing - só quando IA está ativa (não desativada) */}
                  {selectedConversation && isAITyping[selectedConversation] && selectedConversationData?.handledBy === 'AI' && !aiStatus[selectedConversation as string]?.disabled && (
                    <TypingIndicator sender="AI" isClient={false} />
                  )}
                  {/* Show typing indicator if client is typing for this conversation */}
                  {(() => {
                    const convId = selectedConversation ? String(selectedConversation) : null;
                    const isTyping = convId && isClientTyping[convId];
                    const hasData = !!selectedConversationData;
                    
                    // Log apenas quando há mudança relevante
                    if (convId) {
                      const typingValue = isClientTyping[convId];
                      console.log('🔍 Checking typing render conditions', {
                        selectedConversation: convId,
                        isTyping: !!typingValue,
                        typingValue,
                        hasData,
                        allTypingKeys: Object.keys(isClientTyping),
                        allTypingValues: Object.entries(isClientTyping),
                        conversationData: selectedConversationData ? {
                          id: selectedConversationData.id,
                          clientName: selectedConversationData.clientName,
                        } : null,
                      });
                      
                      if (typingValue) {
                        console.log('✅ RENDERING CLIENT TYPING INDICATOR NOW!', {
                          convId,
                          clientName: selectedConversationData?.clientName || 'Cliente',
                        });
                        return (
                          <TypingIndicator 
                            sender={selectedConversationData?.clientName || 'Cliente'} 
                            isClient={true} 
                          />
                        );
                      }
                    }
                    return null;
                  })()}
                </div>
              )}
            </div>
            <div className={`${customerSidebarOpen ? 'p-4' : 'p-3 md:p-4 pr-4 md:pr-6'} bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex-shrink-0 pb-0 md:pb-4`}>
              {/* Assume/Return Control Banner - Integrated in bottom bar */}
              {selectedConversationData?.handledBy === 'AI' ? (
                <div className={`${customerSidebarOpen ? 'max-w-4xl mx-auto' : 'w-full'} flex items-center justify-between px-4 py-3 bg-slate-100 dark:bg-slate-800 rounded-xl animate-assumeBannerShrink`}>
                  <div className="flex items-center space-x-3">
                    <div className={`flex items-center justify-center w-10 h-10 rounded-full ${aiStatus[selectedConversation as string]?.disabled ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-green-100 dark:bg-green-900/30'}`}>
                      <span className={`material-icons-round text-xl ${aiStatus[selectedConversation as string]?.disabled ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                        {aiStatus[selectedConversation as string]?.disabled ? 'pause_circle' : 'smart_toy'}
                      </span>
                    </div>
                    <div className="animate-innerTextFade">
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                        {aiStatus[selectedConversation as string]?.disabled
                          ? 'IA desativada'
                          : 'IA respondendo'}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {aiStatus[selectedConversation as string]?.disabled
                          ? 'Reative a IA ou clique em "Assumir Atendimento" para responder'
                          : 'Clique em "Assumir Atendimento" para poder responder'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        await attendanceService.assumeAttendance(selectedConversation as string);
                        
                        // Stop AI typing indicator immediately when human assumes
                        setIsAITyping((prev) => ({ ...prev, [selectedConversation as string]: false }));
                        if (typingTimeoutRef.current[selectedConversation as string]) {
                          clearTimeout(typingTimeoutRef.current[selectedConversation as string]);
                        }
                        
                        setSelectedConversationData({
                          ...selectedConversationData,
                          handledBy: 'HUMAN',
                        });
                        setConversations((prev) =>
                          prev.map((conv) =>
                            conv.id === selectedConversation
                              ? { ...conv, handledBy: 'HUMAN' }
                              : conv
                          )
                        );
                        toast.success('Atendimento assumido com sucesso');
                      } catch (error: any) {
                        console.error('Error assuming attendance:', error);
                        toast.error(error.response?.data?.error || 'Erro ao assumir atendimento');
                      }
                    }}
                    className="flex items-center space-x-2 px-4 py-2 bg-navy text-white rounded-lg hover:bg-navy/90 transition-all text-sm font-medium shadow-sm hover:shadow-md"
                    style={{ backgroundColor: '#003070' }}
                  >
                    <span className="material-icons-round text-sm">person</span>
                    <span>Assumir Atendimento</span>
                  </button>
                </div>
              ) : selectedConversationData?.handledBy === 'HUMAN' ? (
                <div className={`${customerSidebarOpen ? 'max-w-4xl mx-auto' : 'w-full'} flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3 px-3 py-2 md:px-4 md:py-3 bg-slate-100 dark:bg-slate-800 rounded-xl mb-3 animate-assumeBannerGrow`}>
                  <div className="flex items-center space-x-2 md:space-x-3 min-w-0">
                    <div className="flex items-center justify-center w-8 h-8 md:w-10 md:h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex-shrink-0">
                      <span className="material-icons-round text-blue-600 dark:text-blue-400 text-base md:text-xl">person</span>
                    </div>
                    <div className="min-w-0 flex-1 animate-innerTextFade">
                      <p className="text-xs md:text-sm font-semibold text-slate-700 dark:text-slate-200 leading-tight">
                        Você está respondendo
                      </p>
                      <p className="text-[10px] md:text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-tight">
                        IA armazena o contexto
                      </p>
                      <div className="min-h-[1.25rem] mt-0.5 flex items-center">
                        {selectedConversation && inactivityTimer[selectedConversation as string] !== undefined && inactivityTimer[selectedConversation as string] > 0 && !aiStatus[selectedConversation as string]?.disabled && (
                          <p className="text-[10px] md:text-xs font-semibold text-orange-600 dark:text-orange-400 leading-tight">
                            Devolve em: {formatTimer(inactivityTimer[selectedConversation as string])}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      if (isReturningToAI || !selectedConversation) return;
                      
                      setIsReturningToAI(true);
                      try {
                        await attendanceService.returnAttendanceToAI(selectedConversation as string);
                        setSelectedConversationData({
                          ...selectedConversationData,
                          handledBy: 'AI',
                        });
                        setConversations((prev) =>
                          prev.map((conv) =>
                            conv.id === selectedConversation
                              ? { ...conv, handledBy: 'AI' }
                              : conv
                          )
                        );
                        if (inactivityTimerIntervalRef.current[selectedConversation as string]) {
                          clearInterval(inactivityTimerIntervalRef.current[selectedConversation as string]);
                          delete inactivityTimerIntervalRef.current[selectedConversation as string];
                        }
                        setInactivityTimer((prev) => {
                          const updated = { ...prev };
                          delete updated[selectedConversation as string];
                          return updated;
                        });
                        toast.success('Atendimento devolvido para IA');
                      } catch (error: any) {
                        console.error('Error returning attendance to AI:', error);
                        // Check if it's a network error
                        if (error.code === 'ERR_NETWORK' || error.message?.includes('Network Error')) {
                          toast.error('Erro de conexão. Verifique sua internet e tente novamente.');
                        } else if (error.response?.status === 400) {
                          toast.error(error.response?.data?.error || 'Não foi possível devolver o atendimento');
                        } else {
                          toast.error(error.response?.data?.error || 'Erro ao devolver atendimento. Tente novamente.');
                        }
                      } finally {
                        setIsReturningToAI(false);
                      }
                    }}
                    disabled={isReturningToAI || !selectedConversation}
                    className="flex items-center justify-center space-x-2 px-3 py-2 md:px-4 md:py-2.5 w-full md:w-auto bg-green-600 text-white rounded-lg hover:bg-green-700 transition-all text-xs md:text-sm font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                  >
                    {isReturningToAI ? (
                      <>
                        <span className="material-icons-round text-sm animate-spin">refresh</span>
                        <span>Devolvendo...</span>
                      </>
                    ) : (
                      <>
                        <span className="material-icons-round text-sm">smart_toy</span>
                        <span>Devolver para IA</span>
                      </>
                    )}
                  </button>
                </div>
              ) : null}
              
              {/* Message input area - only show when human is handling. Shift+Enter = quebra linha, Enter = enviar */}
              {selectedConversationData?.handledBy === 'HUMAN' && (
                <div className={`${customerSidebarOpen ? 'max-w-4xl mx-auto' : 'w-full'} flex items-center gap-2 sm:gap-4 bg-slate-100 dark:bg-slate-800 p-2 md:p-3 rounded-xl`}>
                  <textarea
                    ref={chatMessageTextareaRef}
                    className="flex-grow min-h-[36px] md:min-h-[44px] max-h-[120px] resize-none bg-transparent border-none focus:ring-0 text-sm px-2 py-1.5 md:py-2 outline-none overflow-hidden text-slate-900 dark:text-white placeholder-slate-400 leading-normal"
                    placeholder=""
                    rows={1}
                    style={{ maxHeight: 200 }}
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onPaste={(e) => {
                      const items = e.clipboardData?.items;
                      if (!items) return;
                      for (const item of items) {
                        if (item.type.startsWith('image/')) {
                          e.preventDefault();
                          const file = item.getAsFile();
                          if (file) {
                            setPastedImage(file);
                            setMessageInput('');
                            toast.success('Imagem colada. Confirme o envio abaixo.');
                          }
                          break;
                        }
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    disabled={!selectedConversation || !!pastedImage}
                  />
                  <div className="flex items-center justify-center gap-1 md:gap-2 text-slate-500 relative flex-shrink-0">
                    {pastedImage && (
                      <div className="flex items-center gap-2 mr-2">
                        <div className="relative w-10 h-10 rounded overflow-hidden border border-slate-200 dark:border-slate-700">
                          <img
                            src={URL.createObjectURL(pastedImage)}
                            alt={pastedImage.name}
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => setPastedImage(null)}
                            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-slate-700 text-white text-[10px] flex items-center justify-center leading-none"
                            aria-label="Remover imagem"
                          >
                            ×
                          </button>
                        </div>
                        <span className="text-xs text-slate-600 dark:text-slate-300 truncate max-w-[140px]">
                          {pastedImage.name}
                        </span>
                      </div>
                    )}
                    <MediaUpload
                      onFileSelect={handleSendMedia}
                      onCancel={() => {}}
                      disabled={!selectedConversation}
                    />
                    <button 
                      className="hover:text-navy transition-colors disabled:opacity-50 p-1.5 md:p-2 flex items-center justify-center" 
                      disabled={!selectedConversation}
                      onClick={() => setShowAudioRecorder(true)}
                      title="Gravar áudio"
                    >
                      <span className="material-icons-round text-xl">mic</span>
                    </button>
                    <div className="relative" ref={emojiPickerRef}>
                      <button 
                        className="hover:text-navy transition-colors disabled:opacity-50 p-1.5 md:p-2 flex items-center justify-center" 
                        disabled={!selectedConversation}
                        onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                        title="Emojis"
                      >
                        <span className="material-icons-round text-xl">sentiment_satisfied</span>
                      </button>
                      {showEmojiPicker && (
                        <EmojiPicker
                          onEmojiSelect={handleEmojiSelect}
                          onClose={() => setShowEmojiPicker(false)}
                        />
                      )}
                    </div>
                  </div>
                  <button
                    className="bg-navy text-white p-1.5 md:p-2 rounded-lg hover:bg-navy/90 transition-transform active:scale-95 flex items-center justify-center flex-shrink-0 min-w-[36px] min-h-[36px] md:min-w-[40px] md:min-h-[40px]"
                    style={{ backgroundColor: '#003070' }}
                    onClick={async () => {
                      if (pastedImage && selectedConversation) {
                        await handleSendMedia(pastedImage);
                        setPastedImage(null);
                        return;
                      }
                      handleSendMessage();
                    }}
                    disabled={!selectedConversation}
                  >
                    <span className="material-icons-round transform rotate-[-45deg] relative left-0.5">send</span>
                  </button>
                </div>
              )}
            </div>
            {showAudioRecorder && (
              <AudioRecorder
                onRecordingComplete={handleSendAudioRecording}
                onCancel={() => setShowAudioRecorder(false)}
              />
            )}
          </div>
        ) : (isPedidosOrcamentosView || selectedTodasDemandasSubdivision) && !selectedQuote ? (
          <div className="flex-grow overflow-y-auto p-6 flex items-center justify-center bg-slate-100 dark:bg-slate-950">
            <div className="text-center max-w-md">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4" style={{ backgroundColor: '#FEF3E2' }}>
                <span className="material-icons-round text-primary text-3xl" style={{ color: '#F07000' }}>description</span>
              </div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
                {selectedTodasDemandasSubdivision === '__all__' ? 'Todas as Demandas' : isPedidosOrcamentosView ? 'Pedidos de Orçamentos' : 'Pendência'}
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">Selecione uma pendência na lista à esquerda para ver os detalhes.</p>
            </div>
          </div>
        ) : selectedSeller && conversations.length === 0 ? (
          <div className="flex items-center justify-center h-full w-full bg-slate-100 dark:bg-slate-950">
            <div className="text-center">
              <span className="material-icons-round text-6xl text-slate-400 mb-4">person</span>
              <p className="text-slate-500 dark:text-slate-400">Nenhuma conversa encontrada para este vendedor</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full w-full bg-slate-100 dark:bg-slate-950">
            <div className="text-center">
              <span className="material-icons-round text-6xl text-slate-400 mb-4">chat_bubble_outline</span>
              <p className="text-slate-500 dark:text-slate-400">Selecione uma conversa ou vendedor para começar</p>
            </div>
          </div>
        )
        }
        </div>
      </main>
      </div>

      {/* Customer Info Sidebar - transição suave; w-0 ao fechar evita buraco; entrada animada ao abrir */}
      {activeSupervisorTab === 'chat' && selectedConversation && (
        <aside 
          className={`hidden md:block bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 overflow-y-auto custom-scrollbar flex-shrink-0 transition-all duration-300 ease-in-out dark:[&_.text-slate-400]:text-slate-300 dark:[&_.text-slate-500]:text-slate-300 dark:[&_.text-slate-600]:text-slate-200 ${
            customerSidebarOpen 
              ? 'w-80 translate-x-0 opacity-100 animate-sidebarPaneEntrance' 
              : 'w-0 min-w-0 translate-x-full opacity-0 pointer-events-none overflow-hidden'
          }`}
        >
            <div className="p-6 text-center border-b border-slate-100 dark:border-slate-800">
              {selectedConvAvatar ? (
                <img
                  alt="Customer Profile"
                  className="w-16 h-16 rounded-full mx-auto mb-4 border-2 border-slate-100 dark:border-slate-800"
                  src={selectedConvAvatar}
                />
              ) : (
                <div
                  className="w-16 h-16 bg-orange-500 flex items-center justify-center rounded-full mx-auto mb-4 border-2 border-slate-100 dark:border-slate-800 text-white text-2xl font-bold"
                  style={{ backgroundColor: '#F07000' }}
                >
                  {(selectedConversationData?.clientName || selectedConvName || 'C').charAt(0).toUpperCase()}
                </div>
              )}
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                {selectedConversationData?.clientName || selectedConvName || 'Cliente'}
              </h3>
              {selectedConversationData?.clientPhone && (
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 flex items-center justify-center space-x-1">
                  <span className="material-icons-round text-sm">phone</span>
                  <span>{formatPhoneNumber(selectedConversationData.clientPhone)}</span>
                </p>
              )}
            </div>
            <div className="p-6 space-y-4">
              <div
                className="transition-opacity duration-500 ease-out space-y-5"
                style={{ opacity: sidebarDetailsReady ? 1 : 0 }}
              >
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-3 text-slate-500 dark:text-slate-200">
                  <div className="p-1.5 bg-green-50 dark:bg-green-900/20 rounded-md">
                    <span className="material-icons-round text-green-500 text-sm">auto_awesome</span>
                  </div>
                  <span className="font-medium text-slate-700 dark:text-white">Status:</span>
                </div>
                <span className={`font-bold flex items-center space-x-1 ${
                  selectedConversationData?.state === 'OPEN'
                    ? 'text-green-600 dark:text-green-300'
                    : selectedConversationData?.state === 'IN_PROGRESS'
                      ? 'text-blue-600 dark:text-blue-300'
                      : 'text-slate-500 dark:text-slate-200'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    selectedConversationData?.state === 'OPEN' ? 'bg-green-600' :
                    selectedConversationData?.state === 'IN_PROGRESS' ? 'bg-blue-600' :
                    'bg-slate-500'
                  }`}></span>
                  <span>
                    {selectedConversationData?.state === 'OPEN' ? 'Aberto' :
                     selectedConversationData?.state === 'IN_PROGRESS' ? 'Em Andamento' :
                     selectedConversationData?.state === 'FINISHED' ? 'Finalizado' : 'Ativo'}
                  </span>
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-3 text-slate-500 dark:text-slate-200">
                  <div className="p-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-md">
                    <span className="material-icons-round text-blue-500 text-sm">person</span>
                  </div>
                  <span className="font-medium text-slate-700 dark:text-white">Sendo atendido por:</span>
                </div>
                <span className="font-bold text-slate-700 dark:text-slate-100">
                  {selectedConversationData?.handledBy === 'AI' ? 'IA' : 'Humano'}
                </span>
              </div>
              {selectedConversationData?.clientPhone && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center space-x-3 text-slate-500 dark:text-slate-200">
                    <div className="p-1.5 bg-slate-100 dark:bg-slate-800 rounded-md">
                      <span className="material-icons-round text-slate-600 dark:text-slate-400 text-sm">phone</span>
                    </div>
                    <span className="font-medium text-slate-700 dark:text-white">Telefone:</span>
                  </div>
                  <span className="font-bold text-slate-700 dark:text-slate-100">{formatPhoneNumber(selectedConversationData.clientPhone)}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-3 text-slate-500 dark:text-slate-200">
                  <div className="p-1.5 bg-purple-50 dark:bg-purple-900/20 rounded-md">
                    <span className="material-icons-round text-purple-500 text-sm">visibility</span>
                  </div>
                  <span className="font-medium text-slate-700 dark:text-white">Último Contato:</span>
                </div>
                <span className="font-bold text-slate-700 dark:text-slate-100">
                  {selectedConversationData?.lastMessageTime ? (() => {
                    const lastContact = new Date(selectedConversationData.lastMessageTime);
                    const now = new Date();
                    const diffMs = now.getTime() - lastContact.getTime();
                    const diffMins = Math.floor(diffMs / 60000);
                    const diffHours = Math.floor(diffMins / 60);
                    const diffDays = Math.floor(diffHours / 24);
                    
                    if (diffMins < 60) return `${diffMins}min atrás`;
                    if (diffHours < 24) return `${diffHours}h atrás`;
                    return `${diffDays} dias atrás`;
                  })() : 'N/A'}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-3 text-slate-500 dark:text-slate-200">
                  <div className="p-1.5 bg-yellow-50 dark:bg-yellow-900/20 rounded-md">
                    <span className="material-icons-round text-yellow-500 text-sm">bookmark</span>
                  </div>
                  <span className="font-medium text-slate-700 dark:text-white">Primeiro contato:</span>
                </div>
                <span className="font-bold text-slate-700 dark:text-slate-100">
                  {selectedConversationData?.createdAt ? (() => {
                    const created = new Date(selectedConversationData.createdAt);
                    const now = new Date();
                    const diffMs = now.getTime() - created.getTime();
                    const diffDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
                    
                    if (diffDays === 0) return 'Hoje';
                    if (diffDays === 1) return 'Há 1 dia';
                    return `Há ${diffDays} dias`;
                  })() : 'N/A'}
                </span>
              </div>
              </div>
              <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                <div className="flex items-center space-x-2 mb-3">
                  <div className="p-1.5 bg-cyan-50 dark:bg-cyan-900/20 rounded-md">
                    <span className="material-icons-round text-cyan-600 text-sm">history</span>
                  </div>
                  <span className="font-medium text-xs text-slate-700 dark:text-slate-300">
                    Histórico do contato
                  </span>
                </div>
                {isLoadingContactHistory && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">Carregando histórico...</p>
                )}
                {!isLoadingContactHistory && contactHistory.length === 0 && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">Sem histórico encontrado.</p>
                )}
                {contactHistory.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowFullContactHistoryModal(true)}
                    className="mt-3 w-full text-xs px-3 py-2 rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors"
                  >
                    Histórico completo
                  </button>
                )}
              </div>
              {(() => {
                const ac = selectedConversationData?.aiContext;
                const summary = ac?.interesseConversationSummary;
                const questions = ac?.interesseClientQuestions;
                if (!summary && questions == null) return null;
                const subLabel =
                  ac?.ai_subdivision === 'flash-day'
                    ? 'Flash Day'
                    : ac?.ai_subdivision === 'locacao-estudio'
                      ? 'Locação de estúdio'
                      : ac?.ai_subdivision === 'captacao-videos'
                        ? 'Captação de vídeos'
                        : 'Interesse (IA)';
                const questionsLines =
                  Array.isArray(questions) ? questions : questions != null && String(questions).trim() ? [String(questions)] : [];
                return (
                  <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                    <div className="flex items-center space-x-2 mb-3">
                      <div className="p-1.5 bg-violet-50 dark:bg-violet-900/20 rounded-md">
                        <span className="material-icons-round text-violet-600 text-sm">auto_awesome</span>
                      </div>
                      <span className="font-medium text-xs text-slate-700 dark:text-slate-300">
                        {subLabel}
                      </span>
                    </div>
                    {summary ? (
                      <div className="mb-3">
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block mb-1">Resumo da conversa</span>
                        <p className="text-xs text-slate-900 dark:text-white font-medium whitespace-pre-wrap break-words">{summary}</p>
                      </div>
                    ) : null}
                    {questionsLines.length > 0 ? (
                      <div>
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-medium block mb-1">Perguntas do cliente</span>
                        <ul className="list-disc list-inside space-y-1 text-xs text-slate-900 dark:text-white font-medium break-words">
                          {questionsLines.map((line, idx) => (
                            <li key={idx}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                );
              })()}
              {selectedConversationData?.interventionData && Object.keys(selectedConversationData.interventionData).length > 0 && (
                <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                  <div className="flex items-center space-x-2 mb-3">
                    <div className="p-1.5 bg-orange-50 dark:bg-orange-900/20 rounded-md">
                      <span className="material-icons-round text-orange-500 text-sm">fact_check</span>
                    </div>
                    <span className="font-medium text-xs text-slate-700 dark:text-slate-300">
                      {selectedConversationData.interventionType === 'encaminhados-ecommerce'
                        ? 'Informações enviadas ao E-commerce'
                        : 'Informações coletadas'}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {Object.entries(selectedConversationData.interventionData).map(([key, value]) => {
                      const label = INTERVENTION_DATA_LABELS[key] ?? key.replace(/_/g, ' ').replace(/-/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
                      const displayValue = (key === 'client_phone' || key === 'clientPhone') && typeof value === 'string'
                        ? formatPhoneNumber(value)
                        : String(value ?? '—');
                      return (
                        <div key={key} className="flex flex-col text-xs">
                          <span className="text-slate-500 dark:text-slate-400 font-medium">{label}</span>
                          <span className="text-slate-900 dark:text-white font-bold break-words">{displayValue}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 space-y-3">
              {/* Botão Toggle IA - só mostra se o atendimento não estiver fechado */}
              {selectedConversationData?.state !== 'FINISHED' && (
                <button
                  onClick={async () => {
                    if (!selectedConversation) return;
                    const convId = selectedConversation as string;
                    const isCurrentlyDisabled = aiStatus[convId]?.disabled;
                    try {
                      if (isCurrentlyDisabled) {
                        await attendanceService.enableAI(convId);
                        setAiStatus((prev) => ({ ...prev, [convId]: { disabled: false } }));
                        toast.success('IA reativada para este atendimento');
                      } else {
                        await attendanceService.disableAI(convId);
                        setAiStatus((prev) => ({ ...prev, [convId]: { disabled: true } }));
                        toast.success('IA desligada para este atendimento');
                      }
                    } catch (error: any) {
                      console.error('Error toggling AI:', error);
                      toast.error(error.response?.data?.error || 'Erro ao alterar estado da IA');
                    }
                  }}
                  className={`w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-lg transition-colors ${
                    aiStatus[selectedConversation as string]?.disabled
                      ? 'bg-green-50 dark:bg-green-900/20 hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600 dark:text-green-400'
                      : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30 text-amber-600 dark:text-amber-400'
                  }`}
                >
                  <span className="material-icons-round text-sm">
                    {aiStatus[selectedConversation as string]?.disabled ? 'smart_toy' : 'block'}
                  </span>
                  <span className="text-sm font-medium">
                    {aiStatus[selectedConversation as string]?.disabled ? 'Ligar IA' : 'Desligar IA'}
                  </span>
                </button>
              )}
              {/* Botão Fechar Atendimento - só mostra se não estiver fechado */}
              {selectedConversationData?.state !== 'FINISHED' && (
                <button
                  onClick={async () => {
                    if (!selectedConversation) return;
                    
                    if (!confirm('Tem certeza que deseja fechar este atendimento?')) {
                      return;
                    }

                    try {
                      await attendanceService.closeAttendance(selectedConversation as string);
                      toast.success('Atendimento fechado com sucesso');
                    } catch (error: any) {
                      console.error('Error closing attendance:', error);
                      toast.error(error.response?.data?.error || 'Erro ao fechar atendimento');
                    }
                  }}
                  className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-orange-50 dark:bg-orange-900/20 hover:bg-orange-100 dark:hover:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded-lg transition-colors"
                >
                  <span className="material-icons-round text-sm">close</span>
                  <span className="text-sm font-medium">Fechar Atendimento</span>
                </button>
              )}
              
              {/* Botão Excluir Contato - exclui TODOS os atendimentos e contato importado pelo telefone */}
              <button
                onClick={async () => {
                  if (!selectedConversation || !selectedConversationData?.clientPhone) return;
                  
                  if (!confirm('Tem certeza que deseja excluir este contato? Todos os atendimentos serão removidos. Esta ação não pode ser desfeita.')) {
                    return;
                  }

                  try {
                    await contactsService.deleteContact(selectedConversationData.clientPhone);
                    // Remove from conversations list
                    setConversations((prev) => prev.filter(c => c.id !== selectedConversation));
                    // Clear selected conversation
                    setSelectedConversation(null);
                    setSelectedConversationData(null);
                    setMessages([]);
                    // Atualizar lista de contatos (para quando voltar à aba Contatos)
                    const contacts = await contactsService.listContacts();
                    setContactsList(contacts);
                    toast.success('Contato excluído com sucesso');
                  } catch (error: any) {
                    console.error('Error deleting contact:', error);
                    toast.error(error.response?.data?.error || 'Erro ao excluir contato');
                  }
                }}
                className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg transition-colors"
              >
                <span className="material-icons-round text-sm">delete</span>
                <span className="text-sm font-medium">Excluir Contato</span>
              </button>
            </div>
        </aside>
      )}

      {/* Mobile Customer Info Overlay */}
      {activeSupervisorTab === 'chat' && selectedConversation && mobileCustomerInfoOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-black/50" onClick={() => setMobileCustomerInfoOpen(false)}>
          <div
            className="absolute inset-x-0 bottom-0 max-h-[85vh] bg-white dark:bg-slate-900 rounded-t-2xl overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 flex items-center justify-between px-5 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 z-10">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">Detalhes do cliente</h3>
              <button type="button" onClick={() => setMobileCustomerInfoOpen(false)} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                <span className="material-icons-round">close</span>
              </button>
            </div>
            <div className="p-5 text-center border-b border-slate-100 dark:border-slate-800">
              <div
                className="w-14 h-14 bg-orange-500 flex items-center justify-center rounded-full mx-auto mb-3 text-white text-xl font-bold"
                style={{ backgroundColor: '#F07000' }}
              >
                {(selectedConversationData?.clientName || selectedConvName || 'C').charAt(0).toUpperCase()}
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                {selectedConversationData?.clientName || selectedConvName || 'Cliente'}
              </h3>
              {selectedConversationData?.clientPhone && (
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">{formatPhoneNumber(selectedConversationData.clientPhone)}</p>
              )}
            </div>
            <div className="p-5 space-y-4">
              <div
                className="transition-opacity duration-500 ease-out space-y-5"
                style={{ opacity: sidebarDetailsReady ? 1 : 0 }}
              >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700 dark:text-white">Status:</span>
                <span className="font-bold text-slate-700 dark:text-slate-100">
                  {selectedConversationData?.state === 'OPEN' ? 'Aberto' : selectedConversationData?.state === 'IN_PROGRESS' ? 'Em Andamento' : selectedConversationData?.state === 'FINISHED' ? 'Finalizado' : 'Ativo'}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700 dark:text-white">Atendido por:</span>
                <span className="font-bold text-slate-700 dark:text-slate-100">{selectedConversationData?.handledBy === 'AI' ? 'IA' : 'Humano'}</span>
              </div>
              {selectedConversationData?.clientPhone && (
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-700 dark:text-white">Telefone:</span>
                  <span className="font-bold text-slate-700 dark:text-slate-100">{formatPhoneNumber(selectedConversationData.clientPhone)}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700 dark:text-white">Último contato:</span>
                <span className="font-bold text-slate-700 dark:text-slate-100">
                  {selectedConversationData?.lastMessageTime ? (() => {
                    const d = new Date(selectedConversationData.lastMessageTime);
                    const diff = Math.floor((Date.now() - d.getTime()) / 60000);
                    return diff < 60 ? `${diff}min` : diff < 1440 ? `${Math.floor(diff / 60)}h` : `${Math.floor(diff / 1440)}d`;
                  })() : 'N/A'}
                </span>
              </div>
              </div>
              {selectedConversationData?.interventionData && Object.keys(selectedConversationData.interventionData).length > 0 && (
                <div className="pt-3 border-t border-slate-200 dark:border-slate-700 space-y-2">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Informações coletadas</span>
                  {Object.entries(selectedConversationData.interventionData).map(([key, value]) => {
                    const label = INTERVENTION_DATA_LABELS[key] ?? key.replace(/_/g, ' ').replace(/-/g, ' ');
                    return (
                      <div key={key} className="flex flex-col text-xs">
                        <span className="text-slate-500 dark:text-slate-400">{label}</span>
                        <span className="text-slate-900 dark:text-white font-bold break-words">{String(value ?? '—')}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-5 pb-6 space-y-2">
              {selectedConversationData?.state !== 'FINISHED' && (
                <>
                  <button
                    onClick={async () => {
                      if (!selectedConversation) return;
                      const convId = selectedConversation as string;
                      const isDisabled = aiStatus[convId]?.disabled;
                      try {
                        if (isDisabled) {
                          await attendanceService.enableAI(convId);
                          setAiStatus((prev) => ({ ...prev, [convId]: { disabled: false } }));
                          toast.success('IA reativada');
                        } else {
                          await attendanceService.disableAI(convId);
                          setAiStatus((prev) => ({ ...prev, [convId]: { disabled: true } }));
                          toast.success('IA desligada');
                        }
                      } catch (err: any) {
                        toast.error(err.response?.data?.error || 'Erro');
                      }
                      setMobileCustomerInfoOpen(false);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
                  >
                    <span className="material-icons-round text-sm">{aiStatus[selectedConversation as string]?.disabled ? 'smart_toy' : 'block'}</span>
                    {aiStatus[selectedConversation as string]?.disabled ? 'Ligar IA' : 'Desligar IA'}
                  </button>
                  <button
                    onClick={async () => {
                      if (!selectedConversation || !confirm('Fechar atendimento?')) return;
                      try {
                        await attendanceService.closeAttendance(selectedConversation as string);
                        toast.success('Atendimento fechado');
                        setMobileCustomerInfoOpen(false);
                      } catch (err: any) {
                        toast.error(err.response?.data?.error || 'Erro');
                      }
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400"
                  >
                    <span className="material-icons-round text-sm">close</span>
                    Fechar Atendimento
                  </button>
                </>
              )}
              <button
                onClick={async () => {
                  if (!selectedConversation || !selectedConversationData?.clientPhone || !confirm('Excluir contato? Todos os atendimentos serão removidos.')) return;
                  try {
                    await contactsService.deleteContact(selectedConversationData.clientPhone);
                    setConversations((prev) => prev.filter((c) => c.id !== selectedConversation));
                    setSelectedConversation(null);
                    setSelectedConversationData(null);
                    setMessages([]);
                    setMobileCustomerInfoOpen(false);
                    setMobileChatLayer('conversations');
                    const contacts = await contactsService.listContacts();
                    setContactsList(contacts);
                    toast.success('Contato excluído');
                  } catch (err: any) {
                    toast.error(err.response?.data?.error || 'Erro');
                  }
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400"
              >
                <span className="material-icons-round text-sm">delete</span>
                Excluir Contato
              </button>
            </div>
          </div>
        </div>
      )}

      {showFullContactHistoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">Histórico completo do contato</h3>
              <button
                type="button"
                onClick={() => setShowFullContactHistoryModal(false)}
                className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              >
                <span className="material-icons-round text-lg">close</span>
              </button>
            </div>
            <div className="p-5 overflow-y-auto custom-scrollbar bg-slate-50 dark:bg-slate-950">
              <div className="max-w-2xl mx-auto space-y-3">
                {contactHistory
                .flatMap((item) =>
                  item.messages.map((m) => ({
                    ...m,
                    attendanceId: item.attendanceId,
                  }))
                )
                .filter((m) => !isLegacyRelocationSystemMessage(m as any))
                .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime())
                .map((m) => {
                  const isClient = m.origin === 'CLIENT' || m.isClient;
                  const bubbleClass = isClient
                    ? 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-2xl rounded-tl-md border border-slate-100 dark:border-slate-700'
                    : m.origin === 'AI'
                      ? 'bg-blue-600 dark:bg-orange-500 text-white rounded-2xl rounded-tr-md'
                      : m.origin === 'SYSTEM'
                        ? 'bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 rounded-2xl rounded-tr-md'
                        : 'bg-green-50 dark:bg-green-900/20 text-slate-800 dark:text-slate-100 rounded-2xl rounded-tr-md';
                  return (
                    <div key={m.id} className={`flex items-start gap-2.5 ${isClient ? '' : 'flex-row-reverse'}`}>
                      <div className={`flex-1 min-w-0 ${isClient ? '' : 'flex flex-col items-end'}`}>
                        <div className={`flex items-center gap-1.5 mb-1 ${isClient ? '' : 'flex-row-reverse'}`}>
                          <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-300">
                            {m.sender}
                          </span>
                          <span className="text-[10px] text-slate-400">•</span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">
                            {new Date(m.sentAt).toLocaleString('pt-BR')}
                          </span>
                          <span className="text-[10px] text-slate-400">•</span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">
                            Atend. {String(m.attendanceId).slice(0, 8)}
                          </span>
                        </div>
                        <div className={`inline-block px-3 py-2 text-xs leading-relaxed max-w-[92%] break-words ${bubbleClass}`}>
                          {m.mediaUrl && m.mediaType ? (
                            <div className="space-y-1">
                              <MediaPlayer
                                mediaUrl={m.mediaUrl}
                                mediaType={m.mediaType}
                                caption={m.content && m.content !== '[Mídia]' && m.content !== '[Enviando mídia...]' ? m.content : undefined}
                                messageId={m.id}
                              />
                            </div>
                          ) : (
                            <span>{m.content}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
