import React, { useState, useEffect, useRef, useCallback, useMemo, startTransition } from 'react';
import { useAuthStore } from '../../store/auth.store';
import { MediaPlayer } from '../../components/Chat/MediaPlayer';
import { MediaUpload } from '../../components/Chat/MediaUpload';
import { AudioRecorder } from '../../components/Chat/AudioRecorder';
import { EmojiPicker } from '../../components/Chat/EmojiPicker';
import { TypingIndicator } from '../../components/Chat/TypingIndicator';
import { socketService } from '../../services/socket.service';
import { attendanceService, Conversation, ContactHistoryAttendance } from '../../services/attendance.service';
import { userService } from '../../services/user.service';
import { quoteService, type QuoteRequest } from '../../services/quote.service';
import { mediaService } from '../../services/media.service';
import { AIStatusControl } from '../../components/AIStatusControl';
import toast from 'react-hot-toast';

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
  peca_desejada: 'Peça Desejada',
  pecaDesejada: 'Peça Desejada',
  resumo_da_conversa: 'Resumo Da Conversa',
  resumoDaConversa: 'Resumo Da Conversa',
};

export const SellerDashboard: React.FC = () => {
  const { user } = useAuthStore();
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [selectedPendingType, setSelectedPendingType] = useState<string | null>(null);
  const [pendingMessages, setPendingMessages] = useState<Array<{ id: number; text: string; sender: string; timestamp: string }>>([]);
  const [selectedAttendanceFilter, setSelectedAttendanceFilter] = useState<string>('tudo');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAudioRecorder, setShowAudioRecorder] = useState(false);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const chatMessageTextareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingMessageTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [isAITyping, setIsAITyping] = useState<Record<string, boolean>>({});
  const [isClientTyping, setIsClientTyping] = useState<Record<string, boolean>>({});
  const typingTimeoutRef = useRef<Record<string, NodeJS.Timeout>>({});
  const clientTypingTimeoutRef = useRef<Record<string, NodeJS.Timeout>>({});
  const [inactivityTimer, setInactivityTimer] = useState<Record<string, number>>({}); // Time remaining in seconds (from backend)
  const inactivityTimerIntervalRef = useRef<Record<string, NodeJS.Timeout>>({});
  const [aiStatus, setAiStatus] = useState<Record<string, { disabled: boolean; remainingSeconds: number; isUnlimited: boolean }>>({});
  const aiStatusIntervalRef = useRef<Record<string, NodeJS.Timeout>>({}); // Intervals for fetching timer from backend
  const [isReturningToAI, setIsReturningToAI] = useState(false);

  const getConversationSortTimestamp = (c: Conversation): number => {
    const ts = (c as any).lastMessageTime || c.updatedAt || c.createdAt;
    if (!ts) return 0;
    const t = new Date(ts).getTime();
    return isNaN(t) ? 0 : t;
  };

  // Auto-resize textarea conforme o texto (altura máxima 200px)
  useEffect(() => {
    const adjust = (el: HTMLTextAreaElement | null) => {
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    };
    adjust(chatMessageTextareaRef.current);
    adjust(pendingMessageTextareaRef.current);
  }, [messageInput]);

  // Real data from API
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [contactHistory, setContactHistory] = useState<ContactHistoryAttendance[]>([]);
  const [isLoadingContactHistory, setIsLoadingContactHistory] = useState(false);
  const [showFullContactHistoryModal, setShowFullContactHistoryModal] = useState(false);
  const [refreshMessagesTrigger, setRefreshMessagesTrigger] = useState(0);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [customerSidebarOpen, setCustomerSidebarOpen] = useState(true);
  const [selectedConversationData, setSelectedConversationData] = useState<Conversation | null>(null);

  // Pedidos de Orçamento (cards)
  const [quoteCards, setQuoteCards] = useState<QuoteRequest[]>([]);
  const [sentQuoteCards, setSentQuoteCards] = useState<QuoteRequest[]>([]);
  const [isLoadingQuotes, setIsLoadingQuotes] = useState(false);
  const [selectedQuote, setSelectedQuote] = useState<QuoteRequest | null>(null);
  const [selectedQuoteForPerguntar, setSelectedQuoteForPerguntar] = useState<string | null>(null);
  const [perguntarText, setPerguntarText] = useState('');
  const [isSendingPerguntar, setIsSendingPerguntar] = useState(false);
  const [quoteResponseText, setQuoteResponseText] = useState('');
  const [quoteResponseImage, setQuoteResponseImage] = useState<File | null>(null);
  const [isSendingQuote, setIsSendingQuote] = useState(false);
  const [isDeletingQuote, setIsDeletingQuote] = useState<string | null>(null);
  /** Sub-aba dentro de Pedidos de Orçamento: pendentes | orçamentos enviados */
  const [quoteSubTab, setQuoteSubTab] = useState<'pendentes' | 'enviados'>('pendentes');
  /** VERDE: IDs de pedidos de orçamento visualizados pelo vendedor (baseado em sellerViewedAt do backend) */
  const [viewedQuoteIds, setViewedQuoteIds] = useState<Set<string>>(() => new Set());
  /** Seção Fechados: exibir atendimentos fechados do vendedor */
  const [selectedFechadosFilter, setSelectedFechadosFilter] = useState(false);
  const [isLoadingFechados, setIsLoadingFechados] = useState(false);
  const [isBulkSelectMode, setIsBulkSelectMode] = useState(false);
  const [selectedAttendancesForBulk, setSelectedAttendancesForBulk] = useState<Set<string>>(new Set());
  const [isClosingBulk, setIsClosingBulk] = useState(false);
  const [pastedImage, setPastedImage] = useState<File | null>(null);
  const [sellerUnavailableUntil, setSellerUnavailableUntil] = useState<string | null>(null);
  const [isUpdatingAvailability, setIsUpdatingAvailability] = useState(false);
  const [availabilityNow, setAvailabilityNow] = useState(() => Date.now());
  const [isDocumentHidden, setIsDocumentHidden] = useState<boolean>(
    typeof document !== 'undefined' ? document.hidden : false
  );
  const unreadReminderIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const themeStorageKey = useMemo(
    () => (user?.id ? `altese:theme:${user.id}` : 'altese:theme:guest'),
    [user?.id]
  );

  const isSellerUnavailable = useMemo(() => {
    if (!sellerUnavailableUntil) return false;
    const end = new Date(sellerUnavailableUntil).getTime();
    return Number.isFinite(end) && end > availabilityNow;
  }, [sellerUnavailableUntil, availabilityNow]);

  // Pedir permissão para notificações do Windows (quando o vendedor está fora da página)
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // Keep document visibility state updated (used for recurring reminders)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => setIsDocumentHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
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
    const shouldUseDark =
      savedTheme != null
        ? savedTheme === 'dark'
        : guestTheme != null
          ? guestTheme === 'dark'
          : legacyTheme != null
            ? legacyTheme === 'true' || legacyTheme === 'dark'
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
    document.documentElement.classList.toggle('dark', nextMode);
  }, [isDarkMode, themeStorageKey]);

  useEffect(() => {
    const loadAvailability = async () => {
      if (!user?.id) return;
      try {
        const data = await userService.getMySellerAvailability();
        setSellerUnavailableUntil(data.unavailableUntil);
      } catch (error) {
        console.error('Erro ao carregar disponibilidade do vendedor:', error);
      }
    };
    void loadAvailability();
  }, [user?.id]);

  // Construir set de IDs visualizados a partir de sellerViewedAt
  useEffect(() => {
    const viewed = new Set<string>();
    for (const q of quoteCards) {
      if (q.sellerViewedAt) viewed.add(q.id);
    }
    setViewedQuoteIds(viewed);
  }, [quoteCards]);

  const markQuoteAsViewed = useCallback((quoteId: string) => {
    // Atualizar localmente + chamar API do backend
    setViewedQuoteIds((prev) => {
      const next = new Set(prev);
      next.add(quoteId);
      return next;
    });
    // Atualizar quoteCards localmente para refletir sellerViewedAt
    setQuoteCards((prev) => prev.map((q) => q.id === quoteId ? { ...q, sellerViewedAt: new Date().toISOString() } : q));
    quoteService.markViewed(quoteId).catch((e) => console.error('Error marking quote as viewed:', e));
  }, []);

  const unviewedQuoteCount = quoteCards.filter((q) => !q.sellerViewedAt).length;

  // Marcar como visualizado sempre que um pedido for selecionado (garante que o badge verde atualize)
  useEffect(() => {
    if (selectedQuote?.id && selectedPendingType === 'pedidos-orcamentos' && quoteSubTab === 'pendentes') {
      markQuoteAsViewed(selectedQuote.id);
    }
  }, [selectedQuote?.id, selectedPendingType, quoteSubTab, markQuoteAsViewed]);

  // Clear typing indicator when conversation changes
  useEffect(() => {
    // Clear typing state for all conversations when switching
    setIsAITyping({});
    setIsClientTyping({});
    
    // Clear all typing timeouts
    Object.values(typingTimeoutRef.current).forEach((timeout) => {
      if (timeout) clearTimeout(timeout);
    });
    Object.values(clientTypingTimeoutRef.current).forEach((timeout) => {
      if (timeout) clearTimeout(timeout);
    });
    typingTimeoutRef.current = {};
    clientTypingTimeoutRef.current = {};
  }, [selectedConversation]);

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

  // Fetch AI status from backend for a conversation
  const fetchAIStatus = async (conversationId: string) => {
    try {
      const statusData = await attendanceService.getAIStatus(conversationId);
      setAiStatus((prev) => ({ 
        ...prev, 
        [conversationId]: {
          disabled: statusData.aiDisabled,
          remainingSeconds: statusData.remainingSeconds,
          isUnlimited: statusData.isUnlimited,
        }
      }));
    } catch (error) {
      console.error('Error fetching AI status:', error);
      setAiStatus((prev) => ({ 
        ...prev, 
        [conversationId]: { disabled: false, remainingSeconds: 0, isUnlimited: false }
      }));
    }
  };

  // Manage inactivity timer for assumed attendances - usa backend só para valor inicial e faz contagem local
  useEffect(() => {
    // Find all conversations handled by HUMAN
    const humanHandledConversations = conversations.filter(conv => conv.handledBy === 'HUMAN');
    
    // Start/update timers for human-handled conversations
    humanHandledConversations.forEach(conv => {
      // If timer interval doesn't exist for this conversation, initialize it
      if (!inactivityTimerIntervalRef.current[conv.id]) {
        // Fetch imediatamente o valor inicial
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

  const fetchFechadosConversations = useCallback(async () => {
    if (!user?.id || user?.role !== 'SELLER') return;
    setIsLoadingFechados(true);
    setIsLoadingConversations(true);
    try {
      const list = await attendanceService.getFechadosAttendancesBySeller(user.id);
      setConversations(list);
    } catch (e) {
      console.error('Error fetching fechados', e);
      toast.error('Erro ao carregar atendimentos fechados.');
      setConversations([]);
    } finally {
      setIsLoadingFechados(false);
      setIsLoadingConversations(false);
    }
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (!user?.id || user?.role !== 'SELLER') return;
    if (selectedFechadosFilter) {
      fetchFechadosConversations();
    } else {
      const loadConversations = async () => {
        try {
          setIsLoadingConversations(true);
          const sellerConversations = await attendanceService.getConversationsBySeller(user.id);
          const sorted = [...sellerConversations].sort(
            (a, b) => getConversationSortTimestamp(b) - getConversationSortTimestamp(a)
          );
          setConversations(sorted);
        } catch (error: any) {
          console.error('Error loading seller conversations:', error);
          toast.error(error?.response?.data?.error || error?.message || 'Erro ao carregar conversas');
          setConversations([]);
        } finally {
          setIsLoadingConversations(false);
        }
      };
      loadConversations();
    }
  }, [selectedFechadosFilter, user?.id, user?.role, fetchFechadosConversations]);

  // Carregar listas de orçamentos para o badge (sempre) e para a lista (quando na seção)
  useEffect(() => {
    if (!user?.id || user?.role !== 'SELLER') return;
    const load = async () => {
      try {
        if (selectedPendingType === 'pedidos-orcamentos') setIsLoadingQuotes(true);
        const [pendentes, enviados] = await Promise.all([
          quoteService.list('pedidos-orcamentos'),
          quoteService.list('pedidos-orcamentos-enviados')
        ]);
        const sortQuotes = (arr: QuoteRequest[]) =>
          [...arr].sort(
            (a, b) =>
              new Date(b.sellerViewedAt || b.updatedAt || b.createdAt).getTime() -
              new Date(a.sellerViewedAt || a.updatedAt || a.createdAt).getTime()
          );
        setQuoteCards(sortQuotes(pendentes));
        setSentQuoteCards(sortQuotes(enviados));
      } catch (e) {
        console.error('Error loading quote cards', e);
        if (selectedPendingType === 'pedidos-orcamentos') toast.error('Erro ao carregar pedidos de orçamento.');
        setQuoteCards([]);
        setSentQuoteCards([]);
      } finally {
        if (selectedPendingType === 'pedidos-orcamentos') setIsLoadingQuotes(false);
      }
    };
    load();
  }, [user?.id, user?.role, selectedPendingType]);

  // Use refs to access current values without causing re-registration
  const conversationsRef = useRef(conversations);
  const selectedConversationRef = useRef<string | null>(null);
  const selectedConversationDataRef = useRef(selectedConversationData);
  const selectedPendingTypeRef = useRef(selectedPendingType);
  const selectedFechadosFilterRef = useRef(selectedFechadosFilter);
  const isLoadingMessagesRef = useRef(false); // Proteção contra múltiplas chamadas simultâneas
  const lastFetchedConversationRef = useRef<string | null>(null); // Rastrear última conversa carregada
  const markAsReadInProgressRef = useRef<Set<string>>(new Set()); // Proteção contra múltiplas chamadas de markAsRead

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    selectedPendingTypeRef.current = selectedPendingType;
  }, [selectedPendingType]);
  useEffect(() => {
    selectedFechadosFilterRef.current = selectedFechadosFilter;
  }, [selectedFechadosFilter]);

  useEffect(() => {
    if (selectedPendingType || selectedFechadosFilter) {
      setIsBulkSelectMode(false);
      setSelectedAttendancesForBulk(new Set());
    }
  }, [selectedPendingType, selectedFechadosFilter]);
  
  // Limpar refs quando componente desmontar
  useEffect(() => {
    return () => {
      isLoadingMessagesRef.current = false;
      markAsReadInProgressRef.current.clear();
    };
  }, []);

  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
  }, [selectedConversation]);

  useEffect(() => {
    selectedConversationDataRef.current = selectedConversationData;
  }, [selectedConversationData]);

  // Socket.IO: Connect and listen for real-time updates
  useEffect(() => {
    if (user?.id && user?.role === 'SELLER') {
      socketService.connect();

      // Join seller's room
      socketService.joinRoom(`seller_${user.id}`);

      // Listen for attendance routing events
      const handleAttendanceRouted = async (data: {
        attendanceId: string;
        sellerId: string;
        previousSellerId?: string | null;
        supervisorId: string;
        vehicleBrand: string;
        routedAt: string;
      }) => {
        console.log('Attendance routed event (Seller)', data);

        // Se eu era o vendedor anterior e não sou mais, remover atendimento da lista
        if (data.previousSellerId && data.previousSellerId === user.id && data.sellerId !== user.id) {
          startTransition(() => {
            setConversations((prev) => prev.filter((conv) => conv.id !== data.attendanceId));
          });
          return;
        }

        // Só processar como "novo atendimento" se agora for meu
        if (data.sellerId !== user.id) {
          return;
        }

        // Check if conversation already exists
        const exists = conversationsRef.current.some((conv) => conv.id === data.attendanceId);
        
        if (!exists) {
          // Reload conversations from API to get the full data
          try {
            const sellerConversations = await attendanceService.getConversationsBySeller(user.id);
            setConversations(sellerConversations);
          } catch (error) {
            console.error('Error reloading conversations after routing:', error);
            // Fallback: add placeholder if API fails
            startTransition(() => {
              const newConversation: Conversation = {
                id: data.attendanceId,
                clientPhone: '',
                clientName: `Cliente ${data.vehicleBrand}`,
                lastMessage: 'Novo atendimento',
                lastMessageTime: new Date().toISOString(),
                unread: 1,
                state: 'OPEN',
                handledBy: 'HUMAN',
                vehicleBrand: data.vehicleBrand as any,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };

              setConversations((prev) => [newConversation, ...prev]);
            });
          }
        }

        // Show notification
        toast.success(`Novo atendimento atribuído - ${data.vehicleBrand}`, {
          icon: '✅',
          duration: 3000,
          position: 'top-right',
        });
      };

      // Listen for new messages (from seller's room)
      // NOTE: This event is only emitted for CLIENT messages, so it's safe to increment unread
      const handleNewMessage = (data: {
        attendanceId: string;
        messageId: string;
        content: string;
        timestamp: string;
      }) => {
        console.log('New message received via Socket.IO', data);

        // Update conversation's last message
        // This event is only emitted for CLIENT messages, so we can safely increment unread
        startTransition(() => {
          setConversations((prev) =>
            prev.map((conv) =>
              conv.id === data.attendanceId
                ? {
                    ...conv,
                    lastMessage: data.content,
                    lastMessageTime: data.timestamp,
                    unread: selectedConversationRef.current === data.attendanceId ? conv.unread : conv.unread + 1,
                    updatedAt: new Date().toISOString(),
                  }
                : conv
            )
          );
        });
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
        console.log('Message received via Socket.IO', data);

        // Start typing indicator when client sends a message (for AI response)
        // Only show AI typing if attendance is handled by AI
        if (data.message.origin === 'CLIENT' && selectedConversationRef.current === data.attendanceId) {
          // Check if attendance is handled by AI before showing typing indicator
          const conversationData = selectedConversationDataRef.current;
          const conversation = conversationsRef.current.find(conv => conv.id === data.attendanceId);
          const handledBy = conversationData?.handledBy || conversation?.handledBy || 'AI';
          
          // Only show AI typing indicator if handled by AI
          if (handledBy === 'AI') {
            setIsAITyping((prev) => ({ ...prev, [data.attendanceId]: true }));
            
            // Clear any existing timeout for this conversation
            if (typingTimeoutRef.current[data.attendanceId]) {
              clearTimeout(typingTimeoutRef.current[data.attendanceId]);
            }
          } else {
            // If handled by HUMAN, make sure typing indicator is off
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

        // Only process if this message is for one of seller's conversations
        const conv = conversationsRef.current.find((c) => c.id === data.attendanceId);
        if (!conv) {
          return; // Not for this seller
        }

        // Mensagem fromMe (dono enviando do celular): atualizar timer de 1h desligada
        if (data.message.origin === 'SELLER' && (data.message.metadata?.fromMe || (data as any).fromMe) && data.attendanceId) {
          fetchInactivityTimer(data.attendanceId);
        }

        const clientName = conv.clientName || 'Cliente';

        startTransition(() => {
          // If this message is for the currently selected conversation, add it to messages
          if (selectedConversationRef.current === data.attendanceId) {
            const isClient = data.message.origin === 'CLIENT';
            const isFromAI = data.message.origin === 'AI';
            const isFromSeller = data.message.origin === 'SELLER';

            // Determine sender name
            let sender = clientName; // Use client name from conversation by default
            if (isFromAI) {
              sender = 'AI';
            } else if (isFromSeller) {
              sender = data.message.metadata?.ownerPushName || data.message.metadata?.senderName || data.sender || 'Vendedor';
            } else if (isClient && data.message.metadata?.pushName) {
              // Prefer pushName if available (more recent/accurate)
              sender = data.message.metadata.pushName;
            }

            // Format time - use metadata.sentAt if available (ISO string), otherwise use sentAt
            // Always prioritize ISO timestamp from metadata for accurate sorting
            const timestamp = data.message.metadata?.sentAt || data.message.sentAt;
            const timestampDate = new Date(timestamp);
            
            // Validate timestamp
            if (isNaN(timestampDate.getTime())) {
              console.error('Invalid timestamp received:', timestamp, data.message);
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
            const isoTimestamp = timestampDate.toISOString();

            const newMessage: any = {
              id: data.message.id,
              sender,
              content: data.message.content,
              time,
              sentAt: time, // Display time (HH:MM for UI)
              isClient,
              origin: data.message.origin,
              avatar: isClient
                ? `https://ui-avatars.com/api/?name=${encodeURIComponent(sender)}&background=F07000&color=fff`
                : undefined,
              hasLink: data.message.content.includes('http'),
              metadata: {
                ...(data.message.metadata || {}),
                // CRITICAL: Always store full ISO timestamp for sorting
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

            // Add new message to messages list and sort by sentAt
            setMessages((prev) => {
              const existingIndex = prev.findIndex((m) => m.id === data.message.id);
              if (existingIndex >= 0) {
                // Atualizar mensagem existente (ex.: mediaUrl após download; content de [Processando imagem...] para [Imagem])
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
              const updated = [...prev, newMessage];
              // Sort by metadata.sentAt (ISO timestamp) - CRITICAL for correct chronological order
              return updated.sort((a, b) => {
                const getTimestamp = (msg: any): number => {
                  // Always use metadata.sentAt (ISO string) if available
                  const ts = msg.metadata?.sentAt || msg.sentAt || msg.createdAt;
                  if (!ts) {
                    console.warn('Message missing timestamp:', msg.id);
                    return 0;
                  }
                  const date = new Date(ts);
                  const timestamp = date.getTime();
                  if (isNaN(timestamp)) {
                    console.error('Invalid timestamp in message:', msg.id, ts);
                    return 0;
                  }
                  return timestamp;
                };
                const timeA = getTimestamp(a);
                const timeB = getTimestamp(b);
                if (timeA !== timeB) return timeA - timeB;
                // Desempate: mesma timestamp (ex: sticker e resposta IA no mesmo segundo) -
                // mensagem do cliente deve vir ANTES da resposta da IA (cliente enviou primeiro)
                const originOrder = (o: string) => (o === 'CLIENT' ? 0 : o === 'AI' ? 1 : 2);
                return (originOrder(a.origin || '') - originOrder(b.origin || '')) || (String(a.id).localeCompare(String(b.id)));
              });
            });

            // Auto-scroll to bottom when new message arrives
            setTimeout(() => {
              scrollToBottom(true);
            }, 100);
          }

          // Update conversations list
          // Só incrementar unread para mensagens do CLIENTE; quando a IA envia, marcar conversa como lida (unread = 0)
          const isClientMessage = data.message.origin === 'CLIENT';
          const isFromAI = data.message.origin === 'AI';
          setConversations((prev) =>
            prev.map((conv) =>
              conv.id === data.attendanceId
                ? {
                    ...conv,
                    lastMessage: data.message.content,
                    lastMessageTime: data.message.sentAt,
                    unread: isFromAI
                      ? 0
                      : isClientMessage && selectedConversationRef.current !== data.attendanceId
                        ? conv.unread + 1
                        : conv.unread,
                    updatedAt: new Date().toISOString(),
                  }
                : conv
            )
          );
        });

        // Notificação: só quando a conversa não está aberta E é mensagem do cliente
        if (selectedConversationRef.current !== data.attendanceId && data.message.origin === 'CLIENT') {
          const contentPreview = (data.message.content && String(data.message.content).trim())
            ? String(data.message.content).trim().slice(0, 80) + (String(data.message.content).length > 80 ? '...' : '')
            : 'Nova mensagem';
          if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const n = new Notification(`Plataforma • ${clientName}`, {
              body: `💬 ${contentPreview}\nAbra a plataforma para responder.`,
              icon: '/favicon.ico',
              badge: '/favicon.ico',
              tag: `msg-${data.attendanceId}-${data.message.id}`,
              renotify: true,
            });
            n.onclick = () => {
              window.focus();
              n.close();
            };
          } else if (!document.hidden) {
            setTimeout(() => {
              toast.success(`Nova mensagem de ${clientName}`, {
                icon: '📩',
                duration: 2000,
                position: 'top-right',
              });
            }, 150);
          }
        }
      };

      // Listen for sent messages (confirmation from server)
      const handleMessageSent = (data: {
        attendanceId: string;
        messageId: string;
        message: {
          id: string;
          content: string;
          origin: string;
          sentAt: string;
          metadata?: Record<string, any>;
        };
      }) => {
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

        // Only process if this message is for one of seller's conversations
        const conv = conversationsRef.current.find((c) => c.id === data.attendanceId);
        if (!conv) {
          return; // Not for this seller
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
          const sentAt = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;

          const sentMessage: any = {
            id: data.message.id,
            sender: data.message.origin === 'AI' ? 'AI' : (data.message.metadata?.senderName || user?.name || 'Você'),
            content: data.message.content,
            time,
            sentAt,
            isClient: data.message.origin === 'CLIENT',
            origin: data.message.origin,
            avatar: data.message.origin === 'CLIENT'
              ? `https://ui-avatars.com/api/?name=${encodeURIComponent(conv.clientName || 'Cliente')}&background=F07000&color=fff`
              : undefined,
            hasLink: data.message.content.includes('http'),
            metadata: {
              ...(data.message.metadata || {}),
              // Always ensure we have ISO timestamp for sorting
              sentAt: data.message.metadata?.sentAt || timestamp,
              createdAt: data.message.metadata?.sentAt || timestamp,
            },
          };

          startTransition(() => {
            setMessages((prev) => {
              const existingIndex = prev.findIndex((m) => m.id === data.message.id);
              if (existingIndex >= 0) {
                return prev.map((msg) => (msg.id === data.message.id ? sentMessage : msg));
              }

              const tempIndex = prev.findIndex(
                (m) => m.id.startsWith('temp-') && m.content === data.message.content
              );
              if (tempIndex >= 0) {
                return prev.map((msg, idx) => (idx === tempIndex ? sentMessage : msg));
              }

              // NÃO adicionar mensagens novas aqui
              // O message_received já faz isso, evitando duplicação
              return prev;
            });
          });
        }

        // Update conversations list
        startTransition(() => {
          setConversations((prev) =>
            prev.map((conv) =>
              conv.id === data.attendanceId
                ? {
                    ...conv,
                    lastMessage: data.message.content,
                    lastMessageTime: data.message.sentAt,
                    updatedAt: new Date().toISOString(),
                  }
                : conv
            )
          );
        });
      };

      // Listen for client typing updates
      const handleClientTyping = (data: {
        attendanceId: string;
        clientPhone: string;
        isTyping: boolean;
      }) => {
        console.log('🔵🔵🔵 CLIENT TYPING EVENT RECEIVED! (Seller)', {
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

      socketService.on('attendance:routed', handleAttendanceRouted);

      const handleMovedToIntervention = (data: { attendanceId?: string; interventionType?: string; interventionData?: Record<string, unknown> }) => {
        if (!data?.attendanceId || data.interventionType !== 'casos_gerentes') return;
        const aid = String(data.attendanceId);
        setConversations((prev) =>
          prev.map((c) =>
            String(c.id) === aid
              ? { ...c, interventionType: 'casos_gerentes', interventionData: data.interventionData ?? c.interventionData }
              : c
          )
        );
        if (selectedConversationRef.current === aid && selectedConversationData?.id === aid) {
          setSelectedConversationData((prev) =>
            prev ? { ...prev, interventionType: 'casos_gerentes', interventionData: data.interventionData ?? prev.interventionData } : prev
          );
        }
      };
      socketService.on('attendance:moved-to-intervention', handleMovedToIntervention);

      const handleMovedToFechados = (data: { attendanceId: string; reason?: string; closedAt?: string }) => {
        const aid = data.attendanceId;
        setConversations((prev) => prev.filter((c) => c.id !== aid));
        if (selectedConversationRef.current === aid) {
          setSelectedConversation(null);
          setSelectedConversationData(null);
          setMessages([]);
        }
        if (selectedFechadosFilterRef.current) {
          fetchFechadosConversations();
        }
      };
      socketService.on('attendance:moved-to-fechados', handleMovedToFechados);

      const handleReopened = async () => {
        if (!user?.id || user?.role !== 'SELLER') return;
        if (selectedFechadosFilterRef.current) {
          fetchFechadosConversations();
        } else {
          try {
            setIsLoadingConversations(true);
            const sellerConversations = await attendanceService.getConversationsBySeller(user.id);
            setConversations(sellerConversations);
          } catch (e) {
            console.error('Error refetching conversations after reopen', e);
          } finally {
            setIsLoadingConversations(false);
          }
        }
      };
      socketService.on('attendance:reopened', handleReopened);

      // Usando apenas message_received para evitar duplicação
      // socketService.on('new_message', handleNewMessage);
      socketService.on('message_received', handleMessageReceived);
      socketService.on('message_sent', handleMessageSent);
      
      // Register client typing handler with explicit logging
      console.log('📡 Registering client:typing event handler (Seller)');
      socketService.on('client:typing', handleClientTyping);

      // Listen for attendance control events
      const handleAttendanceAssumed = (data: { attendanceId: string; handledBy: 'HUMAN'; assumedBy: string; assumedAt: string }) => {
        console.log('Attendance assumed via Socket.IO (Seller)', data);
        
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
      };

      const handleAttendanceReturnedToAI = (data: { attendanceId: string; handledBy: 'AI'; returnedBy: string; returnedAt: string }) => {
        console.log('Attendance returned to AI via Socket.IO (Seller)', data);
        
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
      };

      socketService.on('attendance_assumed', handleAttendanceAssumed);
      socketService.on('attendance_returned_to_ai', handleAttendanceReturnedToAI);

      const handleQuoteCreated = async () => {
        const [pendentes, enviados] = await Promise.all([
          quoteService.list('pedidos-orcamentos').catch(() => []),
          quoteService.list('pedidos-orcamentos-enviados').catch(() => [])
        ]);
        setQuoteCards(pendentes);
        setSentQuoteCards(enviados);
      };
      const handleQuoteUpdated = async () => {
        const [pendentes, enviados] = await Promise.all([
          quoteService.list('pedidos-orcamentos').catch(() => []),
          quoteService.list('pedidos-orcamentos-enviados').catch(() => [])
        ]);
        setQuoteCards(pendentes);
        setSentQuoteCards(enviados);
      };
      socketService.on('quote:created', handleQuoteCreated);
      socketService.on('quote:updated', handleQuoteUpdated);

      // Disponibilidade do vendedor (atualizações vindas do supervisor ou de outro device)
      const handleSellerAvailabilityUpdated = (data: { sellerId: string; isUnavailable: boolean; unavailableUntil: string | null }) => {
        if (!user?.id || user.role !== 'SELLER') return;
        if (data.sellerId !== user.id) return;
        setSellerUnavailableUntil(data.unavailableUntil);
      };
      socketService.on('seller:availability_updated', handleSellerAvailabilityUpdated);

      console.log('✅ client:typing handler registered (Seller)');

      // Cleanup on unmount
      return () => {
        socketService.off('attendance:routed', handleAttendanceRouted);
        socketService.off('attendance:moved-to-intervention', handleMovedToIntervention);
        socketService.off('attendance:moved-to-fechados', handleMovedToFechados);
        socketService.off('attendance:reopened', handleReopened);
        // socketService.off('new_message', handleNewMessage);
        socketService.off('message_received', handleMessageReceived);
        socketService.off('message_sent', handleMessageSent);
        socketService.off('client:typing', handleClientTyping);
        socketService.off('attendance_assumed', handleAttendanceAssumed);
        socketService.off('attendance_returned_to_ai', handleAttendanceReturnedToAI);
        socketService.off('quote:created', handleQuoteCreated);
        socketService.off('quote:updated', handleQuoteUpdated);
        socketService.off('seller:availability_updated', handleSellerAvailabilityUpdated);
        
        // Clear all typing timeouts on cleanup
        Object.values(typingTimeoutRef.current).forEach((timeout) => {
          if (timeout) clearTimeout(timeout);
        });
      };
    }
  }, [user?.id, user?.role, selectedConversation]);

  // Função para formatar conversas para exibição
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
      const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(conv.clientName || conv.clientPhone)}&background=F07000&color=fff`;

      return {
        id: conv.id,
        name: conv.clientName || conv.clientPhone,
        lastMessage: conv.lastMessage || 'Sem mensagens',
        time: timeStr,
        unread: conv.unread,
        status,
        avatar,
        interventionType: conv.interventionType,
      };
    });
  };

  const displayConversations = formatConversationsForDisplay(conversations);

  // Load messages when a conversation is selected
  useEffect(() => {
    const loadMessages = async () => {
      if (!selectedConversation) {
        setMessages([]);
        setSelectedConversationData(null);
        lastFetchedConversationRef.current = null;
        isLoadingMessagesRef.current = false;
        markAsReadInProgressRef.current.clear();
        return;
      }

      // Proteção: evitar múltiplas chamadas simultâneas
      if (isLoadingMessagesRef.current) {
        console.log('⚠️ loadMessages já está em execução, ignorando chamada duplicada');
        return;
      }

      const convId = selectedConversation as string;
      const isRefetch = lastFetchedConversationRef.current === convId;

      // Se já carregou esta conversa e não é um refresh explícito, não recarregar
      if (isRefetch && refreshMessagesTrigger === 0) {
        return;
      }

      isLoadingMessagesRef.current = true;

      try {
        const response = await attendanceService.getAttendanceMessages(convId, 50, 0);
        // Backend returns messages sorted by sentAt ASC, but ensure correct chronological order
        // Always use metadata.sentAt (ISO string) for accurate sorting
        const sortedMessages = [...response.messages].sort((a: any, b: any) => {
          const getTimestamp = (msg: any): number => {
            // Always use metadata.sentAt (ISO string with full date/time)
            if (msg.metadata?.sentAt) {
              const timestamp = new Date(msg.metadata.sentAt).getTime();
              if (isNaN(timestamp)) {
                console.error('Invalid timestamp in metadata.sentAt:', msg.metadata.sentAt, msg.id);
                return 0;
              }
              return timestamp;
            }
            // This should not happen - backend should always include metadata.sentAt
            console.error('Message missing metadata.sentAt:', msg.id, msg);
            return 0;
          };
          const timeA = getTimestamp(a);
          const timeB = getTimestamp(b);
          if (timeA !== timeB) return timeA - timeB;
          // Desempate: mesma timestamp (ex: sticker e resposta IA) - cliente antes da IA
          const originOrder = (o: string) => (o === 'CLIENT' ? 0 : o === 'AI' ? 1 : 2);
          return (originOrder(a.origin || '') - originOrder(b.origin || '')) || (String(a.id).localeCompare(String(b.id)));
        });
        console.log('Loaded messages sorted:', sortedMessages.map(m => ({
          id: m.id,
          sender: m.sender,
          content: m.content.substring(0, 30),
          time: m.time,
          timestamp: m.metadata?.sentAt,
        })));
        
        // Verificar se há mensagens duplicadas por ID
        const messageIds = sortedMessages.map(m => m.id);
        const uniqueIds = new Set(messageIds);
        if (messageIds.length !== uniqueIds.size) {
          console.error('⚠️ Frontend received duplicate message IDs!', {
            total: messageIds.length,
            unique: uniqueIds.size,
            duplicates: messageIds.length - uniqueIds.size
          });
        }
        
        setMessages(sortedMessages);
        
        // Find and set conversation data (usar conversationsRef para evitar dependência)
        const conv = conversationsRef.current.find((c) => c.id === convId);
        if (conv) {
          setSelectedConversationData(conv);
        }

        // Mark messages as read (com proteção contra múltiplas chamadas)
        if (!markAsReadInProgressRef.current.has(convId)) {
          markAsReadInProgressRef.current.add(convId);
          try {
            await attendanceService.markAsRead(convId);
            // Update local state (usar função de atualização que não causa re-render desnecessário)
            if (conv && conv.unread > 0) {
              setConversations((prev) =>
                prev.map((c) => (c.id === convId ? { ...c, unread: 0 } : c))
              );
            }
          } catch (error) {
            console.error('Error marking as read:', error);
          } finally {
            // Remover após um delay para permitir novas chamadas se necessário
            setTimeout(() => {
              markAsReadInProgressRef.current.delete(convId);
            }, 1000);
          }
        }

        lastFetchedConversationRef.current = convId;

        // Auto-scroll to bottom when messages are loaded
        setTimeout(() => {
          scrollToBottom(true);
        }, 200);
      } catch (error: any) {
        console.error('Error loading messages:', error);
        toast.error('Erro ao carregar mensagens');
        setMessages([]);
        setSelectedConversationData(null);
      } finally {
        isLoadingMessagesRef.current = false;
      }
    };

    // Proteção: evitar chamar loadMessages se já estiver carregando ou se a conversa não mudou
    const convId = selectedConversation as string | null;
    const hasConversationChanged = lastFetchedConversationRef.current !== convId;
    const isExplicitRefresh = refreshMessagesTrigger > 0;
    
    // Se não há conversa selecionada, limpar estado imediatamente
    if (!convId) {
      setMessages([]);
      setSelectedConversationData(null);
      lastFetchedConversationRef.current = null;
      isLoadingMessagesRef.current = false;
      markAsReadInProgressRef.current.clear();
      return;
    }
    
    // Só carregar se realmente mudou a conversa ou se for um refresh explícito
    // E se não estiver já carregando
    if (!isLoadingMessagesRef.current && (hasConversationChanged || isExplicitRefresh)) {
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
  }, [selectedConversation, refreshMessagesTrigger]); // Removido 'conversations' para evitar loops

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

  // Reminder popup every minute while there are unread messages and tab is hidden
  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      if (unreadReminderIntervalRef.current) {
        clearInterval(unreadReminderIntervalRef.current);
        unreadReminderIntervalRef.current = null;
      }
      return;
    }

    const unreadConversations = conversations.filter((c) => (c.unread || 0) > 0);
    const shouldRemind = isDocumentHidden && unreadConversations.length > 0;

    const sendReminder = () => {
      const totalUnread = unreadConversations.reduce((sum, c) => sum + (c.unread || 0), 0);
      const first = unreadConversations[0];
      const extraClients = Math.max(0, unreadConversations.length - 1);
      const body = extraClients > 0
        ? `${first.clientName || first.clientPhone} + ${extraClients} cliente(s) aguardando.\n${totalUnread} mensagem(ns) não lida(s).`
        : `${first.clientName || first.clientPhone} aguardando resposta.\n${totalUnread} mensagem(ns) não lida(s).`;

      const n = new Notification('Plataforma • Mensagens pendentes', {
        body,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        tag: 'seller-unread-reminder',
        renotify: true,
        requireInteraction: true,
      });

      n.onclick = () => {
        window.focus();
        n.close();
      };
    };

    if (shouldRemind) {
      if (!unreadReminderIntervalRef.current) {
        unreadReminderIntervalRef.current = setInterval(sendReminder, 60_000);
      }
    } else if (unreadReminderIntervalRef.current) {
      clearInterval(unreadReminderIntervalRef.current);
      unreadReminderIntervalRef.current = null;
    }

    return () => {
      if (unreadReminderIntervalRef.current && !shouldRemind) {
        clearInterval(unreadReminderIntervalRef.current);
        unreadReminderIntervalRef.current = null;
      }
    };
  }, [conversations, isDocumentHidden]);

  useEffect(() => {
    return () => {
      if (unreadReminderIntervalRef.current) {
        clearInterval(unreadReminderIntervalRef.current);
        unreadReminderIntervalRef.current = null;
      }
    };
  }, []);

  // Load contact-wide history for the right sidebar
  useEffect(() => {
    const loadContactHistory = async () => {
      if (!selectedConversation) {
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

  // Buscar status da IA e timer ao selecionar conversa (evita mostrar 0 ao voltar)
  useEffect(() => {
    if (!selectedConversation || typeof selectedConversation === 'number') return;
    fetchAIStatus(selectedConversation as string);
    const conv = conversations.find(c => c.id === selectedConversation);
    if (conv?.handledBy === 'HUMAN') {
      fetchInactivityTimer(selectedConversation as string);
    }
  }, [selectedConversation]);

  // Get avatar for the selected conversation
  const getSelectedConversationAvatar = (): string => {
    if (!selectedConversation) return '';
    
    const found = displayConversations.find(c => c.id === selectedConversation);
    return found?.avatar || '';
  };

  // Get name for the selected conversation
  const getSelectedConversationName = (): string => {
    if (!selectedConversation) return '';
    
    const found = displayConversations.find(c => c.id === selectedConversation);
    return found?.name || '';
  };

  const selectedConvAvatar = getSelectedConversationAvatar();
  const selectedConvName = getSelectedConversationName();

  // Format phone number for display (aceita 10, 11 dígitos ou 12/13 com código 55)
  const formatPhoneNumber = (phone: string): string => {
    const raw = phone.replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    const digits = raw.length >= 12 && raw.startsWith('55') ? raw.slice(2) : raw;
    if (digits.length === 11) {
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
    }
    return phone;
  };

  // Update selectedConversationData when conversation is selected
  useEffect(() => {
    if (selectedConversation) {
      const conv = conversations.find(c => c.id === selectedConversation);
      setSelectedConversationData(conv || null);
    } else {
      setSelectedConversationData(null);
    }
  }, [selectedConversation, conversations]);

  const scrollToBottom = (force = false) => {
    if (messagesContainerRef.current) {
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        if (messagesContainerRef.current) {
          const container = messagesContainerRef.current;
          const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
          
          // Only auto-scroll if user is near bottom or if forced
          if (force || isNearBottom) {
            container.scrollTo({
              top: container.scrollHeight,
              behavior: force ? 'smooth' : 'auto',
            });
            // Also set directly as fallback
            container.scrollTop = container.scrollHeight;
          }
        }
      });
    }
  };

  // Auto-scroll when messages change (only if user is near bottom)
  useEffect(() => {
    if (messages.length > 0 && selectedConversation) {
      // Small delay to ensure DOM is updated
      const timer = setTimeout(() => {
        scrollToBottom(false);
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [messages.length, selectedConversation]);

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

    const optimisticMessage: any = {
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

        const realMessage: any = {
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

  const handleSendAudioRecording = async (audioBlob: Blob) => {
    try {
      // Convert blob to File
      const audioFile = new File([audioBlob], `audio-${Date.now()}.webm`, { type: 'audio/webm' });
      await handleSendMedia(audioFile);
      setShowAudioRecorder(false);
    } catch (error: any) {
      console.error('Error sending audio recording:', error);
      alert('Erro ao enviar áudio');
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    setMessageInput((prev) => prev + emoji);
    setShowEmojiPicker(false);
  };

  const handleSendMedia = async (file: File) => {
    if (!selectedConversation) return;

    const tempId = `temp-${Date.now()}`;
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    const isoTimestamp = now.toISOString();

    const optimisticMessage: any = {
      id: tempId,
      sender: user?.name || 'Você',
      content: '[Enviando mídia...]',
      time,
      sentAt: time,
      isClient: false,
      avatar: undefined,
      metadata: { sentAt: isoTimestamp, createdAt: isoTimestamp },
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setTimeout(() => scrollToBottom(), 50);

    try {
      const response = await attendanceService.sendMessageWithMedia(
        selectedConversation as string,
        file,
        messageInput.trim() || undefined
      );
      setMessageInput('');

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
        const sentIso = sentDate.toISOString();

        const realMessage: any = {
          id: response.message.id,
          sender: user?.name || 'Você',
          content: response.message.content,
          time: sentTime,
          sentAt: sentTime,
          isClient: false,
          avatar: undefined,
          hasLink: response.message.content?.includes?.('http'),
          metadata: {
            ...(response.message.metadata || {}),
            sentAt: sentIso,
            createdAt: sentIso,
          },
        };

        setMessages((prev) => prev.map((msg) => (msg.id === tempId ? realMessage : msg)));
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
        fetchInactivityTimer(selectedConversation as string);
      }
    } catch (error: any) {
      setMessages((prev) => prev.filter((msg) => msg.id !== tempId));
      toast.error(error.response?.data?.error || 'Erro ao enviar mídia.');
    }
  };

  const handleSendPendingMessage = () => {
    if (!messageInput.trim() || !selectedPendingType) return;
    
    const date = new Date();
    const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const timeParts = timeFormatter.formatToParts(date);
    const hours = timeParts.find((p) => p.type === 'hour')?.value || '00';
    const minutes = timeParts.find((p) => p.type === 'minute')?.value || '00';
    const formattedTime = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;

    const newMessage = {
      id: Date.now(),
      text: messageInput,
      sender: user?.name || 'Você',
      timestamp: formattedTime,
    };
    
    setPendingMessages([...pendingMessages, newMessage]);
    setMessageInput('');
    
    // TODO: Implementar envio real de mensagem/órçamento para o backend
  };

  const handlePerguntarSubmit = async () => {
    if (!selectedQuoteForPerguntar || !perguntarText.trim()) return;
    try {
      setIsSendingPerguntar(true);
      await quoteService.perguntar(selectedQuoteForPerguntar, perguntarText.trim());
      setSelectedQuoteForPerguntar(null);
      setPerguntarText('');
      toast.success('Pergunta enviada ao cliente');
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Erro ao enviar pergunta');
    } finally {
      setIsSendingPerguntar(false);
    }
  };

  const handleEnviarOrcamento = async (quote: QuoteRequest) => {
    if (!quoteResponseText.trim() && !quoteResponseImage) {
      toast.error('Digite o conteúdo do orçamento ou selecione uma imagem');
      return;
    }

    try {
      setIsSendingQuote(true);
      
      let mediaUrl: string | undefined;
      let mimeType: string | undefined;

      // Se houver imagem, fazer upload primeiro
      if (quoteResponseImage) {
        try {
          const uploadResult = await mediaService.uploadMedia(quoteResponseImage);
          mediaUrl = uploadResult.mediaUrl;
          mimeType = uploadResult.mimeType; // Usar mimeType ao invés de mediaType
        } catch (uploadError: any) {
          console.error('Error uploading image', uploadError);
          toast.error('Erro ao fazer upload da imagem');
          setIsSendingQuote(false);
          return;
        }
      }

      await quoteService.enviarOrcamento(
        quote.id,
        quoteResponseText.trim(),
        mediaUrl,
        mimeType
      );

      toast.success('Orçamento enviado com sucesso!');
      
      // Limpar campos
      setQuoteResponseText('');
      setQuoteResponseImage(null);
      setSelectedQuote(null);
      
      // Recarregar listas
      const [pendentes, enviados] = await Promise.all([
        quoteService.list('pedidos-orcamentos'),
        quoteService.list('pedidos-orcamentos-enviados')
      ]);
      setQuoteCards(pendentes);
      setSentQuoteCards(enviados);
    } catch (e: any) {
      console.error('Error sending quote', e);
      toast.error(e?.response?.data?.error || 'Erro ao enviar orçamento');
    } finally {
      setIsSendingQuote(false);
    }
  };

  const handleDeletarOrcamento = async (quoteId: string) => {
    if (!confirm('Tem certeza que deseja deletar este pedido de orçamento?')) {
      return;
    }

    try {
      setIsDeletingQuote(quoteId);
      await quoteService.deletar(quoteId);
      toast.success('Pedido de orçamento deletado');
      
      // Recarregar listas
      const [pendentes, enviados] = await Promise.all([
        quoteService.list('pedidos-orcamentos'),
        quoteService.list('pedidos-orcamentos-enviados')
      ]);
      setQuoteCards(pendentes);
      setSentQuoteCards(enviados);
      
      // Se estava selecionado, limpar seleção
      if (selectedQuote?.id === quoteId) {
        setSelectedQuote(null);
      }
    } catch (e: any) {
      console.error('Error deleting quote', e);
      toast.error(e?.response?.data?.error || 'Erro ao deletar pedido');
    } finally {
      setIsDeletingQuote(null);
    }
  };

  const PENDING_SUBDIVISIONS = [
    { key: 'pedidos-orcamentos', label: 'Pedidos de Orçamentos', icon: 'description', description: 'Pendentes e orçamentos já enviados por você' },
    { key: 'perguntas-pos-orcamento', label: 'Perguntas Pós Orçamento', icon: 'help_outline', description: 'Responda dúvidas após o orçamento' },
    { key: 'confirmacao-pix', label: 'Confirmação Pix', icon: 'payments', description: 'Confirme pagamentos Pix recebidos' },
    { key: 'tirar-pedido', label: 'Tirar Pedido', icon: 'shopping_cart', description: 'Registre e acompanhe pedidos' },
    { key: 'informacoes-entrega', label: 'Informações sobre Entrega', icon: 'local_shipping', description: 'Informe status e prazos de entrega' },
    { key: 'encomendas', label: 'Encomendas', icon: 'inventory', description: 'Acompanhe e gerencie encomendas' },
    { key: 'cliente-pediu-humano', label: 'Cliente pediu Humano', icon: 'support_agent', description: 'Atenda solicitações de intervenção humana' },
  ] as const;

  const getPendingTypeTitle = () => {
    const sub = PENDING_SUBDIVISIONS.find((s) => s.key === selectedPendingType);
    return sub?.label ?? '';
  };

  const getPendingTypeDescription = () => {
    const sub = PENDING_SUBDIVISIONS.find((s) => s.key === selectedPendingType);
    return sub?.description ?? '';
  };

  const getPendingTypeIcon = () => {
    const sub = PENDING_SUBDIVISIONS.find((s) => s.key === selectedPendingType);
    return sub?.icon ?? 'description';
  };

  return (
    <div
      className="flex h-screen overflow-hidden bg-background-light dark:bg-background-dark"
      style={{ backgroundColor: isDarkMode ? '#020617' : '#F0F0F0' }}
    >
      {/* Sidebar Left - Icons */}
      <aside
        className={`${sidebarOpen ? 'w-56' : 'w-16'} transition-all duration-300 flex flex-col items-center py-4 bg-navy text-white flex-shrink-0 z-20`}
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
                <span className="text-lg font-bold tracking-tight">Fabio Guerreiro</span>
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
        <nav className={`flex flex-col space-y-3 flex-grow ${sidebarOpen ? 'px-3 w-full' : 'px-0 items-center'}`}>
          <button className={`p-2 ${sidebarOpen ? 'bg-white/10' : ''} rounded-lg hover:bg-white/20 transition-colors flex items-center ${sidebarOpen ? 'gap-3 w-full' : 'justify-center'}`}>
            <span className="material-icons-round">chat</span>
            {sidebarOpen && <span className="text-sm">Chat</span>}
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

      {/* Entry/Conversations Panel */}
      <div className="w-64 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col flex-shrink-0">
        <div className="p-5 flex justify-between items-center gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight truncate">{user?.name || 'Vendedor'}</h1>
            {isSellerUnavailable && sellerUnavailableUntil && (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">
                Ausente ate {new Date(sellerUnavailableUntil).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          <button
            type="button"
            disabled={isUpdatingAvailability || !user?.id}
            onClick={async () => {
              if (!user?.id || isUpdatingAvailability) return;
              setIsUpdatingAvailability(true);
              try {
                const response = await userService.setSellerAvailability(user.id, !isSellerUnavailable);
                setSellerUnavailableUntil(response.unavailableUntil);
                if (response.isUnavailable) {
                  setMessageInput('');
                  toast.success('Voce esta ausente no round-robin por ate 2 horas.');
                } else {
                  toast.success('Voce voltou para o round-robin.');
                }
              } catch (error) {
                console.error('Erro ao alterar disponibilidade do vendedor:', error);
                toast.error('Nao foi possivel atualizar seu status agora.');
              } finally {
                setIsUpdatingAvailability(false);
              }
            }}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap transition-colors ${
              isSellerUnavailable
                ? 'border-amber-500 text-amber-700 dark:text-amber-300 bg-amber-50/60 dark:bg-amber-900/20 hover:bg-amber-100/80 dark:hover:bg-amber-900/40'
                : 'border-emerald-600 text-emerald-700 dark:text-emerald-300 bg-emerald-50/60 dark:bg-emerald-900/20 hover:bg-emerald-100/80 dark:hover:bg-emerald-900/40'
            } disabled:opacity-50`}
            title={isSellerUnavailable ? 'Marcar como presente e voltar ao round-robin' : 'Ficar ausente por 2 horas'}
          >
            <span className="material-icons-round text-[13px]">
              {isSellerUnavailable ? 'schedule' : 'person_off'}
            </span>
            {isUpdatingAvailability
              ? 'Salvando...'
              : isSellerUnavailable
                ? 'Está ausente'
                : 'Está presente'}
          </button>
        </div>
        <nav className="flex-grow overflow-y-auto px-2 custom-scrollbar space-y-1">
          <div className="px-3 py-4 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Atendimentos</div>
          <button
            onClick={() => {
              setSelectedConversation(null);
              setSelectedPendingType(null);
              setSelectedFechadosFilter(false);
              setPendingMessages([]);
              setSelectedAttendanceFilter('tudo');
              setSelectedQuote(null); // Limpar seleção de pedido
            }}
            className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors ${
              selectedAttendanceFilter === 'tudo' && !selectedPendingType && !selectedFechadosFilter
                ? 'bg-slate-50 dark:bg-slate-800 text-navy dark:text-white font-medium'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
            style={selectedAttendanceFilter === 'tudo' && !selectedPendingType && !selectedFechadosFilter ? { color: '#003070' } : {}}
          >
            <div className="flex items-center space-x-3">
              <span className="material-icons-round text-lg text-slate-400">apps</span>
              <span>Atribuídos</span>
            </div>
            {(() => {
              const totalUnreadAttribuidos = conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
              return totalUnreadAttribuidos > 0 ? (
                <span className="bg-navy text-white text-[10px] font-semibold px-2 py-0.5 rounded-full min-w-[20px] text-center flex-shrink-0" style={{ backgroundColor: '#003070' }}>
                  {totalUnreadAttribuidos > 99 ? '99+' : totalUnreadAttribuidos}
                </span>
              ) : null;
            })()}
          </button>
          <div className="relative opacity-50 cursor-not-allowed">
            <button
              disabled
              className="w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors text-slate-400 dark:text-slate-500"
            >
              <div className="flex items-center space-x-3 min-w-0 flex-1">
                <span className="material-icons-round text-lg flex-shrink-0">smart_toy</span>
                <span className="truncate">IA</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <span className="text-[9px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Em breve</span>
                <span className="text-[10px] px-1.5 py-0.5 whitespace-nowrap">0</span>
              </div>
            </button>
          </div>
          <div className="relative opacity-50 cursor-not-allowed">
            <button
              disabled
              className="w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors text-slate-400 dark:text-slate-500"
            >
              <div className="flex items-center space-x-3 min-w-0 flex-1">
                <span className="material-icons-round text-lg flex-shrink-0">person</span>
                <span className="truncate">Humano</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <span className="text-[9px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Em breve</span>
                <span className="text-[10px] px-1.5 py-0.5 whitespace-nowrap">0</span>
              </div>
            </button>
          </div>
          <div className="relative opacity-50 cursor-not-allowed">
            <button
              disabled
              className="w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors text-slate-400 dark:text-slate-500"
            >
              <div className="flex items-center space-x-3 min-w-0 flex-1">
                <span className="material-icons-round text-lg flex-shrink-0">pending</span>
                <span className="truncate">Orçamento Pendente</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <span className="text-[9px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Em breve</span>
                <span className="text-[10px] px-1.5 py-0.5 whitespace-nowrap">0</span>
              </div>
            </button>
          </div>
          <div className="relative opacity-50 cursor-not-allowed">
            <button
              disabled
              className="w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors text-slate-400 dark:text-slate-500"
            >
              <div className="flex items-center space-x-3 min-w-0 flex-1">
                <span className="material-icons-round text-lg flex-shrink-0">description</span>
                <span className="truncate">Pós Orçamento</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <span className="text-[9px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Em breve</span>
                <span className="text-[10px] px-1.5 py-0.5 whitespace-nowrap">0</span>
              </div>
            </button>
          </div>
          <div className="relative opacity-50 cursor-not-allowed">
            <button
              disabled
              className="w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors text-slate-400 dark:text-slate-500"
            >
              <div className="flex items-center space-x-3 min-w-0 flex-1">
                <span className="material-icons-round text-lg flex-shrink-0">mark_email_unread</span>
                <span className="truncate">Não Lidos</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <span className="text-[9px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Em breve</span>
                <span className="text-[10px] px-1.5 py-0.5 whitespace-nowrap">0</span>
              </div>
            </button>
          </div>
          <div className="px-3 py-4 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Pendências</div>
          {PENDING_SUBDIVISIONS.map((sub) => {
            const isComingSoon = sub.key !== 'pedidos-orcamentos';
            return isComingSoon ? (
              <div key={sub.key} className="relative opacity-50 cursor-not-allowed">
                <button
                  disabled
                  className="w-full flex items-center justify-between px-3 py-2 text-sm text-left rounded-lg transition-colors text-slate-400 dark:text-slate-500"
                >
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <span className="material-icons-round text-lg flex-shrink-0">{sub.icon}</span>
                    <span className="truncate">{sub.label}</span>
                  </div>
                  <span className="text-[9px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap ml-2 flex-shrink-0">Em breve</span>
                </button>
              </div>
            ) : (
              <button
                key={sub.key}
                onClick={() => {
                  setSelectedConversation(null);
                  setSelectedPendingType(sub.key);
                  setSelectedFechadosFilter(false);
                  setSelectedAttendanceFilter('tudo'); // Clear attendance filter when selecting pending type
                  setSelectedQuote(null); // Limpar seleção de pedido ao mudar de pendência
                }}
                className={`w-full flex items-center justify-between space-x-3 px-3 py-2 text-sm text-left rounded-lg transition-colors ${
                  selectedPendingType === sub.key && selectedAttendanceFilter === 'tudo'
                    ? 'bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center space-x-3 min-w-0 flex-1">
                  <span className="material-icons-round text-lg flex-shrink-0">{sub.icon}</span>
                  <span className="truncate">{sub.label}</span>
                </div>
                {unviewedQuoteCount > 0 && (
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-green-500 text-white text-[10px] font-semibold flex items-center justify-center" title={`${unviewedQuoteCount} não visualizado(s)`}>
                    {unviewedQuoteCount > 99 ? '99+' : unviewedQuoteCount}
                  </span>
                )}
              </button>
            );
          })}
          <div className="px-3 py-4 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Fechar atendimento</div>
          <button
            onClick={() => {
              setSelectedConversation(null);
              setSelectedPendingType(null);
              setSelectedFechadosFilter(true);
              setSelectedAttendanceFilter('tudo');
              setSelectedQuote(null);
            }}
            className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors ${
              selectedFechadosFilter
                ? 'bg-slate-50 dark:bg-slate-800 text-navy dark:text-white font-medium'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
            style={selectedFechadosFilter ? { color: '#003070' } : {}}
          >
            <div className="flex items-center space-x-3 min-w-0 flex-1">
              <span className="material-icons-round text-lg text-slate-400 flex-shrink-0">archive</span>
              <span className="truncate">Fechados</span>
            </div>
            {selectedFechadosFilter && (
              <span className="text-[10px] text-slate-500 dark:text-slate-400 flex-shrink-0">{conversations.length} atendimentos</span>
            )}
          </button>
        </nav>
      </div>

      {/* Conversations List */}
      <div className="w-80 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center space-x-2 min-w-0">
              <span className="material-icons-round text-slate-400 flex-shrink-0">sort</span>
              <span className="font-bold text-sm truncate">
                {selectedFechadosFilter ? 'Fechados' :
                 selectedPendingType === 'pedidos-orcamentos' ? 'Pedidos de Orçamentos' :
                 'Atribuídos'}
              </span>
            </div>
            {!selectedPendingType && !selectedFechadosFilter && (
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
          {/* Sub-abas: Pendentes | Orçamentos enviados (só quando na aba Pedidos de Orçamento) */}
          {selectedPendingType === 'pedidos-orcamentos' && (
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
              placeholder={selectedPendingType === 'pedidos-orcamentos' ? 'Buscar pedidos...' : 'Buscar conversas...'}
              type="text"
            />
          </div>
        </div>
        <div className="flex-grow overflow-y-auto custom-scrollbar">
          {selectedPendingType === 'pedidos-orcamentos' ? (
            (() => {
              const isEnviados = selectedPendingType === 'pedidos-orcamentos' && quoteSubTab === 'enviados';
              const list = isEnviados ? sentQuoteCards : quoteCards;
              return isLoadingQuotes ? (
                <div className="flex items-center justify-center p-8">
                  <span className="text-slate-400 text-sm">Carregando pedidos...</span>
                </div>
              ) : list.length === 0 ? (
                <div className="flex items-center justify-center p-8">
                  <span className="text-slate-400 text-sm">
                    {isEnviados ? 'Nenhum orçamento enviado' : 'Nenhum pedido encontrado'}
                  </span>
                </div>
              ) : (
                list.map((quote) => {
                const quoteDate = new Date(quote.createdAt);
                const hours = quoteDate.getHours();
                const minutes = quoteDate.getMinutes();
                const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
                const isSelected = selectedQuote?.id === quote.id;
                const isUnviewed = !isEnviados && !viewedQuoteIds.has(quote.id);
                return (
                  <div
                    key={quote.id}
                    className={`p-4 border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors ${
                      isSelected ? 'bg-green-50/50 dark:bg-green-900/10 border-l-4 border-green-500' : isUnviewed ? 'border-l-4 border-green-500 bg-green-50/30 dark:bg-green-900/5' : ''
                    }`}
                    onClick={() => {
                      markQuoteAsViewed(quote.id);
                      setSelectedQuote(quote);
                      setSelectedConversation(null);
                      setSelectedAttendanceFilter('tudo');
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
                          <h4 className="text-sm font-bold truncate">{quote.clientName || quote.clientPhone}</h4>
                          <p className="text-[10px] text-slate-500 truncate">
                            Pedido de orçamento
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end space-y-1 flex-shrink-0 ml-2">
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
          ) : (
            // Show regular conversations
            isLoadingConversations ? (
              <div className="flex items-center justify-center p-8">
                <span className="text-slate-400 text-sm">Carregando conversas...</span>
              </div>
            ) : displayConversations.length === 0 ? (
              <div className="flex items-center justify-center p-8">
                <span className="text-slate-400 text-sm">Nenhuma conversa encontrada</span>
              </div>
            ) : (
              displayConversations.map((conv) => {
                const isBulkSelected = isBulkSelectMode && selectedAttendancesForBulk.has(String(conv.id));
                const isFinished = (conv as any).state === 'FINISHED';
                return (
              <div
                key={conv.id}
                className={`p-4 border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors flex items-start gap-3 ${
                  selectedConversation === conv.id ? 'bg-green-50/50 dark:bg-green-900/10 border-l-4 border-green-500' : ''
                } ${isBulkSelected ? 'ring-2 ring-green-500 ring-inset' : ''}`}
                onClick={(e) => {
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
                  setSelectedPendingType(null);
                  setPendingMessages([]);
                  setSelectedAttendanceFilter('tudo');
                  setSelectedConversation(conv.id);
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
                  <div className="flex items-center space-x-3">
                    <img alt={conv.name} className="w-10 h-10 rounded-full" src={conv.avatar} />
                    <div>
                      <h4 className="text-sm font-bold">{conv.name}</h4>
                      <p className={`text-[10px] ${conv.status === 'sent' ? 'text-green-600 font-medium italic' : 'text-slate-500'} truncate w-32`}>
                        {conv.lastMessage}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end space-y-1">
                    <span className="text-[10px] text-slate-400">{conv.time}</span>
                    <div className="flex items-center gap-1">
                      {(conv as { interventionType?: string }).interventionType === 'casos_gerentes' && (
                        <span className="w-3 h-3 rounded-full flex-shrink-0" title="Casos gerentes" style={{ backgroundColor: '#7C3AED' }} />
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
              })
            )
          )}
        </div>
      </div>

      {/* Main Chat Area - padrão sem header legado */}
      <main className="flex-grow flex flex-col bg-slate-100 dark:bg-slate-950 min-w-0 relative">
        {selectedPendingType ? (
          <>
            <div className="flex-grow overflow-y-auto p-6 custom-scrollbar min-h-0">
              <button
                type="button"
                onClick={() => {
                  setSelectedPendingType(null);
                  setPendingMessages([]);
                  setSelectedQuote(null);
                  setQuoteSubTab('pendentes');
                }}
                className="mb-4 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
              >
                <span className="material-icons-round text-base">arrow_back</span>
                Voltar aos Atribuídos
              </button>
              {selectedPendingType === 'pedidos-orcamentos' ? (
                (() => {
                  const isEnviadosSubTab = quoteSubTab === 'enviados';
                  const currentList = isEnviadosSubTab ? sentQuoteCards : quoteCards;
                  return (
                <>
                  {isLoadingQuotes ? (
                    <div className="flex items-center justify-center h-48">
                      <span className="material-icons-round animate-spin text-slate-400">refresh</span>
                      <span className="ml-2 text-sm text-slate-500">Carregando...</span>
                    </div>
                  ) : currentList.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center max-w-md">
                        <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4" style={{ backgroundColor: '#FEF3E2' }}>
                          <span className="material-icons-round text-primary text-3xl" style={{ color: '#F07000' }}>description</span>
                        </div>
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
                          {isEnviadosSubTab ? 'Orçamentos enviados' : 'Pedidos de Orçamentos'}
                        </h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                          {isEnviadosSubTab ? 'Nenhum orçamento enviado no momento.' : 'Nenhum pedido no momento. Os cards aparecem aqui quando a IA registrar um orçamento.'}
                        </p>
                      </div>
                    </div>
                  ) : selectedQuote ? (
                    // Mostrar detalhes do pedido selecionado
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
                              {new Date(selectedQuote.createdAt).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' })}
                            </p>
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
                              onClick={() => {
                                setSelectedConversation(selectedQuote.attendanceId);
                                setSelectedPendingType(null);
                                setSelectedQuote(null);
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
                          
                          // Separar seções
                          let vehicleSection = '';
                          let conversationSection = '';
                          let otherSection = '';
                          
                          if (hasConversationSummary) {
                            const parts = obs.split(/Resumo da conversa:/i);
                            vehicleSection = parts[0]?.trim() || '';
                            conversationSection = parts[1]?.trim() || '';
                          } else {
                            if (hasVehicleInfo) {
                              vehicleSection = obs;
                            } else {
                              otherSection = obs;
                            }
                          }
                          
                          return (
                            <div className="mb-4 space-y-3">
                              {/* Informações do Veículo */}
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
                              
                              {/* Resumo da Conversa */}
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
                              
                              {/* Outras observações */}
                              {otherSection && !hasVehicleInfo && !hasConversationSummary && (
                                <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
                                  <div className="text-sm text-slate-600 dark:text-slate-400 whitespace-pre-line">
                                    {otherSection}
                                  </div>
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
                        
                        {/* Campo de resposta do orçamento - apenas para pedidos pendentes */}
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
                                onClick={() => { setSelectedQuoteForPerguntar(selectedQuote.id); setPerguntarText(''); }}
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-sm hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                              >
                                <span className="material-icons-round text-base">help_outline</span>
                                Perguntar ao cliente
                              </button>
                              <button
                                onClick={() => handleEnviarOrcamento(selectedQuote)}
                                disabled={isSendingQuote || (!quoteResponseText.trim() && !quoteResponseImage)}
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                                style={{ backgroundColor: '#003070' }}
                              >
                                <span className="material-icons-round text-base">{isSendingQuote ? 'hourglass_empty' : 'send'}</span>
                                {isSendingQuote ? 'Enviando...' : 'Enviar orçamento'}
                              </button>
                              <button
                                onClick={() => handleDeletarOrcamento(selectedQuote.id)}
                                disabled={isDeletingQuote === selectedQuote.id}
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm hover:bg-red-200 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
                              >
                                <span className="material-icons-round text-base">{isDeletingQuote === selectedQuote.id ? 'hourglass_empty' : 'delete'}</span>
                                {isDeletingQuote === selectedQuote.id ? 'Deletando...' : 'Deletar'}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    // Estado inicial: pedir para selecionar um pedido
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center max-w-md">
                        <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4" style={{ backgroundColor: '#FEF3E2' }}>
                          <span className="material-icons-round text-primary text-3xl" style={{ color: '#F07000' }}>description</span>
                        </div>
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
                          {isEnviadosSubTab ? 'Orçamentos enviados' : 'Pedidos de Orçamentos'}
                        </h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                          {isEnviadosSubTab ? 'Selecione um orçamento enviado na lista à esquerda para ver os detalhes.' : 'Selecione um pedido na lista à esquerda para ver os detalhes.'}
                        </p>
                      </div>
                    </div>
                  )}
                </>
                  );
                })()
              ) : pendingMessages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center max-w-md">
                    <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4" style={{ backgroundColor: '#FEF3E2' }}>
                      <span className="material-icons-round text-primary text-3xl" style={{ color: '#F07000' }}>
                        {getPendingTypeIcon()}
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2" style={{ color: '#0F172A' }}>
                      {getPendingTypeTitle()}
                    </h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                      {getPendingTypeDescription()}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-8">
                  {pendingMessages.map((msg) => (
                    <div key={msg.id} className="flex space-x-4 max-w-2xl ml-auto flex-row-reverse space-x-reverse">
                      <div className="w-8 h-8 bg-navy flex items-center justify-center rounded-full text-[10px] text-white font-bold flex-shrink-0" style={{ backgroundColor: '#003070' }}>
                        AL
                      </div>
                      <div className="space-y-1 text-right">
                        <div className="flex items-baseline space-x-2 flex-row-reverse space-x-reverse">
                          <span className="text-sm font-bold text-slate-900 dark:text-white">{msg.sender}</span>
                          <span className="text-[10px] text-slate-400 dark:text-slate-300">{msg.timestamp}</span>
                        </div>
                        <div className="bg-slate-200 dark:bg-slate-800 p-4 rounded-l-2xl rounded-br-2xl text-sm leading-relaxed text-left">
                          {msg.text}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedPendingType !== 'pedidos-orcamentos' && (
              <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex-shrink-0">
                <div className="max-w-4xl mx-auto flex items-center space-x-4 bg-slate-100 dark:bg-slate-800 p-2 rounded-xl">
                  <textarea
                    ref={pendingMessageTextareaRef}
                    className="flex-grow min-h-[40px] resize-none bg-transparent border-none focus:ring-0 text-sm px-2 py-2 outline-none overflow-hidden text-slate-900 dark:text-white"
                    placeholder="Digite sua mensagem... (Shift+Enter para quebrar linha)"
                    rows={1}
                    style={{ maxHeight: 200 }}
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendPendingMessage();
                      }
                    }}
                  />
                  <div className="flex items-center space-x-2 text-slate-500">
                    <button className="hover:text-navy transition-colors">
                      <span className="material-icons-round">add</span>
                    </button>
                    <button className="hover:text-navy transition-colors">
                      <span className="material-icons-round">attach_file</span>
                    </button>
                  </div>
                  <button
                    className="bg-navy text-white p-2 rounded-lg hover:bg-navy/90 transition-transform active:scale-95 flex items-center justify-center"
                    style={{ backgroundColor: '#003070' }}
                    onClick={handleSendPendingMessage}
                  >
                    <span className="material-icons-round transform rotate-[-45deg] relative left-0.5">send</span>
                  </button>
                </div>
              </div>
            )}
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
                      onClick={() => { setSelectedQuoteForPerguntar(null); setPerguntarText(''); }}
                      className="px-4 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm"
                    >
                      Cancelar
                    </button>
                    <button
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
          <>
            {/* Floating button for sidebar control */}
            <button
              onClick={() => setCustomerSidebarOpen(!customerSidebarOpen)}
              className="absolute top-4 right-4 z-50 p-2 bg-white dark:bg-slate-800 shadow-lg rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              title={customerSidebarOpen ? 'Fechar informações do cliente' : 'Abrir informações do cliente'}
            >
              <span className="material-icons-round text-slate-600 dark:text-slate-300">
                {customerSidebarOpen ? 'chevron_right' : 'chevron_left'}
              </span>
            </button>

            <div 
              ref={messagesContainerRef}
              className={`flex-1 overflow-y-auto py-4 custom-scrollbar min-h-0 ${customerSidebarOpen ? 'px-4' : 'px-6'}`}
              key={`messages-${selectedConversation}`}
            >
              {messages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <span className="material-icons-round text-6xl text-slate-400 mb-4">chat_bubble_outline</span>
                    <p className="text-slate-500 dark:text-slate-400">Nenhuma mensagem ainda</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 pb-4" key={`messages-container-${selectedConversation}-${messages.length}`}>
                  {(() => {
                    // Normalize: ensure content/sender are strings
                    const normalized = messages.map((msg) => ({
                      ...msg,
                      content: msg.content != null ? String(msg.content) : '',
                      sender: msg.sender != null ? String(msg.sender) : (msg.isClient ? 'Cliente' : 'AI'),
                    }));
                    const getTs = (m: any) => (m.metadata?.sentAt ? new Date(m.metadata.sentAt).getTime() : 0);
                    // Dedupe por id
                    const byId = normalized.filter(
                      (msg, i, self) => msg.id && self.findIndex((m) => m.id === msg.id) === i
                    );
                    const sorted = [...byId].sort((a, b) => getTs(a) - getTs(b));
                    // Não exibir mensagens fantasma (sem conteúdo e sem mídia) - evita bloco só com horário ao assumir atendimento
                    const sortedNoGhost = sorted.filter((m: any) => {
                      const hasContent = m.content != null && String(m.content).trim() !== '';
                      const hasMedia = !!(m.metadata?.mediaUrl);
                      return hasContent || hasMedia;
                    });
                    // Para mensagens do CLIENTE: mesmo conteúdo = mesma mensagem. Manter uma só, preferindo a que tem push name.
                    const hasRealSender = (m: any) => m.sender && String(m.sender).trim() !== '' && String(m.sender).toLowerCase() !== 'cliente';
                    const clientContentToLatest = new Map<string, { msg: any; ts: number; hasName: boolean }>();
                    const nonClient: any[] = [];
                    for (const msg of sortedNoGhost) {
                      const content = (msg.content ?? '').trim();
                      if (msg.isClient && content) {
                        const ts = getTs(msg);
                        const hasName = hasRealSender(msg);
                        const existing = clientContentToLatest.get(content);
                        const keepThis =
                          !existing ||
                          (hasName && !existing.hasName) ||
                          (hasName === existing.hasName && ts > existing.ts);
                        if (keepThis) clientContentToLatest.set(content, { msg, ts, hasName });
                      } else {
                        nonClient.push(msg);
                      }
                    }
                    const clientDeduped = Array.from(clientContentToLatest.values()).map((x) => x.msg);
                    const filtered = [...nonClient, ...clientDeduped].sort((a, b) => getTs(a) - getTs(b));
                    
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
                              <span className="text-[10px] opacity-70">{msg.time}</span>
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
                        <div key={key} className={`flex items-start gap-2.5 ${msg.isClient ? '' : 'flex-row-reverse'}`}>
                          {/* Show avatar only for first message in group */}
                          {isFirstInGroup ? (
                            msg.isClient ? (
                              msg.avatar ? (
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
                              )
                            ) : (
                              <div 
                                className="w-9 h-9 bg-navy flex items-center justify-center rounded-full text-[10px] text-white font-medium flex-shrink-0" 
                                style={{ backgroundColor: '#003070' }}
                              >
                                {((msg.sender === 'Altese AI' ? 'AI' : msg.sender) || 'AI').substring(0, 2).toUpperCase() || 'AI'}
                              </div>
                            )
                          ) : (
                            // Spacer to maintain alignment when avatar is hidden
                            <div className="w-9 h-9 flex-shrink-0" />
                          )}
                          <div className={`flex-1 min-w-0 ${msg.isClient ? '' : 'flex flex-col items-end'}`}>
                            {/* Show sender name for first message in group (cliente e vendedor/IA) */}
                            {isFirstInGroup && (
                              <div className={`flex items-center gap-1.5 mb-1 ${msg.isClient ? '' : 'flex-row-reverse'}`}>
                                <span className="text-sm font-medium text-slate-600 dark:text-slate-400">
                                  {(msg.sender === 'Altese AI' ? 'AI' : msg.sender) || (msg.isClient ? 'Cliente' : 'AI')}
                                </span>
                              </div>
                            )}
                            <div 
                              className={`inline-block px-3.5 py-2.5 text-sm leading-relaxed ${customerSidebarOpen ? 'max-w-[85%]' : 'max-w-[90%]'} ${
                                (() => {
                                  const origin = (msg as any).origin || (msg as any).metadata?.origin;
                                  if (origin === 'AI') return 'bg-blue-600 dark:bg-orange-500 text-white rounded-2xl rounded-tr-md shadow-sm';
                                  if (origin === 'SELLER') return 'bg-green-50 dark:bg-green-900/20 text-slate-800 dark:text-slate-100 rounded-2xl rounded-tr-md shadow-sm';
                                  // CLIENT
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
                                    // Vendedor/Supervisor (balão verde claro) → horário preto
                                    if (o === 'SELLER') {
                                      return 'text-slate-900';
                                    }
                                    // Cliente ou outros → cinza suave
                                    return 'text-slate-500 dark:text-slate-400 opacity-70';
                                  })()}`}
                                >
                                  {msg.time}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
              {/* Show typing indicator if AI is typing - só quando IA está ativa (não desativada) */}
              {selectedConversation && isAITyping[selectedConversation] && selectedConversationData?.handledBy === 'AI' && !aiStatus[selectedConversation]?.disabled && (
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
            <div className={`${customerSidebarOpen ? 'p-4' : 'p-4 pr-6'} bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex-shrink-0`}>
              {/* Assume/Return Control Banner - Integrated in bottom bar */}
              {selectedConversationData?.handledBy === 'AI' ? (
                <div className="max-w-4xl mx-auto flex items-center justify-between px-4 py-3 bg-slate-100 dark:bg-slate-800 rounded-xl">
                  <div className="flex items-center space-x-3">
                    <div className={`flex items-center justify-center w-10 h-10 rounded-full ${aiStatus[selectedConversation as string]?.disabled ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-green-100 dark:bg-green-900/30'}`}>
                      <span className={`material-icons-round text-xl ${aiStatus[selectedConversation as string]?.disabled ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                        {aiStatus[selectedConversation as string]?.disabled ? 'pause_circle' : 'smart_toy'}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                        {aiStatus[selectedConversation as string]?.disabled
                          ? 'IA desativada'
                          : 'IA respondendo'}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {aiStatus[selectedConversation as string]?.disabled
                          ? 'Reative no painel à direita ou clique em "Assumir Atendimento" para responder'
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
                        // Atualizar painel direito (IA desativada) e timer "Devolve em"
                        fetchAIStatus(selectedConversation as string);
                        fetchInactivityTimer(selectedConversation as string);
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
                <>
                  <div className="max-w-4xl mx-auto flex items-center justify-between px-4 py-3 bg-slate-100 dark:bg-slate-800 rounded-xl mb-3">
                    <div className="flex items-center space-x-3">
                      <div className="flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30">
                        <span className="material-icons-round text-blue-600 dark:text-blue-400 text-xl">person</span>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                          Você está respondendo este atendimento
                        </p>
                        <div className="flex items-center space-x-2">
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            A IA continuará armazenando o contexto da conversa
                          </p>
                          {selectedConversation && inactivityTimer[selectedConversation as string] !== undefined && (
                            <span className="text-xs font-semibold text-orange-600 dark:text-orange-400">
                              • Devolve em: {formatTimer(inactivityTimer[selectedConversation as string])}
                            </span>
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
                          
                          // Update local state optimistically
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
                          
                          // Clear inactivity timer
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
                      className="flex items-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-all text-sm font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
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
                  {/* Message input area - only show when human is handling. Shift+Enter = quebra linha, Enter = enviar */}
                  <div className={`${customerSidebarOpen ? 'max-w-4xl mx-auto' : 'w-full'} flex items-center space-x-4 bg-slate-100 dark:bg-slate-800 p-2 rounded-xl`}>
                  <textarea
                    ref={chatMessageTextareaRef}
                    className="flex-grow min-h-[40px] resize-none bg-transparent border-none focus:ring-0 text-sm px-2 py-2 outline-none overflow-hidden text-slate-900 dark:text-white"
                    placeholder="Digite sua mensagem... (Shift+Enter para quebrar linha)"
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
                  <div className="flex items-center space-x-2 text-slate-500 relative">
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
                      className="hover:text-navy transition-colors disabled:opacity-50 p-2" 
                      disabled={!selectedConversation}
                      onClick={() => setShowAudioRecorder(true)}
                      title="Gravar áudio"
                    >
                      <span className="material-icons-round">mic</span>
                    </button>
                    <div className="relative" ref={emojiPickerRef}>
                      <button 
                        className="hover:text-navy transition-colors disabled:opacity-50 p-2" 
                        disabled={!selectedConversation}
                        onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                        title="Emojis"
                      >
                        <span className="material-icons-round">sentiment_satisfied</span>
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
                    className="bg-navy text-white p-2 rounded-lg hover:bg-navy/90 transition-transform active:scale-95 flex items-center justify-center"
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
                </>
              ) : null}
            </div>
            {showAudioRecorder && (
              <AudioRecorder
                onRecordingComplete={handleSendAudioRecording}
                onCancel={() => setShowAudioRecorder(false)}
              />
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <span className="material-icons-round text-6xl text-slate-400 mb-4">chat_bubble_outline</span>
              <p className="text-slate-500 dark:text-slate-400">Selecione uma pendência ou conversa para começar</p>
            </div>
          </div>
        )}
      </main>

      {/* Customer Info Sidebar */}
      {selectedConversation && (
        <aside 
          className={`bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 overflow-y-auto custom-scrollbar flex-shrink-0 transition-all duration-300 ease-in-out ${
            customerSidebarOpen 
              ? 'w-80 translate-x-0 opacity-100' 
              : 'w-0 translate-x-full opacity-0 pointer-events-none overflow-hidden'
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
              <h3 className="text-base font-bold">{selectedConversationData?.clientName || selectedConvName || 'Cliente'}</h3>
              {selectedConversationData?.clientPhone && (
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 flex items-center justify-center space-x-1">
                  <span className="material-icons-round text-sm">phone</span>
                  <span>{formatPhoneNumber(selectedConversationData.clientPhone)}</span>
                </p>
              )}
            </div>
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-3 text-slate-500">
                  <div className="p-1.5 bg-green-50 dark:bg-green-900/20 rounded-md">
                    <span className="material-icons-round text-green-500 text-sm">auto_awesome</span>
                  </div>
                  <span className="font-medium">Status:</span>
                </div>
                <span className={`font-bold flex items-center space-x-1 ${
                  selectedConversationData?.state === 'OPEN' ? 'text-green-600' :
                  selectedConversationData?.state === 'IN_PROGRESS' ? 'text-blue-600' :
                  'text-slate-500'
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
                <div className="flex items-center space-x-3 text-slate-500">
                  <div className="p-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-md">
                    <span className="material-icons-round text-blue-500 text-sm">person</span>
                  </div>
                  <span className="font-medium">Sendo atendido por:</span>
                </div>
                <span className="font-bold">
                  {selectedConversationData?.handledBy === 'AI' ? 'IA' : 'Humano'}
                </span>
              </div>
              {selectedConversationData?.vehicleBrand && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center space-x-3 text-slate-500">
                    <div className="p-1.5 bg-purple-50 dark:bg-purple-900/20 rounded-md">
                      <span className="material-icons-round text-purple-500 text-sm">directions_car</span>
                    </div>
                    <span className="font-medium">Marca:</span>
                  </div>
                  <span className="font-bold">
                    {selectedConversationData.vehicleBrand === 'FORD' ? 'Ford' :
                     selectedConversationData.vehicleBrand === 'GM' ? 'GM' :
                     selectedConversationData.vehicleBrand === 'VW' ? 'Volkswagen' :
                     selectedConversationData.vehicleBrand === 'FIAT' ? 'Fiat' :
                     selectedConversationData.vehicleBrand === 'IMPORTADOS' ? 'Importados' :
                     selectedConversationData.vehicleBrand}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-3 text-slate-500">
                  <div className="p-1.5 bg-purple-50 dark:bg-purple-900/20 rounded-md">
                    <span className="material-icons-round text-purple-500 text-sm">visibility</span>
                  </div>
                  <span className="font-medium">Último Contato:</span>
                </div>
                <span className="font-bold">
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
                <div className="flex items-center space-x-3 text-slate-500">
                  <div className="p-1.5 bg-yellow-50 dark:bg-yellow-900/20 rounded-md">
                    <span className="material-icons-round text-yellow-500 text-sm">bookmark</span>
                  </div>
                  <span className="font-medium">Primeiro contato:</span>
                </div>
                <span className="font-bold">
                  {selectedConversationData?.createdAt ? (() => {
                    const created = new Date(selectedConversationData.createdAt);
                    const now = new Date();
                    const diffMs = now.getTime() - created.getTime();
                    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                    
                    if (diffDays === 0) return 'Hoje';
                    if (diffDays === 1) return 'Há 1 dia';
                    return `Há ${diffDays} dias`;
                  })() : 'N/A'}
                </span>
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

              {/* AI Status Control */}
              {selectedConversation && (
                <div className="pt-4 border-t border-slate-100 dark:border-slate-800 w-full">
                  <AIStatusControl 
                    attendanceId={selectedConversation}
                    handledByHuman={selectedConversationData?.handledBy === 'HUMAN'}
                    onStatusChange={() => {
                      // Atualizar status local para o "digitando" voltar a aparecer quando IA for reativada
                      fetchAIStatus(selectedConversation as string);
                    }}
                  />
                </div>
              )}
            </div>
            {selectedConversationData?.state !== 'FINISHED' && (
              <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  onClick={async () => {
                    if (!selectedConversation) return;
                    if (!confirm('Tem certeza que deseja fechar este atendimento?')) return;
                    try {
                      await attendanceService.closeAttendance(selectedConversation);
                      setConversations((prev) => prev.filter(c => c.id !== selectedConversation));
                      setSelectedConversation(null);
                      setSelectedConversationData(null);
                      setMessages([]);
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
              </div>
            )}
            <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={async () => {
                  if (!selectedConversation) return;
                  
                  if (!confirm('Tem certeza que deseja excluir este contato? Esta ação não pode ser desfeita.')) {
                    return;
                  }

                  try {
                    await attendanceService.deleteAttendance(selectedConversation);
                    // Remove from conversations list
                    setConversations((prev) => prev.filter(c => c.id !== selectedConversation));
                    // Clear selected conversation
                    setSelectedConversation(null);
                    setSelectedConversationData(null);
                    setMessages([]);
                    // Show success message
                    toast.success('Contato excluído com sucesso');
                  } catch (error: any) {
                    console.error('Error deleting attendance:', error);
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
