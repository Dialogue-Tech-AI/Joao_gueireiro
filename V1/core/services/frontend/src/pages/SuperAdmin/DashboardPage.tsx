import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/auth.store';
import toast from 'react-hot-toast';
import { whatsappService, WhatsAppNumberListItem } from '../../services/whatsapp.service';
import { userService, User } from '../../services/user.service';
import { aiConfigService, PendingFunctionConfig, functionCallConfigService, FunctionCallConfig, FollowUpConfig, FollowUpMovementConfig } from '../../services/ai-config.service';
import { v4 as uuidv4 } from 'uuid';
import { BufferConfigTab } from '../../components/SuperAdmin/BufferConfigTab';
import { TemperatureConfigTab } from '../../components/SuperAdmin/TemperatureConfigTab';
import { MultiAgentTab } from '../../components/SuperAdmin/MultiAgentTab';
import { WorkflowTab } from '../../components/SuperAdmin/WorkflowTab';
import { CostsTab } from '../../components/SuperAdmin/CostsTab';
import { SubdivisionInactivityTimeouts } from '../../components/SuperAdmin/SubdivisionInactivityTimeouts';
import { FollowUpConfigTab } from '../../components/SuperAdmin/FollowUpConfigTab';
import { FollowUpMovementConfigTab } from '../../components/SuperAdmin/FollowUpMovementConfigTab';
import { AutoReopenTimeout } from '../../components/SuperAdmin/AutoReopenTimeout';
import { ImageDescriptionPrompt } from '../../components/SuperAdmin/ImageDescriptionPrompt';
import { BibliotecaDashboard, type BibliotecaSchema } from '../../components/SuperAdmin/BibliotecaDashboard';
import { multiAgentService } from '../../services/multi-agent.service';
import { workflowService, type Workflow } from '../../services/workflow.service';
import { bibliotecaService, processToFCFields, processToFCFieldsArrays, type BibliotecaPrompt, type BibliotecaFunctionCall, type BibliotecaFolder, type Process, type AgentFunctionCall as AgentFunctionCallAPI } from '../../services/biblioteca.service';

// URL do backend (webhook, etc). Em dev usar localhost para não afetar produção.
const BACKEND_URL = import.meta.env.VITE_API_URL || '/api';

type MenuItem = 'whatsapp' | 'sellers' | 'ai-config' | 'costs';
type AIConfigTab =
  | 'tools'
  | 'buffer';

type BibliotecaFolder = { id: string; name: string; parentId: string | null };
type BibliotecaPrompt = { id: string; name: string; content: string; folderId: string | null };
type BibliotecaFunctionCall = {
  id: string;
  name: string;
  folderId: string | null;
  objective: string;
  triggerConditions: string;
  executionTiming: string;
  requiredFields: string;
  optionalFields: string;
  restrictions: string;
  processingNotes: string;
  isActive: boolean;
  hasOutput: boolean;
  processingMethod: 'RABBITMQ' | 'HTTP';
  customAttributes: Record<string, string>;
};

type AgentFunctionCall = {
  id: string;
  name: string;
  objective: string;
  triggerConditions: string;
  executionTiming: string;
  requiredFields: string;
  optionalFields: string;
  restrictions: string;
  processingNotes: string;
  isActive: boolean;
  hasOutput: boolean;
  processingMethod: 'RABBITMQ' | 'HTTP';
  customAttributes: Record<string, string>;
  bibliotecaId?: string; // ID from biblioteca if imported
};


const OPENAI_MODELS = [
  { id: 'gpt-4.1', label: 'GPT-4.1', desc: 'Mais capaz, código e instruções' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', desc: 'Rápido e eficiente (recomendado)' },
  { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', desc: 'Mais rápido e econômico (correto)' },
  { id: 'gpt-4o', label: 'GPT-4o', desc: 'Flagship, multimodal' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', desc: 'Leve, multimodal' },
  { id: 'gpt-4o-nano', label: 'GPT-4o nano', desc: 'DEPRECADO - Use gpt-4.1-nano' },
  { id: 'gpt-5-nano', label: 'GPT-5 nano', desc: 'Próxima geração, máximo de economia' },
  { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', desc: '128k contexto' },
  { id: 'gpt-4', label: 'GPT-4', desc: 'Modelo clássico' },
  { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', desc: 'Rápido, tarefas simples' },
] as const;

interface Seller {
  id: string;
  name: string;
  email: string;
}

export const SuperAdminDashboard: React.FC = () => {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [activeMenu, setActiveMenu] = useState<MenuItem>('sellers');
  const [aiConfigMode, setAiConfigMode] = useState<'geral' | 'agent' | 'multi-agent' | 'biblioteca'>('geral');
  const [aiConfigDropdownOpen, setAiConfigDropdownOpen] = useState(false);
  const SIDEBAR_COLLAPSED_KEY = 'superadmin-sidebar-collapsed';
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {}
      return next;
    });
  };
  const [aiConfigTab, setAiConfigTab] = useState<AIConfigTab>('tools');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingFunctionCall, setEditingFunctionCall] = useState<string | null>(null);
  const [showFunctionCallModal, setShowFunctionCallModal] = useState(false);
  const [selectedFunctionCallForView, setSelectedFunctionCallForView] = useState<string>('');
  const [functionCallSearchQuery, setFunctionCallSearchQuery] = useState('');
  const [apiType, setApiType] = useState<'official' | 'unofficial'>('official');
  const [unofficialName, setUnofficialName] = useState('');
  const [officialName, setOfficialName] = useState('');
  const [officialPhoneNumber, setOfficialPhoneNumber] = useState('');
  const [officialAccessToken, setOfficialAccessToken] = useState('');
  const [officialVerifyToken, setOfficialVerifyToken] = useState('');
  const [officialConnecting, setOfficialConnecting] = useState(false);
  const [whatsappTab, setWhatsappTab] = useState<'create' | 'list'>('list');
  const [sellersTab, setSellersTab] = useState<'manage' | 'list'>('list');

  // Biblioteca: árvore única (estilo Obsidian)
  const [bibliotecaFolders, setBibliotecaFolders] = useState<BibliotecaFolder[]>([]);
  const [bibliotecaEditingFolderId, setBibliotecaEditingFolderId] = useState<string | null>(null);
  const [bibliotecaPrompts, setBibliotecaPrompts] = useState<BibliotecaPrompt[]>([]);
  const [bibliotecaFunctionCalls, setBibliotecaFunctionCalls] = useState<BibliotecaFunctionCall[]>([]);
  const [bibliotecaSchemas, setBibliotecaSchemas] = useState<BibliotecaSchema[]>([]);
  const [bibliotecaProcesses, setBibliotecaProcesses] = useState<Process[]>([]);
  const [bibliotecaSelectedFolderId, setBibliotecaSelectedFolderId] = useState<string | null>(null);
  const [bibliotecaSelectedItem, setBibliotecaSelectedItem] = useState<{ type: 'prompt' | 'function-call' | 'schema' | 'process'; id: string } | null>(null);
  const [isLoadingBiblioteca, setIsLoadingBiblioteca] = useState(false);
  const [showCreatePromptModal, setShowCreatePromptModal] = useState(false);
  const [createPromptName, setCreatePromptName] = useState('');
  const [createPromptContent, setCreatePromptContent] = useState('');
  const [createPromptFolderId, setCreatePromptFolderId] = useState<string>('');
  const [showEditPromptModal, setShowEditPromptModal] = useState(false);
  const [editPromptId, setEditPromptId] = useState<string | null>(null);
  const [editPromptName, setEditPromptName] = useState('');
  const [editPromptContent, setEditPromptContent] = useState('');
  const [editPromptFolderId, setEditPromptFolderId] = useState<string>('');
  const [editFolderState, setEditFolderState] = useState<{ folderId: string; name: string; parentId: string | null } | null>(null);
  const [bibliotecaCollapsedFolderIds, setBibliotecaCollapsedFolderIds] = useState<string[]>([]);
  
  // Import from Biblioteca modal state
  const [showImportBibliotecaModal, setShowImportBibliotecaModal] = useState(false);
  const [selectedPromptsToImport, setSelectedPromptsToImport] = useState<string[]>([]);
  const [selectedFunctionCallsToImport, setSelectedFunctionCallsToImport] = useState<string[]>([]);
  
  // Local state for modal to ensure fresh data
  const [modalPrompts, setModalPrompts] = useState<BibliotecaPrompt[]>([]);
  const [modalFunctionCalls, setModalFunctionCalls] = useState<BibliotecaFunctionCall[]>([]);
  
  // Function to reload modal data from API
  const reloadModalData = useCallback(async () => {
    try {
      const [prompts, functionCalls] = await Promise.all([
        bibliotecaService.getAllPrompts(),
        bibliotecaService.getAllFunctionCalls(),
      ]);
      setModalPrompts(prompts);
      setModalFunctionCalls(functionCalls);
    } catch (error: any) {
      console.error('Error reloading modal data:', error);
      toast.error('Erro ao carregar dados da biblioteca');
    }
  }, []);

  // Reload data from API when modal opens
  useEffect(() => {
    if (showImportBibliotecaModal) {
      reloadModalData();
    } else {
      // Clear modal data when closed
      setModalPrompts([]);
      setModalFunctionCalls([]);
    }
  }, [showImportBibliotecaModal, reloadModalData]);
  
  // Also update modal data when biblioteca data changes (if modal is open)
  useEffect(() => {
    if (showImportBibliotecaModal) {
      reloadModalData();
    }
  }, [bibliotecaPrompts, bibliotecaFunctionCalls, showImportBibliotecaModal, reloadModalData]);
  const [showCreateBibliotecaFunctionCallModal, setShowCreateBibliotecaFunctionCallModal] = useState(false);
  const [createFCName, setCreateFCName] = useState('');
  const [createFCFolderId, setCreateFCFolderId] = useState('');
  const [createFCObjective, setCreateFCObjective] = useState('');
  const [createFCTriggerConditions, setCreateFCTriggerConditions] = useState('');
  const [createFCExecutionTiming, setCreateFCExecutionTiming] = useState('');
  const [createFCRequiredFields, setCreateFCRequiredFields] = useState('');
  const [createFCOptionalFields, setCreateFCOptionalFields] = useState('');
  const [createFCRestrictions, setCreateFCRestrictions] = useState('');
  const [createFCProcessingNotes, setCreateFCProcessingNotes] = useState('');
  const [createFCHasOutput, setCreateFCHasOutput] = useState(false);
  const [createFCProcessingMethod, setCreateFCProcessingMethod] = useState<'RABBITMQ' | 'HTTP'>('RABBITMQ');
  const [createFCCustomAttributes, setCreateFCCustomAttributes] = useState<Array<{ key: string; value: string }>>([]);
  const [createFCProcessId, setCreateFCProcessId] = useState<string | null>(null);
  const [showEditBibliotecaFunctionCallModal, setShowEditBibliotecaFunctionCallModal] = useState(false);
  const [editFCId, setEditFCId] = useState<string | null>(null);
  const [editFCName, setEditFCName] = useState('');
  const [editFCFolderId, setEditFCFolderId] = useState('');
  const [editFCObjective, setEditFCObjective] = useState('');
  const [editFCTriggerConditions, setEditFCTriggerConditions] = useState('');
  const [editFCExecutionTiming, setEditFCExecutionTiming] = useState('');
  const [editFCRequiredFields, setEditFCRequiredFields] = useState('');
  const [editFCOptionalFields, setEditFCOptionalFields] = useState('');
  const [editFCRestrictions, setEditFCRestrictions] = useState('');
  const [editFCProcessingNotes, setEditFCProcessingNotes] = useState('');
  const [editFCIsActive, setEditFCIsActive] = useState(true);
  const [editFCHasOutput, setEditFCHasOutput] = useState(false);
  const [editFCProcessingMethod, setEditFCProcessingMethod] = useState<'RABBITMQ' | 'HTTP'>('RABBITMQ');
  const [editFCCustomAttributes, setEditFCCustomAttributes] = useState<Array<{ key: string; value: string }>>([]);
  const [editFCProcessId, setEditFCProcessId] = useState<string | null>(null);
  const [bibliotecaCopiedItem, setBibliotecaCopiedItem] = useState<{ type: 'prompt' | 'function-call' | 'folder'; data: any } | null>(null);
  const [bibliotecaEditFCIdRequest, setBibliotecaEditFCIdRequest] = useState<string | null>(null);
  const [bibliotecaEditPromptIdRequest, setBibliotecaEditPromptIdRequest] = useState<string | null>(null);
  const [editingSchema, setEditingSchema] = useState<BibliotecaSchema | null>(null);
  const [editSchemaName, setEditSchemaName] = useState('');
  const [editSchemaDefinition, setEditSchemaDefinition] = useState('');
  const [renamingSchema, setRenamingSchema] = useState<BibliotecaSchema | null>(null);
  const [renameSchemaName, setRenameSchemaName] = useState('');
  const [showCreateSchemaModal, setShowCreateSchemaModal] = useState(false);
  const [createSchemaFolderId, setCreateSchemaFolderId] = useState<string | null>(null);
  const [createSchemaName, setCreateSchemaName] = useState('');
  const [createSchemaType, setCreateSchemaType] = useState<'sem-tags' | 'com-tags' | null>(null);

  const toggleBibliotecaFolder = (folderId: string) => {
    setBibliotecaCollapsedFolderIds((prev) =>
      prev.includes(folderId) ? prev.filter((id) => id !== folderId) : [...prev, folderId]
    );
  };

  // WhatsApp connection states
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [connectingNumberId, setConnectingNumberId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [isLoading, setIsLoading] = useState(false);
  const [qrCodeExpiresIn, setQrCodeExpiresIn] = useState<number | null>(null);
  const [qrCodeRegenerationAttempts, setQrCodeRegenerationAttempts] = useState<number>(0);
  const statusPollingInterval = useRef<NodeJS.Timeout | null>(null);
  const qrCodeTimerInterval = useRef<NodeJS.Timeout | null>(null);
  const mainContentRef = useRef<HTMLDivElement>(null);
  const leftColumnRef = useRef<HTMLDivElement>(null);
  
  // WhatsApp numbers list state
  const [whatsappNumbersList, setWhatsappNumbersList] = useState<WhatsAppNumberListItem[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [editingNumberId, setEditingNumberId] = useState<string | null>(null);
  const [editingNumberType, setEditingNumberType] = useState<'UNDEFINED' | 'PRIMARY' | 'SECONDARY'>('UNDEFINED');
  const [editingSellerId, setEditingSellerId] = useState<string | null>(null);
  
  // User management states
  const [users, setUsers] = useState<User[]>([]);
  const [sellersList, setSellersList] = useState<User[]>([]);
  const [supervisorsList, setSupervisorsList] = useState<User[]>([]);
  const [adminsList, setAdminsList] = useState<User[]>([]);
  const [sellersDetails, setSellersDetails] = useState<Array<{
    id: string;
    name: string;
    email: string;
    active: boolean;
    brands: string[];
    supervisorId: string | null;
    supervisor: { id: string; name: string; email: string } | null;
    supervisors?: Array<{ id: string; name: string; email: string }>;
    createdAt: string;
    updatedAt: string;
  }>>([]);
  const [editingBrandSellerId, setEditingBrandSellerId] = useState<string | null>(null);
  const [editingSellerBrand, setEditingSellerBrand] = useState<string>('INDEFINIDO');
  
  // Create user modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  
  // AI Config states
  const [agentPrompt, setAgentPrompt] = useState<string>('');
  const [agentPromptBibliotecaId, setAgentPromptBibliotecaId] = useState<string | null>(null); // ID do prompt na biblioteca se estiver salvo
  const [showSaveAgentPromptModal, setShowSaveAgentPromptModal] = useState(false);
  const [saveAgentPromptName, setSaveAgentPromptName] = useState('');
  const [saveAgentPromptFolderId, setSaveAgentPromptFolderId] = useState<string>('');
  const [imageDescriptionPrompt, setImageDescriptionPrompt] = useState<string>('');
  
  // Agent Function Calls (local to agent, separate from biblioteca) - loaded from API
  const [agentFunctionCalls, setAgentFunctionCalls] = useState<AgentFunctionCall[]>([]);
  const [isLoadingAgentFCs, setIsLoadingAgentFCs] = useState(false);
  const agentFCsLoadedRef = useRef(false); // evita salvar [] antes do primeiro load
  const [editingAgentFCId, setEditingAgentFCId] = useState<string | null>(null);
  const [showCreateAgentFCModal, setShowCreateAgentFCModal] = useState(false);
  
  // Modal para adicionar function call à biblioteca
  const [showAddFCToBibliotecaModal, setShowAddFCToBibliotecaModal] = useState(false);
  const [addFCToBibliotecaId, setAddFCToBibliotecaId] = useState<string | null>(null);
  const [addFCToBibliotecaName, setAddFCToBibliotecaName] = useState('');
  const [addFCToBibliotecaFolderId, setAddFCToBibliotecaFolderId] = useState<string>('');
  
  // Agent FC form states
  const [agentFCName, setAgentFCName] = useState('');
  const [agentFCObjective, setAgentFCObjective] = useState('');
  const [agentFCTriggerConditions, setAgentFCTriggerConditions] = useState('');
  const [agentFCExecutionTiming, setAgentFCExecutionTiming] = useState('');
  const [agentFCRequiredFields, setAgentFCRequiredFields] = useState('');
  const [agentFCOptionalFields, setAgentFCOptionalFields] = useState('');
  const [agentFCRestrictions, setAgentFCRestrictions] = useState('');
  const [agentFCProcessingNotes, setAgentFCProcessingNotes] = useState('');
  const [agentFCIsActive, setAgentFCIsActive] = useState(true);
  const [agentFCHasOutput, setAgentFCHasOutput] = useState(false);
  const [agentFCProcessingMethod, setAgentFCProcessingMethod] = useState<'RABBITMQ' | 'HTTP'>('RABBITMQ');
  const [agentFCCustomAttributes, setAgentFCCustomAttributes] = useState<Array<{ key: string; value: string }>>([]);
  
  // Load editing FC data when editingAgentFCId changes
  useEffect(() => {
    if (editingAgentFCId) {
      const fcToEdit = agentFunctionCalls.find((f) => f.id === editingAgentFCId);
      if (fcToEdit) {
        setAgentFCName(fcToEdit.name);
        setAgentFCObjective(fcToEdit.objective);
        setAgentFCTriggerConditions(fcToEdit.triggerConditions);
        setAgentFCExecutionTiming(fcToEdit.executionTiming);
        setAgentFCRequiredFields(fcToEdit.requiredFields);
        setAgentFCOptionalFields(fcToEdit.optionalFields);
        setAgentFCRestrictions(fcToEdit.restrictions);
        setAgentFCProcessingNotes(fcToEdit.processingNotes);
        setAgentFCIsActive(fcToEdit.isActive);
        setAgentFCHasOutput(fcToEdit.hasOutput);
        setAgentFCProcessingMethod(fcToEdit.processingMethod);
        setAgentFCCustomAttributes(
          fcToEdit.customAttributes
            ? Object.entries(fcToEdit.customAttributes).map(([k, v]) => ({ key: k, value: String(v) }))
            : []
        );
      }
    }
  }, [editingAgentFCId, agentFunctionCalls]);
  
  // Reset form when creating new FC
  useEffect(() => {
    if (showCreateAgentFCModal && !editingAgentFCId) {
      setAgentFCName('');
      setAgentFCObjective('');
      setAgentFCTriggerConditions('');
      setAgentFCExecutionTiming('');
      setAgentFCRequiredFields('');
      setAgentFCOptionalFields('');
      setAgentFCRestrictions('');
      setAgentFCProcessingNotes('');
      setAgentFCIsActive(true);
      setAgentFCHasOutput(false);
      setAgentFCProcessingMethod('RABBITMQ');
      setAgentFCCustomAttributes([]);
    }
  }, [showCreateAgentFCModal, editingAgentFCId]);
  
  // Persist agent function calls to API (inclui lista vazia após "Remover do agente")
  useEffect(() => {
    if (isLoadingAgentFCs) return;
    // Só persiste depois do primeiro load; evita salvar [] e apagar tudo antes de carregar
    if (!agentFCsLoadedRef.current) return;

    const saveAgentFunctionCalls = async () => {
      try {
        setIsLoadingAgentFCs(true);
        await bibliotecaService.saveAllAgentFunctionCalls(agentFunctionCalls);
      } catch (error: any) {
        console.error('Error saving agent function calls to API:', error);
        toast.error('Erro ao salvar function calls do agente');
      } finally {
        setIsLoadingAgentFCs(false);
      }
    };

    const timeoutId = setTimeout(saveAgentFunctionCalls, 500);
    return () => clearTimeout(timeoutId);
  }, [agentFunctionCalls]);

  // Load agent function calls on mount
  useEffect(() => {
    const loadAgentFunctionCalls = async () => {
      try {
        setIsLoadingAgentFCs(true);
        const fcs = await bibliotecaService.getAllAgentFunctionCalls();
        setAgentFunctionCalls(fcs);
      } catch (error: any) {
        console.error('Error loading agent function calls:', error);
        toast.error('Erro ao carregar function calls do agente');
      } finally {
        setIsLoadingAgentFCs(false);
        agentFCsLoadedRef.current = true;
      }
    };
    loadAgentFunctionCalls();
  }, []);
  
  // Load biblioteca data on mount (prompts, FCs, folders, schemas, processes).
  // Usa Promise.allSettled para que falha em uma requisição (ex.: processos sem migration) não zere os demais dados.
  useEffect(() => {
    const loadBibliotecaData = async () => {
      setIsLoadingBiblioteca(true);
      const [promptsResult, functionCallsResult, foldersResult, schemasResult, processesResult] =
        await Promise.allSettled([
          bibliotecaService.getAllPrompts(),
          bibliotecaService.getAllFunctionCalls(),
          bibliotecaService.getAllFolders(),
          bibliotecaService.getAllSchemas(),
          bibliotecaService.getAllProcesses(),
        ]);

      if (promptsResult.status === 'fulfilled') {
        const prompts = promptsResult.value || [];
        setBibliotecaPrompts(prompts);
        if (agentPrompt.trim()) {
          const matchingPrompt = prompts.find((p) => p.content.trim() === agentPrompt.trim());
          setAgentPromptBibliotecaId(matchingPrompt?.id || null);
        }
      } else {
        console.error('Error loading prompts:', promptsResult.reason);
        setBibliotecaPrompts([]);
      }

      if (functionCallsResult.status === 'fulfilled') {
        setBibliotecaFunctionCalls(functionCallsResult.value || []);
      } else {
        console.error('Error loading function calls:', functionCallsResult.reason);
        setBibliotecaFunctionCalls([]);
      }

      if (foldersResult.status === 'fulfilled') {
        setBibliotecaFolders(foldersResult.value || []);
      } else {
        console.error('Error loading folders:', foldersResult.reason);
        setBibliotecaFolders([]);
      }

      if (schemasResult.status === 'fulfilled') {
        const schemas = schemasResult.value || [];
        setBibliotecaSchemas(schemas.map((s) => ({ id: s.id, name: s.name, folderId: s.folderId ?? null, definition: s.definition ?? undefined, schemaType: s.schemaType ?? undefined })));
      } else {
        console.error('Error loading schemas:', schemasResult.reason);
        setBibliotecaSchemas([]);
      }

      if (processesResult.status === 'fulfilled') {
        setBibliotecaProcesses(processesResult.value || []);
      } else {
        console.warn('Error loading processes (pode ser tabela ainda não criada):', processesResult.reason);
        setBibliotecaProcesses([]);
      }

      const failed = [promptsResult, functionCallsResult, foldersResult, schemasResult].filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        toast.error(`Erro ao carregar alguns dados da biblioteca. Verifique o console.`);
      }
      setIsLoadingBiblioteca(false);
    };
    loadBibliotecaData();
  }, []);
  
  // Check if agent prompt is saved in biblioteca when prompt changes
  useEffect(() => {
    if (agentPrompt.trim() && bibliotecaPrompts.length > 0) {
      const matchingPrompt = bibliotecaPrompts.find((p) => p.content.trim() === agentPrompt.trim());
      setAgentPromptBibliotecaId(matchingPrompt?.id || null);
    } else {
      setAgentPromptBibliotecaId(null);
    }
  }, [agentPrompt, bibliotecaPrompts]);

  const [pendingFunctionsConfig, setPendingFunctionsConfig] = useState<PendingFunctionConfig>({
    orcamento: { enabled: true },
    fechamento: { enabled: true },
    garantias: { enabled: true },
    encomendas: { enabled: true },
    chamado_humano: { enabled: true },
  });
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isLoadingImagePrompt, setIsLoadingImagePrompt] = useState(false);
  const [isSavingImagePrompt, setIsSavingImagePrompt] = useState(false);
  
  // Buffer Config states
  const [bufferEnabled, setBufferEnabled] = useState<boolean>(false);
  const [bufferTimeMs, setBufferTimeMs] = useState<number>(5000);
  const [isLoadingBuffer, setIsLoadingBuffer] = useState(false);
  const [isSavingBuffer, setIsSavingBuffer] = useState(false);

  // Blacklist config states
  const [blacklistEnabled, setBlacklistEnabled] = useState<boolean>(false);
  const [blacklistNumbers, setBlacklistNumbers] = useState<string[]>([]);
  const [blacklistNewNumber, setBlacklistNewNumber] = useState('');
  const [isLoadingBlacklist, setIsLoadingBlacklist] = useState(false);
  const [isSavingBlacklist, setIsSavingBlacklist] = useState(false);

  // Auto-reopen timeout config states
  const [autoReopenTimeoutMinutes, setAutoReopenTimeoutMinutes] = useState<number>(60);
  const [isLoadingAutoReopen, setIsLoadingAutoReopen] = useState(false);
  const [isSavingAutoReopen, setIsSavingAutoReopen] = useState(false);

  // Subdivision inactivity timeouts config states
  const [subdivisionInactivityTimeouts, setSubdivisionInactivityTimeouts] = useState<Record<string, number>>({});
  const [isLoadingSubdivisionTimeouts, setIsLoadingSubdivisionTimeouts] = useState(false);
  const [isSavingSubdivisionTimeouts, setIsSavingSubdivisionTimeouts] = useState(false);

  // Follow-up config states (tempos e mensagens de follow-up por inatividade)
  const [followUpConfig, setFollowUpConfig] = useState<FollowUpConfig>({
    firstDelayMinutes: 60,
    secondDelayMinutes: 1440,
    closeDelayMinutes: 2160,
    firstMessage: '',
    secondMessage: '',
  });
  const [isLoadingFollowUp, setIsLoadingFollowUp] = useState(false);
  const [isSavingFollowUp, setIsSavingFollowUp] = useState(false);

  // Follow-up movement config (movimentação entre divisões)
  const [followUpMovementConfig, setFollowUpMovementConfig] = useState<FollowUpMovementConfig>({
    moveOpenToFirstFollowUpMinutes: 60,
    moveToFechadosAfterSecondFollowUpMinutes: 1440,
  });
  const [isLoadingFollowUpMovement, setIsLoadingFollowUpMovement] = useState(false);
  const [isSavingFollowUpMovement, setIsSavingFollowUpMovement] = useState(false);

  // Temperature Config states
  const [temperature, setTemperature] = useState<number>(0.7);
  const [isLoadingTemperature, setIsLoadingTemperature] = useState(false);
  const [isSavingTemperature, setIsSavingTemperature] = useState(false);

  // AI module on/off (worker consumes RabbitMQ when enabled)
  const [aiEnabled, setAiEnabled] = useState<boolean>(true);
  const [isLoadingAiEnabled, setIsLoadingAiEnabled] = useState(false);
  const [isSavingAiEnabled, setIsSavingAiEnabled] = useState(false);

  // AI Operation Mode (agent or multi-agent)
  const [aiOperationMode, setAiOperationMode] = useState<'agent' | 'multi-agent'>('agent');
  const [isLoadingOperationMode, setIsLoadingOperationMode] = useState(false);
  const [isSavingOperationMode, setIsSavingOperationMode] = useState(false);
  
  // Workflow selection (for multi-agent mode)
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [isLoadingWorkflows, setIsLoadingWorkflows] = useState(false);
  const [isSavingWorkflow, setIsSavingWorkflow] = useState(false);

  // OpenAI model selection
  const [openaiModel, setOpenaiModel] = useState<string | null>(null);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const [isSavingModel, setIsSavingModel] = useState(false);
  
  // Function call prompts states
  const [functionCallPrompts, setFunctionCallPrompts] = useState<Record<string, string>>({});
  const [selectedFunctionCall, setSelectedFunctionCall] = useState<string>('');
  
  // Function call inputs states
  const [showCreateFunctionCallModal, setShowCreateFunctionCallModal] = useState(false);
  const [newFunctionCallName, setNewFunctionCallName] = useState('');
  const [newFunctionCallLabel, setNewFunctionCallLabel] = useState('');
  const [isCreatingFunctionCall, setIsCreatingFunctionCall] = useState(false);
  
  // Function call configs states
  const [functionCallConfigs, setFunctionCallConfigs] = useState<Record<string, FunctionCallConfig>>({});
  const [isLoadingConfigs, setIsLoadingConfigs] = useState(false);
  const [isSavingStructure, setIsSavingStructure] = useState(false);
  const [ecommerceWhatsappNumber, setEcommerceWhatsappNumber] = useState('');
  const [contatoEcommerce, setContatoEcommerce] = useState('');
  const [tempoFechamentoEcommerce, setTempoFechamentoEcommerce] = useState(30);
  const [isSavingCustomAttrs, setIsSavingCustomAttrs] = useState(false);
  const [tempoFechamentoBalcao, setTempoFechamentoBalcao] = useState<number>(30);
  const [tempoInatividadeBalcao, setTempoInatividadeBalcao] = useState<number>(30);
  const [structureForm, setStructureForm] = useState<{
    objective: string;
    triggerConditions: string;
    executionTiming: string;
    requiredFields: string;
    optionalFields: string;
    restrictions: string;
    processingNotes: string;
  }>({
    objective: '',
    triggerConditions: '',
    executionTiming: '',
    requiredFields: '',
    optionalFields: '',
    restrictions: '',
    processingNotes: '',
  });
  
  // Available function calls
  const availableFunctionCalls = [
    { value: 'classificar_intencao', label: 'Classificar Intenção' },
    { value: 'identificar_origem_compra', label: 'Identificar Origem da Compra' },
    { value: 'decidir_atendimento', label: 'Decidir Atendimento' },
    { value: 'rotear_para_vendedor', label: 'Rotear para Vendedor' },
    { value: 'rotear_para_gerente', label: 'Rotear para Gerente' },
    { value: 'rotear_para_vendedor_original', label: 'Rotear para Vendedor Original' },
    { value: 'solicitar_orcamento', label: 'Solicitar Orçamento' },
    { value: 'criar_purchase', label: 'Criar Purchase' },
    { value: 'solicitar_link_pagamento', label: 'Solicitar Link de Pagamento' },
    { value: 'atualizar_estado_atendimento', label: 'Atualizar Estado do Atendimento' },
    { value: 'atualizar_status_purchase', label: 'Atualizar Status do Purchase' },
  ];
  const [createUserRole, setCreateUserRole] = useState<'SELLER' | 'SUPERVISOR' | 'ADMIN_GENERAL'>('SELLER');
  const [createUserName, setCreateUserName] = useState('');
  const [createUserEmail, setCreateUserEmail] = useState('');
  const [createUserPassword, setCreateUserPassword] = useState('');
  const [createUserBrand, setCreateUserBrand] = useState<string>('INDEFINIDO');
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  
  // Assignment states
  const [selectedSupervisorForSeller, setSelectedSupervisorForSeller] = useState('');
  const [selectedSellerForSupervisor, setSelectedSellerForSupervisor] = useState('');
  const [selectedAdminForSupervisor, setSelectedAdminForSupervisor] = useState('');
  const [selectedSupervisorForAdmin, setSelectedSupervisorForAdmin] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  
  // Reset system states
  const [showResetModal, setShowResetModal] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  
  // Memory reset states
  const [selectedSupervisorForReset, setSelectedSupervisorForReset] = useState('');
  const [selectedSellerForReset, setSelectedSellerForReset] = useState('');
  const [selectedClientForReset, setSelectedClientForReset] = useState('');
  const [clientPhones, setClientPhones] = useState<string[]>([]);
  const [isLoadingClients, setIsLoadingClients] = useState(false);
  const [isResettingMemory, setIsResettingMemory] = useState(false);
  const [isWipingAll, setIsWipingAll] = useState(false);
  const [resetOptions, setResetOptions] = useState({
    deleteMessages: true,
    deleteAiContext: true,
    deleteEmbeddings: true,
    resetAttendanceState: false,
  });
  
  // Queue management states
  const [isPurgingQueue, setIsPurgingQueue] = useState(false);
  const [queueStats, setQueueStats] = useState<{
    aiMessages: number;
    aiResponses: number;
    messages: number;
    notifications: number;
  } | null>(null);
  const [isLoadingQueueStats, setIsLoadingQueueStats] = useState(false);
  
  // URL do webhook oficial (Meta) - mesma usada pelo backend em GET/POST /api/whatsapp/webhook/official
  const webhookUrl = `${BACKEND_URL}/whatsapp/webhook/official`;
  // Inicializar dark mode do localStorage
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('darkMode');
      const shouldBeDark = saved === 'true';
      // Aplicar imediatamente ao inicializar
      if (shouldBeDark) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      return shouldBeDark;
    }
    return false;
  });

  // Garantir que o estado está sincronizado com o DOM
  useEffect(() => {
    const htmlElement = document.documentElement;
    if (isDarkMode) {
      htmlElement.classList.add('dark');
    } else {
      htmlElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const handleLogout = () => {
    logout();
    navigate('/login');
    toast.success('Logout realizado com sucesso');
  };

  const handleResetSystem = async () => {
    try {
      setIsResetting(true);
      await whatsappService.resetSystem();
      toast.success('Sistema resetado com sucesso! Todos os dados foram apagados.');
      setShowResetModal(false);
      
      // Reload page after a short delay to reflect changes
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } catch (error: any) {
      console.error('Error resetting system:', error);
      toast.error(error.response?.data?.error || 'Erro ao resetar o sistema');
    } finally {
      setIsResetting(false);
    }
  };

  // Handle memory reset
  const handleResetMemory = async () => {
    if (!selectedSupervisorForReset && !selectedSellerForReset && !selectedClientForReset) {
      toast.error('Selecione pelo menos um filtro (Supervisor, Vendedor ou Cliente)');
      return;
    }

    if (!resetOptions.deleteMessages && !resetOptions.deleteAiContext && !resetOptions.deleteEmbeddings && !resetOptions.resetAttendanceState) {
      toast.error('Selecione pelo menos uma opção de reset');
      return;
    }

    const confirmMessage = selectedClientForReset
      ? `Resetar memória do cliente ${selectedClientForReset}?`
      : selectedSellerForReset
      ? `Resetar memória de todos os clientes do vendedor selecionado?`
      : `Resetar memória de todos os clientes do supervisor selecionado?`;

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setIsResettingMemory(true);
    try {
      const result = await aiConfigService.resetMemory({
        supervisorId: selectedSupervisorForReset || undefined,
        sellerId: selectedSellerForReset || undefined,
        clientPhone: selectedClientForReset || undefined,
        options: resetOptions,
      });

      toast.success(
        `Memória resetada! ${result.deleted.messages} mensagens, ${result.deleted.attendances} resumos, ${result.deleted.embeddings} embeddings removidos.`
      );

      // Reset form
      setSelectedSupervisorForReset('');
      setSelectedSellerForReset('');
      setSelectedClientForReset('');
      setClientPhones([]);
    } catch (error: any) {
      console.error('Error resetting memory:', error);
      toast.error(error.response?.data?.error || 'Erro ao resetar memória');
    } finally {
      setIsResettingMemory(false);
    }
  };

  // Handle reset all memory
  const handleResetAllMemory = async () => {
    if (!window.confirm('⚠️ ATENÇÃO: Isso vai resetar TODA a memória da IA e TODAS as conversas! Tem certeza?')) {
      return;
    }

    if (!window.confirm('Esta ação é IRREVERSÍVEL e vai apagar:\n\n• TODAS as mensagens\n• TODOS os resumos de atendimento\n• TODOS os embeddings\n• TODOS os estados de atendimento\n• TODOS os estados do multi-agente\n\nConfirmar mesmo assim?')) {
      return;
    }

    setIsResettingMemory(true);
    try {
      // Use the new resetAll parameter to reset everything at once
      const result = await aiConfigService.resetMemory({
        resetAll: true,
        options: {
          deleteMessages: true,
          deleteAiContext: true,
          deleteEmbeddings: true,
          resetAttendanceState: true,
        },
      });

      toast.success(
        `✅ Toda memória resetada com sucesso!\n\n${result.deleted.messages} mensagens removidas\n${result.deleted.attendances} resumos limpos\n${result.deleted.embeddings} embeddings deletados\n\nO sistema está completamente limpo.`
      );

      // Reset form
      setSelectedSupervisorForReset('');
      setSelectedSellerForReset('');
      setSelectedClientForReset('');
      setClientPhones([]);
    } catch (error: any) {
      console.error('Error resetting all memory:', error);
      toast.error(error.response?.data?.error || 'Erro ao resetar toda memória');
    } finally {
      setIsResettingMemory(false);
    }
  };

  // Handle wipe all data (memory + attendances + clients + quote requests)
  const handleWipeAllData = async () => {
    if (
      !window.confirm(
        '⚠️ PERIGO: Esta ação vai APAGAR TUDO no sistema!\n\n• Toda a memória da IA\n• Todos os atendimentos\n• Todos os clientes\n• Todos os pedidos de orçamento\n\nEsta ação é IRREVERSÍVEL. Tem certeza absoluta?'
      )
    ) {
      return;
    }
    const confirmText = 'APAGAR';
    const typed = window.prompt(
      `Digite "${confirmText}" (em maiúsculas) para confirmar que deseja apagar todo o sistema:`
    );
    if (typed !== confirmText) {
      toast.info('Operação cancelada.');
      return;
    }

    setIsWipingAll(true);
    try {
      const result = await aiConfigService.wipeAllData();
      toast.success(
        `✅ Sistema completamente limpo!\n\n${result.deleted.messages} mensagens\n${result.deleted.quoteRequests} pedidos de orçamento\n${result.deleted.attendances} atendimentos\n${result.deleted.embeddings} embeddings removidos.`
      );
      setSelectedSupervisorForReset('');
      setSelectedSellerForReset('');
      setSelectedClientForReset('');
      setClientPhones([]);
      // Recarregar página para refletir dados vazios
      window.location.reload();
    } catch (error: any) {
      console.error('Error wiping all data:', error);
      toast.error(error.response?.data?.error || 'Erro ao apagar todos os dados');
    } finally {
      setIsWipingAll(false);
    }
  };

  // Handle queue purge
  const handlePurgeQueue = async () => {
    if (!window.confirm('⚠️ ATENÇÃO: Isso vai apagar TODAS as mensagens pendentes na fila ai-messages!\n\nIsso é útil quando a IA ficou desligada e você não quer processar mensagens antigas.\n\nContinuar?')) {
      return;
    }

    setIsPurgingQueue(true);
    try {
      // Don't pass queueName - let backend use default from config
      const result = await aiConfigService.purgeQueue();
      toast.success(
        `Fila limpa com sucesso! ${result.messagesDeleted} mensagens removidas.`
      );
      
      // Refresh queue stats
      await loadQueueStats();
    } catch (error: any) {
      console.error('Error purging queue:', error);
      toast.error(error.response?.data?.error || 'Erro ao limpar fila');
    } finally {
      setIsPurgingQueue(false);
    }
  };

  // Load queue statistics
  const loadQueueStats = async () => {
    setIsLoadingQueueStats(true);
    try {
      const stats = await aiConfigService.getQueueStats();
      setQueueStats(stats);
      
      // Log for debugging
      console.log('Queue stats loaded:', stats);
    } catch (error: any) {
      console.error('Error loading queue stats:', error);
      // Show error if it's a real error (not just empty stats)
      if (error.response?.status !== 200) {
        toast.error('Erro ao carregar estatísticas da fila. Verifique se RabbitMQ está rodando.');
      }
    } finally {
      setIsLoadingQueueStats(false);
    }
  };

  const toggleDarkMode = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Verificar estado atual do DOM diretamente
    const htmlElement = document.documentElement;
    const currentlyDark = htmlElement.classList.contains('dark');
    const newDarkMode = !currentlyDark;
    
    // Atualizar estado
    setIsDarkMode(newDarkMode);
    
    // Salvar preferência
    localStorage.setItem('darkMode', newDarkMode.toString());
    
    // Aplicar mudança imediatamente no DOM
    if (newDarkMode) {
      htmlElement.classList.add('dark');
    } else {
      htmlElement.classList.remove('dark');
    }
  };

  // Regenerate QR code automatically
  const regenerateQrCode = async () => {
    if (!connectingNumberId || !unofficialName.trim()) {
      return;
    }

    if (qrCodeRegenerationAttempts >= 3) {
      toast.error('Limite de tentativas de regeneração do QR code atingido. Por favor, gere um novo manualmente.');
      setQrCode(null);
      setQrCodeExpiresIn(null);
      setQrCodeRegenerationAttempts(0);
      return;
    }

    try {
      setIsLoading(true);
      toast.info(`Regenerando QR code... (Tentativa ${qrCodeRegenerationAttempts + 1}/3)`);
      
      const response = await whatsappService.connectNumber(connectingNumberId, {
        name: unofficialName.trim(),
      });

      if (response.qrCode) {
        setQrCode(response.qrCode);
        setConnectionStatus('connecting');
        setQrCodeExpiresIn(40); // QR code expira em 40 segundos
        setQrCodeRegenerationAttempts((prev) => prev + 1);
        toast.success('Novo QR code gerado! Escaneie novamente.');

        // Restart polling
        startStatusPolling(connectingNumberId);

        // Restart QR code expiration timer
        if (qrCodeTimerInterval.current) {
          clearInterval(qrCodeTimerInterval.current);
        }
        qrCodeTimerInterval.current = setInterval(() => {
          setQrCodeExpiresIn((prev) => {
            if (prev === null || prev <= 1) {
              if (qrCodeTimerInterval.current) {
                clearInterval(qrCodeTimerInterval.current);
                qrCodeTimerInterval.current = null;
              }
              // Auto-regenerate if attempts left
              regenerateQrCode();
              return null;
            }
            return prev - 1;
          });
        }, 1000);
      }
    } catch (error: any) {
      console.error('Error regenerating QR code:', error);
      toast.error(error.response?.data?.error || 'Erro ao regenerar QR code');
      setQrCode(null);
      setQrCodeExpiresIn(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Load WhatsApp numbers from API
  const loadWhatsAppNumbers = async () => {
    try {
      const numbers = await whatsappService.listNumbers();
      // Only show numbers that are actually connected (not just created with QR code)
      // Filter out temporary numbers (those that match the pattern "name_uuid")
      // Real WhatsApp numbers are typically in E.164 format (e.g., +5511999999999) or just digits
      setWhatsappNumbersList(
        numbers.filter(n => {
          if (n.connectionStatus !== 'CONNECTED' || !n.number) {
            return false;
          }
          // Check if it's a temporary number (pattern: name_uuid or name_shortid)
          // Real WhatsApp numbers are usually digits with optional + prefix
          const isTemporary = /^[a-zA-Z]+_[a-f0-9]+$/i.test(n.number);
          return !isTemporary;
        })
      );
    } catch (error) {
      console.error('Error loading WhatsApp numbers:', error);
      toast.error('Erro ao carregar números WhatsApp');
    }
  };

  // Load sellers from API
  const loadSellers = async () => {
    try {
      const sellersList = await whatsappService.listSellers();
      setSellers(sellersList);
    } catch (error) {
      console.error('Error loading sellers:', error);
      toast.error('Erro ao carregar vendedores');
    }
  };

  // Load all users
  const loadUsers = async () => {
    try {
      const usersData = await userService.listUsers();
      setUsers(usersData);
      
      // Filter by role
      setSellersList(usersData.filter(u => u.role === 'SELLER'));
      setSupervisorsList(usersData.filter(u => u.role === 'SUPERVISOR'));
      setAdminsList(usersData.filter(u => u.role === 'ADMIN_GENERAL'));

      // Load sellers details (with brand and supervisor)
      try {
        const sellersDetailsData = await userService.getSellersDetails();
        setSellersDetails(sellersDetailsData);
      } catch (error) {
        console.error('Error loading sellers details:', error);
      }
    } catch (error) {
      console.error('Error loading users:', error);
      toast.error('Erro ao carregar usuários');
    }
  };

  // Create user
  const handleCreateUser = async () => {
    if (!createUserName.trim() || !createUserEmail.trim() || !createUserPassword.trim()) {
      toast.error('Preencha todos os campos');
      return;
    }

    if (createUserPassword.length < 8) {
      toast.error('A senha deve ter pelo menos 8 caracteres');
      return;
    }

    setIsCreatingUser(true);
    try {
      await userService.createUser({
        name: createUserName.trim(),
        email: createUserEmail.trim(),
        password: createUserPassword,
        role: createUserRole,
      });
      
      // If role is SELLER and brand is not INDEFINIDO, update the brand
      if (createUserRole === 'SELLER' && createUserBrand !== 'INDEFINIDO') {
        // Get the newly created user to update brand
        const usersData = await userService.listUsers();
        const newUser = usersData.find(u => u.email === createUserEmail.trim() && u.role === 'SELLER');
        if (newUser) {
          try {
            await userService.updateSellerBrand(newUser.id, createUserBrand);
          } catch (error) {
            console.error('Error updating seller brand:', error);
            // Don't fail the creation if brand update fails
          }
        }
      }
      
      toast.success(`${createUserRole === 'SELLER' ? 'Vendedor' : createUserRole === 'SUPERVISOR' ? 'Supervisor' : 'Administrador'} criado com sucesso!`);
      
      // Reset form
      setCreateUserName('');
      setCreateUserEmail('');
      setCreateUserPassword('');
      setCreateUserBrand('INDEFINIDO');
      setShowCreateModal(false);
      
      // Reload users
      await loadUsers();
    } catch (error: any) {
      console.error('Error creating user:', error);
      toast.error(error.response?.data?.error || 'Erro ao criar usuário');
    } finally {
      setIsCreatingUser(false);
    }
  };

  // Assign seller to supervisor
  const handleAssignSellerToSupervisor = async () => {
    if (!selectedSupervisorForSeller || !selectedSellerForSupervisor) {
      toast.error('Selecione um supervisor e um vendedor');
      return;
    }

    setIsAssigning(true);
    try {
      await userService.assignSellerToSupervisor({
        sellerId: selectedSellerForSupervisor,
        supervisorId: selectedSupervisorForSeller,
      });
      
      toast.success('Vendedor atribuído ao supervisor com sucesso!');
      
      // Reset selections
      setSelectedSupervisorForSeller('');
      setSelectedSellerForSupervisor('');
      
      // Reload users
      await loadUsers();
    } catch (error: any) {
      console.error('Error assigning seller to supervisor:', error);
      toast.error(error.response?.data?.error || 'Erro ao atribuir vendedor');
    } finally {
      setIsAssigning(false);
    }
  };

  // Desatribuir vendedor de um supervisor (ou de todos se supervisorId não for passado)
  const handleUnassignSeller = async (sellerId: string, sellerName: string, supervisorId?: string) => {
    const msg = supervisorId
      ? `Remover o vínculo deste vendedor com o supervisor selecionado?`
      : `Desatribuir ${sellerName} de todos os supervisores?`;
    if (!window.confirm(msg)) return;
    try {
      await userService.unassignSellerFromSupervisor(sellerId, supervisorId);
      toast.success(supervisorId ? 'Vínculo removido.' : 'Vendedor desatribuído de todos os supervisores.');
      await loadUsers();
    } catch (error: any) {
      console.error('Error unassigning seller:', error);
      toast.error(error.response?.data?.error || 'Erro ao desatribuir vendedor');
    }
  };

  // Handle update seller brand
  const handleUpdateSellerBrand = async (sellerId: string, brand: string) => {
    try {
      await userService.updateSellerBrand(sellerId, brand);
      toast.success('Marca do vendedor atualizada com sucesso!');
      await loadUsers();
    } catch (error: any) {
      console.error('Error updating seller brand:', error);
      toast.error(error.response?.data?.error || 'Erro ao atualizar marca do vendedor');
    }
  };

  // Assign supervisor to admin
  const handleAssignSupervisorToAdmin = async () => {
    if (!selectedAdminForSupervisor || !selectedSupervisorForAdmin) {
      toast.error('Selecione um administrador e um supervisor');
      return;
    }

    setIsAssigning(true);
    try {
      await userService.assignSupervisorToAdmin({
        supervisorId: selectedSupervisorForAdmin,
        adminId: selectedAdminForSupervisor,
      });
      
      toast.success('Supervisor atribuído ao administrador com sucesso!');
      
      // Reset selections
      setSelectedAdminForSupervisor('');
      setSelectedSupervisorForAdmin('');
      
      // Reload users
      await loadUsers();
    } catch (error: any) {
      console.error('Error assigning supervisor to admin:', error);
      toast.error(error.response?.data?.error || 'Erro ao atribuir supervisor');
    } finally {
      setIsAssigning(false);
    }
  };

  // Handle number update
  const handleUpdateNumber = async (numberId: string) => {
    try {
      // Validation: SECONDARY requires sellerId
      if (editingNumberType === 'SECONDARY' && !editingSellerId) {
        toast.error('Para selecionar tipo "Pessoal", é necessário escolher um vendedor');
        return;
      }

      const updateData: { numberType: 'UNDEFINED' | 'PRIMARY' | 'SECONDARY'; sellerId?: string | null } = {
        numberType: editingNumberType,
      };

      // Only include sellerId in the update if:
      // 1. Type is SECONDARY and seller is selected (required)
      // 2. Don't send sellerId at all if type is PRIMARY or UNDEFINED (let backend handle it)
      if (editingNumberType === 'SECONDARY') {
        if (!editingSellerId) {
          toast.error('Para selecionar tipo "Pessoal", é necessário escolher um vendedor');
          return;
        }
        updateData.sellerId = editingSellerId;
      }
      // For PRIMARY or UNDEFINED, don't send sellerId - backend will set it to null automatically

      await whatsappService.updateNumber(numberId, updateData);
      toast.success('Número WhatsApp atualizado com sucesso!');
      setEditingNumberId(null);
      loadWhatsAppNumbers();
    } catch (error: any) {
      console.error('Error updating WhatsApp number:', error);
      toast.error(error.response?.data?.error || 'Erro ao atualizar número WhatsApp');
    }
  };

  // Start editing a number
  const startEditingNumber = (number: WhatsAppNumberListItem) => {
    setEditingNumberId(number.id);
    setEditingNumberType(number.numberType as 'UNDEFINED' | 'PRIMARY' | 'SECONDARY');
    setEditingSellerId(number.sellerId || null);
  };

  // Cancel editing
  const cancelEditing = () => {
    setEditingNumberId(null);
    setEditingNumberType('UNDEFINED');
    setEditingSellerId(null);
  };

  // Handle number deletion
  const handleDeleteNumber = async (numberId: string, number: string, force: boolean = false) => {
    const confirmMessage = force
      ? `ATENÇÃO: Você está prestes a excluir o número ${number} e TODOS os atendimentos relacionados. Esta ação é IRREVERSÍVEL. Deseja continuar?`
      : `Tem certeza que deseja excluir o número ${number}? Esta ação não pode ser desfeita.`;

    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      await whatsappService.deleteNumber(numberId, force);
      toast.success('Número WhatsApp excluído com sucesso!');
      loadWhatsAppNumbers();
    } catch (error: any) {
      console.error('Error deleting WhatsApp number:', error);
      
      const errorData = error.response?.data;
      
      // Check if it's a foreign key constraint error
      if (errorData?.details) {
        const { total, open, inProgress, finished } = errorData.details;
        const message = errorData.message || errorData.error;
        
        // Show detailed error with option to force delete
        const forceDelete = window.confirm(
          `${message}\n\n` +
          `Detalhes:\n` +
          `- Total de atendimentos: ${total}\n` +
          `- Abertos: ${open}\n` +
          `- Em progresso: ${inProgress}\n` +
          `- Finalizados: ${finished}\n\n` +
          `Deseja forçar a exclusão? Isso removerá TODOS os atendimentos relacionados.`
        );
        
        if (forceDelete) {
          // Retry with force=true
          await handleDeleteNumber(numberId, number, true);
          return;
        }
        
        toast.error(message, { duration: 5000 });
      } else {
        toast.error(errorData?.message || errorData?.error || 'Erro ao excluir número WhatsApp');
      }
    }
  };

  // Handle user deletion
  const handleDeleteUser = async (userId: string, userName: string) => {
    if (!window.confirm(`Tem certeza que deseja excluir o usuário "${userName}"? Esta ação não pode ser desfeita.`)) {
      return;
    }

    try {
      await userService.deleteUser(userId);
      toast.success('Usuário excluído com sucesso!');
      await loadUsers(); // Aguarda recarregar lista para invalidar cache/estado
      await loadSellers(); // Também atualiza lista de vendedores usada no dropdown WhatsApp
    } catch (error: any) {
      console.error('Error deleting user:', error);
      toast.error(error.response?.data?.error || 'Erro ao excluir usuário');
    }
  };

  // Load AI config when menu is active
  useEffect(() => {
    if (activeMenu === 'ai-config') {
      loadAIConfig();
      loadFunctionCallPrompts();
      loadFunctionCallConfigs();
      loadBufferConfig();
      loadAIModuleEnabled();
      if (aiConfigMode === 'geral') {
        loadOperationMode();
        loadWorkflows();
      }
    }
  }, [activeMenu, aiConfigMode]);

  // Load buffer and blacklist config when in geral mode
  useEffect(() => {
    if (aiConfigMode === 'geral' && activeMenu === 'ai-config') {
      loadBufferConfig();
      loadBlacklistConfig();
      // Also load auto-reopen timeout config
      const loadSubdivisionInactivityTimeouts = async () => {
        setIsLoadingSubdivisionTimeouts(true);
        try {
          const timeouts = await aiConfigService.getSubdivisionInactivityTimeouts();
          setSubdivisionInactivityTimeouts(timeouts);
        } catch (error: any) {
          console.error('Error loading subdivision inactivity timeouts:', error);
          toast.error('Erro ao carregar tempos de inatividade por subdivisão');
        } finally {
          setIsLoadingSubdivisionTimeouts(false);
        }
      };

      const loadAutoReopenConfig = async () => {
        setIsLoadingAutoReopen(true);
        try {
          const timeoutMinutes = await aiConfigService.getAutoReopenTimeout();
          setAutoReopenTimeoutMinutes(timeoutMinutes || 60);
        } catch (error: any) {
          console.error('Error loading auto-reopen timeout config:', error);
          toast.error('Erro ao carregar configuração de reabertura automática');
        } finally {
          setIsLoadingAutoReopen(false);
        }
      };
      const loadFollowUpConfig = async () => {
        setIsLoadingFollowUp(true);
        try {
          const config = await aiConfigService.getFollowUpConfig();
          setFollowUpConfig(config);
        } catch (error: any) {
          console.error('Error loading follow-up config:', error);
          toast.error('Erro ao carregar configuração de follow-up');
        } finally {
          setIsLoadingFollowUp(false);
        }
      };
      const loadFollowUpMovementConfig = async () => {
        setIsLoadingFollowUpMovement(true);
        try {
          const config = await aiConfigService.getFollowUpMovementConfig();
          setFollowUpMovementConfig(config);
        } catch (error: any) {
          console.error('Error loading follow-up movement config:', error);
          toast.error('Erro ao carregar configuração de movimentação');
        } finally {
          setIsLoadingFollowUpMovement(false);
        }
      };
      loadSubdivisionInactivityTimeouts();
      loadAutoReopenConfig();
      loadFollowUpConfig();
      loadFollowUpMovementConfig();
    }
  }, [aiConfigMode, activeMenu]);

  // Load temperature and model config when agent mode is selected
  useEffect(() => {
    if (aiConfigMode === 'agent') {
      loadTemperatureConfig();
      loadModelConfig();
    }
  }, [aiConfigMode]);

  // Function Calls tab removed from Geral mode - now only in Biblioteca

  // Biblioteca data is now persisted via API calls, not localStorage
  // Data is loaded on mount and saved immediately when changed

  // Sync left column height with main content height (removed - Function Calls tab no longer exists in Geral)

  const loadAIConfig = async () => {
    setIsLoadingConfig(true);
    setIsLoadingImagePrompt(true);
    try {
      const configs = await aiConfigService.getAllConfigs();
      setAgentPrompt(configs.prompt || '');
      setImageDescriptionPrompt(configs.imageDescriptionPrompt || '');
      // Ensure all properties exist with defaults
      setPendingFunctionsConfig({
        orcamento: configs.pendingFunctions?.orcamento || { enabled: true },
        fechamento: configs.pendingFunctions?.fechamento || { enabled: true },
        garantias: configs.pendingFunctions?.garantias || { enabled: true },
        encomendas: configs.pendingFunctions?.encomendas || { enabled: true },
        chamado_humano: configs.pendingFunctions?.chamado_humano || { enabled: true },
      });
    } catch (error: any) {
      console.error('Error loading AI config:', error);
      toast.error('Erro ao carregar configurações da IA');
      // Keep default values on error
    } finally {
      setIsLoadingConfig(false);
      setIsLoadingImagePrompt(false);
    }
  };

  const loadBufferConfig = async () => {
    setIsLoadingBuffer(true);
    try {
      const config = await aiConfigService.getBufferConfig();
      setBufferEnabled(config.enabled || false);
      setBufferTimeMs(config.bufferTimeMs || 5000);
    } catch (error: any) {
      console.error('Error loading buffer config:', error);
      toast.error('Erro ao carregar configurações de buffer');
      // Keep default values on error
    } finally {
      setIsLoadingBuffer(false);
    }
  };

  const loadBlacklistConfig = async () => {
    setIsLoadingBlacklist(true);
    try {
      const config = await (aiConfigService as any).getBlacklistConfig();
      setBlacklistEnabled(config.enabled ?? false);
      setBlacklistNumbers(Array.isArray(config.numbers) ? config.numbers : []);
    } catch (error: any) {
      console.error('Error loading blacklist config:', error);
      toast.error('Erro ao carregar blacklist');
    } finally {
      setIsLoadingBlacklist(false);
    }
  };

  const handleSaveBlacklist = async () => {
    setIsSavingBlacklist(true);
    try {
      await (aiConfigService as any).updateBlacklistConfig({
        enabled: blacklistEnabled,
        numbers: blacklistNumbers,
      });
      toast.success('Blacklist atualizada.');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Erro ao atualizar blacklist');
    } finally {
      setIsSavingBlacklist(false);
    }
  };

  const handleToggleBlacklistEnabled = async () => {
    const next = !blacklistEnabled;
    setBlacklistEnabled(next);
    setIsSavingBlacklist(true);
    try {
      await (aiConfigService as any).updateBlacklistConfig({
        enabled: next,
        numbers: blacklistNumbers,
      });
      toast.success(next ? 'Blacklist ativada.' : 'Blacklist desativada.');
    } catch (error: any) {
      setBlacklistEnabled(blacklistEnabled);
      toast.error('Erro ao atualizar blacklist');
    } finally {
      setIsSavingBlacklist(false);
    }
  };

  const handleAddBlacklistNumber = () => {
    const raw = blacklistNewNumber.trim().replace(/\D/g, '');
    if (!raw) return;
    const normalized = raw.length >= 10 ? raw : raw;
    if (blacklistNumbers.includes(normalized)) {
      toast.error('Número já está na lista.');
      return;
    }
    setBlacklistNumbers((prev) => [...prev, normalized].sort());
    setBlacklistNewNumber('');
  };

  const handleRemoveBlacklistNumber = (num: string) => {
    setBlacklistNumbers((prev) => prev.filter((n) => n !== num));
  };

  const loadTemperatureConfig = async () => {
    setIsLoadingTemperature(true);
    try {
      const value = await aiConfigService.getAgentTemperature();
      setTemperature(value);
    } catch (error: any) {
      console.error('Error loading temperature config:', error);
      toast.error('Erro ao carregar temperatura do agente');
    } finally {
      setIsLoadingTemperature(false);
    }
  };

  const loadAIModuleEnabled = async () => {
    setIsLoadingAiEnabled(true);
    try {
      const enabled = await aiConfigService.getAIModuleEnabled();
      setAiEnabled(enabled);
    } catch (error: any) {
      console.error('Error loading AI enabled state:', error);
      toast.error('Erro ao carregar estado da IA');
    } finally {
      setIsLoadingAiEnabled(false);
    }
  };

  const handleToggleAIEnabled = async () => {
    const next = !aiEnabled;
    setIsSavingAiEnabled(true);
    try {
      await aiConfigService.updateAIModuleEnabled(next);
      setAiEnabled(next);
      toast.success(next ? 'IA ligada – worker voltará a consumir a fila.' : 'IA desligada – worker parou de consumir a fila.');
    } catch (error: any) {
      console.error('Error toggling AI enabled:', error);
      toast.error(error.response?.data?.error || 'Erro ao alterar estado da IA');
    } finally {
      setIsSavingAiEnabled(false);
    }
  };

  const loadOperationMode = async () => {
    setIsLoadingOperationMode(true);
    try {
      const config = await multiAgentService.getConfig();
      setAiOperationMode(config.isEnabled ? 'multi-agent' : 'agent');
      setSelectedWorkflowId(config.workflowId ?? null);
    } catch (error: any) {
      console.error('Error loading operation mode:', error);
      toast.error('Erro ao carregar modo de operação');
    } finally {
      setIsLoadingOperationMode(false);
    }
  };

  const loadWorkflows = async () => {
    setIsLoadingWorkflows(true);
    try {
      const workflowList = await workflowService.list();
      setWorkflows(workflowList);
    } catch (error: any) {
      console.error('Error loading workflows:', error);
      toast.error('Erro ao carregar workflows');
    } finally {
      setIsLoadingWorkflows(false);
    }
  };

  const handleChangeOperationMode = async (mode: 'agent' | 'multi-agent') => {
    if (mode === 'multi-agent' && !selectedWorkflowId) {
      toast.error('Selecione um workflow antes de ativar o modo Multi Agente');
      return;
    }
    setIsSavingOperationMode(true);
    try {
      await multiAgentService.toggle(mode === 'multi-agent');
      if (mode === 'multi-agent' && selectedWorkflowId) {
        await multiAgentService.updateConfig({ workflowId: selectedWorkflowId });
      }
      setAiOperationMode(mode);
      toast.success(`Modo ${mode === 'agent' ? 'Agente' : 'Multi Agente'} ativado`);
    } catch (error: any) {
      console.error('Error changing operation mode:', error);
      toast.error(error.response?.data?.error || 'Erro ao alterar modo de operação');
    } finally {
      setIsSavingOperationMode(false);
    }
  };

  const handleSelectWorkflow = async (workflowId: string | null) => {
    setSelectedWorkflowId(workflowId);
    if (aiOperationMode === 'multi-agent' && workflowId) {
      setIsSavingWorkflow(true);
      try {
        await multiAgentService.updateConfig({ workflowId });
        toast.success('Workflow selecionado');
      } catch (error: any) {
        console.error('Error selecting workflow:', error);
        toast.error('Erro ao selecionar workflow');
        setSelectedWorkflowId(null);
      } finally {
        setIsSavingWorkflow(false);
      }
    }
  };

  const handleSaveAutoReopenTimeout = async () => {
    if (autoReopenTimeoutMinutes < 1 || autoReopenTimeoutMinutes > 480) {
      toast.error('O tempo deve estar entre 1 minuto e 480 minutos (8 horas)');
      return;
    }
    setIsSavingAutoReopen(true);
    try {
      await aiConfigService.updateAutoReopenTimeout(autoReopenTimeoutMinutes);
      toast.success('Tempo de reabertura automática atualizado com sucesso');
    } catch (error: any) {
      console.error('Error saving auto-reopen timeout:', error);
      toast.error(error.response?.data?.error || 'Erro ao atualizar configuração de reabertura automática');
    } finally {
      setIsSavingAutoReopen(false);
    }
  };

  const handleSaveSubdivisionInactivityTimeouts = async () => {
    // Enviar apenas valores válidos (1-1440). Campos em branco = desativado para aquela subdivisão
    const toSave: Record<string, number> = {};
    for (const [key, value] of Object.entries(subdivisionInactivityTimeouts)) {
      if (typeof value === 'number' && value >= 1 && value <= 1440) {
        toSave[key] = value;
      }
    }

    setIsSavingSubdivisionTimeouts(true);
    try {
      await aiConfigService.updateSubdivisionInactivityTimeouts(toSave);
      setSubdivisionInactivityTimeouts(toSave);
      toast.success('Tempos de inatividade por subdivisão atualizados com sucesso');
    } catch (error: any) {
      console.error('Error saving subdivision inactivity timeouts:', error);
      toast.error(error.response?.data?.error || 'Erro ao atualizar tempos de inatividade por subdivisão');
    } finally {
      setIsSavingSubdivisionTimeouts(false);
    }
  };

  const handleSaveFollowUpConfig = async () => {
    if (!followUpConfig.firstMessage?.trim()) {
      toast.error('A mensagem do 1º follow-up é obrigatória');
      return;
    }
    if (!followUpConfig.secondMessage?.trim()) {
      toast.error('A mensagem do 2º follow-up é obrigatória');
      return;
    }
    setIsSavingFollowUp(true);
    try {
      await aiConfigService.updateFollowUpConfig(followUpConfig);
      toast.success('Configuração de follow-up atualizada com sucesso');
    } catch (error: any) {
      console.error('Error saving follow-up config:', error);
      toast.error(error.response?.data?.error || 'Erro ao atualizar configuração de follow-up');
    } finally {
      setIsSavingFollowUp(false);
    }
  };

  const handleSaveFollowUpMovementConfig = async () => {
    setIsSavingFollowUpMovement(true);
    try {
      await aiConfigService.updateFollowUpMovementConfig(followUpMovementConfig);
      toast.success('Configuração de movimentação atualizada com sucesso');
    } catch (error: any) {
      console.error('Error saving follow-up movement config:', error);
      toast.error(error.response?.data?.error || 'Erro ao atualizar configuração de movimentação');
    } finally {
      setIsSavingFollowUpMovement(false);
    }
  };

  const loadModelConfig = async () => {
    setIsLoadingModel(true);
    try {
      const model = await aiConfigService.getOpenAIModel();
      setOpenaiModel(model);
    } catch (error: any) {
      console.error('Error loading model config:', error);
      toast.error('Erro ao carregar modelo OpenAI');
    } finally {
      setIsLoadingModel(false);
    }
  };

  const handleSaveModel = async () => {
    if (openaiModel == null || !openaiModel.trim()) {
      toast.error('Selecione um modelo');
      return;
    }
    setIsSavingModel(true);
    try {
      await aiConfigService.updateOpenAIModel(openaiModel.trim());
      toast.success('Modelo OpenAI atualizado. O worker usará o novo modelo na próxima mensagem.');
    } catch (error: any) {
      console.error('Error saving model:', error);
      toast.error(error.response?.data?.error || 'Erro ao atualizar modelo');
    } finally {
      setIsSavingModel(false);
    }
  };

  const loadFunctionCallPrompts = async () => {
    try {
      const prompts = await aiConfigService.getAllFunctionCallPrompts();
      setFunctionCallPrompts(prompts);
    } catch (error: any) {
      console.error('Error loading function call prompts:', error);
      toast.error('Erro ao carregar prompts de function calls');
    }
  };

  const handleFunctionCallChange = async (toolName: string) => {
    setSelectedFunctionCall(toolName);
  };

  const handleCreateFunctionCall = async () => {
    if (!newFunctionCallName.trim()) {
      toast.error('O nome da function call é obrigatório');
      return;
    }

    // Validate name format (only lowercase letters, numbers, and underscores)
    const namePattern = /^[a-z0-9_]+$/;
    if (!namePattern.test(newFunctionCallName.trim())) {
      toast.error('O nome deve conter apenas letras minúsculas, números e underscores');
      return;
    }

    // Check if name already exists
    if (functionCallPrompts[newFunctionCallName.trim()] || functionCallConfigs[newFunctionCallName.trim()]) {
      toast.error('Já existe uma function call com esse nome');
      return;
    }

    setIsCreatingFunctionCall(true);
    try {
      const toolName = newFunctionCallName.trim();
      await functionCallConfigService.updateConfig(toolName, {});
      toast.success('Function call criada com sucesso!');
      
      await loadFunctionCallPrompts();
      await loadFunctionCallConfigs();
      
      setSelectedFunctionCallForView(toolName);
      setSelectedFunctionCall(toolName);
      setEditingFunctionCall(toolName);
      await loadFunctionCallConfigs();
      
      // Reset form
      setNewFunctionCallName('');
      setNewFunctionCallLabel('');
      setShowCreateFunctionCallModal(false);
    } catch (error: any) {
      console.error('Error creating function call:', error);
      toast.error(error.response?.data?.error || 'Erro ao criar function call');
    } finally {
      setIsCreatingFunctionCall(false);
    }
  };

  const handleDeleteFunctionCall = async (toolName: string, label: string) => {
    if (!window.confirm(`Tem certeza que deseja deletar a function call "${label}"?\n\nEsta ação irá deletar a configuração (objetivo, quando acionar, campos, etc.) e os inputs.\n\nEsta ação não pode ser desfeita.`)) {
      return;
    }

    try {
      await aiConfigService.deleteFunctionCallPrompt(toolName);
      toast.success(`Function call "${label}" deletada com sucesso!`);
      
      if (selectedFunctionCallForView === toolName) {
        setSelectedFunctionCallForView('');
        setSelectedFunctionCall('');
        setEditingFunctionCall(null);
      }
      
      const updatedPrompts = await aiConfigService.getAllFunctionCallPrompts();
      setFunctionCallPrompts(updatedPrompts);
      await loadFunctionCallConfigs();
      
      const remaining = Object.keys(updatedPrompts);
      if (remaining.length > 0) {
        const firstFunctionCall = remaining[0];
        setSelectedFunctionCallForView(firstFunctionCall);
        setSelectedFunctionCall(firstFunctionCall);
        setEditingFunctionCall(firstFunctionCall);
        await loadFunctionCallConfigs();
      } else {
        setSelectedFunctionCallForView('');
        setSelectedFunctionCall('');
        setEditingFunctionCall(null);
      }
    } catch (error: any) {
      console.error('Error deleting function call:', error);
      toast.error(error.response?.data?.error || 'Erro ao deletar function call');
    }
  };

  // Function call configs management
  const loadFunctionCallConfigs = async () => {
    setIsLoadingConfigs(true);
    try {
      const configs = await functionCallConfigService.getAll();
      const configsMap: Record<string, FunctionCallConfig> = {};
      configs.forEach(config => {
        configsMap[config.functionCallName] = config;
      });
      setFunctionCallConfigs(configsMap);
    } catch (error: any) {
      console.error('Error loading function call configs:', error);
      toast.error('Erro ao carregar configurações de function calls');
    } finally {
      setIsLoadingConfigs(false);
    }
  };

  const handleToggleHasOutput = async (functionCallName: string, hasOutput: boolean) => {
    setIsSavingConfig(true);
    try {
      await functionCallConfigService.setHasOutput(functionCallName, hasOutput);
      await loadFunctionCallConfigs();
      toast.success('Configuração atualizada com sucesso!');
    } catch (error: any) {
      console.error('Error updating hasOutput:', error);
      toast.error('Erro ao atualizar configuração');
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleToggleIsSync = async (functionCallName: string, isSync: boolean) => {
    setIsSavingConfig(true);
    try {
      await functionCallConfigService.setIsSync(functionCallName, isSync);
      await loadFunctionCallConfigs();
      toast.success('Configuração atualizada com sucesso!');
    } catch (error: any) {
      console.error('Error updating isSync:', error);
      toast.error('Erro ao atualizar configuração');
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleToggleIsActive = async (functionCallName: string, isActive: boolean) => {
    setIsSavingConfig(true);
    try {
      await functionCallConfigService.setIsActive(functionCallName, isActive);
      await loadFunctionCallConfigs();
      toast.success('Status da function call atualizado com sucesso!');
    } catch (error: any) {
      console.error('Error updating isActive:', error);
      const errorMessage = error.response?.data?.message || error.message || 'Erro ao atualizar status';
      toast.error(errorMessage);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleChangeProcessingMethod = async (functionCallName: string, method: 'RABBITMQ' | 'HTTP') => {
    if (method === 'HTTP') {
      toast.error('HTTP Request ainda não está disponível. Em breve!');
      return;
    }
    
    setIsSavingConfig(true);
    try {
      await functionCallConfigService.setProcessingMethod(functionCallName, method);
      await loadFunctionCallConfigs();
      toast.success('Método de processamento atualizado com sucesso!');
    } catch (error: any) {
      console.error('Error updating processing method:', error);
      toast.error('Erro ao atualizar método de processamento');
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleUpdateFunctionCallField = async (
    functionCallName: string,
    field: string,
    value: any
  ) => {
    setIsSavingConfig(true);
    try {
      await functionCallConfigService.updateConfig(functionCallName, { [field]: value });
      await loadFunctionCallConfigs();
      toast.success('Campo atualizado com sucesso!');
    } catch (error: any) {
      console.error(`Error updating ${field}:`, error);
      toast.error('Erro ao atualizar campo');
    } finally {
      setIsSavingConfig(false);
    }
  };

  const syncStructureFormFromConfig = (functionCallName: string) => {
    const config = functionCallConfigs[functionCallName];
    if (!config) {
      setStructureForm({
        objective: '',
        triggerConditions: '',
        executionTiming: '',
        requiredFields: '',
        optionalFields: '',
        restrictions: '',
        processingNotes: '',
      });
      if (functionCallName === 'registrarposvendaecommerce') setEcommerceWhatsappNumber('');
      return;
    }
    setStructureForm({
      objective: config.objective ?? '',
      triggerConditions: config.triggerConditions ?? '',
      executionTiming: config.executionTiming ?? '',
      requiredFields: (config.requiredFields ?? []).join(', '),
      optionalFields: (config.optionalFields ?? []).join(', '),
      restrictions: config.restrictions ?? '',
      processingNotes: config.processingNotes ?? '',
    });
    if (functionCallName === 'registrarposvendaecommerce') {
      const v = config.customAttributes?.ecommerce_whatsapp_number;
      setEcommerceWhatsappNumber(typeof v === 'string' ? v : '');
    }
    if (functionCallName === 'fechaatendimentobalcao') {
      const t1 = config.customAttributes?.tempo_fechamento_balcao;
      const t2 = config.customAttributes?.tempo_inatividade_balcao;
      setTempoFechamentoBalcao(typeof t1 === 'number' && t1 >= 1 && t1 <= 60 ? t1 : typeof t1 === 'string' ? Math.min(60, Math.max(1, parseInt(t1, 10) || 30)) : 30);
      setTempoInatividadeBalcao(typeof t2 === 'number' && t2 >= 1 && t2 <= 60 ? t2 : typeof t2 === 'string' ? Math.min(60, Math.max(1, parseInt(t2, 10) || 30)) : 30);
    }
    if (functionCallName === 'enviaecommerce') {
      const v = config.customAttributes?.contato_ecommerce;
      const t = config.customAttributes?.tempo_fechamento_ecommerce;
      setContatoEcommerce(typeof v === 'string' ? v : '');
      setTempoFechamentoEcommerce(typeof t === 'number' && t >= 1 && t <= 60 ? t : typeof t === 'string' ? Math.min(60, Math.max(1, parseInt(t, 10) || 30)) : 30);
    }
  };

  const handleSaveStructure = async () => {
    const name = selectedFunctionCallForView || editingFunctionCall;
    if (!name) {
      toast.error('Nenhuma function call selecionada');
      return;
    }
    setIsSavingStructure(true);
    try {
      const requiredFields = structureForm.requiredFields
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
      const optionalFields = structureForm.optionalFields
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
      await functionCallConfigService.updateConfig(name, {
        objective: structureForm.objective || undefined,
        triggerConditions: structureForm.triggerConditions || undefined,
        executionTiming: structureForm.executionTiming || undefined,
        requiredFields: requiredFields.length ? requiredFields : undefined,
        optionalFields: optionalFields.length ? optionalFields : undefined,
        restrictions: structureForm.restrictions || undefined,
        processingNotes: structureForm.processingNotes || undefined,
      });
      await loadFunctionCallConfigs();
      syncStructureFormFromConfig(name);
      toast.success('Estrutura da function call salva com sucesso!');
    } catch (error: any) {
      console.error('Error saving structure:', error);
      toast.error(error.response?.data?.message || 'Erro ao salvar estrutura');
    } finally {
      setIsSavingStructure(false);
    }
  };

  const handleSaveCustomAttributes = async () => {
    const name = selectedFunctionCallForView || editingFunctionCall;
    if (name !== 'registrarposvendaecommerce' && name !== 'fechaatendimentobalcao' && name !== 'enviaecommerce') return;
    setIsSavingCustomAttrs(true);
    try {
      const config = functionCallConfigs[name];
      const base = (config?.customAttributes as Record<string, unknown>) || {};
      if (name === 'registrarposvendaecommerce') {
        await functionCallConfigService.updateConfig(name, {
          customAttributes: { ...base, ecommerce_whatsapp_number: ecommerceWhatsappNumber.trim() || undefined },
        });
      } else if (name === 'fechaatendimentobalcao') {
        const t1 = Math.min(60, Math.max(1, tempoFechamentoBalcao));
        const t2 = Math.min(60, Math.max(1, tempoInatividadeBalcao));
        await functionCallConfigService.updateConfig(name, {
          customAttributes: {
            ...base,
            tempo_fechamento_balcao: t1,
            tempo_inatividade_balcao: t2,
          },
        });
      } else if (name === 'enviaecommerce') {
        const t = Math.min(60, Math.max(1, tempoFechamentoEcommerce));
        await functionCallConfigService.updateConfig(name, {
          customAttributes: {
            ...base,
            contato_ecommerce: contatoEcommerce.trim() || undefined,
            tempo_fechamento_ecommerce: t,
          },
        });
      }
      await loadFunctionCallConfigs();
      if (name === 'fechaatendimentobalcao' || name === 'enviaecommerce') syncStructureFormFromConfig(name);
      toast.success('Atributos personalizados salvos!');
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Erro ao salvar atributos');
    } finally {
      setIsSavingCustomAttrs(false);
    }
  };

  // Cleanup is now handled server-side, no need for client-side cleanup

  // Load WhatsApp numbers, sellers, and users on mount
  useEffect(() => {
    loadWhatsAppNumbers();
    loadSellers();
    loadUsers();
  }, []);

  // Recarregar usuários e vendedores ao entrar na aba de vendedores ou ao alternar para Gestão de Usuários
  useEffect(() => {
    if (activeMenu === 'sellers') {
      loadUsers();
      loadSellers();
    }
  }, [activeMenu, sellersTab]);

  // Load clients when supervisor changes
  useEffect(() => {
    const loadClients = async () => {
      if (!selectedSupervisorForReset) {
        setClientPhones([]);
        return;
      }

      setIsLoadingClients(true);
      try {
        const clients = await aiConfigService.getClientsBySupervisor(selectedSupervisorForReset);
        setClientPhones(clients);
      } catch (error) {
        console.error('Error loading clients:', error);
        toast.error('Erro ao carregar clientes');
        setClientPhones([]);
      } finally {
        setIsLoadingClients(false);
      }
    };

    loadClients();
  }, [selectedSupervisorForReset]);

  // Load clients when seller changes
  useEffect(() => {
    const loadClients = async () => {
      if (!selectedSellerForReset) {
        setClientPhones([]);
        return;
      }

      setIsLoadingClients(true);
      try {
        const clients = await aiConfigService.getClientsBySeller(selectedSellerForReset);
        setClientPhones(clients);
      } catch (error) {
        console.error('Error loading clients:', error);
        toast.error('Erro ao carregar clientes');
        setClientPhones([]);
      } finally {
        setIsLoadingClients(false);
      }
    };

    loadClients();
  }, [selectedSellerForReset]);

  // Load queue stats when AI Config tab is active
  useEffect(() => {
    if (activeMenu === 'ai-config') {
      loadQueueStats();
      // Refresh stats every 10 seconds
      const interval = setInterval(() => {
        loadQueueStats();
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [activeMenu]);

  // Reload numbers when connection status changes to connected
  useEffect(() => {
    if (connectionStatus === 'connected') {
      loadWhatsAppNumbers();
    }
  }, [connectionStatus]);

  // Start polling connection status
  const startStatusPolling = (numberId: string) => {
    // Clear existing interval
    if (statusPollingInterval.current) {
      clearInterval(statusPollingInterval.current);
    }

    // Poll every 3 seconds
    statusPollingInterval.current = setInterval(async () => {
      try {
        const status = await whatsappService.getStatus(numberId);
        
        if (status.connected) {
          setConnectionStatus('connected');
          setQrCode(null);
          setQrCodeExpiresIn(null);
          toast.success('WhatsApp conectado com sucesso!');
          
          // Stop polling
          if (statusPollingInterval.current) {
            clearInterval(statusPollingInterval.current);
            statusPollingInterval.current = null;
          }
          
          // Stop QR code timer
          if (qrCodeTimerInterval.current) {
            clearInterval(qrCodeTimerInterval.current);
            qrCodeTimerInterval.current = null;
          }
          
          // Reset regeneration attempts
          setQrCodeRegenerationAttempts(0);
          
          // Clear form
          setUnofficialName('');
          setConnectingNumberId(null);
          
          // Reload WhatsApp numbers list
          loadWhatsAppNumbers();
        }
      } catch (error) {
        console.error('Error polling status:', error);
      }
    }, 3000);
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (statusPollingInterval.current) {
        clearInterval(statusPollingInterval.current);
      }
    };
  }, []);

  const getStatusBadge = (status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR') => {
    if (status === 'CONNECTED') {
      return (
        <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          <span className="text-xs font-medium">Conectado</span>
        </div>
      );
    }
    if (status === 'ERROR') {
      return (
        <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
          <span className="text-xs font-medium">Erro</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
        <span className="text-xs font-medium">Desconectado</span>
      </div>
    );
  };

  const getNumberTypeBadge = (type: 'UNDEFINED' | 'PRIMARY' | 'SECONDARY') => {
    if (type === 'PRIMARY') {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded-lg shadow-sm" style={{ backgroundColor: '#DBEAFE', color: '#1E40AF' }}>
          <span className="w-1.5 h-1.5 rounded-full bg-blue-600"></span>
          Principal
        </span>
      );
    }
    if (type === 'SECONDARY') {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded-lg shadow-sm" style={{ backgroundColor: '#F3E8FF', color: '#7C3AED' }}>
          <span className="w-1.5 h-1.5 rounded-full bg-purple-600"></span>
          Pessoal
        </span>
      );
    }
    // UNDEFINED
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300 rounded-lg shadow-sm" style={{ backgroundColor: '#F1F5F9', color: '#475569' }}>
        <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
        Indefinido
      </span>
    );
  };

  const getFinancialStatusBadge = (status: string) => {
    if (status === 'regularized') {
      return (
        <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          <span className="text-xs font-medium">Regularizado</span>
        </div>
      );
    }
    if (status === 'pending') {
      return (
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
          <span className="text-xs font-medium">Pendente</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
        <span className="text-xs font-medium">Inadimplente</span>
      </div>
    );
  };

  function getBibliotecaDescendantIds(id: string, list: BibliotecaFolder[]): string[] {
    const children = list.filter((f) => f.parentId === id);
    return [id, ...children.flatMap((c) => getBibliotecaDescendantIds(c.id, list))];
  }

  const handleOpenCreatePrompt = () => {
    setCreatePromptName('');
    setCreatePromptContent('');
    setCreatePromptFolderId('');
    setShowCreatePromptModal(true);
  };

  const handleCreatePromptSubmit = async () => {
    const name = createPromptName.trim();
    if (!name) {
      toast.error('Informe o nome do prompt.');
      return;
    }
    if (!createPromptContent.trim()) {
      toast.error('Informe o conteúdo do prompt.');
      return;
    }
    const folderId = createPromptFolderId.trim() || null;
    try {
      const newPrompt = await bibliotecaService.createPrompt({
        name,
        content: createPromptContent.trim(),
        folderId,
      });
      // Update state using functional update to ensure we have the latest state
      setBibliotecaPrompts((prev) => [...prev, newPrompt]);
      // Reset form fields
      setCreatePromptName('');
      setCreatePromptContent('');
      setCreatePromptFolderId('');
      setShowCreatePromptModal(false);
      toast.success('Prompt criado.');
    } catch (error: any) {
      console.error('Error creating prompt:', error);
      toast.error('Erro ao criar prompt');
    }
  };

  const handleOpenEditPrompt = (prompt: BibliotecaPrompt) => {
    setBibliotecaSelectedItem({ type: 'prompt', id: prompt.id });
    setBibliotecaEditPromptIdRequest(prompt.id);
  };

  const handleEditPromptSubmit = async () => {
    if (!editPromptId) return;
    const name = editPromptName.trim();
    if (!name) {
      toast.error('Informe o nome do prompt.');
      return;
    }
    if (!editPromptContent.trim()) {
      toast.error('Informe o conteúdo do prompt.');
      return;
    }
    const folderId = editPromptFolderId.trim() || null;
    try {
      const updated = await bibliotecaService.updatePrompt(editPromptId, {
        name,
        content: editPromptContent.trim(),
        folderId,
      });
      setBibliotecaPrompts(bibliotecaPrompts.map((p) => (p.id === editPromptId ? updated : p)));
      // Check if this is the agent prompt
      if (updated.content.trim() === agentPrompt.trim()) {
        setAgentPromptBibliotecaId(updated.id);
      } else if (agentPromptBibliotecaId === editPromptId) {
        setAgentPromptBibliotecaId(null);
      }
      // Update modal if open
      if (showImportBibliotecaModal) {
        reloadModalData();
      }
      setShowEditPromptModal(false);
      setEditPromptId(null);
      toast.success('Prompt atualizado.');
    } catch (error: any) {
      console.error('Error editing prompt:', error);
      toast.error('Erro ao atualizar prompt');
    }
  };

  const handleUpdatePromptInline = async (id: string, data: { name?: string; content?: string }) => {
    const name = (data.name ?? '').trim();
    const content = (data.content ?? '').trim();
    if (!name) {
      toast.error('Informe o nome do prompt.');
      return;
    }
    try {
      const updated = await bibliotecaService.updatePrompt(id, { name, content });
      setBibliotecaPrompts((prev) => prev.map((p) => (p.id === id ? updated : p)));
      if (updated.content.trim() === agentPrompt.trim()) {
        setAgentPromptBibliotecaId(updated.id);
      } else if (agentPromptBibliotecaId === id) {
        setAgentPromptBibliotecaId(null);
      }
      if (showImportBibliotecaModal) {
        reloadModalData();
      }
      toast.success('Prompt atualizado.');
    } catch (error: any) {
      console.error('Error updating prompt:', error);
      toast.error('Erro ao atualizar prompt');
    }
  };

  const handleOpenCreateBibliotecaFunctionCall = () => {
    setCreateFCName('');
    setCreateFCFolderId('');
    setCreateFCObjective('');
    setCreateFCTriggerConditions('');
    setCreateFCExecutionTiming('');
    setCreateFCRequiredFields('');
    setCreateFCOptionalFields('');
    setCreateFCRestrictions('');
    setCreateFCProcessingNotes('');
    setCreateFCHasOutput(false);
    setCreateFCProcessingMethod('RABBITMQ');
    setCreateFCCustomAttributes([]);
    setShowCreateBibliotecaFunctionCallModal(true);
  };

  const handleCreateBibliotecaFunctionCallSubmit = async () => {
    const name = createFCName.trim();
    if (!name) {
      toast.error('Informe o nome da function call.');
      return;
    }
    const folderId = createFCFolderId.trim() || null;
    try {
      const newFC = await bibliotecaService.createFunctionCall({
        name,
        folderId,
        objective: createFCObjective.trim(),
        triggerConditions: createFCTriggerConditions.trim(),
        executionTiming: createFCExecutionTiming.trim(),
        requiredFields: createFCRequiredFields.trim(),
        optionalFields: createFCOptionalFields.trim(),
        restrictions: createFCRestrictions.trim(),
        processingNotes: createFCProcessingNotes.trim(),
        isActive: true,
        hasOutput: createFCHasOutput,
        processingMethod: createFCProcessingMethod,
        customAttributes: createFCCustomAttributes.reduce<Record<string, string>>((acc, { key, value }) => {
          const k = key.trim();
          if (k) acc[k] = value;
          return acc;
        }, {}),
      });
      if (createFCProcessId) {
        const process = bibliotecaProcesses.find((p) => p.id === createFCProcessId);
        try {
          const { requiredFields: reqArr, optionalFields: optArr } = processToFCFieldsArrays(process ?? undefined);
          await functionCallConfigService.updateConfig(name, {
            processId: createFCProcessId,
            ...(reqArr.length > 0 && { requiredFields: reqArr }),
            ...(optArr.length > 0 && { optionalFields: optArr }),
          });
        } catch (e: any) {
          toast.error(e?.response?.data?.message || 'Erro ao vincular processo');
        }
      }
      // Update state using functional update to ensure we have the latest state
      setBibliotecaFunctionCalls((prev) => [...prev, newFC]);
      // Reset form fields
      setCreateFCName('');
      setCreateFCFolderId('');
      setCreateFCObjective('');
      setCreateFCTriggerConditions('');
      setCreateFCExecutionTiming('');
      setCreateFCRequiredFields('');
      setCreateFCProcessId(null);
      setCreateFCOptionalFields('');
      setCreateFCRestrictions('');
      setCreateFCProcessingNotes('');
      setCreateFCHasOutput(false);
      setCreateFCProcessingMethod('RABBITMQ');
      setCreateFCCustomAttributes([]);
      setShowCreateBibliotecaFunctionCallModal(false);
      toast.success('Function call criada.');
    } catch (error: any) {
      console.error('Error creating function call:', error);
      toast.error('Erro ao criar function call');
    }
  };

  const handleOpenEditBibliotecaFunctionCall = (fc: BibliotecaFunctionCall) => {
    setBibliotecaSelectedItem({ type: 'function-call', id: fc.id });
    setBibliotecaEditFCIdRequest(fc.id);
    setEditFCId(fc.id);
    setEditFCName(fc.name ?? '');
    setEditFCFolderId(fc.folderId ?? '');
    setEditFCObjective(fc.objective ?? '');
    setEditFCTriggerConditions(fc.triggerConditions ?? '');
    setEditFCExecutionTiming(fc.executionTiming ?? '');
    setEditFCRequiredFields(fc.requiredFields ?? '');
    setEditFCOptionalFields(fc.optionalFields ?? '');
    setEditFCRestrictions(fc.restrictions ?? '');
    setEditFCProcessingNotes(fc.processingNotes ?? '');
    setEditFCIsActive(fc.isActive ?? true);
    setEditFCHasOutput(fc.hasOutput ?? false);
    setEditFCProcessingMethod(fc.processingMethod ?? 'RABBITMQ');
    setEditFCCustomAttributes(
      fc.customAttributes ? Object.entries(fc.customAttributes).map(([k, v]) => ({ key: k, value: String(v) })) : []
    );
    setEditFCProcessId(functionCallConfigs[fc.name]?.processId ?? null);
    setShowEditBibliotecaFunctionCallModal(true);
    setBibliotecaEditFCIdRequest(null);
  };

  const handleUpdateFunctionCallInline = async (
    id: string,
    data: {
      name: string;
      folderId: string | null;
      objective: string;
      triggerConditions: string;
      executionTiming: string;
      requiredFields: string;
      optionalFields: string;
      restrictions: string;
      processingNotes: string;
      isActive: boolean;
      hasOutput: boolean;
      processingMethod: 'RABBITMQ' | 'HTTP';
      customAttributes: Record<string, string>;
    }
  ) => {
    try {
      const updated = await bibliotecaService.updateFunctionCall(id, data);
      setBibliotecaFunctionCalls((prev) => prev.map((fc) => (fc.id === id ? updated : fc)));
      if (showImportBibliotecaModal) reloadModalData();
      toast.success('Function call atualizada.');
    } catch (error: any) {
      console.error('Error updating function call:', error);
      toast.error('Erro ao atualizar function call');
      throw error;
    }
  };

  const handleEditBibliotecaFunctionCallSubmit = async () => {
    if (!editFCId) return;
    const name = editFCName.trim();
    if (!name) {
      toast.error('Informe o nome da function call.');
      return;
    }
    const folderId = editFCFolderId.trim() || null;
    try {
      const updated = await bibliotecaService.updateFunctionCall(editFCId, {
        name,
        folderId,
        objective: editFCObjective.trim(),
        triggerConditions: editFCTriggerConditions.trim(),
        executionTiming: editFCExecutionTiming.trim(),
        requiredFields: editFCRequiredFields.trim(),
        optionalFields: editFCOptionalFields.trim(),
        restrictions: editFCRestrictions.trim(),
        processingNotes: editFCProcessingNotes.trim(),
        isActive: editFCIsActive,
        hasOutput: editFCHasOutput,
        processingMethod: editFCProcessingMethod,
        customAttributes: editFCCustomAttributes.reduce<Record<string, string>>((acc, { key, value }) => {
          const k = key.trim();
          if (k) acc[k] = value;
          return acc;
        }, {}),
      });
      setBibliotecaFunctionCalls(bibliotecaFunctionCalls.map((fc) => (fc.id === editFCId ? updated : fc)));
      // Update modal if open
      if (showImportBibliotecaModal) {
        reloadModalData();
      }
      setShowEditBibliotecaFunctionCallModal(false);
      setEditFCId(null);
      toast.success('Function call atualizada.');
    } catch (error: any) {
      console.error('Error updating function call:', error);
      toast.error('Erro ao atualizar function call');
    }
  };

  const handleSaveEditFolder = async () => {
    if (!editFolderState) return;
    const name = editFolderState.name.trim();
    if (!name) {
      toast.error('Informe o nome da pasta.');
      return;
    }
    const newParentId = (editFolderState.parentId && editFolderState.parentId.trim()) || null;
    const descendantIds = getBibliotecaDescendantIds(editFolderState.folderId, bibliotecaFolders);
    if (newParentId && (newParentId === editFolderState.folderId || descendantIds.includes(newParentId))) {
      toast.error('Não é possível mover a pasta para dentro de si mesma ou de uma subpasta.');
      return;
    }
    try {
      const updated = await bibliotecaService.updateFolder(editFolderState.folderId, { name, parentId: newParentId });
      setBibliotecaFolders((prev) => prev.map((f) => (f.id === editFolderState.folderId ? updated : f)));
      setEditFolderState(null);
      toast.success('Pasta atualizada.');
    } catch (error: any) {
      console.error('Error updating folder:', error);
      toast.error('Erro ao atualizar pasta');
    }
  };

  const handleCopyPrompt = (prompt: BibliotecaPrompt) => {
    setBibliotecaCopiedItem({ type: 'prompt', data: prompt });
    toast.success('Prompt copiado.');
  };

  const handleCopyFunctionCall = (fc: BibliotecaFunctionCall) => {
    setBibliotecaCopiedItem({ type: 'function-call', data: fc });
    toast.success('Function call copiada.');
  };

  const handleDeletePrompt = async (prompt: BibliotecaPrompt) => {
    if (!window.confirm(`Excluir o prompt "${prompt.name}"?`)) return;
    try {
      await bibliotecaService.deletePrompt(prompt.id);
      setBibliotecaPrompts(bibliotecaPrompts.filter((p) => p.id !== prompt.id));
      // Check if this was the agent prompt
      if (agentPromptBibliotecaId === prompt.id) {
        setAgentPromptBibliotecaId(null);
      }
      // Update modal if open
      if (showImportBibliotecaModal) {
        reloadModalData();
      }
      toast.success('Prompt excluído.');
    } catch (error: any) {
      console.error('Error deleting prompt:', error);
      toast.error('Erro ao excluir prompt');
    }
  };

  const handleDeleteBibliotecaFunctionCall = async (fc: BibliotecaFunctionCall) => {
    if (!window.confirm(`Excluir a function call "${fc.name}"?`)) return;
    try {
      await bibliotecaService.deleteFunctionCall(fc.id);
      setBibliotecaFunctionCalls(bibliotecaFunctionCalls.filter((f) => f.id !== fc.id));
      // Update modal if open
      if (showImportBibliotecaModal) {
        reloadModalData();
      }
      toast.success('Function call excluída.');
    } catch (error: any) {
      console.error('Error deleting function call:', error);
      toast.error('Erro ao excluir function call');
    }
  };

  const handleCopyFolder = (folderId: string) => {
    const folder = bibliotecaFolders.find((f) => f.id === folderId);
    if (!folder) return;
    const getChildren = (parentId: string) => bibliotecaFolders.filter((f) => f.parentId === parentId);
    const getPromptsInFolder = (fId: string | null) => bibliotecaPrompts.filter((p) => (p.folderId || null) === fId);
    const getFunctionCallsInFolder = (fId: string | null) => bibliotecaFunctionCalls.filter((fc) => (fc.folderId || null) === fId);
    const collectFolderData = (fId: string): any => {
      const f = bibliotecaFolders.find((fold) => fold.id === fId);
      if (!f) return null;
      const children = getChildren(fId);
      return {
        folder: f,
        subfolders: children.map((child) => collectFolderData(child.id)).filter(Boolean),
        prompts: getPromptsInFolder(fId),
        functionCalls: getFunctionCallsInFolder(fId),
      };
    };
    const folderData = collectFolderData(folderId);
    setBibliotecaCopiedItem({ type: 'folder', data: folderData });
    toast.success('Pasta copiada.');
  };

  const handlePaste = async (targetFolderId: string | null) => {
    if (!bibliotecaCopiedItem) {
      toast.error('Nada copiado.');
      return;
    }
    try {
      if (bibliotecaCopiedItem.type === 'prompt') {
        const prompt = bibliotecaCopiedItem.data as BibliotecaPrompt;
        const newPrompt = await bibliotecaService.createPrompt({
          name: `${prompt.name} (cópia)`,
          content: prompt.content,
          folderId: targetFolderId,
        });
        setBibliotecaPrompts([...bibliotecaPrompts, newPrompt]);
        toast.success('Prompt colado.');
      } else if (bibliotecaCopiedItem.type === 'function-call') {
        const fc = bibliotecaCopiedItem.data as BibliotecaFunctionCall;
        const newFC = await bibliotecaService.createFunctionCall({
          name: `${fc.name} (cópia)`,
          folderId: targetFolderId,
          objective: fc.objective,
          triggerConditions: fc.triggerConditions,
          executionTiming: fc.executionTiming,
          requiredFields: fc.requiredFields,
          optionalFields: fc.optionalFields,
          restrictions: fc.restrictions,
          processingNotes: fc.processingNotes,
          isActive: fc.isActive,
          hasOutput: fc.hasOutput,
          processingMethod: fc.processingMethod,
          customAttributes: fc.customAttributes,
        });
        setBibliotecaFunctionCalls([...bibliotecaFunctionCalls, newFC]);
        toast.success('Function call colada.');
      } else if (bibliotecaCopiedItem.type === 'folder') {
        const folderData = bibliotecaCopiedItem.data as any;
        const pasteFolderRecursive = async (data: any, newParentId: string | null): Promise<string> => {
          const newFolder = await bibliotecaService.createFolder({
            name: `${data.folder.name} (cópia)`,
            parentId: newParentId,
          });
          const newFolderId = newFolder.id;
          setBibliotecaFolders((prev) => [...prev, newFolder]);
          if (data.prompts && data.prompts.length > 0) {
            const newPrompts = await Promise.all(
              data.prompts.map((p: BibliotecaPrompt) =>
                bibliotecaService.createPrompt({
                  name: `${p.name} (cópia)`,
                  content: p.content,
                  folderId: newFolderId,
                })
              )
            );
            setBibliotecaPrompts((prev) => [...prev, ...newPrompts]);
          }
          if (data.functionCalls && data.functionCalls.length > 0) {
            const newFCs = await Promise.all(
              data.functionCalls.map((fc: BibliotecaFunctionCall) =>
                bibliotecaService.createFunctionCall({
                  name: `${fc.name} (cópia)`,
                  folderId: newFolderId,
                  objective: fc.objective,
                  triggerConditions: fc.triggerConditions,
                  executionTiming: fc.executionTiming,
                  requiredFields: fc.requiredFields,
                  optionalFields: fc.optionalFields,
                  restrictions: fc.restrictions,
                  processingNotes: fc.processingNotes,
                  isActive: fc.isActive,
                  hasOutput: fc.hasOutput,
                  processingMethod: fc.processingMethod,
                  customAttributes: fc.customAttributes,
                })
              )
            );
            setBibliotecaFunctionCalls((prev) => [...prev, ...newFCs]);
          }
          if (data.subfolders && data.subfolders.length > 0) {
            for (const subfolder of data.subfolders) {
              await pasteFolderRecursive(subfolder, newFolderId);
            }
          }
          return newFolderId;
        };
        await pasteFolderRecursive(folderData, targetFolderId);
        toast.success('Pasta colada.');
      }
    } catch (error: any) {
      console.error('Error pasting item:', error);
      toast.error('Erro ao colar item');
    }
  };

  const handleOpenCreateSchemaModal = (folderId: string | null) => {
    setCreateSchemaFolderId(folderId);
    setCreateSchemaName('');
    setCreateSchemaType(null);
    setShowCreateSchemaModal(true);
  };

  const handleCreateSchemaSubmit = async () => {
    const name = createSchemaName.trim() || 'Novo schema';
    if (!createSchemaType) {
      toast.error('Selecione um tipo: Sem Tags ou Com tags.');
      return;
    }
    try {
      const newSchema = await bibliotecaService.createSchema({
        name,
        folderId: createSchemaFolderId || null,
        definition: '',
        schemaType: createSchemaType,
      });
      const item: BibliotecaSchema = {
        id: newSchema.id,
        name: newSchema.name,
        folderId: newSchema.folderId ?? null,
        definition: newSchema.definition ?? undefined,
        schemaType: newSchema.schemaType ?? undefined,
      };
      setBibliotecaSchemas((prev) => [...prev, item]);
      setBibliotecaSelectedItem({ type: 'schema', id: item.id });
      setBibliotecaSelectedFolderId(null);
      setShowCreateSchemaModal(false);
      setCreateSchemaFolderId(null);
      setCreateSchemaName('');
      setCreateSchemaType(null);
      toast.success('Schema criado. Use o editor de workflows à direita para configurá-lo.');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Erro ao criar schema');
    }
  };

  const handleUpdateSchema = async (schemaId: string, data: { definition?: string }) => {
    try {
      await bibliotecaService.updateSchema(schemaId, data);
      setBibliotecaSchemas((prev) =>
        prev.map((s) => (s.id === schemaId ? { ...s, ...data } : s))
      );
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Erro ao atualizar schema');
    }
  };

  const handleEditSchema = (s: BibliotecaSchema) => {
    setEditingSchema(s);
    setEditSchemaName(s.name);
    setEditSchemaDefinition(s.definition ?? '');
  };

  const handleDeleteSchema = async (s: BibliotecaSchema) => {
    if (!window.confirm(`Excluir o schema "${s.name}"?`)) return;
    try {
      await bibliotecaService.deleteSchema(s.id);
      setBibliotecaSchemas((prev) => prev.filter((x) => x.id !== s.id));
      if (bibliotecaSelectedItem?.type === 'schema' && bibliotecaSelectedItem?.id === s.id) {
        setBibliotecaSelectedItem(null);
      }
      setEditingSchema(null);
      toast.success('Schema excluído.');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Erro ao excluir schema');
    }
  };

  const handleSaveSchema = async () => {
    if (!editingSchema) return;
    const name = editSchemaName.trim() || editingSchema.name;
    const definition = editSchemaDefinition;
    try {
      await bibliotecaService.updateSchema(editingSchema.id, { name, definition });
      setBibliotecaSchemas((prev) => prev.map((x) => (x.id === editingSchema.id ? { ...x, name, definition } : x)));
      setEditingSchema(null);
      toast.success('Schema salvo.');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Erro ao salvar schema');
    }
  };

  const handleOpenRenameSchema = (s: BibliotecaSchema) => {
    setRenamingSchema(s);
    setRenameSchemaName(s.name);
  };

  const handleRenameSchemaSubmit = async () => {
    if (!renamingSchema) return;
    const name = renameSchemaName.trim() || renamingSchema.name;
    try {
      await bibliotecaService.updateSchema(renamingSchema.id, { name });
      setBibliotecaSchemas((prev) => prev.map((x) => (x.id === renamingSchema.id ? { ...x, name } : x)));
      setRenamingSchema(null);
      toast.success('Schema renomeado.');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Erro ao renomear schema');
    }
  };

  return (
    <div className="text-slate-900 dark:text-slate-100 min-h-screen w-full flex" style={{ backgroundColor: '#F0F0F0' }}>
      {/* Sidebar */}
      <aside
        className={`bg-navy text-white flex-shrink-0 hidden lg:flex flex-col border-r border-navy/10 transition-[width] duration-300 ease-in-out overflow-hidden ${
          sidebarCollapsed ? 'w-20' : 'w-64'
        }`}
        style={{ backgroundColor: '#003070' }}
      >
        <div
          className={`shrink-0 flex items-center gap-3 ${sidebarCollapsed ? 'flex-col p-3' : 'p-6'}`}
        >
          <div className="flex items-center gap-3 min-w-0 flex-1 w-full">
            <div className="w-10 h-10 bg-primary rounded flex items-center justify-center shrink-0" style={{ backgroundColor: '#F07000' }}>
              <span className="material-icons-outlined text-white">settings_suggest</span>
            </div>
            {!sidebarCollapsed && <span className="text-xl font-bold tracking-tight truncate">Fabio Guerreiro</span>}
            {!sidebarCollapsed && (
              <button
                type="button"
                onClick={toggleSidebar}
                className="ml-auto shrink-0 p-1.5 rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                title="Recolher barra"
                aria-label="Recolher barra"
              >
                <span className="material-icons-outlined">chevron_left</span>
              </button>
            )}
          </div>
          {sidebarCollapsed && (
            <button
              type="button"
              onClick={toggleSidebar}
              className="p-1.5 rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition-colors"
              title="Expandir barra"
              aria-label="Expandir barra"
            >
              <span className="material-icons-outlined">chevron_right</span>
            </button>
          )}
        </div>

        <nav className="mt-4 flex-grow px-2">
          <button
            onClick={() => {
              setActiveMenu('sellers');
              setAiConfigDropdownOpen(false);
            }}
            title="Usuários"
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-medium transition-all ${
              sidebarCollapsed ? 'justify-center px-2' : ''
            } ${activeMenu === 'sellers' ? 'sidebar-item-active' : 'text-white/70 hover:bg-white/5'}`}
          >
            <span className="material-icons-outlined shrink-0">people</span>
            {!sidebarCollapsed && <span>Usuários</span>}
          </button>

          <button
            onClick={() => {
              setActiveMenu('whatsapp');
              setAiConfigDropdownOpen(false);
            }}
            title="WhatsApp"
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-medium transition-all ${
              sidebarCollapsed ? 'justify-center px-2' : ''
            } ${activeMenu === 'whatsapp' ? 'sidebar-item-active' : 'text-white/70 hover:bg-white/5'}`}
          >
            <span className="material-icons-outlined shrink-0">phone_android</span>
            {!sidebarCollapsed && <span>WhatsApp</span>}
          </button>

          <div className="relative">
            <button
              onClick={() => {
                setActiveMenu('ai-config');
                if (sidebarCollapsed) {
                  setSidebarCollapsed(false);
                  try {
                    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'false');
                  } catch {}
                }
                setAiConfigDropdownOpen((prev) => !prev);
              }}
              title="Configurações IA"
              className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-sm font-medium transition-all ${
                sidebarCollapsed ? 'justify-center px-2' : ''
              } ${activeMenu === 'ai-config' ? 'sidebar-item-active' : 'text-white/70 hover:bg-white/5'}`}
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="material-icons-outlined shrink-0">smart_toy</span>
                {!sidebarCollapsed && <span>Configurações IA</span>}
              </span>
              {!sidebarCollapsed && (
                <span
                  className={`material-icons-outlined text-base transition-transform duration-200 shrink-0 ${
                    aiConfigDropdownOpen && activeMenu === 'ai-config' ? 'rotate-180' : ''
                  }`}
                >
                  expand_more
                </span>
              )}
            </button>
            <div
              className={`overflow-hidden transition-all duration-200 ease-out ${
                aiConfigDropdownOpen && activeMenu === 'ai-config' ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
              }`}
            >
              <div className={`pr-2 pb-2 pt-1 space-y-0.5 ${sidebarCollapsed ? 'pl-2' : 'pl-4'}`}>
                <button
                  onClick={() => {
                    setAiConfigMode('geral');
                    setAiConfigTab('tools');
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-all ${
                    sidebarCollapsed ? 'justify-center px-2' : ''
                  } ${aiConfigMode === 'geral' ? 'sidebar-item-active text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}`}
                >
                  <span className="material-icons-outlined text-sm shrink-0">tune</span>
                  {!sidebarCollapsed && <span>Geral</span>}
                </button>
                <button
                  onClick={() => setAiConfigMode('agent')}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-all ${
                    sidebarCollapsed ? 'justify-center px-2' : ''
                  } ${aiConfigMode === 'agent' ? 'sidebar-item-active text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}`}
                >
                  <span className="material-icons-outlined text-sm shrink-0">psychology</span>
                  {!sidebarCollapsed && <span>Agente Mode</span>}
                </button>
                <button
                  onClick={() => setAiConfigMode('multi-agent')}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-all ${
                    sidebarCollapsed ? 'justify-center px-2' : ''
                  } ${aiConfigMode === 'multi-agent' ? 'sidebar-item-active text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}`}
                >
                  <span className="material-icons-outlined text-sm shrink-0">account_tree</span>
                  {!sidebarCollapsed && <span>Multi Agente Mode</span>}
                </button>
                <button
                  onClick={() => setAiConfigMode('biblioteca')}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-all ${
                    sidebarCollapsed ? 'justify-center px-2' : ''
                  } ${aiConfigMode === 'biblioteca' ? 'sidebar-item-active text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}`}
                >
                  <span className="material-icons-outlined text-sm shrink-0">menu_book</span>
                  {!sidebarCollapsed && <span>Biblioteca</span>}
                </button>
              </div>
            </div>
          </div>

          <button
            onClick={() => {
              setActiveMenu('costs');
              setAiConfigDropdownOpen(false);
            }}
            title="Custos"
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-medium transition-all ${
              sidebarCollapsed ? 'justify-center px-2' : ''
            } ${activeMenu === 'costs' ? 'sidebar-item-active' : 'text-white/70 hover:bg-white/5'}`}
          >
            <span className="material-icons-outlined shrink-0">savings</span>
            {!sidebarCollapsed && <span>Custos</span>}
          </button>
        </nav>

        <div className={`border-t border-white/10 space-y-2 shrink-0 ${sidebarCollapsed ? 'p-2' : 'p-4'}`}>
          <button
            onClick={() => setShowResetModal(true)}
            title="Resetar Sistema"
            className={`flex items-center gap-3 px-4 py-2 w-full text-sm font-medium text-red-400 hover:text-red-300 transition-colors ${
              sidebarCollapsed ? 'justify-center px-2' : ''
            }`}
          >
            <span className="material-icons-outlined shrink-0">delete_forever</span>
            {!sidebarCollapsed && <span>Resetar Sistema</span>}
          </button>
          <button
            onClick={handleLogout}
            title="Sair do Sistema"
            className={`flex items-center gap-3 px-4 py-2 w-full text-sm font-medium text-white/60 hover:text-white transition-colors ${
              sidebarCollapsed ? 'justify-center px-2' : ''
            }`}
          >
            <span className="material-icons-outlined shrink-0">logout</span>
            {!sidebarCollapsed && <span>Sair do Sistema</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-grow flex flex-col h-screen overflow-hidden" style={{ backgroundColor: '#F0F0F0', background: '#F0F0F0' }}>
        {/* Content Area */}
        <div
          className={`flex-grow custom-scrollbar ${
            activeMenu === 'ai-config' && (aiConfigMode === 'agent' || aiConfigMode === 'multi-agent')
              ? 'overflow-hidden flex flex-col p-3'
              : 'overflow-y-auto p-6'
          }`}
        >
          <div className={`${activeMenu === 'ai-config' ? 'w-full h-full flex flex-col min-h-0 flex-1' : 'max-w-7xl mx-auto'}`}>
            {activeMenu === 'whatsapp' && (
              <>
                {/* Tabs */}
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm mb-6" style={{ backgroundColor: '#FFFFFF' }}>
                  <div className="flex border-b border-slate-200 dark:border-slate-800 relative">
                    <button
                      onClick={() => setWhatsappTab('list')}
                      className={`flex-1 px-6 py-4 text-sm font-semibold transition-colors relative ${
                        whatsappTab === 'list'
                          ? 'text-primary'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                      style={whatsappTab === 'list' ? { color: '#F07000' } : { color: '#64748B' }}
                    >
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-icons-outlined text-lg">list</span>
                        Lista de Números
                      </div>
                      {whatsappTab === 'list' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#F07000' }}></div>
                      )}
                    </button>
                    <button
                      onClick={() => setWhatsappTab('create')}
                      className={`flex-1 px-6 py-4 text-sm font-semibold transition-colors relative ${
                        whatsappTab === 'create'
                          ? 'text-primary'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                      style={whatsappTab === 'create' ? { color: '#F07000' } : { color: '#64748B' }}
                    >
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-icons-outlined text-lg">add_circle</span>
                        Criar Número
                      </div>
                      {whatsappTab === 'create' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#F07000' }}></div>
                      )}
                    </button>
                  </div>
                </div>

                {/* Create WhatsApp Number Cards */}
                {whatsappTab === 'create' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
                  {/* API Oficial - Fixed Form Section */}
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
                    <div className="p-6 border-b border-slate-200 dark:border-slate-800">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-14 h-14 bg-green-50 dark:bg-green-900/20 rounded-xl flex items-center justify-center">
                          <span className="material-icons-outlined text-green-600 dark:text-green-400 text-3xl">verified</span>
                        </div>
                        <span className="px-3 py-1 text-xs font-semibold bg-green-100 dark:bg-green-900/30 rounded-full" style={{ color: '#166534', backgroundColor: '#DCFCE7' }}>API Oficial</span>
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2" style={{ color: '#0F172A' }}>API Oficial - Meta Business Platform</h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4" style={{ color: '#64748B' }}>
                        Configure um número usando a API oficial da Meta (WhatsApp Business Platform)
                      </p>
                    </div>
                    <div className="p-6 space-y-4">
                      {/* Webhook URL Display - Read Only */}
                      <div className="bg-green-50 dark:bg-green-900/10 rounded-lg p-4 border border-green-200 dark:border-green-900/30">
                        <label className="block text-sm font-semibold text-green-800 dark:text-green-300 mb-2" style={{ color: '#166534' }}>
                          URL do Webhook (Meta)
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={webhookUrl}
                            readOnly
                            className="flex-1 px-4 py-2.5 bg-white dark:bg-slate-900 border border-green-300 dark:border-green-800 rounded-lg text-sm text-slate-900 dark:text-slate-100 font-mono text-xs"
                            style={{ backgroundColor: '#FFFFFF', color: '#0F172A', borderColor: '#86EFAC' }}
                          />
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(webhookUrl);
                              toast.success('URL do webhook copiada!');
                            }}
                            className="p-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors shadow-sm"
                            style={{ backgroundColor: '#16A34A' }}
                            title="Copiar URL"
                          >
                            <span className="material-icons-outlined text-base">content_copy</span>
                          </button>
                        </div>
                        <p className="text-xs text-green-700 dark:text-green-400 mt-2 flex items-center gap-1" style={{ color: '#166534' }}>
                          <span className="material-icons-outlined text-sm">info</span>
                          Use esta URL para configurar o webhook no Meta Business Platform
                        </p>
                      </div>

                      {/* Verify Token - mesma config usada na verificação do webhook */}
                      <div className="bg-blue-50 dark:bg-blue-900/10 rounded-lg p-4 border border-blue-200 dark:border-blue-900/30">
                        <label className="block text-sm font-semibold text-blue-800 dark:text-blue-300 mb-2" style={{ color: '#1E40AF' }}>
                          Verify Token
                        </label>
                        <p className="text-xs text-blue-700 dark:text-blue-400" style={{ color: '#1E40AF' }}>
                          O valor do campo <strong>Verify Token (opcional)</strong> abaixo, ao adicionar o número, é o mesmo que deve ser configurado no Meta for Developers (Webhook → Editar → Token de verificação). Se não preencher, configure <code className="bg-blue-100 dark:bg-blue-900/40 px-1 rounded">WHATSAPP_META_VERIFY_TOKEN</code> no servidor.
                        </p>
                      </div>

                      <div className="mb-4">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Nome/Identificação *
                        </label>
                        <input
                          type="text"
                          value={officialName}
                          onChange={(e) => setOfficialName(e.target.value)}
                          placeholder="Ex: WhatsApp Oficial Principal"
                          className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 dark:text-white outline-none"
                          style={{ backgroundColor: '#F8FAFC' }}
                        />
                      </div>
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Phone Number ID (Meta) *
                        </label>
                        <input
                          type="text"
                          value={officialPhoneNumber}
                          onChange={(e) => setOfficialPhoneNumber(e.target.value)}
                          placeholder="ID do número no Meta for Developers"
                          className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 dark:text-white outline-none"
                          style={{ backgroundColor: '#F8FAFC' }}
                        />
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1" style={{ color: '#64748B' }}>Encontrado em: Meta for Developers → WhatsApp → API Setup</p>
                      </div>
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Access Token *
                        </label>
                        <input
                          type="password"
                          value={officialAccessToken}
                          onChange={(e) => setOfficialAccessToken(e.target.value)}
                          placeholder="Token de acesso da Meta"
                          className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 dark:text-white outline-none"
                          style={{ backgroundColor: '#F8FAFC' }}
                        />
                      </div>
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Verify Token (mesmo valor configurado no Meta)
                        </label>
                        <input
                          type="text"
                          value={officialVerifyToken}
                          onChange={(e) => setOfficialVerifyToken(e.target.value)}
                          placeholder="Mesmo token do webhook no Meta for Developers"
                          className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 dark:text-white outline-none"
                          style={{ backgroundColor: '#F8FAFC' }}
                        />
                      </div>
                      <button
                        onClick={async () => {
                          if (!officialName.trim() || !officialPhoneNumber.trim() || !officialAccessToken.trim()) {
                            toast.error('Preencha nome, Phone Number ID e Access Token');
                            return;
                          }
                          setOfficialConnecting(true);
                          try {
                            const numberId = uuidv4();
                            await whatsappService.connectNumber(numberId, {
                              name: officialName.trim(),
                              adapterType: 'OFFICIAL',
                              phoneNumberId: officialPhoneNumber.trim(),
                              accessToken: officialAccessToken.trim(),
                              verifyToken: officialVerifyToken.trim() || undefined,
                            });
                            toast.success('Número oficial conectado com sucesso.');
                            setOfficialName('');
                            setOfficialPhoneNumber('');
                            setOfficialAccessToken('');
                            setOfficialVerifyToken('');
                            const numbers = await whatsappService.listNumbers();
                            setWhatsappNumbersList(numbers);
                            setWhatsappTab('list');
                          } catch (error: any) {
                            toast.error(error.response?.data?.error || 'Erro ao conectar número oficial');
                          } finally {
                            setOfficialConnecting(false);
                          }
                        }}
                        disabled={officialConnecting}
                        className="w-full bg-green-600 hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed text-white px-4 py-3 rounded-lg flex items-center justify-center gap-2 font-semibold shadow-sm transition-all transform hover:scale-[1.02] active:scale-[0.98]"
                        style={{ backgroundColor: officialConnecting ? '#4ADE80' : '#16A34A' }}
                      >
                        {officialConnecting ? (
                          <>
                            <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                            Conectando...
                          </>
                        ) : (
                          <>
                            <span className="material-icons-outlined text-lg">add</span>
                            Adicionar Número
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* API Não Oficial - Fixed Form Section */}
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
                    <div className="p-6 border-b border-slate-200 dark:border-slate-800">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-14 h-14 bg-amber-50 dark:bg-amber-900/20 rounded-xl flex items-center justify-center">
                          <span className="material-icons-outlined text-amber-600 dark:text-amber-400 text-3xl">code</span>
                        </div>
                        <span className="px-3 py-1 text-xs font-semibold bg-amber-100 dark:bg-amber-900/30 rounded-full" style={{ color: '#92400E', backgroundColor: '#FEF3C7' }}>API Não Oficial</span>
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2" style={{ color: '#0F172A' }}>API Não Oficial</h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4" style={{ color: '#64748B' }}>
                        Adicione um número usando bibliotecas externas (whatsapp-web.js ou baileys)
                      </p>
                    </div>
                    <div className="p-6">
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Nome/Identificação *
                        </label>
                        <input
                          type="text"
                          value={unofficialName}
                          onChange={(e) => setUnofficialName(e.target.value)}
                          placeholder="Ex: WhatsApp Principal"
                          className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500 text-slate-900 dark:text-white outline-none"
                          style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                        />
                      </div>
                      <button
                        onClick={async () => {
                          if (!unofficialName.trim()) {
                            toast.error('Por favor, preencha o nome/identificação');
                            return;
                          }

                          setIsLoading(true);
                          setConnectionStatus('connecting');
                          setQrCode(null);

                          try {
                            // Generate a valid UUID for the WhatsApp number
                            const numberId = uuidv4();

                            // Connect WhatsApp number
                            const response = await whatsappService.connectNumber(numberId, {
                              name: unofficialName.trim(),
                            });

                            setConnectingNumberId(numberId);
                            
                            if (response.qrCode) {
                              setQrCode(response.qrCode);
                              setConnectionStatus('connecting');
                              setQrCodeExpiresIn(40); // QR code expira em 40 segundos
                              setQrCodeRegenerationAttempts(0); // Reset attempts for new connection
                              toast.success('Conexão iniciada. Escaneie o QR code abaixo.');
                              
                              // Start polling for connection status
                              startStatusPolling(numberId);
                              
                              // Start QR code expiration timer
                              if (qrCodeTimerInterval.current) {
                                clearInterval(qrCodeTimerInterval.current);
                              }
                              qrCodeTimerInterval.current = setInterval(() => {
                                setQrCodeExpiresIn((prev) => {
                                  if (prev === null || prev <= 1) {
                                    if (qrCodeTimerInterval.current) {
                                      clearInterval(qrCodeTimerInterval.current);
                                      qrCodeTimerInterval.current = null;
                                    }
                                    // Auto-regenerate QR code instead of just showing error
                                    regenerateQrCode();
                                    return null;
                                  }
                                  return prev - 1;
                                });
                              }, 1000);
                            } else if (response.success) {
                              setConnectionStatus('connected');
                              toast.success('Número conectado com sucesso!');
                              setUnofficialName('');
                            }
                          } catch (error: any) {
                            console.error('Error connecting WhatsApp:', error);
                            toast.error(error.response?.data?.error || 'Erro ao conectar número WhatsApp');
                            setConnectionStatus('disconnected');
                            setQrCode(null);
                            setQrCodeExpiresIn(null);
                            setQrCodeRegenerationAttempts(0);
                            if (qrCodeTimerInterval.current) {
                              clearInterval(qrCodeTimerInterval.current);
                              qrCodeTimerInterval.current = null;
                            }
                          } finally {
                            setIsLoading(false);
                          }
                        }}
                        disabled={isLoading}
                        className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 disabled:cursor-not-allowed text-white px-4 py-3 rounded-lg flex items-center justify-center gap-2 font-semibold shadow-sm transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:transform-none"
                        style={{ backgroundColor: isLoading ? '#FBBF24' : '#D97706' }}
                      >
                        {isLoading ? (
                          <>
                            <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                            Conectando...
                          </>
                        ) : (
                          <>
                            <span className="material-icons-outlined text-lg">add</span>
                            Adicionar Número
                          </>
                        )}
                      </button>

                      {/* QR Code Display */}
                      {qrCode && (
                        <div className="mt-8 flex flex-col items-center justify-center">
                          <div className="text-center mb-6">
                            <h3 className="text-xl font-semibold text-slate-900 mb-2" style={{ color: '#0F172A', fontWeight: 600 }}>
                              Escaneie o QR Code
                            </h3>
                            <p className="text-sm text-slate-600" style={{ color: '#64748B' }}>
                              Abra o WhatsApp no seu celular e escaneie este código
                            </p>
                            <p className="text-xs text-slate-500 mt-2" style={{ color: '#94A3B8' }}>
                              💡 Dica: Aumente o brilho da tela e mantenha o zoom em 100% para melhor leitura
                            </p>
                          </div>
                          
                          <div 
                            className="bg-white rounded-3xl overflow-hidden"
                            style={{ 
                              padding: '32px',
                              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05)',
                              border: '2px solid #E5E7EB',
                              backgroundColor: '#FFFFFF',
                            }}
                          >
                            <div 
                              className="bg-white rounded-2xl p-8 flex items-center justify-center"
                              style={{
                                backgroundColor: '#FFFFFF',
                                minWidth: '450px',
                                minHeight: '450px',
                              }}
                            >
                              <img
                                src={qrCode}
                                alt="QR Code WhatsApp"
                                className="w-full h-full"
                                style={{ 
                                  width: '450px', 
                                  height: '450px',
                                  maxWidth: '100%',
                                  objectFit: 'contain',
                                  imageRendering: 'crisp-edges',
                                  filter: 'none',
                                  backgroundColor: '#FFFFFF',
                                  padding: '20px',
                                }}
                              />
                            </div>
                          </div>

                          {/* Expiration Timer */}
                          {qrCodeExpiresIn !== null && qrCodeExpiresIn > 0 && (
                            <div className="mt-4 flex items-center justify-center gap-2 px-4 py-2 bg-orange-50 dark:bg-orange-900/20 rounded-full border border-orange-200 dark:border-orange-800">
                              <span className="material-icons-outlined text-orange-600 text-sm">schedule</span>
                              <p className="text-sm font-medium text-orange-700 dark:text-orange-300" style={{ color: '#EA580C' }}>
                                QR code expira em <span className="font-bold">{qrCodeExpiresIn}s</span>
                                {qrCodeRegenerationAttempts > 0 && (
                                  <span className="ml-2">• Tentativa {qrCodeRegenerationAttempts}/3</span>
                                )}
                              </p>
                            </div>
                          )}
                          
                          {/* Regeneration Status */}
                          {qrCodeRegenerationAttempts > 0 && qrCodeRegenerationAttempts < 3 && (
                            <div className="mt-2 flex items-center justify-center gap-2 px-4 py-2 bg-blue-50 dark:bg-blue-900/20 rounded-full border border-blue-200 dark:border-blue-800">
                              <span className="material-icons-outlined text-blue-600 text-sm">autorenew</span>
                              <p className="text-xs font-medium text-blue-700 dark:text-blue-300" style={{ color: '#2563EB' }}>
                                QR code será regenerado automaticamente ({qrCodeRegenerationAttempts}/3)
                              </p>
                            </div>
                          )}

                          <div className="mt-6 text-center">
                            {connectionStatus === 'connecting' && (
                              <div className="flex items-center justify-center gap-2">
                                <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></div>
                                <p className="text-sm font-medium text-slate-700 dark:text-slate-300" style={{ color: '#475569' }}>
                                  Aguardando leitura do QR code...
                                </p>
                              </div>
                            )}
                            {connectionStatus === 'connected' && (
                              <div className="flex items-center justify-center gap-2">
                                <span className="material-icons-outlined text-green-600 text-lg">check_circle</span>
                                <p className="text-sm font-medium text-green-600 dark:text-green-400" style={{ color: '#059669' }}>
                                  Conectado com sucesso!
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                )}

                {/* WhatsApp Numbers Table */}
                {whatsappTab === 'list' && (
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-lg overflow-hidden" style={{ backgroundColor: '#FFFFFF', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)' }}>
                  <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4" style={{ backgroundColor: '#FFFFFF' }}>
                    <div>
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1" style={{ color: '#0F172A', fontWeight: 700 }}>Lista de Números WhatsApp</h2>
                      <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                        Gerencie seus números WhatsApp conectados
                      </p>
                    </div>
                    <div className="relative w-full md:w-80">
                      <span className="material-icons-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg" style={{ color: '#94A3B8' }}>search</span>
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Pesquisar número..."
                        className="w-full pl-10 pr-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary dark:text-white placeholder-slate-400 outline-none transition-all"
                        style={{ backgroundColor: '#F8FAFC' }}
                      />
                    </div>
                  </div>
                  
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="bg-slate-50 border-b-2 border-slate-200" style={{ backgroundColor: '#F9FAFB' }}>
                          <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider" style={{ color: '#64748B', fontWeight: 700 }}>Número</th>
                          <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider" style={{ color: '#64748B', fontWeight: 700 }}>Tipo</th>
                          <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider" style={{ color: '#64748B', fontWeight: 700 }}>Vendedor</th>
                          <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider" style={{ color: '#64748B', fontWeight: 700 }}>Status</th>
                          <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-right" style={{ color: '#64748B', fontWeight: 700 }}>Ações</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
                        {whatsappNumbersList.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-6 py-12 text-center">
                              <div className="flex flex-col items-center justify-center">
                                <span className="material-icons-outlined text-slate-400 text-5xl mb-4" style={{ color: '#94A3B8' }}>phone_android</span>
                                <p className="text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>Nenhum número WhatsApp conectado</p>
                                <p className="text-sm text-slate-400 dark:text-slate-500 mt-1" style={{ color: '#94A3B8' }}>Conecte um número na aba "Criar Número"</p>
                              </div>
                            </td>
                          </tr>
                        ) : (
                          whatsappNumbersList
                            .filter(n => 
                              searchQuery === '' || 
                              n.number.toLowerCase().includes(searchQuery.toLowerCase()) ||
                              (n.seller?.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                              (n.seller?.email || '').toLowerCase().includes(searchQuery.toLowerCase())
                            )
                            .map((number) => (
                              <tr key={number.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-all duration-150 group" style={{ backgroundColor: '#FFFFFF' }}>
                                <td className="px-6 py-5">
                                  <div className="flex items-center gap-3">
                                    <div className="w-11 h-11 bg-gradient-to-br from-primary/10 to-primary/5 dark:from-primary/20 dark:to-primary/10 rounded-xl flex items-center justify-center shadow-sm" style={{ backgroundColor: '#FEF3E2' }}>
                                      <span className="material-icons-outlined text-primary text-lg" style={{ color: '#F07000' }}>phone</span>
                                    </div>
                                    <div>
                                      <p className="text-sm font-bold text-slate-900 dark:text-white mb-0.5" style={{ color: '#0F172A', fontWeight: 700 }}>{number.number}</p>
                                      <p className="text-xs text-slate-500 dark:text-slate-400 font-medium" style={{ color: '#64748B' }}>
                                        {number.config?.name ? `${number.config.name} • ` : ''}{number.adapterType === 'OFFICIAL' ? 'API Oficial' : 'API Não Oficial'}
                                      </p>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-6 py-5">
                                  {editingNumberId === number.id ? (
                                    <select
                                      value={editingNumberType}
                                      onChange={(e) => {
                                        const newType = e.target.value as 'UNDEFINED' | 'PRIMARY' | 'SECONDARY';
                                        setEditingNumberType(newType);
                                        if (newType === 'PRIMARY' || newType === 'UNDEFINED') {
                                          setEditingSellerId(null);
                                        } else if (newType === 'SECONDARY' && !editingSellerId) {
                                          // If changing to SECONDARY without seller, show warning
                                          toast.warning('Selecione um vendedor para o tipo "Pessoal"');
                                        }
                                      }}
                                      className="px-3 py-2 text-sm border-2 border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all"
                                      style={{ color: '#0F172A', backgroundColor: '#FFFFFF' }}
                                    >
                                      <option value="UNDEFINED">Indefinido</option>
                                      <option value="PRIMARY">Principal</option>
                                      <option value="SECONDARY">Pessoal</option>
                                    </select>
                                  ) : (
                                    getNumberTypeBadge(number.numberType)
                                  )}
                                </td>
                                <td className="px-6 py-5">
                                  {editingNumberId === number.id ? (
                                    editingNumberType === 'SECONDARY' ? (
                                      <select
                                        value={editingSellerId || ''}
                                        onChange={(e) => setEditingSellerId(e.target.value || null)}
                                        className="px-3 py-2 text-sm border-2 border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none w-full min-w-[220px] transition-all"
                                        style={{ color: '#0F172A', backgroundColor: '#FFFFFF' }}
                                      >
                                        <option value="">Selecione um vendedor</option>
                                        {sellers.map((seller) => (
                                          <option key={seller.id} value={seller.id}>
                                            {seller.name} ({seller.email})
                                          </option>
                                        ))}
                                      </select>
                                    ) : (
                                      <span className="text-sm text-slate-400 italic" style={{ color: '#94A3B8' }}>-</span>
                                    )
                                  ) : (
                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300" style={{ color: '#475569' }}>
                                      {number.seller ? (
                                        <span className="flex items-center gap-2">
                                          <span className="material-icons-outlined text-xs" style={{ color: '#64748B' }}>person</span>
                                          <span>{number.seller.name}</span>
                                        </span>
                                      ) : (
                                        <span className="text-slate-400 italic">-</span>
                                      )}
                                    </span>
                                  )}
                                </td>
                                <td className="px-6 py-5">{getStatusBadge(number.connectionStatus)}</td>
                                <td className="px-6 py-5">
                                  {editingNumberId === number.id ? (
                                    <div className="flex items-center justify-end gap-2">
                                      <button
                                        onClick={() => handleUpdateNumber(number.id)}
                                        className="px-4 py-2 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-lg transition-all shadow-sm hover:shadow"
                                        style={{ backgroundColor: '#059669' }}
                                      >
                                        Salvar
                                      </button>
                                      <button
                                        onClick={cancelEditing}
                                        className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border-2 border-slate-300 dark:border-slate-600 rounded-lg transition-all hover:bg-slate-50 dark:hover:bg-slate-800"
                                      >
                                        Cancelar
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center justify-end gap-2">
                                      <button
                                        onClick={() => startEditingNumber(number)}
                                        className="p-2 text-slate-400 hover:text-primary hover:bg-primary/10 rounded-lg transition-all"
                                        title="Editar"
                                      >
                                        <span className="material-icons-outlined text-lg">edit</span>
                                      </button>
                                      <button
                                        onClick={() => handleDeleteNumber(number.id, number.number)}
                                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all"
                                        title="Excluir"
                                      >
                                        <span className="material-icons-outlined text-lg">delete</span>
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  
                  {whatsappNumbersList.length > 0 && (
                    <div className="px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between" style={{ backgroundColor: '#F9FAFB' }}>
                      <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                        Exibindo <span className="font-bold text-slate-900 dark:text-white">1 - {whatsappNumbersList.length}</span> de{' '}
                        <span className="font-bold text-slate-900 dark:text-white">{whatsappNumbersList.length}</span> número{whatsappNumbersList.length !== 1 ? 's' : ''}
                      </p>
                      <div className="flex gap-2">
                        <button
                          disabled
                          className="px-4 py-2 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-500 dark:text-slate-500 hover:bg-white dark:hover:bg-slate-700 transition-all disabled:opacity-40 cursor-not-allowed shadow-sm"
                        >
                          Anterior
                        </button>
                        <button
                          disabled={whatsappNumbersList.length <= 10}
                          onClick={() => toast.info('Funcionalidade em desenvolvimento')}
                          className="px-4 py-2 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-700 transition-all disabled:opacity-40 cursor-not-allowed shadow-sm"
                        >
                          Próxima
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                )}
              </>
            )}

            {activeMenu === 'sellers' && (
              <>
                {/* Tabs */}
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm mb-6" style={{ backgroundColor: '#FFFFFF' }}>
                  <div className="flex border-b border-slate-200 dark:border-slate-800 relative">
                    <button
                      onClick={() => setSellersTab('list')}
                      className={`flex-1 px-6 py-4 text-sm font-semibold transition-colors relative ${
                        sellersTab === 'list'
                          ? 'text-primary'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                      style={sellersTab === 'list' ? { color: '#F07000' } : { color: '#64748B' }}
                    >
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-icons-outlined text-lg">list</span>
                        Usuários Cadastrados
                      </div>
                      {sellersTab === 'list' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#F07000' }}></div>
                      )}
                    </button>
                    <button
                      onClick={() => setSellersTab('manage')}
                      className={`flex-1 px-6 py-4 text-sm font-semibold transition-colors relative ${
                        sellersTab === 'manage'
                          ? 'text-primary'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                      style={sellersTab === 'manage' ? { color: '#F07000' } : { color: '#64748B' }}
                    >
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-icons-outlined text-lg">people</span>
                        Gestão de Usuários
                      </div>
                      {sellersTab === 'manage' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#F07000' }}></div>
                      )}
                    </button>
                  </div>
                </div>

                {/* Usuários Cadastrados Tab */}
                {sellersTab === 'list' && (
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
                  <div className="p-6 border-b border-slate-200 dark:border-slate-800">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>Usuários Cadastrados</h2>
                  </div>
                  {users.length === 0 ? (
                    <div className="p-12 text-center">
                      <span className="material-icons-outlined text-slate-400 text-6xl mb-4 inline-block" style={{ color: '#94A3B8' }}>people</span>
                      <p className="text-slate-500 dark:text-slate-400 text-lg mb-2" style={{ color: '#64748B' }}>Nenhum usuário cadastrado</p>
                      <p className="text-sm text-slate-400 dark:text-slate-500" style={{ color: '#94A3B8' }}>Use a aba "Gestão de Usuários" para criar novas contas</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 p-6" style={{ backgroundColor: '#FFFFFF' }}>
                      {/* Coluna de Vendedores */}
                      <div className="rounded-xl p-6 border border-slate-200 shadow-sm" style={{ backgroundColor: '#F9FAFB' }}>
                        {(() => {
                          const displayedSellers = sellersDetails.filter(seller =>
                            sellersList.some(u => u.id === seller.id)
                          );
                          return (
                            <>
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-base font-bold" style={{ color: '#0F172A', fontWeight: 700 }}>
                            Vendedores ({displayedSellers.length})
                          </h3>
                          <span className="px-3 py-1 text-xs font-bold rounded-lg" style={{ backgroundColor: '#DBEAFE', color: '#1E40AF' }}>
                            {displayedSellers.length}
                          </span>
                        </div>
                        <div className="space-y-3 max-h-[600px] overflow-y-auto custom-scrollbar">
                          {displayedSellers.length === 0 ? (
                            <p className="text-sm text-center py-8" style={{ color: '#94A3B8' }}>Nenhum vendedor cadastrado</p>
                          ) : (
                            displayedSellers.map((seller) => {
                                const sellerUser = sellersList.find(u => u.id === seller.id);
                                const sellerBrand = seller.brands && seller.brands.length > 0 ? seller.brands[0] : 'INDEFINIDO';
                                const isEditing = editingBrandSellerId === seller.id;
                                
                                return (
                                  <div key={seller.id} className="rounded-lg p-4 border border-slate-200 hover:shadow-md transition-shadow" style={{ backgroundColor: '#FFFFFF' }}>
                                    <div className="flex items-start justify-between mb-2">
                                      <div className="flex-1">
                                        <p className="text-sm font-bold mb-1" style={{ color: '#0F172A', fontWeight: 700 }}>{seller.name}</p>
                                        <p className="text-xs mb-2" style={{ color: '#475569' }}>{seller.email}</p>
                                        
                                        {/* Marca */}
                                        <div className="mb-2">
                                          {isEditing ? (
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <select
                                                value={editingSellerBrand}
                                                onChange={(e) => setEditingSellerBrand(e.target.value)}
                                                className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                                style={{ color: '#0F172A', backgroundColor: '#FFFFFF' }}
                                              >
                                                <option value="INDEFINIDO">Indefinido</option>
                                                <option value="FORD">Ford</option>
                                                <option value="GM">GM</option>
                                                <option value="VW">VW</option>
                                                <option value="FIAT">Fiat</option>
                                                <option value="IMPORTADOS">Importados</option>
                                              </select>
                                              <button
                                                onClick={() => {
                                                  handleUpdateSellerBrand(seller.id, editingSellerBrand);
                                                  setEditingBrandSellerId(null);
                                                }}
                                                className="px-3 py-1.5 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-lg transition-all"
                                                style={{ backgroundColor: '#059669' }}
                                              >
                                                Salvar
                                              </button>
                                              <button
                                                onClick={() => {
                                                  setEditingBrandSellerId(null);
                                                  setEditingSellerBrand('INDEFINIDO');
                                                }}
                                                className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg transition-all hover:bg-slate-50"
                                              >
                                                Cancelar
                                              </button>
                                            </div>
                                          ) : (
                                            <div className="flex items-center gap-2">
                                              <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded-md" style={{
                                                backgroundColor: sellerBrand === 'INDEFINIDO' ? '#F1F5F9' : '#DBEAFE',
                                                color: sellerBrand === 'INDEFINIDO' ? '#64748B' : '#1E40AF'
                                              }}>
                                                <span className="material-icons-outlined text-xs">directions_car</span>
                                                {sellerBrand === 'INDEFINIDO' ? 'Indefinido' :
                                                 sellerBrand === 'FORD' ? 'Ford' :
                                                 sellerBrand === 'GM' ? 'GM' :
                                                 sellerBrand === 'VW' ? 'VW' :
                                                 sellerBrand === 'FIAT' ? 'Fiat' : 'Importados'}
                                              </span>
                                              <button
                                                onClick={() => {
                                                  setEditingBrandSellerId(seller.id);
                                                  setEditingSellerBrand(sellerBrand);
                                                }}
                                                className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all"
                                                title="Editar marca"
                                              >
                                                <span className="material-icons-outlined text-sm">edit</span>
                                              </button>
                                            </div>
                                          )}
                                        </div>

                                        {/* Supervisores (N:N - vários podem ver o mesmo vendedor) */}
                                        {(seller.supervisors && seller.supervisors.length > 0) ? (
                                          <div className="mb-2 flex flex-wrap gap-1">
                                            {seller.supervisors.map((sup) => (
                                              <span
                                                key={sup.id}
                                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-md"
                                                style={{ backgroundColor: '#F3E8FF', color: '#7C3AED' }}
                                              >
                                                <span className="material-icons-outlined text-xs">supervisor_account</span>
                                                {sup.name}
                                                <button
                                                  type="button"
                                                  onClick={() => handleUnassignSeller(seller.id, seller.name, sup.id)}
                                                  className="ml-0.5 p-0.5 rounded hover:bg-purple-200"
                                                  title={`Remover vínculo com ${sup.name}`}
                                                >
                                                  <span className="material-icons-outlined text-xs">close</span>
                                                </button>
                                              </span>
                                            ))}
                                          </div>
                                        ) : (
                                          <div className="mb-2">
                                            <span className="text-xs" style={{ color: '#94A3B8' }}>Nenhum supervisor vinculado</span>
                                          </div>
                                        )}

                                        {sellerUser && (
                                          <p className="text-xs" style={{ color: '#64748B' }}>
                                            {new Date(sellerUser.createdAt).toLocaleDateString('pt-BR')}
                                          </p>
                                        )}
                                      </div>
                                      <div className="flex flex-col gap-1">
                                        <button
                                          onClick={() => handleDeleteUser(seller.id, seller.name)}
                                          className="p-1.5 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                                          style={{ color: '#94A3B8' }}
                                          title="Excluir usuário"
                                        >
                                          <span className="material-icons-outlined text-lg">delete</span>
                                        </button>
                                        {(seller.supervisors && seller.supervisors.length > 0) && (
                                          <button
                                            onClick={() => handleUnassignSeller(seller.id, seller.name)}
                                            className="p-1.5 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all"
                                            style={{ color: '#94A3B8' }}
                                            title="Desatribuir de todos os supervisores"
                                          >
                                            <span className="material-icons-outlined text-lg">link_off</span>
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 mt-2">
                                      {seller.active ? (
                                        <div className="flex items-center gap-1.5" style={{ color: '#059669' }}>
                                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#10B981' }}></span>
                                          <span className="text-xs font-medium">Ativo</span>
                                        </div>
                                      ) : (
                                        <div className="flex items-center gap-1.5" style={{ color: '#94A3B8' }}>
                                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#94A3B8' }}></span>
                                          <span className="text-xs font-medium">Inativo</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })
                          )}
                        </div>
                            </>
                          );
                        })()}
                      </div>

                      {/* Coluna de Supervisores */}
                      <div className="rounded-xl p-6 border border-slate-200 shadow-sm" style={{ backgroundColor: '#F9FAFB' }}>
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-base font-bold" style={{ color: '#0F172A', fontWeight: 700 }}>
                            Supervisores ({supervisorsList.length})
                          </h3>
                          <span className="px-3 py-1 text-xs font-bold rounded-lg" style={{ backgroundColor: '#F3E8FF', color: '#7C3AED' }}>
                            {supervisorsList.length}
                          </span>
                        </div>
                        <div className="space-y-3 max-h-[600px] overflow-y-auto custom-scrollbar">
                          {supervisorsList.length === 0 ? (
                            <p className="text-sm text-center py-8" style={{ color: '#94A3B8' }}>Nenhum supervisor cadastrado</p>
                          ) : (
                            supervisorsList.map((user) => (
                              <div key={user.id} className="rounded-lg p-4 border border-slate-200 hover:shadow-md transition-shadow" style={{ backgroundColor: '#FFFFFF' }}>
                                <div className="flex items-start justify-between mb-2">
                                  <div className="flex-1">
                                    <p className="text-sm font-bold mb-1" style={{ color: '#0F172A', fontWeight: 700 }}>{user.name}</p>
                                    <p className="text-xs mb-2" style={{ color: '#475569' }}>{user.email}</p>
                                    <p className="text-xs" style={{ color: '#64748B' }}>
                                      {new Date(user.createdAt).toLocaleDateString('pt-BR')}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => handleDeleteUser(user.id, user.name)}
                                    className="p-1.5 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all ml-2"
                                    style={{ color: '#94A3B8' }}
                                    title="Excluir usuário"
                                  >
                                    <span className="material-icons-outlined text-lg">delete</span>
                                  </button>
                                </div>
                                <div className="flex items-center gap-2 mt-2">
                                  {user.active ? (
                                    <div className="flex items-center gap-1.5" style={{ color: '#059669' }}>
                                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#10B981' }}></span>
                                      <span className="text-xs font-medium">Ativo</span>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-1.5" style={{ color: '#94A3B8' }}>
                                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#94A3B8' }}></span>
                                      <span className="text-xs font-medium">Inativo</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      {/* Coluna de Administradores */}
                      <div className="rounded-xl p-6 border border-slate-200 shadow-sm" style={{ backgroundColor: '#F9FAFB' }}>
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-base font-bold" style={{ color: '#0F172A', fontWeight: 700 }}>
                            Administradores ({adminsList.length})
                          </h3>
                          <span className="px-3 py-1 text-xs font-bold rounded-lg" style={{ backgroundColor: '#FFEDD5', color: '#C2410C' }}>
                            {adminsList.length}
                          </span>
                        </div>
                        <div className="space-y-3 max-h-[600px] overflow-y-auto custom-scrollbar">
                          {adminsList.length === 0 ? (
                            <p className="text-sm text-center py-8" style={{ color: '#94A3B8' }}>Nenhum administrador cadastrado</p>
                          ) : (
                            adminsList.map((user) => (
                              <div key={user.id} className="rounded-lg p-4 border border-slate-200 hover:shadow-md transition-shadow" style={{ backgroundColor: '#FFFFFF' }}>
                                <div className="flex items-start justify-between mb-2">
                                  <div className="flex-1">
                                    <p className="text-sm font-bold mb-1" style={{ color: '#0F172A', fontWeight: 700 }}>{user.name}</p>
                                    <p className="text-xs mb-2" style={{ color: '#475569' }}>{user.email}</p>
                                    <p className="text-xs" style={{ color: '#64748B' }}>
                                      {new Date(user.createdAt).toLocaleDateString('pt-BR')}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => handleDeleteUser(user.id, user.name)}
                                    className="p-1.5 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all ml-2"
                                    style={{ color: '#94A3B8' }}
                                    title="Excluir usuário"
                                  >
                                    <span className="material-icons-outlined text-lg">delete</span>
                                  </button>
                                </div>
                                <div className="flex items-center gap-2 mt-2">
                                  {user.active ? (
                                    <div className="flex items-center gap-1.5" style={{ color: '#059669' }}>
                                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#10B981' }}></span>
                                      <span className="text-xs font-medium">Ativo</span>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-1.5" style={{ color: '#94A3B8' }}>
                                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#94A3B8' }}></span>
                                      <span className="text-xs font-medium">Inativo</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                )}

                {/* Gestão de Usuários Tab */}
                {sellersTab === 'manage' && (
                <>
                {/* Create Account Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                  {/* Seller Card */}
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden hover:shadow-lg transition-shadow duration-300" style={{ backgroundColor: '#FFFFFF' }}>
                    <div className="p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-14 h-14 bg-blue-50 dark:bg-blue-900/20 rounded-xl flex items-center justify-center">
                          <span className="material-icons-outlined text-blue-600 dark:text-blue-400 text-3xl">person</span>
                        </div>
                        <span className="px-3 py-1 text-xs font-semibold bg-blue-100 dark:bg-blue-900/30 rounded-full" style={{ color: '#1E40AF', backgroundColor: '#DBEAFE' }}>Vendedor</span>
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2" style={{ color: '#0F172A' }}>Vendedor</h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mb-6" style={{ color: '#64748B' }}>
                        Crie uma conta para um vendedor que atenderá clientes através do WhatsApp
                      </p>
                      <button
                        onClick={() => {
                          setCreateUserRole('SELLER');
                          setShowCreateModal(true);
                        }}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-lg flex items-center justify-center gap-2 font-semibold shadow-sm transition-all transform hover:scale-[1.02] active:scale-[0.98]"
                        style={{ backgroundColor: '#2563EB' }}
                      >
                        <span className="material-icons-outlined text-lg">add</span>
                        Criar Vendedor
                      </button>
                    </div>
                  </div>

                  {/* Supervisor Card */}
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden hover:shadow-lg transition-shadow duration-300" style={{ backgroundColor: '#FFFFFF' }}>
                    <div className="p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-14 h-14 bg-purple-50 dark:bg-purple-900/20 rounded-xl flex items-center justify-center">
                          <span className="material-icons-outlined text-purple-600 dark:text-purple-400 text-3xl">supervisor_account</span>
                        </div>
                        <span className="px-3 py-1 text-xs font-semibold bg-purple-100 dark:bg-purple-900/30 rounded-full" style={{ color: '#7C3AED', backgroundColor: '#F3E8FF' }}>Supervisor</span>
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2" style={{ color: '#0F172A' }}>Supervisor</h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mb-6" style={{ color: '#64748B' }}>
                        Crie uma conta para um supervisor que gerenciará vendedores e atendimentos
                      </p>
                      <button
                        onClick={() => {
                          setCreateUserRole('SUPERVISOR');
                          setShowCreateModal(true);
                        }}
                        className="w-full bg-purple-600 hover:bg-purple-700 text-white px-4 py-3 rounded-lg flex items-center justify-center gap-2 font-semibold shadow-sm transition-all transform hover:scale-[1.02] active:scale-[0.98]"
                        style={{ backgroundColor: '#9333EA' }}
                      >
                        <span className="material-icons-outlined text-lg">add</span>
                        Criar Supervisor
                      </button>
                    </div>
                  </div>

                  {/* Admin Card */}
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden hover:shadow-lg transition-shadow duration-300" style={{ backgroundColor: '#FFFFFF' }}>
                    <div className="p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-14 h-14 bg-orange-50 dark:bg-orange-900/20 rounded-xl flex items-center justify-center">
                          <span className="material-icons-outlined text-orange-600 dark:text-orange-400 text-3xl">admin_panel_settings</span>
                        </div>
                        <span className="px-3 py-1 text-xs font-semibold bg-orange-100 dark:bg-orange-900/30 rounded-full" style={{ color: '#C2410C', backgroundColor: '#FFEDD5' }}>Administrador</span>
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2" style={{ color: '#0F172A' }}>Administrador</h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mb-6" style={{ color: '#64748B' }}>
                        Crie uma conta para um administrador geral com acesso a todas as operações
                      </p>
                      <button
                        onClick={() => {
                          setCreateUserRole('ADMIN_GENERAL');
                          setShowCreateModal(true);
                        }}
                        className="w-full bg-orange-600 hover:bg-orange-700 text-white px-4 py-3 rounded-lg flex items-center justify-center gap-2 font-semibold shadow-sm transition-all transform hover:scale-[1.02] active:scale-[0.98]"
                        style={{ backgroundColor: '#F07000' }}
                      >
                        <span className="material-icons-outlined text-lg">add</span>
                        Criar Administrador
                      </button>
                    </div>
                  </div>
                </div>

                {/* Hierarchy Management Section */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
                  {/* Assign Sellers to Supervisors */}
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
                    <div className="p-6 border-b border-slate-200 dark:border-slate-800">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center">
                            <span className="material-icons-outlined text-blue-600 dark:text-blue-400">link</span>
                          </div>
                          <h2 className="text-lg font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>Atribuir Vendedores</h2>
                        </div>
                        <button
                          type="button"
                          onClick={async () => { await loadUsers(); await loadSellers(); toast.success('Lista atualizada'); }}
                          className="p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-all"
                          title="Atualizar lista"
                        >
                          <span className="material-icons-outlined">refresh</span>
                        </button>
                      </div>
                      <p className="text-sm text-slate-500 dark:text-slate-400 ml-13" style={{ color: '#64748B' }}>Vincule vendedores a supervisores</p>
                    </div>
                    <div className="p-6 space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Supervisor
                        </label>
                        <div className="relative">
                          <span className="material-icons-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">supervisor_account</span>
                          <select
                            value={selectedSupervisorForSeller}
                            onChange={(e) => setSelectedSupervisorForSeller(e.target.value)}
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:text-white outline-none"
                            style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                          >
                            <option value="">Selecione um supervisor</option>
                            {supervisorsList.map((supervisor) => (
                              <option key={supervisor.id} value={supervisor.id}>
                                {supervisor.name} ({supervisor.email})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Vendedor
                        </label>
                        <div className="relative">
                          <span className="material-icons-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">person</span>
                          <select
                            value={selectedSellerForSupervisor}
                            onChange={(e) => setSelectedSellerForSupervisor(e.target.value)}
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:text-white outline-none"
                            style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                          >
                            <option value="">Selecione um vendedor</option>
                            {sellersList.map((seller) => (
                              <option key={seller.id} value={seller.id}>
                                {seller.name} ({seller.email})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <button
                        onClick={handleAssignSellerToSupervisor}
                        disabled={isAssigning || !selectedSupervisorForSeller || !selectedSellerForSupervisor}
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white px-4 py-3 rounded-lg flex items-center justify-center gap-2 font-semibold shadow-sm transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:transform-none"
                        style={{ backgroundColor: isAssigning || !selectedSupervisorForSeller || !selectedSellerForSupervisor ? '#93C5FD' : '#2563EB' }}
                      >
                        {isAssigning ? (
                          <>
                            <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                            Atribuindo...
                          </>
                        ) : (
                          <>
                            <span className="material-icons-outlined text-lg">link</span>
                            Atribuir Vendedor
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Assign Supervisors to Administrators */}
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
                    <div className="p-6 border-b border-slate-200 dark:border-slate-800">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 bg-orange-50 dark:bg-orange-900/20 rounded-lg flex items-center justify-center">
                          <span className="material-icons-outlined text-orange-600 dark:text-orange-400">admin_panel_settings</span>
                        </div>
                        <h2 className="text-lg font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>Atribuir Supervisores</h2>
                      </div>
                      <p className="text-sm text-slate-500 dark:text-slate-400 ml-13" style={{ color: '#64748B' }}>Vincule supervisores a administradores</p>
                    </div>
                    <div className="p-6 space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Administrador
                        </label>
                        <div className="relative">
                          <span className="material-icons-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">admin_panel_settings</span>
                          <select
                            value={selectedAdminForSupervisor}
                            onChange={(e) => setSelectedAdminForSupervisor(e.target.value)}
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500 dark:text-white outline-none"
                            style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                          >
                            <option value="">Selecione um administrador</option>
                            {adminsList.map((admin) => (
                              <option key={admin.id} value={admin.id}>
                                {admin.name} ({admin.email})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                          Supervisor
                        </label>
                        <div className="relative">
                          <span className="material-icons-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">supervisor_account</span>
                          <select
                            value={selectedSupervisorForAdmin}
                            onChange={(e) => setSelectedSupervisorForAdmin(e.target.value)}
                            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500 dark:text-white outline-none"
                            style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                          >
                            <option value="">Selecione um supervisor</option>
                            {supervisorsList.map((supervisor) => (
                              <option key={supervisor.id} value={supervisor.id}>
                                {supervisor.name} ({supervisor.email})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <button
                        onClick={handleAssignSupervisorToAdmin}
                        disabled={isAssigning || !selectedAdminForSupervisor || !selectedSupervisorForAdmin}
                        className="w-full bg-orange-600 hover:bg-orange-700 disabled:bg-orange-400 disabled:cursor-not-allowed text-white px-4 py-3 rounded-lg flex items-center justify-center gap-2 font-semibold shadow-sm transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:transform-none"
                        style={{ backgroundColor: isAssigning || !selectedAdminForSupervisor || !selectedSupervisorForAdmin ? '#FDBA74' : '#F07000' }}
                      >
                        {isAssigning ? (
                          <>
                            <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                            Atribuindo...
                          </>
                        ) : (
                          <>
                            <span className="material-icons-outlined text-lg">link</span>
                            Atribuir Supervisor
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                </>
                )}
              </>
            )}

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCreateModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-md w-full mx-4" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>
                  Criar {createUserRole === 'SELLER' ? 'Vendedor' : createUserRole === 'SUPERVISOR' ? 'Supervisor' : 'Administrador'}
                </h3>
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                >
                  <span className="material-icons-outlined">close</span>
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                  Nome Completo *
                </label>
                <input
                  type="text"
                  value={createUserName}
                  onChange={(e) => setCreateUserName(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary dark:text-white outline-none"
                  style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                  placeholder="Digite o nome completo"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                  E-mail *
                </label>
                <input
                  type="email"
                  value={createUserEmail}
                  onChange={(e) => setCreateUserEmail(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary dark:text-white outline-none"
                  style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                  placeholder="exemplo@email.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                  Senha *
                </label>
                <input
                  type="password"
                  value={createUserPassword}
                  onChange={(e) => setCreateUserPassword(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary dark:text-white outline-none"
                  style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                  placeholder="Mínimo de 8 caracteres"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1" style={{ color: '#64748B' }}>A senha deve ter pelo menos 8 caracteres</p>
              </div>
              {createUserRole === 'SELLER' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                    Marca *
                  </label>
                  <select
                    value={createUserBrand}
                    onChange={(e) => setCreateUserBrand(e.target.value)}
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary dark:text-white outline-none"
                    style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                    required
                  >
                    <option value="INDEFINIDO">Indefinido</option>
                    <option value="FORD">Ford</option>
                    <option value="GM">GM</option>
                    <option value="VW">VW</option>
                    <option value="FIAT">Fiat</option>
                    <option value="IMPORTADOS">Importados</option>
                  </select>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1" style={{ color: '#64748B' }}>
                    O vendedor só poderá ser atribuído a um supervisor após definir uma marca
                  </p>
                </div>
              )}
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                  style={{ color: '#475569' }}
                >
                  Cancelar
                </button>
                <button
                  onClick={handleCreateUser}
                  disabled={isCreatingUser || !createUserName.trim() || !createUserEmail.trim() || !createUserPassword.trim() || createUserPassword.length < 8}
                  className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 disabled:bg-primary/50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-sm transition-all"
                  style={{ backgroundColor: createUserRole === 'SELLER' ? '#2563EB' : createUserRole === 'SUPERVISOR' ? '#9333EA' : '#F07000' }}
                >
                  {isCreatingUser ? 'Criando...' : 'Criar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

            {activeMenu === 'costs' && (
              <div className="max-w-6xl mx-auto">
                <CostsTab />
              </div>
            )}

            {activeMenu === 'ai-config' && (
              <div className={`w-full flex-1 flex flex-col min-h-0 ${aiConfigMode === 'agent' ? '' : 'space-y-6'}`}>
                {/* Geral mode: Controls at top, then two-column layout */}
                {aiConfigMode === 'geral' && (
                  <div className="space-y-6">
                    {/* Top Controls: AI On/Off and Operation Mode */}
                    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden p-6" style={{ backgroundColor: '#FFFFFF' }}>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* AI On/Off Toggle */}
                        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-lg" style={{ backgroundColor: '#F8FAFC' }}>
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: aiEnabled ? '#DCFCE7' : '#FEE2E2' }}>
                              <span className="material-icons-outlined" style={{ color: aiEnabled ? '#16A34A' : '#DC2626' }}>
                                smart_toy
                              </span>
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-slate-900 dark:text-white" style={{ color: '#0F172A' }}>
                                {aiEnabled ? 'IA ligada' : 'IA desligada'}
                              </p>
                              <p className="text-xs text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                {aiEnabled
                                  ? 'Worker está consumindo a fila RabbitMQ'
                                  : 'Worker parou de consumir a fila RabbitMQ'}
                              </p>
                            </div>
                          </div>
                          {isLoadingAiEnabled ? (
                            <span className="material-icons-outlined animate-spin text-slate-400">refresh</span>
                          ) : isSavingAiEnabled ? (
                            <span className="material-icons-outlined animate-spin text-slate-400">refresh</span>
                          ) : (
                            <button
                              onClick={handleToggleAIEnabled}
                              disabled={isSavingAiEnabled}
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                aiEnabled ? 'bg-primary' : 'bg-slate-300'
                              } ${isSavingAiEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                              style={{ backgroundColor: aiEnabled ? '#F07000' : '#CBD5E1' }}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                  aiEnabled ? 'translate-x-6' : 'translate-x-1'
                                }`}
                              />
                            </button>
                          )}
                        </div>

                        {/* Operation Mode Selection */}
                        <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg" style={{ backgroundColor: '#F8FAFC' }}>
                          <label className="block text-sm font-semibold text-slate-900 dark:text-white" style={{ color: '#0F172A' }}>
                            Modo de Operação
                          </label>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleChangeOperationMode('agent')}
                              disabled={isSavingOperationMode || aiOperationMode === 'agent'}
                              className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                                aiOperationMode === 'agent'
                                  ? 'bg-primary text-white'
                                  : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600'
                              } ${isSavingOperationMode ? 'opacity-50 cursor-not-allowed' : ''}`}
                              style={{
                                backgroundColor: aiOperationMode === 'agent' ? '#F07000' : '#FFFFFF',
                                color: aiOperationMode === 'agent' ? '#FFFFFF' : '#334155',
                              }}
                            >
                              Agente
                            </button>
                            <button
                              onClick={() => handleChangeOperationMode('multi-agent')}
                              disabled={isSavingOperationMode || aiOperationMode === 'multi-agent' || !selectedWorkflowId}
                              className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                                aiOperationMode === 'multi-agent'
                                  ? 'bg-primary text-white'
                                  : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600'
                              } ${isSavingOperationMode || !selectedWorkflowId ? 'opacity-50 cursor-not-allowed' : ''}`}
                              style={{
                                backgroundColor: aiOperationMode === 'multi-agent' ? '#F07000' : '#FFFFFF',
                                color: aiOperationMode === 'multi-agent' ? '#FFFFFF' : '#334155',
                              }}
                            >
                              Multi Agente
                            </button>
                          </div>
                          {aiOperationMode === 'multi-agent' && (
                            <div className="mt-2 space-y-2">
                              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300" style={{ color: '#475569' }}>
                                Workflow Selecionado *
                              </label>
                              <select
                                value={selectedWorkflowId || ''}
                                onChange={(e) => handleSelectWorkflow(e.target.value || null)}
                                disabled={isLoadingWorkflows || isSavingWorkflow}
                                className="w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                                style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                              >
                                <option value="">Selecione um workflow</option>
                                {workflows
                                  .filter((w) => w.isActive)
                                  .map((w) => (
                                    <option key={w.id} value={w.id}>
                                      {w.name}
                                    </option>
                                  ))}
                              </select>
                              {selectedWorkflowId && (
                                <div className="flex items-center gap-2 mt-1">
                                  <span className="text-xs text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                    Status:
                                  </span>
                                  <span className={`text-xs font-medium ${aiOperationMode === 'multi-agent' ? 'text-green-600' : 'text-slate-500'}`} style={{ color: aiOperationMode === 'multi-agent' ? '#16A34A' : '#64748B' }}>
                                    {aiOperationMode === 'multi-agent' ? 'Ativo' : 'Inativo'}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Organized layout: Three balanced rows */}
                    <div className="space-y-6">
                      {/* Row 1: Image Prompt and Buffer */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
                        <div className="flex">
                          <ImageDescriptionPrompt
                            imageDescriptionPrompt={imageDescriptionPrompt}
                            setImageDescriptionPrompt={setImageDescriptionPrompt}
                            isLoadingImagePrompt={isLoadingImagePrompt}
                            isSavingImagePrompt={isSavingImagePrompt}
                            setIsSavingImagePrompt={setIsSavingImagePrompt}
                          />
                        </div>
                        <div className="flex">
                          <BufferConfigTab
                          bufferEnabled={bufferEnabled}
                          setBufferEnabled={setBufferEnabled}
                          bufferTimeMs={bufferTimeMs}
                          setBufferTimeMs={setBufferTimeMs}
                          isLoadingBuffer={isLoadingBuffer}
                          isSavingBuffer={isSavingBuffer}
                          setIsSavingBuffer={setIsSavingBuffer}
                        />
                        </div>
                      </div>

                      {/* Blacklist: números ignorados pela IA e não exibidos como atendimentos */}
                      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
                        <div className="p-6 border-b border-slate-200 dark:border-slate-800">
                          <div className="flex items-center gap-3 mb-2">
                            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ backgroundColor: '#FEE2E2' }}>
                              <span className="material-icons-outlined" style={{ color: '#DC2626' }}>block</span>
                            </div>
                            <div>
                              <h2 className="text-xl font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>
                                Blacklist de números
                              </h2>
                              <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                Números que não recebem resposta da IA e não aparecem nas listas de atendimento
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="p-6 space-y-4">
                          {isLoadingBlacklist ? (
                            <div className="flex items-center justify-center py-6">
                              <span className="material-icons-outlined text-slate-400 animate-spin">refresh</span>
                              <span className="ml-2 text-sm text-slate-500">Carregando...</span>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center justify-between p-4 rounded-lg" style={{ backgroundColor: '#F8FAFC' }}>
                                <div>
                                  <p className="text-sm font-semibold text-slate-900 dark:text-white" style={{ color: '#0F172A' }}>Ativar Blacklist</p>
                                  <p className="text-xs text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>Quando ativa, os números da lista são ignorados</p>
                                </div>
                                <button
                                  onClick={handleToggleBlacklistEnabled}
                                  disabled={isSavingBlacklist}
                                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${blacklistEnabled ? 'bg-primary' : 'bg-slate-300'} ${isSavingBlacklist ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  style={{ backgroundColor: blacklistEnabled ? '#F07000' : '#CBD5E1' }}
                                >
                                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${blacklistEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                </button>
                              </div>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={blacklistNewNumber}
                                  onChange={(e) => setBlacklistNewNumber(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && handleAddBlacklistNumber()}
                                  placeholder="Ex: 5511999999999 ou 11999999999"
                                  className="flex-1 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary outline-none"
                                  style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                                />
                                <button
                                  type="button"
                                  onClick={handleAddBlacklistNumber}
                                  disabled={isSavingBlacklist}
                                  className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-primary hover:opacity-90 disabled:opacity-50"
                                  style={{ backgroundColor: '#F07000' }}
                                >
                                  Adicionar
                                </button>
                              </div>
                              {blacklistNumbers.length > 0 && (
                                <div>
                                  <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2" style={{ color: '#475569' }}>
                                    {blacklistNumbers.length} número(s) na lista — alterações são salvas ao ativar/desativar ou ao clicar em Salvar
                                  </p>
                                  <ul className="space-y-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 p-2" style={{ backgroundColor: '#F8FAFC' }}>
                                    {blacklistNumbers.map((num) => (
                                      <li key={num} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-white dark:hover:bg-slate-700/50">
                                        <span className="text-sm font-mono text-slate-800 dark:text-slate-200">{num}</span>
                                        <button
                                          type="button"
                                          onClick={() => handleRemoveBlacklistNumber(num)}
                                          className="text-slate-400 hover:text-red-600 p-1 rounded"
                                          title="Remover"
                                        >
                                          <span className="material-icons-outlined text-lg">close</span>
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                  <button
                                    type="button"
                                    onClick={handleSaveBlacklist}
                                    disabled={isSavingBlacklist}
                                    className="mt-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-primary hover:opacity-90 disabled:opacity-50"
                                    style={{ backgroundColor: '#F07000' }}
                                  >
                                    {isSavingBlacklist ? 'Salvando...' : 'Salvar lista'}
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      {/* Row 2: Memory Reset and Queue Management */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Memory Reset Section */}
                        <div className="bg-red-50 dark:bg-red-900/10 rounded-xl border-2 border-red-200 dark:border-red-800 shadow-sm overflow-hidden">
                          <div className="p-6 border-b border-red-200 dark:border-red-800 bg-red-100 dark:bg-red-900/20">
                            <div className="flex items-center gap-3 mb-2">
                              <div className="w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center">
                                <span className="material-icons-outlined text-red-600 dark:text-red-400">delete_sweep</span>
                              </div>
                              <div>
                                <h2 className="text-xl font-bold text-red-800 dark:text-red-300" style={{ fontWeight: 700 }}>
                                  🗑️ Resetar Memória da IA (Testes)
                                </h2>
                                <p className="text-sm text-red-600 dark:text-red-400">
                                  Apague mensagens e contexto da IA para facilitar testes
                                </p>
                              </div>
                            </div>
                          </div>
                          
                          <div className="p-6 space-y-6">
                            {/* Filters */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              {/* Supervisor Dropdown */}
                              <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                                  Supervisor
                                </label>
                                <select
                                  value={selectedSupervisorForReset}
                                  onChange={(e) => {
                                    setSelectedSupervisorForReset(e.target.value);
                                    setSelectedSellerForReset('');
                                    setSelectedClientForReset('');
                                  }}
                                  className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
                                  disabled={isResettingMemory}
                                >
                                  <option value="">Selecione um supervisor</option>
                                  {supervisorsList.map((sup) => (
                                    <option key={sup.id} value={sup.id}>
                                      {sup.name}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {/* Seller Dropdown */}
                              <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                                  Vendedor
                                </label>
                                <select
                                  value={selectedSellerForReset}
                                  onChange={(e) => {
                                    setSelectedSellerForReset(e.target.value);
                                    setSelectedClientForReset('');
                                  }}
                                  className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none disabled:bg-slate-100 disabled:cursor-not-allowed"
                                  disabled={!selectedSupervisorForReset || isResettingMemory}
                                >
                                  <option value="">Todos os vendedores</option>
                                  {sellersDetails
                                    .filter((s) => s.supervisorId === selectedSupervisorForReset || s.supervisors?.some((sup) => sup.id === selectedSupervisorForReset))
                                    .map((seller) => (
                                      <option key={seller.id} value={seller.id}>
                                        {seller.name}
                                      </option>
                                    ))}
                                </select>
                              </div>

                              {/* Client Phone Dropdown */}
                              <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                                  Número do Cliente
                                </label>
                                <select
                                  value={selectedClientForReset}
                                  onChange={(e) => setSelectedClientForReset(e.target.value)}
                                  className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none disabled:bg-slate-100 disabled:cursor-not-allowed"
                                  disabled={(!selectedSupervisorForReset && !selectedSellerForReset) || isLoadingClients || isResettingMemory}
                                >
                                  <option value="">
                                    {isLoadingClients ? 'Carregando...' : 'Todos os clientes'}
                                  </option>
                                  {clientPhones.map((phone) => (
                                    <option key={phone} value={phone}>
                                      {phone}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>

                            {/* Reset Options */}
                            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
                              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
                                Opções de Reset
                              </h3>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={resetOptions.deleteMessages}
                                    onChange={(e) =>
                                      setResetOptions({
                                        ...resetOptions,
                                        deleteMessages: e.target.checked,
                                      })
                                    }
                                    className="w-4 h-4 text-red-600 bg-gray-100 border-gray-300 rounded focus:ring-red-500"
                                    disabled={isResettingMemory}
                                  />
                                  <span className="text-sm text-slate-700 dark:text-slate-300">
                                    Apagar mensagens
                                  </span>
                                </label>

                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={resetOptions.deleteAiContext}
                                    onChange={(e) =>
                                      setResetOptions({
                                        ...resetOptions,
                                        deleteAiContext: e.target.checked,
                                      })
                                    }
                                    className="w-4 h-4 text-red-600 bg-gray-100 border-gray-300 rounded focus:ring-red-500"
                                    disabled={isResettingMemory}
                                  />
                                  <span className="text-sm text-slate-700 dark:text-slate-300">
                                    Apagar resumos (AI Context)
                                  </span>
                                </label>

                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={resetOptions.deleteEmbeddings}
                                    onChange={(e) =>
                                      setResetOptions({
                                        ...resetOptions,
                                        deleteEmbeddings: e.target.checked,
                                      })
                                    }
                                    className="w-4 h-4 text-red-600 bg-gray-100 border-gray-300 rounded focus:ring-red-500"
                                    disabled={isResettingMemory}
                                  />
                                  <span className="text-sm text-slate-700 dark:text-slate-300">
                                    Apagar embeddings (Vector DB)
                                  </span>
                                </label>

                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={resetOptions.resetAttendanceState}
                                    onChange={(e) =>
                                      setResetOptions({
                                        ...resetOptions,
                                        resetAttendanceState: e.target.checked,
                                      })
                                    }
                                    className="w-4 h-4 text-red-600 bg-gray-100 border-gray-300 rounded focus:ring-red-500"
                                    disabled={isResettingMemory}
                                  />
                                  <span className="text-sm text-slate-700 dark:text-slate-300">
                                    Resetar estado do atendimento
                                  </span>
                                </label>
                              </div>
                            </div>

                            {/* Action Buttons */}
                            <div className="flex gap-3">
                              <button
                                onClick={handleResetMemory}
                                disabled={isResettingMemory || isWipingAll || (!selectedSupervisorForReset && !selectedSellerForReset && !selectedClientForReset)}
                                className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center justify-center gap-2"
                              >
                                {isResettingMemory ? (
                                  <>
                                    <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                                    Resetando...
                                  </>
                                ) : (
                                  <>
                                    <span className="material-icons-outlined text-lg">delete</span>
                                    Resetar Memória Selecionada
                                  </>
                                )}
                              </button>

                              <button
                                onClick={handleResetAllMemory}
                                disabled={isResettingMemory || isWipingAll}
                                className="px-6 py-3 bg-red-800 hover:bg-red-900 disabled:bg-red-400 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center gap-2"
                              >
                                {isResettingMemory ? (
                                  <>
                                    <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                                    Resetando...
                                  </>
                                ) : (
                                  <>
                                    <span className="material-icons-outlined text-lg">delete_forever</span>
                                    Resetar Tudo
                                  </>
                                )}
                              </button>
                            </div>

                            {/* Apagar todo o sistema */}
                            <div className="border-t border-red-200 dark:border-red-800 pt-4 mt-4">
                              <button
                                onClick={handleWipeAllData}
                                disabled={isResettingMemory || isWipingAll}
                                className="w-full px-6 py-3 bg-red-950 hover:bg-red-900 disabled:bg-red-900/50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-bold shadow-md border-2 border-red-800 transition-all flex items-center justify-center gap-2"
                              >
                                {isWipingAll ? (
                                  <>
                                    <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                                    Apagando todo o sistema...
                                  </>
                                ) : (
                                  <>
                                    <span className="material-icons-outlined text-lg">warning</span>
                                    Apagar todo o sistema (memória + atendimentos + clientes + pedidos de orçamento)
                                  </>
                                )}
                              </button>
                              <p className="text-xs text-red-600 dark:text-red-400 mt-2 text-center">
                                Remove TUDO: memória da IA, atendimentos, clientes e pedidos de orçamento. Irreversível.
                              </p>
                            </div>

                            {/* Warning */}
                            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                              <div className="flex items-start gap-2">
                                <span className="material-icons-outlined text-yellow-600 dark:text-yellow-400 text-lg">warning</span>
                                <div>
                                  <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300 mb-1">
                                    ⚠️ Atenção
                                  </p>
                                  <p className="text-xs text-yellow-700 dark:text-yellow-400">
                                    Esta ação é irreversível. Use apenas para testes. Dados apagados não podem ser recuperados.
                                  </p>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Queue Management Section */}
                        <div className="bg-orange-50 dark:bg-orange-900/10 rounded-xl border-2 border-orange-200 dark:border-orange-800 shadow-sm overflow-hidden">
                          <div className="p-6 border-b border-orange-200 dark:border-orange-800 bg-orange-100 dark:bg-orange-900/20">
                            <div className="flex items-center gap-3 mb-2">
                              <div className="w-12 h-12 bg-orange-100 dark:bg-orange-900/30 rounded-xl flex items-center justify-center">
                                <span className="material-icons-outlined text-orange-600 dark:text-orange-400">queue</span>
                              </div>
                              <div>
                                <h2 className="text-xl font-bold text-orange-800 dark:text-orange-300" style={{ fontWeight: 700 }}>
                                  🗂️ Gerenciar Fila RabbitMQ
                                </h2>
                                <p className="text-sm text-orange-600 dark:text-orange-400">
                                  Limpe a fila quando a IA estiver desligada para evitar processar mensagens antigas
                                </p>
                              </div>
                            </div>
                          </div>
                          
                          <div className="p-6 space-y-6">
                            {/* Queue Statistics */}
                            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
                              <div className="flex items-center justify-between mb-4">
                                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                                  Estatísticas das Filas
                                </h3>
                                <button
                                  onClick={loadQueueStats}
                                  disabled={isLoadingQueueStats}
                                  className="px-3 py-1.5 text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded transition-all flex items-center gap-1"
                                >
                                  <span className={`material-icons-outlined text-sm ${isLoadingQueueStats ? 'animate-spin' : ''}`}>
                                    refresh
                                  </span>
                                  Atualizar
                                </button>
                              </div>
                              
                              {isLoadingQueueStats ? (
                                <div className="flex items-center justify-center py-4">
                                  <span className="material-icons-outlined text-slate-400 animate-spin">refresh</span>
                                  <span className="ml-2 text-sm text-slate-500">Carregando estatísticas...</span>
                                </div>
                              ) : queueStats ? (
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                                    <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">AI Messages</p>
                                    <p className="text-lg font-bold text-blue-800 dark:text-blue-300">
                                      {queueStats.aiMessages}
                                    </p>
                                  </div>
                                  <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 border border-green-200 dark:border-green-800">
                                    <p className="text-xs text-green-600 dark:text-green-400 mb-1">AI Responses</p>
                                    <p className="text-lg font-bold text-green-800 dark:text-green-300">
                                      {queueStats.aiResponses}
                                    </p>
                                  </div>
                                  <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 border border-purple-200 dark:border-purple-800">
                                    <p className="text-xs text-purple-600 dark:text-purple-400 mb-1">Messages</p>
                                    <p className="text-lg font-bold text-purple-800 dark:text-purple-300">
                                      {queueStats.messages}
                                    </p>
                                  </div>
                                  <div className="bg-gray-50 dark:bg-gray-900/20 rounded-lg p-3 border border-gray-200 dark:border-gray-800">
                                    <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">Notifications</p>
                                    <p className="text-lg font-bold text-gray-800 dark:text-gray-300">
                                      {queueStats.notifications}
                                    </p>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">
                                  Clique em "Atualizar" para ver as estatísticas
                                </p>
                              )}
                            </div>

                            {/* Purge Queue Button */}
                            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
                              <div className="flex items-center justify-between">
                                <div>
                                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                                    Limpar Fila AI Messages
                                  </h3>
                                  <p className="text-xs text-slate-500 dark:text-slate-400">
                                    Remove todas as mensagens pendentes na fila. Útil quando a IA ficou desligada.
                                  </p>
                                  {queueStats && (
                                    <p className="text-xs text-orange-600 dark:text-orange-400 mt-2">
                                      ⚠️ {queueStats.aiMessages} mensagens aguardando processamento
                                    </p>
                                  )}
                                </div>
                                <button
                                  onClick={handlePurgeQueue}
                                  disabled={isPurgingQueue || (queueStats && queueStats.aiMessages === 0)}
                                  className="px-6 py-3 bg-orange-600 hover:bg-orange-700 disabled:bg-orange-300 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center gap-2"
                                >
                                  {isPurgingQueue ? (
                                    <>
                                      <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                                      Limpando...
                                    </>
                                  ) : (
                                    <>
                                      <span className="material-icons-outlined text-lg">delete_sweep</span>
                                      Limpar Fila
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>

                            {/* Info */}
                            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                              <div className="flex items-start gap-2">
                                <span className="material-icons-outlined text-blue-600 dark:text-blue-400 text-lg">info</span>
                                <div>
                                  <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1">
                                    💡 Quando usar
                                  </p>
                                  <ul className="text-xs text-blue-700 dark:text-blue-400 space-y-1 list-disc list-inside">
                                    <li>IA ficou desligada por um período</li>
                                    <li>Mensagens antigas não são mais relevantes</li>
                                    <li>Quer começar processamento do zero</li>
                                    <li>Evitar processar mensagens acumuladas de uma vez</li>
                                  </ul>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Row 3: Auto Reopen and Subdivision Inactivity Timeouts */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <AutoReopenTimeout
                          autoReopenTimeoutMinutes={autoReopenTimeoutMinutes}
                          setAutoReopenTimeoutMinutes={setAutoReopenTimeoutMinutes}
                          isLoadingAutoReopen={isLoadingAutoReopen}
                          isSavingAutoReopen={isSavingAutoReopen}
                          onSaveAutoReopen={handleSaveAutoReopenTimeout}
                        />
                        <SubdivisionInactivityTimeouts
                          subdivisionInactivityTimeouts={subdivisionInactivityTimeouts}
                          setSubdivisionInactivityTimeouts={setSubdivisionInactivityTimeouts}
                          isLoadingSubdivisionTimeouts={isLoadingSubdivisionTimeouts}
                          isSavingSubdivisionTimeouts={isSavingSubdivisionTimeouts}
                          onSaveSubdivisionTimeouts={handleSaveSubdivisionInactivityTimeouts}
                        />
                      </div>

                      {/* Row 4: Follow-up Config (tempos e mensagens de follow-up por inatividade) */}
                      <FollowUpConfigTab
                        followUpConfig={followUpConfig}
                        setFollowUpConfig={setFollowUpConfig}
                        isLoading={isLoadingFollowUp}
                        isSaving={isSavingFollowUp}
                        onSave={handleSaveFollowUpConfig}
                      />

                      {/* Row 5: Follow-up Movement Config (movimentação entre divisões) */}
                      <FollowUpMovementConfigTab
                        config={followUpMovementConfig}
                        setConfig={setFollowUpMovementConfig}
                        isLoading={isLoadingFollowUpMovement}
                        isSaving={isSavingFollowUpMovement}
                        onSave={handleSaveFollowUpMovementConfig}
                      />
                    </div>
                  </div>
                )}

                {/* Tab Content */}
                <div className={`w-full flex-1 flex flex-col min-h-0 ${aiConfigMode === 'agent' ? '' : 'space-y-4'}`}>
                  {/* Agente Mode: Prompt + Modelo + Temperatura */}
                  {aiConfigMode === 'agent' && (
                    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden flex flex-col flex-1 min-h-0" style={{ backgroundColor: '#FFFFFF' }}>
                      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#FEE4E2' }}>
                              <span className="material-icons-outlined text-primary text-base" style={{ color: '#F07000' }}>psychology</span>
                            </div>
                            <div>
                              <h2 className="text-lg font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>Agente único</h2>
                              <p className="text-xs text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                Configure prompt, modelo e temperatura do agente de IA
                              </p>
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              // Force reload data before opening modal
                              reloadModalData();
                              setShowImportBibliotecaModal(true);
                            }}
                            className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all"
                            style={{ backgroundColor: '#F07000' }}
                          >
                            <span className="material-icons-outlined text-sm">import_export</span>
                            Importar da Biblioteca
                          </button>
                        </div>
                      </div>
                      {isLoadingConfig ? (
                        <div className="flex items-center justify-center py-8 flex-1">
                          <span className="material-icons-outlined text-slate-400 animate-spin" style={{ color: '#94A3B8' }}>refresh</span>
                          <span className="ml-2 text-slate-500" style={{ color: '#64748B' }}>Carregando configurações...</span>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 p-3 flex-1 min-h-0 overflow-hidden">
                          {/* Left Column: Prompt */}
                          <div className="lg:col-span-3 flex flex-col h-full min-h-0 overflow-hidden">
                            <div className="flex items-center justify-between mb-1 flex-shrink-0">
                              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300" style={{ color: '#475569' }}>
                                Prompt XML do Agente
                              </label>
                              {agentPromptBibliotecaId ? (
                                <button
                                  onClick={async () => {
                                    if (window.confirm('Remover este prompt da biblioteca?')) {
                                      try {
                                        await bibliotecaService.deletePrompt(agentPromptBibliotecaId);
                                        setAgentPromptBibliotecaId(null);
                                        setBibliotecaPrompts((prev) => prev.filter((p) => p.id !== agentPromptBibliotecaId));
                                        toast.success('Prompt removido da biblioteca.');
                                      } catch (error: any) {
                                        console.error('Error deleting prompt from biblioteca:', error);
                                        toast.error('Erro ao remover prompt da biblioteca');
                                      }
                                    }
                                  }}
                                  className="px-3 py-1.5 text-xs bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg transition-all flex items-center gap-1.5 font-medium"
                                  title="Remover da biblioteca"
                                >
                                  <span className="material-icons-outlined text-sm">delete_outline</span>
                                  Remover da Biblioteca
                                </button>
                              ) : (
                                <button
                                  onClick={() => {
                                    setSaveAgentPromptName('');
                                    setSaveAgentPromptFolderId('');
                                    setShowSaveAgentPromptModal(true);
                                  }}
                                  className="px-3 py-1.5 text-xs bg-primary/10 hover:bg-primary/20 text-primary rounded-lg transition-all flex items-center gap-1.5 font-medium"
                                  style={{ backgroundColor: '#FEE4E2', color: '#F07000' }}
                                  title="Salvar na biblioteca"
                                >
                                  <span className="material-icons-outlined text-sm">save</span>
                                  Salvar na Biblioteca
                                </button>
                              )}
                            </div>
                            <textarea
                              value={agentPrompt}
                              onChange={(e) => setAgentPrompt(e.target.value)}
                              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-mono text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-none flex-1 min-h-0"
                              style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                              placeholder="Cole o prompt XML aqui..."
                            />
                            
                            {/* Function Calls Section - Horizontal below prompt */}
                            <div className="mt-1.5 flex-shrink-0" style={{ maxHeight: '150px' }}>
                              <div className="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
                                <div className="px-2 py-1.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                                  <div className="flex items-center gap-1.5">
                                    <h3 className="text-xs font-semibold text-slate-900 dark:text-white" style={{ color: '#0F172A' }}>
                                      Function Calls
                                    </h3>
                                    <span className="text-xs text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                      ({agentFunctionCalls.length})
                                    </span>
                                  </div>
                                  <button
                                    onClick={() => {
                                      // Reset form
                                      setAgentFCName('');
                                      setAgentFCObjective('');
                                      setAgentFCTriggerConditions('');
                                      setAgentFCExecutionTiming('');
                                      setAgentFCRequiredFields('');
                                      setAgentFCOptionalFields('');
                                      setAgentFCRestrictions('');
                                      setAgentFCProcessingNotes('');
                                      setAgentFCIsActive(true);
                                      setAgentFCHasOutput(false);
                                      setAgentFCProcessingMethod('RABBITMQ');
                                      setAgentFCCustomAttributes([]);
                                      setShowCreateAgentFCModal(true);
                                    }}
                                    className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-all"
                                    title="Criar Function Call"
                                  >
                                    <span className="material-icons-outlined text-primary text-base" style={{ color: '#F07000' }}>add</span>
                                  </button>
                                </div>
                                <div className="p-2 overflow-x-auto overflow-y-hidden" style={{ maxHeight: '120px' }}>
                                  {agentFunctionCalls.length === 0 ? (
                                    <div className="flex items-center justify-center py-1.5 text-center">
                                      <p className="text-xs text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                        Nenhuma function call configurada. Importe da biblioteca ou crie novas.
                                      </p>
                                    </div>
                                  ) : (
                                    <div className="flex gap-1.5 overflow-x-auto pb-1.5" style={{ maxHeight: '110px' }}>
                                      {agentFunctionCalls.map((fc) => (
                                        <div
                                          key={fc.id}
                                          className="bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-1.5 hover:shadow-sm transition-all flex-shrink-0 min-w-[170px] max-w-[210px]"
                                          style={{ backgroundColor: fc.isActive ? '#F8FAFC' : '#F1F5F9' }}
                                        >
                                          <div className="flex items-start justify-between gap-2 mb-2">
                                            <div className="flex-1 min-w-0">
                                              <p className="text-xs font-medium text-slate-900 dark:text-white truncate" style={{ color: '#0F172A' }}>
                                                {fc.name}
                                              </p>
                                              {fc.objective && (
                                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2" style={{ color: '#64748B' }}>
                                                  {fc.objective}
                                                </p>
                                              )}
                                            </div>
                                            <div className="flex items-center gap-1 flex-shrink-0">
                                              <button
                                                onClick={() => setAgentFunctionCalls((prev) => prev.map((f) => (f.id === fc.id ? { ...f, isActive: !f.isActive } : f)))}
                                                className={`p-0.5 rounded transition-all ${fc.isActive ? 'text-green-600 hover:bg-green-50' : 'text-slate-400 hover:bg-slate-100'}`}
                                                title={fc.isActive ? 'Desabilitar' : 'Habilitar'}
                                              >
                                                <span className="material-icons-outlined text-xs">{fc.isActive ? 'toggle_on' : 'toggle_off'}</span>
                                              </button>
                                              <button
                                                onClick={() => setEditingAgentFCId(fc.id)}
                                                className="p-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 hover:text-slate-700 transition-all"
                                                title="Editar"
                                              >
                                                <span className="material-icons-outlined text-xs">edit</span>
                                              </button>
                                              <button
                                                onClick={() => {
                                                  if (fc.bibliotecaId) {
                                                    // Remover da biblioteca
                                                    if (window.confirm(`Remover "${fc.name}" da biblioteca?`)) {
                                                      setBibliotecaFunctionCalls((prev) => prev.filter((f) => f.id !== fc.bibliotecaId));
                                                      setAgentFunctionCalls((prev) => prev.map((f) => (f.id === fc.id ? { ...f, bibliotecaId: undefined } : f)));
                                                      toast.success('Removida da biblioteca.');
                                                    }
                                                  } else {
                                                    // Adicionar à biblioteca
                                                    setAddFCToBibliotecaId(fc.id);
                                                    setAddFCToBibliotecaName(fc.name);
                                                    setAddFCToBibliotecaFolderId('');
                                                    setShowAddFCToBibliotecaModal(true);
                                                  }
                                                }}
                                                className={`p-0.5 rounded transition-all ${
                                                  fc.bibliotecaId 
                                                    ? 'hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 hover:text-red-700' 
                                                    : 'hover:bg-primary/10 text-primary hover:text-primary/80'
                                                }`}
                                                title={fc.bibliotecaId ? 'Remover da biblioteca' : 'Adicionar à biblioteca'}
                                              >
                                                <span className="material-icons-outlined text-xs">{fc.bibliotecaId ? 'delete_outline' : 'add_circle'}</span>
                                              </button>
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-1 mt-2 pt-2 border-t border-slate-200 dark:border-slate-700">
                                            <button
                                              onClick={() => {
                                                if (window.confirm(`Remover a function call "${fc.name}" do agente?`)) {
                                                  setAgentFunctionCalls((prev) => prev.filter((f) => f.id !== fc.id));
                                                  toast.success('Function call removida do agente.');
                                                }
                                              }}
                                              className="flex-1 px-1.5 py-1 text-xs bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded transition-all flex items-center justify-center gap-1"
                                              title="Remover do agente"
                                            >
                                              <span className="material-icons-outlined text-xs">remove_circle</span>
                                              Remover do Agente
                                            </button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                            
                            <div className="flex items-center justify-between mt-1.5 flex-shrink-0">
                              <p className="text-xs text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                O prompt define como a IA se comporta e responde aos clientes
                              </p>
                              <button
                                onClick={async () => {
                                  setIsSavingConfig(true);
                                  try {
                                    await aiConfigService.updateAgentPrompt(agentPrompt);
                                    toast.success('Prompt do agente atualizado com sucesso!');
                                  } catch (error: any) {
                                    console.error('Error updating agent prompt:', error);
                                    toast.error(error.response?.data?.error || 'Erro ao atualizar prompt do agente');
                                  } finally {
                                    setIsSavingConfig(false);
                                  }
                                }}
                                disabled={isSavingConfig}
                                className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-primary/50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold shadow-sm transition-all flex items-center gap-1.5"
                                style={{ backgroundColor: '#F07000' }}
                              >
                                {isSavingConfig ? (
                                  <>
                                    <span className="material-icons-outlined text-sm animate-spin">refresh</span>
                                    Salvando...
                                  </>
                                ) : (
                                  <>
                                    <span className="material-icons-outlined text-sm">save</span>
                                    Salvar Prompt do Agente
                                  </>
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Right Column: Model and Temperature */}
                          <div className="lg:col-span-2 flex flex-col h-full min-h-0 overflow-hidden">
                            {/* Seção Modelo */}
                            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden mb-2.5" style={{ backgroundColor: '#FFFFFF', flex: '0 0 auto' }}>
                              <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800">
                                <h3 className="text-xs font-semibold text-slate-900 dark:text-white" style={{ color: '#0F172A' }}>Modelo OpenAI</h3>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5" style={{ color: '#64748B' }}>
                                  Escolha o modelo usado pelo agente. O worker aplica na próxima mensagem.
                                </p>
                              </div>
                              <div className="p-2.5">
                                {isLoadingModel ? (
                                  <div className="flex items-center justify-center py-8">
                                    <span className="material-icons-outlined text-slate-400 animate-spin">refresh</span>
                                    <span className="ml-2 text-sm text-slate-500">Carregando...</span>
                                  </div>
                                ) : (
                                  <>
                                    <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-2" style={{ backgroundColor: '#F8FAFC' }}>
                                      <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1" style={{ color: '#475569' }}>
                                        Modelo
                                      </label>
                                      <select
                                        value={openaiModel ?? ''}
                                        onChange={(e) => setOpenaiModel(e.target.value || null)}
                                        className="w-full px-2 py-1.5 text-[11px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary"
                                        style={{ borderColor: '#E2E8F0' }}
                                      >
                                        <option value="">Usar modelo do .env (fallback)</option>
                                        {openaiModel && !OPENAI_MODELS.some((m) => m.id === openaiModel) && (
                                          <option value={openaiModel}>{openaiModel} (atual)</option>
                                        )}
                                        {OPENAI_MODELS.map((m) => (
                                          <option key={m.id} value={m.id}>
                                            {m.label} — {m.desc}
                                          </option>
                                        ))}
                                      </select>
                                      {openaiModel && (
                                        <p className="text-[11px] text-slate-500 mt-1" style={{ color: '#64748B' }}>
                                          Atual: <strong>{openaiModel}</strong>
                                        </p>
                                      )}
                                    </div>
                                    <div className="flex gap-2 pt-1.5">
                                      <button
                                        onClick={handleSaveModel}
                                        disabled={isSavingModel || !openaiModel || !openaiModel.trim()}
                                        className="flex-1 px-3 py-1.5 bg-primary hover:bg-primary/90 disabled:bg-primary/50 disabled:cursor-not-allowed text-white rounded-lg text-[11px] font-semibold shadow-sm transition-all flex items-center justify-center gap-1"
                                        style={{ backgroundColor: '#F07000', opacity: isSavingModel ? 0.7 : 1 }}
                                      >
                                        {isSavingModel ? (
                                          <>
                                            <span className="material-icons-outlined text-xs animate-spin">refresh</span>
                                            Salvando...
                                          </>
                                        ) : (
                                          <>
                                            <span className="material-icons-outlined text-xs">save</span>
                                            Salvar modelo
                                          </>
                                        )}
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Seção Temperatura */}
                            <TemperatureConfigTab
                              temperature={temperature}
                              setTemperature={setTemperature}
                              isLoadingTemperature={isLoadingTemperature}
                              isSavingTemperature={isSavingTemperature}
                              setIsSavingTemperature={setIsSavingTemperature}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Import from Biblioteca Modal */}
                  {showImportBibliotecaModal && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col" style={{ backgroundColor: '#FFFFFF' }}>
                        <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center" style={{ backgroundColor: '#FEE4E2' }}>
                                <span className="material-icons-outlined text-primary" style={{ color: '#F07000' }}>import_export</span>
                              </div>
                              <div>
                                <h2 className="text-xl font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>
                                  Importar da Biblioteca
                                </h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                  Selecione prompts e function calls para importar para o prompt do agente
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => {
                                setShowImportBibliotecaModal(false);
                                setSelectedPromptsToImport([]);
                                setSelectedFunctionCallsToImport([]);
                              }}
                              className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-all"
                            >
                              <span className="material-icons-outlined text-slate-500 dark:text-slate-400">close</span>
                            </button>
                          </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6">
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            {/* Prompts Section */}
                            <div className="flex flex-col">
                              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4" style={{ color: '#0F172A' }}>
                                Prompts ({modalPrompts.length})
                              </h3>
                              {modalPrompts.length === 0 ? (
                                <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                  Nenhum prompt disponível na biblioteca
                                </p>
                              ) : (
                                <div className="space-y-2 flex-1 overflow-y-auto max-h-[60vh]">
                                  {modalPrompts.map((prompt) => (
                                    <label
                                      key={prompt.id}
                                      className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition-all"
                                      style={{ backgroundColor: selectedPromptsToImport.includes(prompt.id) ? '#FEE4E2' : '#F8FAFC' }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selectedPromptsToImport.includes(prompt.id)}
                                        onChange={(e) => {
                                          if (e.target.checked) {
                                            setSelectedPromptsToImport([...selectedPromptsToImport, prompt.id]);
                                          } else {
                                            setSelectedPromptsToImport(selectedPromptsToImport.filter((id) => id !== prompt.id));
                                          }
                                        }}
                                        className="mt-1 w-4 h-4 text-primary border-slate-300 rounded focus:ring-primary"
                                        style={{ accentColor: '#F07000' }}
                                      />
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-slate-900 dark:text-white" style={{ color: '#0F172A' }}>
                                          {prompt.name}
                                        </p>
                                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2" style={{ color: '#64748B' }}>
                                          {prompt.content.substring(0, 100)}...
                                        </p>
                                      </div>
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Function Calls Section */}
                            <div className="flex flex-col">
                              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4" style={{ color: '#0F172A' }}>
                                Function Calls ({modalFunctionCalls.length})
                              </h3>
                              {modalFunctionCalls.length === 0 ? (
                                <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                  Nenhuma function call disponível na biblioteca
                                </p>
                              ) : (
                                <div className="space-y-2 flex-1 overflow-y-auto max-h-[60vh]">
                                  {modalFunctionCalls.map((fc) => (
                                    <label
                                      key={fc.id}
                                      className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition-all"
                                      style={{ backgroundColor: selectedFunctionCallsToImport.includes(fc.id) ? '#FEE4E2' : '#F8FAFC' }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selectedFunctionCallsToImport.includes(fc.id)}
                                        onChange={(e) => {
                                          if (e.target.checked) {
                                            setSelectedFunctionCallsToImport([...selectedFunctionCallsToImport, fc.id]);
                                          } else {
                                            setSelectedFunctionCallsToImport(selectedFunctionCallsToImport.filter((id) => id !== fc.id));
                                          }
                                        }}
                                        className="mt-1 w-4 h-4 text-primary border-slate-300 rounded focus:ring-primary"
                                        style={{ accentColor: '#F07000' }}
                                      />
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-slate-900 dark:text-white" style={{ color: '#0F172A' }}>
                                          {fc.name}
                                        </p>
                                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2" style={{ color: '#64748B' }}>
                                          {fc.objective || 'Sem descrição'}
                                        </p>
                                      </div>
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex-shrink-0 flex items-center justify-end gap-3">
                          <button
                            onClick={() => {
                              setShowImportBibliotecaModal(false);
                              setSelectedPromptsToImport([]);
                              setSelectedFunctionCallsToImport([]);
                              // Clear modal data when closing
                              setModalPrompts([]);
                              setModalFunctionCalls([]);
                            }}
                            className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-sm font-medium transition-all"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={() => {
                              const promptsToImport = modalPrompts.filter((p) => selectedPromptsToImport.includes(p.id));
                              const functionCallsToImport = modalFunctionCalls.filter((fc) => selectedFunctionCallsToImport.includes(fc.id));

                              // Helper function to extract clean content (remove XML comments and markers)
                              const extractCleanContent = (content: string): string => {
                                // Remove XML comments like <!-- ... -->
                                let clean = content.replace(/<!--[\s\S]*?-->/g, '');
                                // Remove multiple empty lines
                                clean = clean.replace(/\n\s*\n\s*\n/g, '\n\n');
                                // Trim whitespace
                                return clean.trim();
                              };

                              let importText = '';

                              // Add prompts - only clean content, no markers
                              if (promptsToImport.length > 0) {
                                promptsToImport.forEach((prompt) => {
                                  const cleanContent = extractCleanContent(prompt.content);
                                  if (cleanContent) {
                                    importText += `${cleanContent}\n\n`;
                                  }
                                });
                              }

                              // Add function calls - only clean content, no markers
                              if (functionCallsToImport.length > 0) {
                                functionCallsToImport.forEach((fc) => {
                                  let fcContent = '';
                                  if (fc.objective) fcContent += `${fc.objective}\n`;
                                  if (fc.triggerConditions) fcContent += `${fc.triggerConditions}\n`;
                                  if (fc.executionTiming) fcContent += `${fc.executionTiming}\n`;
                                  if (fc.requiredFields) fcContent += `${fc.requiredFields}\n`;
                                  if (fc.optionalFields) fcContent += `${fc.optionalFields}\n`;
                                  if (fc.restrictions) fcContent += `${fc.restrictions}\n`;
                                  if (fc.processingNotes) fcContent += `${fc.processingNotes}\n`;
                                  
                                  const cleanContent = extractCleanContent(fcContent);
                                  if (cleanContent) {
                                    importText += `${cleanContent}\n\n`;
                                  }
                                });
                              }

                              // Validate selection
                              if (promptsToImport.length === 0 && functionCallsToImport.length === 0) {
                                toast.error('Selecione pelo menos um item para importar');
                                return;
                              }

                              // Import prompts to agent prompt text
                              if (promptsToImport.length > 0) {
                                const promptsText = promptsToImport.map((p) => {
                                  const cleanContent = extractCleanContent(p.content);
                                  return cleanContent;
                                }).filter(Boolean).join('\n\n');
                                
                                if (promptsText) {
                                  setAgentPrompt((prev) => (prev ? `${prev}\n\n${promptsText}` : promptsText));
                                }
                              }
                              
                              // Import function calls to agent function calls list
                              if (functionCallsToImport.length > 0) {
                                const newFunctionCalls: AgentFunctionCall[] = functionCallsToImport.map((fc) => ({
                                  id: uuidv4(),
                                  name: fc.name,
                                  objective: fc.objective || '',
                                  triggerConditions: fc.triggerConditions || '',
                                  executionTiming: fc.executionTiming || '',
                                  requiredFields: fc.requiredFields || '',
                                  optionalFields: fc.optionalFields || '',
                                  restrictions: fc.restrictions || '',
                                  processingNotes: fc.processingNotes || '',
                                  isActive: fc.isActive ?? true,
                                  hasOutput: fc.hasOutput ?? false,
                                  processingMethod: fc.processingMethod || 'RABBITMQ',
                                  customAttributes: fc.customAttributes || {},
                                  bibliotecaId: fc.id, // Store reference to biblioteca item
                                }));
                                
                                setAgentFunctionCalls((prev) => [...prev, ...newFunctionCalls]);
                              }
                              
                              toast.success(`${promptsToImport.length} prompt(s) e ${functionCallsToImport.length} function call(s) importados com sucesso!`);

                              setShowImportBibliotecaModal(false);
                              setSelectedPromptsToImport([]);
                              setSelectedFunctionCallsToImport([]);
                              // Clear modal data when closing
                              setModalPrompts([]);
                              setModalFunctionCalls([]);
                            }}
                            disabled={selectedPromptsToImport.length === 0 && selectedFunctionCallsToImport.length === 0}
                            className="px-6 py-2.5 bg-primary hover:bg-primary/90 disabled:bg-primary/50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center gap-2"
                            style={{ backgroundColor: '#F07000', opacity: (selectedPromptsToImport.length === 0 && selectedFunctionCallsToImport.length === 0) ? 0.5 : 1 }}
                          >
                            <span className="material-icons-outlined text-lg">import_export</span>
                            Importar ({selectedPromptsToImport.length + selectedFunctionCallsToImport.length})
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Create/Edit Agent Function Call Modal */}
                  {(showCreateAgentFCModal || editingAgentFCId) && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" style={{ backgroundColor: '#FFFFFF' }}>
                        <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center" style={{ backgroundColor: '#FEE4E2' }}>
                                <span className="material-icons-outlined text-primary" style={{ color: '#F07000' }}>code</span>
                              </div>
                              <div>
                                <h2 className="text-xl font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>
                                  {editingAgentFCId ? 'Editar Function Call' : 'Criar Function Call'}
                                </h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                  {editingAgentFCId ? 'Edite os detalhes da function call do agente' : 'Configure uma nova function call para o agente'}
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => {
                                const resetForm = () => {
                                  setAgentFCName('');
                                  setAgentFCObjective('');
                                  setAgentFCTriggerConditions('');
                                  setAgentFCExecutionTiming('');
                                  setAgentFCRequiredFields('');
                                  setAgentFCOptionalFields('');
                                  setAgentFCRestrictions('');
                                  setAgentFCProcessingNotes('');
                                  setAgentFCIsActive(true);
                                  setAgentFCHasOutput(false);
                                  setAgentFCProcessingMethod('RABBITMQ');
                                  setAgentFCCustomAttributes([]);
                                };
                                resetForm();
                                setShowCreateAgentFCModal(false);
                                setEditingAgentFCId(null);
                              }}
                              className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-all"
                            >
                              <span className="material-icons-outlined text-slate-500 dark:text-slate-400">close</span>
                            </button>
                          </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                          <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                              Nome *
                            </label>
                            <input
                              type="text"
                              value={agentFCName}
                              onChange={(e) => setAgentFCName(e.target.value)}
                              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                              style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                              placeholder="Nome da function call"
                            />
                          </div>

                          <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                              Objetivo
                            </label>
                            <textarea
                              value={agentFCObjective}
                              onChange={(e) => setAgentFCObjective(e.target.value)}
                              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-y"
                              style={{ backgroundColor: '#FFFFFF', color: '#0F172A', minHeight: '80px' }}
                              placeholder="Objetivo da function call"
                            />
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                                Quando Acionar
                              </label>
                              <textarea
                                value={agentFCTriggerConditions}
                                onChange={(e) => setAgentFCTriggerConditions(e.target.value)}
                                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-y"
                                style={{ backgroundColor: '#FFFFFF', color: '#0F172A', minHeight: '60px' }}
                                placeholder="Condições de acionamento"
                              />
                            </div>

                            <div>
                              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                                Momento de Execução
                              </label>
                              <textarea
                                value={agentFCExecutionTiming}
                                onChange={(e) => setAgentFCExecutionTiming(e.target.value)}
                                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-y"
                                style={{ backgroundColor: '#FFFFFF', color: '#0F172A', minHeight: '60px' }}
                                placeholder="Momento de execução"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                                Campos Obrigatórios
                              </label>
                              <input
                                type="text"
                                value={agentFCRequiredFields}
                                onChange={(e) => setAgentFCRequiredFields(e.target.value)}
                                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                                style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                                placeholder="Separados por vírgula"
                              />
                            </div>

                            <div>
                              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                                Campos Opcionais
                              </label>
                              <input
                                type="text"
                                value={agentFCOptionalFields}
                                onChange={(e) => setAgentFCOptionalFields(e.target.value)}
                                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                                style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                                placeholder="Separados por vírgula"
                              />
                            </div>
                          </div>

                          <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                              Restrições
                            </label>
                            <textarea
                              value={agentFCRestrictions}
                              onChange={(e) => setAgentFCRestrictions(e.target.value)}
                              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-y"
                              style={{ backgroundColor: '#FFFFFF', color: '#0F172A', minHeight: '60px' }}
                              placeholder="Restrições e limitações"
                            />
                          </div>

                          <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                              Notas de Processamento
                            </label>
                            <textarea
                              value={agentFCProcessingNotes}
                              onChange={(e) => setAgentFCProcessingNotes(e.target.value)}
                              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-y"
                              style={{ backgroundColor: '#FFFFFF', color: '#0F172A', minHeight: '60px' }}
                              placeholder="Notas sobre o processamento"
                            />
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="flex items-center gap-2">
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={agentFCIsActive}
                                  onChange={(e) => setAgentFCIsActive(e.target.checked)}
                                  className="sr-only peer"
                                />
                                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" style={{ backgroundColor: agentFCIsActive ? '#F07000' : '#E2E8F0' }}></div>
                              </label>
                              <span className="text-sm text-slate-700 dark:text-slate-300" style={{ color: '#475569' }}>
                                Ativa
                              </span>
                            </div>

                            <div className="flex items-center gap-2">
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={agentFCHasOutput}
                                  onChange={(e) => setAgentFCHasOutput(e.target.checked)}
                                  className="sr-only peer"
                                />
                                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" style={{ backgroundColor: agentFCHasOutput ? '#F07000' : '#E2E8F0' }}></div>
                              </label>
                              <span className="text-sm text-slate-700 dark:text-slate-300" style={{ color: '#475569' }}>
                                Usar resposta no atendimento
                              </span>
                            </div>

                            <div>
                              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                                Método de Processamento
                              </label>
                              <select
                                value={agentFCProcessingMethod}
                                onChange={(e) => setAgentFCProcessingMethod(e.target.value as 'RABBITMQ' | 'HTTP')}
                                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                                style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                              >
                                <option value="RABBITMQ">RabbitMQ</option>
                                <option value="HTTP" disabled style={{ opacity: 0.5 }}>HTTP Request (Em breve)</option>
                              </select>
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300" style={{ color: '#475569' }}>
                                Atributos Personalizados
                              </label>
                              <button
                                onClick={() => setAgentFCCustomAttributes((prev) => [...prev, { key: '', value: '' }])}
                                className="px-2 py-1 text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded transition-all"
                              >
                                <span className="material-icons-outlined text-sm">add</span> Adicionar
                              </button>
                            </div>
                            <div className="space-y-2">
                              {agentFCCustomAttributes.map((attr, idx) => (
                                <div key={idx} className="flex items-center gap-2">
                                  <input
                                    type="text"
                                    value={attr.key}
                                    onChange={(e) => setAgentFCCustomAttributes((prev) => prev.map((a, i) => (i === idx ? { ...a, key: e.target.value } : a)))}
                                    placeholder="Chave"
                                    className="flex-1 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                                    style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                                  />
                                  <input
                                    type="text"
                                    value={attr.value}
                                    onChange={(e) => setAgentFCCustomAttributes((prev) => prev.map((a, i) => (i === idx ? { ...a, value: e.target.value } : a)))}
                                    placeholder="Valor"
                                    className="flex-1 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                                    style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                                  />
                                  <button
                                    onClick={() => setAgentFCCustomAttributes((prev) => prev.filter((_, i) => i !== idx))}
                                    className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/30 text-slate-500 hover:text-red-600 rounded transition-all"
                                  >
                                    <span className="material-icons-outlined text-sm">delete_outline</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                            <button
                              onClick={() => {
                                const resetForm = () => {
                                  setAgentFCName('');
                                  setAgentFCObjective('');
                                  setAgentFCTriggerConditions('');
                                  setAgentFCExecutionTiming('');
                                  setAgentFCRequiredFields('');
                                  setAgentFCOptionalFields('');
                                  setAgentFCRestrictions('');
                                  setAgentFCProcessingNotes('');
                                  setAgentFCIsActive(true);
                                  setAgentFCHasOutput(false);
                                  setAgentFCProcessingMethod('RABBITMQ');
                                  setAgentFCCustomAttributes([]);
                                };
                                resetForm();
                                setShowCreateAgentFCModal(false);
                                setEditingAgentFCId(null);
                              }}
                              className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-sm font-medium transition-all"
                            >
                              Cancelar
                            </button>
                            <button
                              onClick={() => {
                                if (!agentFCName.trim()) {
                                  toast.error('Informe o nome da function call.');
                                  return;
                                }

                                const editingFC = editingAgentFCId ? agentFunctionCalls.find((f) => f.id === editingAgentFCId) : null;
                                const fcData: AgentFunctionCall = {
                                  id: editingAgentFCId || uuidv4(),
                                  name: agentFCName.trim(),
                                  objective: agentFCObjective.trim(),
                                  triggerConditions: agentFCTriggerConditions.trim(),
                                  executionTiming: agentFCExecutionTiming.trim(),
                                  requiredFields: agentFCRequiredFields.trim(),
                                  optionalFields: agentFCOptionalFields.trim(),
                                  restrictions: agentFCRestrictions.trim(),
                                  processingNotes: agentFCProcessingNotes.trim(),
                                  isActive: agentFCIsActive,
                                  hasOutput: agentFCHasOutput,
                                  processingMethod: agentFCProcessingMethod,
                                  customAttributes: agentFCCustomAttributes.reduce<Record<string, string>>((acc, { key, value }) => {
                                    const k = key.trim();
                                    if (k) acc[k] = value;
                                    return acc;
                                  }, {}),
                                  bibliotecaId: editingFC?.bibliotecaId,
                                };

                                if (editingAgentFCId) {
                                  setAgentFunctionCalls((prev) => prev.map((f) => (f.id === editingAgentFCId ? fcData : f)));
                                  toast.success('Function call atualizada.');
                                } else {
                                  setAgentFunctionCalls((prev) => [...prev, fcData]);
                                  toast.success('Function call criada.');
                                }

                                const resetForm = () => {
                                  setAgentFCName('');
                                  setAgentFCObjective('');
                                  setAgentFCTriggerConditions('');
                                  setAgentFCExecutionTiming('');
                                  setAgentFCRequiredFields('');
                                  setAgentFCOptionalFields('');
                                  setAgentFCRestrictions('');
                                  setAgentFCProcessingNotes('');
                                  setAgentFCIsActive(true);
                                  setAgentFCHasOutput(false);
                                  setAgentFCProcessingMethod('RABBITMQ');
                                  setAgentFCCustomAttributes([]);
                                };
                                resetForm();
                                setShowCreateAgentFCModal(false);
                                setEditingAgentFCId(null);
                              }}
                              className="px-6 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center gap-2"
                              style={{ backgroundColor: '#F07000' }}
                            >
                              <span className="material-icons-outlined text-lg">save</span>
                              {editingAgentFCId ? 'Salvar Alterações' : 'Criar Function Call'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Add Function Call to Biblioteca Modal */}
                  {showAddFCToBibliotecaModal && addFCToBibliotecaId && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl max-w-md w-full overflow-hidden flex flex-col" style={{ backgroundColor: '#FFFFFF' }}>
                        <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center" style={{ backgroundColor: '#FEE4E2' }}>
                                <span className="material-icons-outlined text-primary" style={{ color: '#F07000' }}>add_circle</span>
                              </div>
                              <div>
                                <h2 className="text-xl font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>
                                  Adicionar à Biblioteca
                                </h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                                  Escolha o nome e a pasta para salvar a function call
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => {
                                setShowAddFCToBibliotecaModal(false);
                                setAddFCToBibliotecaId(null);
                                setAddFCToBibliotecaName('');
                                setAddFCToBibliotecaFolderId('');
                              }}
                              className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-all"
                            >
                              <span className="material-icons-outlined text-slate-500 dark:text-slate-400">close</span>
                            </button>
                          </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                          <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                              Nome *
                            </label>
                            <input
                              type="text"
                              value={addFCToBibliotecaName}
                              onChange={(e) => setAddFCToBibliotecaName(e.target.value)}
                              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                              style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                              placeholder="Nome da function call"
                            />
                          </div>

                          <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                              Pasta
                            </label>
                            <select
                              value={addFCToBibliotecaFolderId}
                              onChange={(e) => setAddFCToBibliotecaFolderId(e.target.value)}
                              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                              style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                            >
                              <option value="">Raiz (sem pasta)</option>
                              {(() => {
                                const getFolderPath = (folderId: string, folders: BibliotecaFolder[]): string => {
                                  const folder = folders.find((f) => f.id === folderId);
                                  if (!folder) return '';
                                  if (folder.parentId === null) return folder.name;
                                  const parentPath = getFolderPath(folder.parentId, folders);
                                  return parentPath ? `${parentPath} / ${folder.name}` : folder.name;
                                };

                                const renderFolderOptions = (parentId: string | null, level: number = 0): JSX.Element[] => {
                                  const children = bibliotecaFolders.filter((f) => f.parentId === parentId);
                                  const options: JSX.Element[] = [];
                                  
                                  children.forEach((folder) => {
                                    const path = getFolderPath(folder.id, bibliotecaFolders);
                                    const indent = '  '.repeat(level);
                                    options.push(
                                      <option key={folder.id} value={folder.id}>
                                        {indent}📁 {path}
                                      </option>
                                    );
                                    const subOptions = renderFolderOptions(folder.id, level + 1);
                                    options.push(...subOptions);
                                  });
                                  
                                  return options;
                                };

                                return renderFolderOptions(null);
                              })()}
                            </select>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1" style={{ color: '#64748B' }}>
                              Selecione a pasta onde a function call será salva
                            </p>
                          </div>

                          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                            <button
                              onClick={() => {
                                setShowAddFCToBibliotecaModal(false);
                                setAddFCToBibliotecaId(null);
                                setAddFCToBibliotecaName('');
                                setAddFCToBibliotecaFolderId('');
                              }}
                              className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-sm font-medium transition-all"
                            >
                              Cancelar
                            </button>
                            <button
                              onClick={() => {
                                if (!addFCToBibliotecaName.trim()) {
                                  toast.error('Informe o nome da function call.');
                                  return;
                                }

                                const fc = agentFunctionCalls.find((f) => f.id === addFCToBibliotecaId);
                                if (!fc) {
                                  toast.error('Function call não encontrada.');
                                  return;
                                }

                                const folderId = addFCToBibliotecaFolderId.trim() || null;
                                const newFC: BibliotecaFunctionCall = {
                                  id: uuidv4(),
                                  name: addFCToBibliotecaName.trim(),
                                  folderId,
                                  objective: fc.objective,
                                  triggerConditions: fc.triggerConditions,
                                  executionTiming: fc.executionTiming,
                                  requiredFields: fc.requiredFields,
                                  optionalFields: fc.optionalFields,
                                  restrictions: fc.restrictions,
                                  processingNotes: fc.processingNotes,
                                  isActive: fc.isActive,
                                  hasOutput: fc.hasOutput,
                                  processingMethod: fc.processingMethod,
                                  customAttributes: fc.customAttributes,
                                };
                                
                                setBibliotecaFunctionCalls((prev) => [...prev, newFC]);
                                setAgentFunctionCalls((prev) => prev.map((f) => (f.id === addFCToBibliotecaId ? { ...f, bibliotecaId: newFC.id } : f)));
                                toast.success('Function call adicionada à biblioteca.');
                                
                                setShowAddFCToBibliotecaModal(false);
                                setAddFCToBibliotecaId(null);
                                setAddFCToBibliotecaName('');
                                setAddFCToBibliotecaFolderId('');
                              }}
                              className="px-6 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center gap-2"
                              style={{ backgroundColor: '#F07000' }}
                            >
                              <span className="material-icons-outlined text-lg">save</span>
                              Adicionar à Biblioteca
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Geral mode: Buffer, Workflows, Ferramentas */}
                  {/* Function Calls removed - now only in Biblioteca */}

                  {/* Tools Tab */}

                  {/* Multi Agente Mode */}
                  {aiConfigMode === 'multi-agent' && <WorkflowTab />}

                  {/* Biblioteca: dashboard estilo Obsidian (árvore única + main) */}
                  {aiConfigMode === 'biblioteca' && (
                    <BibliotecaDashboard
                      isLoading={isLoadingBiblioteca}
                      folders={bibliotecaFolders}
                      prompts={bibliotecaPrompts}
                      functionCalls={bibliotecaFunctionCalls}
                      schemas={bibliotecaSchemas}
                      processes={bibliotecaProcesses}
                      selectedFolderId={bibliotecaSelectedFolderId}
                      selectedItem={bibliotecaSelectedItem}
                      collapsedFolderIds={bibliotecaCollapsedFolderIds}
                      editingFolderId={bibliotecaEditingFolderId}
                      copiedItem={bibliotecaCopiedItem}
                      onFoldersChange={setBibliotecaFolders}
                      onSelectFolder={setBibliotecaSelectedFolderId}
                      onSelectItem={setBibliotecaSelectedItem}
                      onToggleCollapse={toggleBibliotecaFolder}
                      onEditingFolderId={setBibliotecaEditingFolderId}
                      onEditFolderState={setEditFolderState}
                      getDescendantIds={getBibliotecaDescendantIds}
                      onOpenCreatePrompt={() => {
                        setCreatePromptFolderId(bibliotecaSelectedFolderId === '' || bibliotecaSelectedFolderId === null ? '' : bibliotecaSelectedFolderId || '');
                        setCreatePromptName('');
                        setCreatePromptContent('');
                        setShowCreatePromptModal(true);
                      }}
                      onOpenEditPrompt={handleOpenEditPrompt}
                      editPromptIdRequest={bibliotecaEditPromptIdRequest}
                      onClearEditPromptIdRequest={() => setBibliotecaEditPromptIdRequest(null)}
                      onUpdatePrompt={handleUpdatePromptInline}
                      onDeletePrompt={handleDeletePrompt}
                      onOpenCreateFunctionCall={() => {
                        setCreateFCFolderId(bibliotecaSelectedFolderId === '' || bibliotecaSelectedFolderId === null ? '' : bibliotecaSelectedFolderId || '');
                        setCreateFCName('');
                        setCreateFCObjective('');
                        setCreateFCTriggerConditions('');
                        setCreateFCExecutionTiming('');
                        setCreateFCRequiredFields('');
                        setCreateFCOptionalFields('');
                        setCreateFCRestrictions('');
                        setCreateFCProcessingNotes('');
                        setCreateFCHasOutput(false);
                        setCreateFCProcessingMethod('RABBITMQ');
                        setCreateFCCustomAttributes([]);
                        setShowCreateBibliotecaFunctionCallModal(true);
                      }}
                      onOpenEditFunctionCall={handleOpenEditBibliotecaFunctionCall}
                      editFCIdRequest={bibliotecaEditFCIdRequest}
                      onClearEditFCIdRequest={() => setBibliotecaEditFCIdRequest(null)}
                      onUpdateFunctionCall={handleUpdateFunctionCallInline}
                      onDeleteFunctionCall={handleDeleteBibliotecaFunctionCall}
                      onPaste={handlePaste}
                      onCopyPrompt={handleCopyPrompt}
                      onCopyFunctionCall={handleCopyFunctionCall}
                      onCopyFolder={handleCopyFolder}
                      onCreateSchema={handleOpenCreateSchemaModal}
                      onEditSchema={handleEditSchema}
                      onRenameSchema={handleOpenRenameSchema}
                      onUpdateSchema={handleUpdateSchema}
                      onDeleteSchema={handleDeleteSchema}
                      getFCProcessId={(name) => functionCallConfigs[name]?.processId ?? null}
                      onUpdateFCProcessId={async (name, processId) => {
                        try {
                          const process = processId ? bibliotecaProcesses.find((p) => p.id === processId) : null;
                          const { requiredFields: reqArr, optionalFields: optArr } = processToFCFieldsArrays(process);
                          await functionCallConfigService.updateConfig(name, {
                            processId,
                            ...(reqArr.length > 0 && { requiredFields: reqArr }),
                            ...(optArr.length > 0 && { optionalFields: optArr }),
                          });
                          const fc = bibliotecaFunctionCalls.find((f) => f.name === name);
                          if (fc && process) {
                            const { requiredFields: reqStr, optionalFields: optStr } = processToFCFields(process);
                            await bibliotecaService.updateFunctionCall(fc.id, {
                              requiredFields: reqStr,
                              optionalFields: optStr,
                            });
                            setBibliotecaFunctionCalls((prev) =>
                              prev.map((f) =>
                                f.name === name ? { ...f, requiredFields: reqStr, optionalFields: optStr } : f
                              )
                            );
                          } else if (fc && !processId) {
                            await bibliotecaService.updateFunctionCall(fc.id, {
                              requiredFields: '',
                              optionalFields: '',
                            });
                            setBibliotecaFunctionCalls((prev) =>
                              prev.map((f) => (f.name === name ? { ...f, requiredFields: '', optionalFields: '' } : f))
                            );
                          }
                          await loadFunctionCallConfigs();
                          toast.success(processId ? 'Processo vinculado. Campos sincronizados.' : 'Processo desvinculado.');
                        } catch (err: any) {
                          toast.error(err?.response?.data?.message || 'Erro ao atualizar processo');
                        }
                      }}
                      onDeleteProcess={async (process) => {
                        try {
                          await bibliotecaService.deleteProcess(process.id);
                          const list = await bibliotecaService.getAllProcesses();
                          setBibliotecaProcesses(list);
                          toast.success('Processo excluído.');
                        } catch (err: any) {
                          toast.error(err?.response?.data?.message || 'Erro ao excluir processo');
                        }
                      }}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Reset System Confirmation Modal */}
      {showResetModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowResetModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-md w-full mx-4" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-red-600 dark:text-red-400" style={{ color: '#DC2626', fontWeight: 700 }}>
                  <span className="material-icons-outlined inline-block mr-2 align-middle">warning</span>
                  Resetar Sistema Completo
                </h3>
                <button
                  onClick={() => setShowResetModal(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                >
                  <span className="material-icons-outlined">close</span>
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <p className="text-sm text-red-800 dark:text-red-200 font-medium mb-2">
                  ⚠️ ATENÇÃO: Esta ação é IRREVERSÍVEL!
                </p>
                <p className="text-sm text-red-700 dark:text-red-300">
                  Ao confirmar, todos os dados serão permanentemente apagados:
                </p>
                <ul className="text-sm text-red-700 dark:text-red-300 mt-2 ml-4 list-disc space-y-1">
                  <li>Todas as conexões do WhatsApp serão desconectadas</li>
                  <li>Todos os dados do banco de dados serão apagados</li>
                  <li>Todo o cache do Redis será limpo</li>
                  <li>Todos os usuários serão deletados (exceto você)</li>
                  <li>Todas as mensagens e atendimentos serão apagados</li>
                  <li>Todas as credenciais do Baileys serão removidas</li>
                </ul>
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setShowResetModal(false)}
                  className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                  style={{ color: '#475569' }}
                  disabled={isResetting}
                >
                  Cancelar
                </button>
                <button
                  onClick={handleResetSystem}
                  disabled={isResetting}
                  className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 disabled:bg-red-400 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center justify-center gap-2"
                >
                  {isResetting ? (
                    <>
                      <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                      Resetando...
                    </>
                  ) : (
                    <>
                      <span className="material-icons-outlined text-lg">delete_forever</span>
                      Confirmar Reset
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Salvar Prompt do Agente na Biblioteca */}
      {showSaveAgentPromptModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowSaveAgentPromptModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] flex flex-col" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Salvar Prompt na Biblioteca</h3>
              <button type="button" onClick={() => setShowSaveAgentPromptModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nome do prompt *</label>
                <input
                  type="text"
                  value={saveAgentPromptName}
                  onChange={(e) => setSaveAgentPromptName(e.target.value)}
                  placeholder="Ex: Prompt do Agente Principal"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Pasta (opcional)</label>
                <select
                  value={saveAgentPromptFolderId}
                  onChange={(e) => setSaveAgentPromptFolderId(e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                >
                  <option value="">Raiz (sem pasta)</option>
                  {(() => {
                    const getFolderPath = (folderId: string, folders: BibliotecaFolder[]): string => {
                      const folder = folders.find((f) => f.id === folderId);
                      if (!folder) return '';
                      if (folder.parentId === null) return folder.name;
                      const parentPath = getFolderPath(folder.parentId, folders);
                      return parentPath ? `${parentPath} / ${folder.name}` : folder.name;
                    };

                                const renderFolderOptions = (parentId: string | null, level: number = 0): JSX.Element[] => {
                                  const children = bibliotecaFolders.filter((f) => f.parentId === parentId);
                                  const options: JSX.Element[] = [];
                                  
                                  children.forEach((folder) => {
                                    const path = getFolderPath(folder.id, bibliotecaFolders);
                        const indent = '  '.repeat(level);
                        options.push(
                          <option key={folder.id} value={folder.id}>
                            {indent}📁 {path}
                          </option>
                        );
                        const subOptions = renderFolderOptions(folder.id, level + 1);
                        options.push(...subOptions);
                      });
                      
                      return options;
                    };

                    return renderFolderOptions(null);
                  })()}
                </select>
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowSaveAgentPromptModal(false);
                  setSaveAgentPromptName('');
                  setSaveAgentPromptFolderId('');
                }}
                className="px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!saveAgentPromptName.trim()) {
                    toast.error('Informe o nome do prompt.');
                    return;
                  }
                  if (!agentPrompt.trim()) {
                    toast.error('O prompt está vazio.');
                    return;
                  }
                  
                  try {
                    const folderId = saveAgentPromptFolderId.trim() || null;
                    const newPrompt = await bibliotecaService.createPrompt({
                      name: saveAgentPromptName.trim(),
                      content: agentPrompt.trim(),
                      folderId,
                    });
                    
                    setBibliotecaPrompts((prev) => [...prev, newPrompt]);
                    setAgentPromptBibliotecaId(newPrompt.id);
                    setShowSaveAgentPromptModal(false);
                    setSaveAgentPromptName('');
                    setSaveAgentPromptFolderId('');
                    toast.success('Prompt salvo na biblioteca.');
                  } catch (error: any) {
                    console.error('Error saving prompt to biblioteca:', error);
                    toast.error('Erro ao salvar prompt na biblioteca');
                  }
                }}
                className="px-6 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center gap-2"
                style={{ backgroundColor: '#F07000' }}
              >
                <span className="material-icons-outlined text-lg">save</span>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Criar Prompt (Biblioteca) */}
      {showCreatePromptModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCreatePromptModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] flex flex-col" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Criar prompt</h3>
              <button type="button" onClick={() => setShowCreatePromptModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nome do prompt</label>
                <input
                  type="text"
                  value={createPromptName}
                  onChange={(e) => setCreatePromptName(e.target.value)}
                  placeholder="Ex: Resposta de orçamento"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Pasta (opcional)</label>
                <select
                  value={createPromptFolderId}
                  onChange={(e) => setCreatePromptFolderId(e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                >
                  <option value="">Nenhuma</option>
                  {bibliotecaFolders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Conteúdo</label>
                <textarea
                  value={createPromptContent}
                  onChange={(e) => setCreatePromptContent(e.target.value)}
                  placeholder="Digite o texto do prompt..."
                  rows={8}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-y"
                />
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button type="button" onClick={() => setShowCreatePromptModal(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                Cancelar
              </button>
              <button type="button" onClick={handleCreatePromptSubmit} className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all" style={{ backgroundColor: '#F07000' }}>
                Criar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Editar Prompt (Biblioteca) */}
      {showEditPromptModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowEditPromptModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] flex flex-col" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Editar prompt</h3>
              <button type="button" onClick={() => setShowEditPromptModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nome do prompt</label>
                <input
                  type="text"
                  value={editPromptName}
                  onChange={(e) => setEditPromptName(e.target.value)}
                  placeholder="Ex: Resposta de orçamento"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Pasta (opcional — trocar de pasta)</label>
                <select
                  value={editPromptFolderId}
                  onChange={(e) => setEditPromptFolderId(e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                >
                  <option value="">Nenhuma (raiz)</option>
                  {bibliotecaFolders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Conteúdo</label>
                <textarea
                  value={editPromptContent}
                  onChange={(e) => setEditPromptContent(e.target.value)}
                  placeholder="Digite o texto do prompt..."
                  rows={8}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-y"
                />
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button type="button" onClick={() => setShowEditPromptModal(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                Cancelar
              </button>
              <button type="button" onClick={handleEditPromptSubmit} className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all" style={{ backgroundColor: '#F07000' }}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Criar Function Call (Biblioteca) */}
      {showCreateBibliotecaFunctionCallModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCreateBibliotecaFunctionCallModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Criar function call</h3>
              <button type="button" onClick={() => setShowCreateBibliotecaFunctionCallModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nome da function call</label>
                <input
                  type="text"
                  value={createFCName}
                  onChange={(e) => setCreateFCName(e.target.value)}
                  placeholder="Ex: Alocabalcao"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Pasta (opcional)</label>
                <select
                  value={createFCFolderId}
                  onChange={(e) => setCreateFCFolderId(e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                >
                  <option value="">Nenhuma</option>
                  {bibliotecaFolders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Objetivo</label>
                <textarea
                  value={createFCObjective}
                  onChange={(e) => setCreateFCObjective(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Identificar se o cliente precisa de algo relacionado a compras no balcão (Lojas físicas)"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Quando Acionar</label>
                <textarea
                  value={createFCTriggerConditions}
                  onChange={(e) => setCreateFCTriggerConditions(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Após o cliente falar que comprou no balcão (Loja física)"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Momento de Execução</label>
                <textarea
                  value={createFCExecutionTiming}
                  onChange={(e) => setCreateFCExecutionTiming(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Quando o cliente falar de assuntos de balcão disparar imediatamente"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Campos Obrigatórios (separados por vírgula)</label>
                <input
                  type="text"
                  value={createFCRequiredFields}
                  onChange={(e) => setCreateFCRequiredFields(e.target.value)}
                  placeholder="Ex.: resumo"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
                <p className="text-xs text-slate-500 mt-1">A FC só dispara quando todos os campos obrigatórios forem coletados</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Campos Opcionais (separados por vírgula)</label>
                <input
                  type="text"
                  value={createFCOptionalFields}
                  onChange={(e) => setCreateFCOptionalFields(e.target.value)}
                  placeholder="Ex.: NumeroDoPedido, ObservacaoExtra"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Restrições (o que NÃO fazer)</label>
                <textarea
                  value={createFCRestrictions}
                  onChange={(e) => setCreateFCRestrictions(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Não chamar se o cliente apenas comente sobre o e-commerce/site, mas queira outra coisa."
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Anotações de Processamento</label>
                <textarea
                  value={createFCProcessingNotes}
                  onChange={(e) => setCreateFCProcessingNotes(e.target.value)}
                  rows={3}
                  placeholder="Descreva como essa FC é processada no backend (ex.: envia resumo para WhatsApp do setor, cria ticket no sistema, etc.)"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              {/* Configuração de Processamento */}
              <div className="border-t border-slate-200 dark:border-slate-700 pt-4 mt-4">
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Configuração de Processamento</label>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                  A function call é sempre processada na fila (RabbitMQ). As opções abaixo definem apenas se a resposta processada é usada na mensagem ao cliente.
                </p>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                    <div className="flex-1">
                      <label className="text-sm font-medium text-slate-900 dark:text-white">Usar resposta no atendimento</label>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Se ativado, o agente espera uma resposta processada (síncrono ou assíncrono) para usar na mensagem ao cliente. Se desativado, a function call ainda é processada na fila, mas a resposta não é enviada ao cliente.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={createFCHasOutput}
                      onClick={() => setCreateFCHasOutput((v) => !v)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20 ${createFCHasOutput ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-600'}`}
                      style={createFCHasOutput ? { backgroundColor: '#F07000' } : {}}
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${createFCHasOutput ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                    <label className="block text-sm font-medium text-slate-900 dark:text-white mb-2">Método de Processamento</label>
                    <select
                      value={createFCProcessingMethod}
                      onChange={(e) => setCreateFCProcessingMethod(e.target.value as 'RABBITMQ' | 'HTTP')}
                      className="w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                    >
                      <option value="RABBITMQ">RabbitMQ</option>
                      <option value="HTTP" disabled className="opacity-50">HTTP Request (Em breve)</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                    <div className="flex-1">
                      <label className="text-sm font-medium text-slate-900 dark:text-white">Usar processo</label>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Se ativado, ao executar esta function call o processo selecionado também será executado, com as informações preenchidas.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!createFCProcessId}
                      onClick={() => {
                        if (createFCProcessId) {
                          setCreateFCProcessId(null);
                          setCreateFCRequiredFields('');
                          setCreateFCOptionalFields('');
                        } else if (bibliotecaProcesses[0]) {
                          const p = bibliotecaProcesses[0];
                          const { requiredFields: req, optionalFields: opt } = processToFCFields(p);
                          setCreateFCProcessId(p.id);
                          setCreateFCRequiredFields(req);
                          setCreateFCOptionalFields(opt);
                        }
                      }}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20 ${createFCProcessId ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-600'}`}
                      style={createFCProcessId ? { backgroundColor: '#F07000' } : {}}
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${createFCProcessId ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  {createFCProcessId && (
                    <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                      <label className="block text-sm font-medium text-slate-900 dark:text-white mb-2">Processo</label>
                      <select
                        value={createFCProcessId}
                        onChange={(e) => {
                          const id = e.target.value || null;
                          setCreateFCProcessId(id);
                          const p = id ? bibliotecaProcesses.find((proc) => proc.id === id) : null;
                          const { requiredFields: req, optionalFields: opt } = processToFCFields(p ?? undefined);
                          setCreateFCRequiredFields(req);
                          setCreateFCOptionalFields(opt);
                        }}
                        className="w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                      >
                        <option value="">Nenhum</option>
                        {bibliotecaProcesses.map((proc) => (
                          <option key={proc.id} value={proc.id}>{proc.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
              {/* Atributos Personalizados */}
              <div className="border-t border-slate-200 dark:border-slate-700 pt-4 mt-4">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-900 dark:text-white">Atributos Personalizados</label>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Configurações específicas desta function call</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCreateFCCustomAttributes((prev) => [...prev, { key: '', value: '' }])}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white rounded-lg transition-colors"
                    style={{ backgroundColor: '#F07000' }}
                  >
                    <span className="material-icons-outlined text-sm">add</span>
                    Adicionar
                  </button>
                </div>
                <div className="space-y-2">
                  {createFCCustomAttributes.map((attr, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={attr.key}
                        onChange={(e) => setCreateFCCustomAttributes((prev) => prev.map((a, i) => (i === idx ? { ...a, key: e.target.value } : a)))}
                        placeholder="Chave"
                        className="flex-1 min-w-0 px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm"
                      />
                      <input
                        type="text"
                        value={attr.value}
                        onChange={(e) => setCreateFCCustomAttributes((prev) => prev.map((a, i) => (i === idx ? { ...a, value: e.target.value } : a)))}
                        placeholder="Valor"
                        className="flex-1 min-w-0 px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setCreateFCCustomAttributes((prev) => prev.filter((_, i) => i !== idx))}
                        className="p-2 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-500"
                        title="Remover"
                      >
                        <span className="material-icons-outlined text-sm">delete_outline</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button type="button" onClick={() => setShowCreateBibliotecaFunctionCallModal(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                Cancelar
              </button>
              <button type="button" onClick={handleCreateBibliotecaFunctionCallSubmit} className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all" style={{ backgroundColor: '#F07000' }}>
                Criar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Editar Function Call (Biblioteca) */}
      {showEditBibliotecaFunctionCallModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowEditBibliotecaFunctionCallModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Editar function call</h3>
              <button type="button" onClick={() => setShowEditBibliotecaFunctionCallModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nome da function call</label>
                <input
                  type="text"
                  value={editFCName}
                  onChange={(e) => setEditFCName(e.target.value)}
                  placeholder="Ex: Alocabalcao"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Pasta (opcional — trocar de pasta)</label>
                <select
                  value={editFCFolderId}
                  onChange={(e) => setEditFCFolderId(e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                >
                  <option value="">Nenhuma (raiz)</option>
                  {bibliotecaFolders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Objetivo</label>
              <textarea
                value={editFCObjective}
                  onChange={(e) => setEditFCObjective(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Identificar se o cliente precisa de algo relacionado a compras no balcão (Lojas físicas)"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Quando Acionar</label>
                <textarea
                  value={editFCTriggerConditions}
                  onChange={(e) => setEditFCTriggerConditions(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Após o cliente falar que comprou no balcão (Loja física)"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Momento de Execução</label>
                <textarea
                  value={editFCExecutionTiming}
                  onChange={(e) => setEditFCExecutionTiming(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Quando o cliente falar de assuntos de balcão disparar imediatamente"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Campos Obrigatórios (separados por vírgula)</label>
                <input
                  type="text"
                  value={editFCRequiredFields}
                  onChange={(e) => setEditFCRequiredFields(e.target.value)}
                  placeholder="Ex.: resumo"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
                <p className="text-xs text-slate-500 mt-1">A FC só dispara quando todos os campos obrigatórios forem coletados</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Campos Opcionais (separados por vírgula)</label>
                <input
                  type="text"
                  value={editFCOptionalFields}
                  onChange={(e) => setEditFCOptionalFields(e.target.value)}
                  placeholder="Ex.: NumeroDoPedido, ObservacaoExtra"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Restrições (o que NÃO fazer)</label>
                <textarea
                  value={editFCRestrictions}
                  onChange={(e) => setEditFCRestrictions(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Não chamar se o cliente apenas comente sobre o e-commerce/site, mas queira outra coisa."
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Anotações de Processamento</label>
                <textarea
                  value={editFCProcessingNotes}
                  onChange={(e) => setEditFCProcessingNotes(e.target.value)}
                  rows={3}
                  placeholder="Descreva como essa FC é processada no backend (ex.: envia resumo para WhatsApp do setor, cria ticket no sistema, etc.)"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                />
              </div>
              {/* Configuração de Processamento */}
              <div className="border-t border-slate-200 dark:border-slate-700 pt-4 mt-4">
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Configuração de Processamento</label>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                  A function call é sempre processada na fila (RabbitMQ). As opções abaixo definem apenas se a resposta processada é usada na mensagem ao cliente.
                </p>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                    <div className="flex-1">
                      <label className="text-sm font-medium text-slate-900 dark:text-white">Usar resposta no atendimento</label>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Se ativado, o agente espera uma resposta processada (síncrono ou assíncrono) para usar na mensagem ao cliente. Se desativado, a function call ainda é processada na fila, mas a resposta não é enviada ao cliente.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={editFCHasOutput}
                      onClick={() => setEditFCHasOutput((v) => !v)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20 ${editFCHasOutput ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-600'}`}
                      style={editFCHasOutput ? { backgroundColor: '#F07000' } : {}}
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${editFCHasOutput ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                    <label className="block text-sm font-medium text-slate-900 dark:text-white mb-2">Método de Processamento</label>
                    <select
                      value={editFCProcessingMethod}
                      onChange={(e) => setEditFCProcessingMethod(e.target.value as 'RABBITMQ' | 'HTTP')}
                      className="w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                    >
                      <option value="RABBITMQ">RabbitMQ</option>
                      <option value="HTTP" disabled className="opacity-50">HTTP Request (Em breve)</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                    <div className="flex-1">
                      <label className="text-sm font-medium text-slate-900 dark:text-white">Usar processo</label>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Se ativado, ao executar esta function call o processo selecionado também será executado, com as informações (X) preenchidas.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!editFCProcessId}
                      onClick={async () => {
                        const next = editFCProcessId ? null : (bibliotecaProcesses[0]?.id ?? null);
                        const process = next ? bibliotecaProcesses.find((p) => p.id === next) : null;
                        const { requiredFields: reqStr, optionalFields: optStr } = processToFCFields(process ?? undefined);
                        setEditFCProcessId(next);
                        setEditFCRequiredFields(reqStr);
                        setEditFCOptionalFields(optStr);
                        if (editFCName.trim()) {
                          try {
                            const { requiredFields: reqArr, optionalFields: optArr } = processToFCFieldsArrays(process ?? undefined);
                            await functionCallConfigService.updateConfig(editFCName.trim(), {
                              processId: next,
                              ...(reqArr.length > 0 && { requiredFields: reqArr }),
                              ...(optArr.length > 0 && { optionalFields: optArr }),
                            });
                            const fc = bibliotecaFunctionCalls.find((f) => f.name === editFCName.trim());
                            if (fc && process) {
                              await bibliotecaService.updateFunctionCall(fc.id, {
                                requiredFields: reqStr,
                                optionalFields: optStr,
                              });
                              setBibliotecaFunctionCalls((prev) =>
                                prev.map((f) =>
                                  f.name === editFCName.trim() ? { ...f, requiredFields: reqStr, optionalFields: optStr } : f
                                )
                              );
                            } else if (fc && !next) {
                              await bibliotecaService.updateFunctionCall(fc.id, { requiredFields: '', optionalFields: '' });
                              setBibliotecaFunctionCalls((prev) =>
                                prev.map((f) => (f.name === editFCName.trim() ? { ...f, requiredFields: '', optionalFields: '' } : f))
                              );
                            }
                            await loadFunctionCallConfigs();
                            toast.success(next ? 'Processo ativado. Campos sincronizados.' : 'Processo desativado.');
                          } catch (err: any) {
                            toast.error(err?.response?.data?.message || 'Erro ao atualizar');
                          }
                        }
                      }}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20 ${editFCProcessId ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-600'}`}
                      style={editFCProcessId ? { backgroundColor: '#F07000' } : {}}
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${editFCProcessId ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  {editFCProcessId && (
                    <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                      <label className="block text-sm font-medium text-slate-900 dark:text-white mb-2">Processo</label>
                      <select
                        value={editFCProcessId}
                        onChange={async (e) => {
                          const value = e.target.value || null;
                          const process = value ? bibliotecaProcesses.find((p) => p.id === value) : null;
                          const { requiredFields: reqStr, optionalFields: optStr } = processToFCFields(process ?? undefined);
                          const { requiredFields: reqArr, optionalFields: optArr } = processToFCFieldsArrays(process ?? undefined);
                          setEditFCProcessId(value);
                          setEditFCRequiredFields(reqStr);
                          setEditFCOptionalFields(optStr);
                          if (editFCName.trim()) {
                            try {
                              await functionCallConfigService.updateConfig(editFCName.trim(), {
                                processId: value,
                                ...(reqArr.length > 0 && { requiredFields: reqArr }),
                                ...(optArr.length > 0 && { optionalFields: optArr }),
                              });
                              const fc = bibliotecaFunctionCalls.find((f) => f.name === editFCName.trim());
                              if (fc && process) {
                                await bibliotecaService.updateFunctionCall(fc.id, {
                                  requiredFields: reqStr,
                                  optionalFields: optStr,
                                });
                                setBibliotecaFunctionCalls((prev) =>
                                  prev.map((f) =>
                                    f.name === editFCName.trim() ? { ...f, requiredFields: reqStr, optionalFields: optStr } : f
                                  )
                                );
                              } else if (fc && !value) {
                                await bibliotecaService.updateFunctionCall(fc.id, { requiredFields: '', optionalFields: '' });
                                setBibliotecaFunctionCalls((prev) =>
                                  prev.map((f) => (f.name === editFCName.trim() ? { ...f, requiredFields: '', optionalFields: '' } : f))
                                );
                              }
                              await loadFunctionCallConfigs();
                              toast.success('Processo atualizado. Campos sincronizados.');
                            } catch (err: any) {
                              toast.error(err?.response?.data?.message || 'Erro ao vincular processo');
                            }
                          }
                        }}
                        className="w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                      >
                        <option value="">Nenhum</option>
                        {bibliotecaProcesses.map((proc) => (
                          <option key={proc.id} value={proc.id}>{proc.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
              {/* Atributos Personalizados */}
              <div className="border-t border-slate-200 dark:border-slate-700 pt-4 mt-4">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-900 dark:text-white">Atributos Personalizados</label>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Configurações específicas desta function call</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditFCCustomAttributes((prev) => [...prev, { key: '', value: '' }])}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white rounded-lg transition-colors"
                    style={{ backgroundColor: '#F07000' }}
                  >
                    <span className="material-icons-outlined text-sm">add</span>
                    Adicionar
                  </button>
                </div>
                <div className="space-y-2">
                  {editFCCustomAttributes.map((attr, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={attr.key}
                        onChange={(e) => setEditFCCustomAttributes((prev) => prev.map((a, i) => (i === idx ? { ...a, key: e.target.value } : a)))}
                        placeholder="Chave"
                        className="flex-1 min-w-0 px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm"
                      />
                      <input
                        type="text"
                        value={attr.value}
                        onChange={(e) => setEditFCCustomAttributes((prev) => prev.map((a, i) => (i === idx ? { ...a, value: e.target.value } : a)))}
                        placeholder="Valor"
                        className="flex-1 min-w-0 px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setEditFCCustomAttributes((prev) => prev.filter((_, i) => i !== idx))}
                        className="p-2 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-500"
                        title="Remover"
                      >
                        <span className="material-icons-outlined text-sm">delete_outline</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button type="button" onClick={() => setShowEditBibliotecaFunctionCallModal(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                Cancelar
              </button>
              <button type="button" onClick={handleEditBibliotecaFunctionCallSubmit} className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all" style={{ backgroundColor: '#F07000' }}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Editar Pasta (Biblioteca) */}
      {editFolderState && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditFolderState(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-md w-full mx-4" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Editar pasta</h3>
              <button type="button" onClick={() => setEditFolderState(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nome da pasta</label>
                <input
                  type="text"
                  value={editFolderState.name}
                  onChange={(e) => setEditFolderState((prev) => (prev ? { ...prev, name: e.target.value } : null))}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Mover para</label>
                <select
                  value={editFolderState.parentId ?? ''}
                  onChange={(e) => setEditFolderState((prev) => (prev ? { ...prev, parentId: e.target.value || null } : null))}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                >
                  <option value="">Raiz</option>
                  {(() => {
                    const folders = bibliotecaFolders;
                    const descendantIds = getBibliotecaDescendantIds(editFolderState.folderId, folders);
                    return folders
                      .filter((f) => f.id !== editFolderState.folderId && !descendantIds.includes(f.id))
                      .map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ));
                  })()}
                </select>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Subpastas e itens dentro desta pasta vão junto.</p>
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button type="button" onClick={() => setEditFolderState(null)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                Cancelar
              </button>
              <button type="button" onClick={handleSaveEditFolder} className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all" style={{ backgroundColor: '#F07000' }}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Criar Schema (Biblioteca) */}
      {showCreateSchemaModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCreateSchemaModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-md w-full mx-4" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Criar novo schema</h3>
              <button type="button" onClick={() => setShowCreateSchemaModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nome do schema</label>
                <input
                  type="text"
                  value={createSchemaName}
                  onChange={(e) => setCreateSchemaName(e.target.value)}
                  placeholder="Ex: Meu fluxo de atendimento"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">Tipo de schema</label>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setCreateSchemaType('sem-tags')}
                    className={`flex flex-col items-center justify-center p-6 rounded-xl border-2 transition-all duration-200 ${
                      createSchemaType === 'sem-tags'
                        ? 'border-primary bg-primary/5 shadow-md'
                        : 'border-slate-200 dark:border-slate-600 hover:border-slate-300 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                    style={createSchemaType === 'sem-tags' ? { borderColor: '#F07000', backgroundColor: 'rgba(240,112,0,0.08)' } : {}}
                  >
                    <span className="material-icons-outlined text-3xl text-slate-500 dark:text-slate-400 mb-2">account_tree</span>
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Sem Tags</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateSchemaType('com-tags')}
                    className={`flex flex-col items-center justify-center p-6 rounded-xl border-2 transition-all duration-200 ${
                      createSchemaType === 'com-tags'
                        ? 'border-primary bg-primary/5 shadow-md'
                        : 'border-slate-200 dark:border-slate-600 hover:border-slate-300 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                    style={createSchemaType === 'com-tags' ? { borderColor: '#F07000', backgroundColor: 'rgba(240,112,0,0.08)' } : {}}
                  >
                    <span className="material-icons-outlined text-3xl text-slate-500 dark:text-slate-400 mb-2">label</span>
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Com tags</span>
                  </button>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button type="button" onClick={() => setShowCreateSchemaModal(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                Cancelar
              </button>
              <button type="button" onClick={handleCreateSchemaSubmit} className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all" style={{ backgroundColor: '#F07000' }}>
                Criar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Renomear Schema (apenas nome) */}
      {renamingSchema && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setRenamingSchema(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-sm w-full mx-4" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">Renomear schema</h3>
              <button type="button" onClick={() => setRenamingSchema(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6">
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Nome</label>
              <input
                type="text"
                value={renameSchemaName}
                onChange={(e) => setRenameSchemaName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRenameSchemaSubmit()}
                placeholder="Nome do schema"
                className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
            </div>
            <div className="p-6 pt-0 flex gap-3">
              <button type="button" onClick={() => setRenamingSchema(null)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                Cancelar
              </button>
              <button type="button" onClick={handleRenameSchemaSubmit} className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all" style={{ backgroundColor: '#F07000' }}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Editar Schema (Biblioteca) - edição completa com definição JSON */}
      {editingSchema && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditingSchema(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] flex flex-col" style={{ backgroundColor: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Editar schema</h3>
              <button type="button" onClick={() => setEditingSchema(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <span className="material-icons-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nome</label>
                <input
                  id="edit-schema-name"
                  type="text"
                  value={editSchemaName}
                  onChange={(e) => setEditSchemaName(e.target.value)}
                  placeholder="Nome do schema"
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Definição (JSON ou texto)</label>
                <textarea
                  id="edit-schema-definition"
                  value={editSchemaDefinition}
                  onChange={(e) => setEditSchemaDefinition(e.target.value)}
                  placeholder="Conteúdo do schema..."
                  rows={10}
                  className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 resize-y"
                />
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button type="button" onClick={() => setEditingSchema(null)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                Cancelar
              </button>
              <button type="button" onClick={handleSaveSchema} className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-semibold shadow-sm transition-all" style={{ backgroundColor: '#F07000' }}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
