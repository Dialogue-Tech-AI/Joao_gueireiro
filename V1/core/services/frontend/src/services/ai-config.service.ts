import { api } from './api';

export interface PendingFunctionConfig {
  orcamento: {
    enabled: boolean;
    description?: string;
  };
  fechamento: {
    enabled: boolean;
    description?: string;
  };
  garantias: {
    enabled: boolean;
    description?: string;
  };
  encomendas: {
    enabled: boolean;
    description?: string;
  };
  chamado_humano: {
    enabled: boolean;
    description?: string;
  };
}

export interface AIConfigResponse {
  prompt: string;
  pendingFunctions: PendingFunctionConfig;
  imageDescriptionPrompt?: string;
}

class AIConfigService {
  /**
   * Get agent prompt
   */
  async getAgentPrompt(): Promise<string> {
    const response = await api.get<{ success: boolean; data: { prompt: string } }>('/ai/config/prompt');
    return response.data.data.prompt;
  }

  /**
   * Update agent prompt
   */
  async updateAgentPrompt(prompt: string): Promise<{ id: string; prompt: string; updatedAt: Date }> {
    const response = await api.put<{ success: boolean; data: { id: string; prompt: string; updatedAt: Date } }>(
      '/ai/config/prompt',
      { prompt }
    );
    return response.data.data;
  }

  /**
   * Get image description prompt
   */
  async getImageDescriptionPrompt(): Promise<string> {
    const response = await api.get<{ success: boolean; data: { prompt: string } }>('/ai/config/image-description-prompt');
    return response.data.data.prompt;
  }

  /**
   * Update image description prompt
   */
  async updateImageDescriptionPrompt(prompt: string): Promise<{ id: string; prompt: string; updatedAt: Date }> {
    const response = await api.put<{ success: boolean; data: { id: string; prompt: string; updatedAt: Date } }>(
      '/ai/config/image-description-prompt',
      { prompt }
    );
    return response.data.data;
  }

  /**
   * Get pending functions configuration
   */
  async getPendingFunctionsConfig(): Promise<PendingFunctionConfig> {
    const response = await api.get<{ success: boolean; data: { config: PendingFunctionConfig } }>(
      '/ai/config/pending-functions'
    );
    return response.data.data.config;
  }

  /**
   * Update pending functions configuration
   */
  async updatePendingFunctionsConfig(
    config: PendingFunctionConfig
  ): Promise<{ id: string; config: PendingFunctionConfig; updatedAt: Date }> {
    const response = await api.put<{
      success: boolean;
      data: { id: string; config: PendingFunctionConfig; updatedAt: Date };
    }>('/ai/config/pending-functions', { config });
    return response.data.data;
  }

  /**
   * Get all configurations
   */
  async getAllConfigs(): Promise<AIConfigResponse> {
    const response = await api.get<{ success: boolean; data: AIConfigResponse }>('/ai/config');
    return response.data.data;
  }

  /**
   * Reset AI memory for testing
   */
  async resetMemory(params: {
    supervisorId?: string;
    sellerId?: string;
    clientPhone?: string;
    resetUnassigned?: boolean;
    resetAll?: boolean;
    options: {
      deleteMessages: boolean;
      deleteAiContext: boolean;
      deleteEmbeddings: boolean;
      resetAttendanceState: boolean;
    };
  }): Promise<{
    deleted: { messages: number; attendances: number; embeddings: number };
    attendanceIds: string[];
  }> {
    const response = await api.delete<{
      success: boolean;
      data: {
        deleted: { messages: number; attendances: number; embeddings: number };
        attendanceIds: string[];
      };
      message: string;
    }>('/ai/config/memory/reset', { data: params });
    return response.data.data;
  }

  /**
   * Wipe all data: memory, attendances, clients, quote requests.
   * Apenas Super Admin.
   */
  async wipeAllData(): Promise<{
    deleted: { messages: number; quoteRequests: number; attendances: number; embeddings: number };
  }> {
    const response = await api.delete<{
      success: boolean;
      data: { deleted: { messages: number; quoteRequests: number; attendances: number; embeddings: number } };
      message: string;
    }>('/ai/config/memory/wipe-all');
    return response.data.data;
  }

  /**
   * Get clients by seller
   */
  async getClientsBySeller(sellerId: string): Promise<string[]> {
    const response = await api.get<{ success: boolean; data: { clients: string[] } }>(
      `/ai/config/memory/clients/${sellerId}`
    );
    return response.data.data.clients;
  }

  /**
   * Get clients by supervisor
   */
  async getClientsBySupervisor(supervisorId: string): Promise<string[]> {
    const response = await api.get<{ success: boolean; data: { clients: string[] } }>(
      `/ai/config/memory/clients/supervisor/${supervisorId}`
    );
    return response.data.data.clients;
  }

  /**
   * Purge AI messages queue
   */
  async purgeQueue(queueName?: string): Promise<{ queue: string; messagesDeleted: number }> {
    const response = await api.delete<{
      success: boolean;
      data: { queue: string; messagesDeleted: number };
      message: string;
    }>('/ai/config/queue/purge', { data: { queueName } });
    return response.data.data;
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    aiMessages: number;
    aiResponses: number;
    messages: number;
    notifications: number;
  }> {
    const response = await api.get<{
      success: boolean;
      data: {
        aiMessages: number;
        aiResponses: number;
        messages: number;
        notifications: number;
      };
    }>('/ai/config/queue/stats');
    return response.data.data;
  }

  /**
   * Debug queue connection and names
   */
  async debugQueue(): Promise<any> {
    const response = await api.get<{
      success: boolean;
      data: any;
    }>('/ai/config/queue/debug');
    return response.data.data;
  }

  /**
   * Get all function call prompts
   */
  async getAllFunctionCallPrompts(): Promise<Record<string, string>> {
    const response = await api.get<{
      success: boolean;
      data: Record<string, string>;
    }>('/ai/config/function-calls');
    return response.data.data;
  }

  /**
   * Get function call prompt
   */
  async getFunctionCallPrompt(toolName: string): Promise<string> {
    const response = await api.get<{
      success: boolean;
      data: { toolName: string; prompt: string | null };
    }>(`/ai/config/function-calls/${toolName}`);
    return response.data.data.prompt || '';
  }

  /**
   * Update function call prompt
   */
  async updateFunctionCallPrompt(toolName: string, prompt: string): Promise<{
    toolName: string;
    prompt: string;
    updatedAt: string;
  }> {
    const response = await api.put<{
      success: boolean;
      data: {
        toolName: string;
        prompt: string;
        updatedAt: string;
      };
      message: string;
    }>(`/ai/config/function-calls/${toolName}`, { prompt });
    return response.data.data;
  }

  /**
   * Get default function call prompt (reference only)
   */
  async getDefaultFunctionCallPrompt(toolName: string): Promise<{
    toolName: string;
    note: string;
    location: string;
  }> {
    const response = await api.get<{
      success: boolean;
      data: {
        toolName: string;
        note: string;
        location: string;
      };
    }>(`/ai/config/function-calls/${toolName}/default`);
    return response.data.data;
  }

  /**
   * Delete function call prompt
   */
  async deleteFunctionCallPrompt(toolName: string): Promise<void> {
    await api.delete<{
      success: boolean;
      message: string;
    }>(`/ai/config/function-calls/${toolName}`);
  }
}

export interface FunctionCallInput {
  id: string;
  functionCallName: string;
  inputFormat: 'TEXT' | 'TEMPLATE' | 'JSON';
  template: string;
  conditions?: Record<string, any>;
  isActive: boolean;
  priority: number;
  description?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFunctionCallInputDto {
  functionCallName: string;
  inputFormat: 'TEXT' | 'TEMPLATE' | 'JSON';
  template: string;
  conditions?: Record<string, any>;
  priority?: number;
  description?: string;
  metadata?: Record<string, any>;
  isActive?: boolean;
}

export interface UpdateFunctionCallInputDto {
  inputFormat?: 'TEXT' | 'TEMPLATE' | 'JSON';
  template?: string;
  conditions?: Record<string, any>;
  priority?: number;
  description?: string;
  metadata?: Record<string, any>;
  isActive?: boolean;
}

export interface FunctionCallConfig {
  functionCallName: string;
  hasOutput: boolean;
  isSync: boolean;
  processingMethod: 'RABBITMQ' | 'HTTP';
  isActive: boolean;
  metadata?: Record<string, any>;
  triggerConditions?: string;
  executionTiming?: string;
  objective?: string;
  requiredFields?: string[];
  optionalFields?: string[];
  restrictions?: string;
  processingNotes?: string;
  customAttributes?: Record<string, unknown>;
  processId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateFunctionCallConfigDto {
  hasOutput?: boolean;
  isSync?: boolean;
  processingMethod?: 'RABBITMQ' | 'HTTP';
  isActive?: boolean;
  metadata?: Record<string, any>;
  triggerConditions?: string;
  executionTiming?: string;
  objective?: string;
  requiredFields?: string[];
  optionalFields?: string[];
  restrictions?: string;
  processingNotes?: string;
  customAttributes?: Record<string, unknown>;
  processId?: string | null;
}

class FunctionCallInputService {
  async getAllInputs(includeInactive = false): Promise<FunctionCallInput[]> {
    const response = await api.get<{
      success: boolean;
      data: FunctionCallInput[];
    }>(`/ai/inputs?includeInactive=${includeInactive}`);
    return response.data.data;
  }

  async getInputsByFunctionCall(
    functionCallName: string,
    includeInactive = false
  ): Promise<FunctionCallInput[]> {
    const response = await api.get<{
      success: boolean;
      data: FunctionCallInput[];
    }>(`/ai/inputs/function-call/${functionCallName}?includeInactive=${includeInactive}`);
    return response.data.data;
  }

  async getInputById(id: string): Promise<FunctionCallInput> {
    const response = await api.get<{
      success: boolean;
      data: FunctionCallInput;
    }>(`/ai/inputs/${id}`);
    return response.data.data;
  }

  async createInput(dto: CreateFunctionCallInputDto): Promise<FunctionCallInput> {
    const response = await api.post<{
      success: boolean;
      data: FunctionCallInput;
      message: string;
    }>('/ai/inputs', dto);
    return response.data.data;
  }

  async updateInput(id: string, dto: UpdateFunctionCallInputDto): Promise<FunctionCallInput> {
    const response = await api.put<{
      success: boolean;
      data: FunctionCallInput;
      message: string;
    }>(`/ai/inputs/${id}`, dto);
    return response.data.data;
  }

  async deleteInput(id: string): Promise<void> {
    await api.delete<{
      success: boolean;
      message: string;
    }>(`/ai/inputs/${id}`);
  }

  async toggleActive(id: string): Promise<FunctionCallInput> {
    const response = await api.patch<{
      success: boolean;
      data: FunctionCallInput;
      message: string;
    }>(`/ai/inputs/${id}/toggle-active`);
    return response.data.data;
  }
}

export const functionCallInputService = new FunctionCallInputService();

export class FunctionCallConfigService {
  async getAll(): Promise<FunctionCallConfig[]> {
    const response = await api.get<{ success: boolean; data: FunctionCallConfig[] }>(
      '/ai/function-call-configs'
    );
    return response.data.data;
  }

  async getByFunctionCallName(functionCallName: string): Promise<FunctionCallConfig | null> {
    try {
      const response = await api.get<{ success: boolean; data: FunctionCallConfig }>(
        `/ai/function-call-configs/${functionCallName}`
      );
      return response.data.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async update(
    functionCallName: string,
    dto: UpdateFunctionCallConfigDto
  ): Promise<FunctionCallConfig> {
    const response = await api.put<{ success: boolean; data: FunctionCallConfig }>(
      `/ai/function-call-configs/${functionCallName}`,
      dto
    );
    return response.data.data;
  }

  async setHasOutput(functionCallName: string, hasOutput: boolean): Promise<FunctionCallConfig> {
    const response = await api.patch<{ success: boolean; data: FunctionCallConfig }>(
      `/ai/function-call-configs/${functionCallName}/has-output`,
      { hasOutput }
    );
    return response.data.data;
  }

  async setIsSync(functionCallName: string, isSync: boolean): Promise<FunctionCallConfig> {
    const response = await api.patch<{ success: boolean; data: FunctionCallConfig }>(
      `/ai/function-call-configs/${functionCallName}/is-sync`,
      { isSync }
    );
    return response.data.data;
  }

  async setProcessingMethod(
    functionCallName: string,
    processingMethod: 'RABBITMQ' | 'HTTP'
  ): Promise<FunctionCallConfig> {
    const response = await api.patch<{ success: boolean; data: FunctionCallConfig }>(
      `/ai/function-call-configs/${functionCallName}/processing-method`,
      { processingMethod }
    );
    return response.data.data;
  }

  async setIsActive(functionCallName: string, isActive: boolean): Promise<FunctionCallConfig> {
    const response = await api.patch<{ success: boolean; data: FunctionCallConfig }>(
      `/ai/function-call-configs/${functionCallName}/is-active`,
      { isActive }
    );
    return response.data.data;
  }

  async updateConfig(functionCallName: string, dto: UpdateFunctionCallConfigDto): Promise<FunctionCallConfig> {
    const response = await api.patch<{ success: boolean; data: FunctionCallConfig }>(
      `/ai/function-call-configs/${functionCallName}`,
      dto
    );
    return response.data.data;
  }
}

// Extend AIConfigService with buffer methods
AIConfigService.prototype.getBufferConfig = async function(): Promise<{ enabled: boolean; bufferTimeMs: number }> {
  const response = await api.get<{ 
    success: boolean; 
    data: { enabled: boolean; bufferTimeMs: number } 
  }>('/ai/config/buffer');
  return response.data.data;
};

AIConfigService.prototype.updateBufferConfig = async function(config: {
  enabled: boolean;
  bufferTimeMs: number;
}): Promise<{ enabled: boolean; bufferTimeMs: number; updatedAt: Date }> {
  const response = await api.put<{ 
    success: boolean; 
    data: { enabled: boolean; bufferTimeMs: number; updatedAt: Date } 
  }>('/ai/config/buffer', config);
  return response.data.data;
};

AIConfigService.prototype.getAgentTemperature = async function(): Promise<number> {
  const response = await api.get<{ success: boolean; data: { temperature: number } }>('/ai/config/temperature');
  return response.data.data.temperature;
};

AIConfigService.prototype.updateAgentTemperature = async function(temperature: number): Promise<{ temperature: number; updatedAt: Date }> {
  const response = await api.put<{
    success: boolean;
    data: { temperature: number; updatedAt: Date };
  }>('/ai/config/temperature', { temperature });
  return response.data.data;
};

AIConfigService.prototype.getAIModuleEnabled = async function(): Promise<boolean> {
  const response = await api.get<{ success: boolean; data: { enabled: boolean } }>('/ai/config/ai-enabled');
  return response.data.data.enabled;
};

AIConfigService.prototype.updateAIModuleEnabled = async function(enabled: boolean): Promise<{ enabled: boolean; updatedAt: Date }> {
  const response = await api.put<{
    success: boolean;
    data: { enabled: boolean; updatedAt: Date };
  }>('/ai/config/ai-enabled', { enabled });
  return response.data.data;
};

AIConfigService.prototype.getOpenAIModel = async function(): Promise<string | null> {
  const response = await api.get<{ success: boolean; data: { model: string | null } }>('/ai/config/model');
  return response.data.data.model;
};

AIConfigService.prototype.getAutoReopenTimeout = async function(): Promise<number> {
  const response = await api.get<{ success: boolean; data: { timeoutMinutes: number } }>('/ai/config/auto-reopen-timeout');
  return response.data.data.timeoutMinutes;
};

AIConfigService.prototype.updateAutoReopenTimeout = async function(timeoutMinutes: number): Promise<{ timeoutMinutes: number; updatedAt: Date }> {
  const response = await api.put<{
    success: boolean;
    data: { timeoutMinutes: number; updatedAt: Date };
  }>('/ai/config/auto-reopen-timeout', { timeoutMinutes });
  return response.data.data;
};

/**
 * Get subdivision inactivity timeouts configuration
 */
AIConfigService.prototype.getSubdivisionInactivityTimeouts = async function(): Promise<Record<string, number>> {
  const response = await api.get<{ success: boolean; data: { timeouts: Record<string, number> } }>(
    '/ai/config/subdivision-inactivity-timeouts'
  );
  return response.data.data.timeouts;
};

/**
 * Update subdivision inactivity timeouts configuration
 */
AIConfigService.prototype.updateSubdivisionInactivityTimeouts = async function(timeouts: Record<string, number>): Promise<{ timeouts: Record<string, number>; updatedAt: Date }> {
  const response = await api.put<{ success: boolean; data: { timeouts: Record<string, number>; updatedAt: Date } }>(
    '/ai/config/subdivision-inactivity-timeouts', { timeouts }
  );
  return response.data.data;
};

/**
 * Follow-up configuration for inactive attendances
 */
export interface FollowUpConfig {
  firstDelayMinutes: number;
  secondDelayMinutes: number;
  closeDelayMinutes: number;
  firstMessage: string;
  secondMessage: string;
}

AIConfigService.prototype.getFollowUpConfig = async function(): Promise<FollowUpConfig> {
  const response = await api.get<{ success: boolean; data: FollowUpConfig }>('/ai/config/follow-up-config');
  return response.data.data;
};

AIConfigService.prototype.updateFollowUpConfig = async function(config: FollowUpConfig): Promise<{ success: boolean; updatedAt: Date }> {
  const response = await api.put<{ success: boolean; data: { success: boolean; updatedAt: Date } }>(
    '/ai/config/follow-up-config',
    config
  );
  return response.data.data;
};

/**
 * Configuração de movimentação automática entre divisões (não sobre envio de mensagens)
 */
export interface FollowUpMovementConfig {
  moveOpenToFirstFollowUpMinutes: number;
  moveToFechadosAfterSecondFollowUpMinutes: number;
}

AIConfigService.prototype.getFollowUpMovementConfig = async function(): Promise<FollowUpMovementConfig> {
  const response = await api.get<{ success: boolean; data: FollowUpMovementConfig }>('/ai/config/follow-up-movement-config');
  return response.data.data;
};

AIConfigService.prototype.updateFollowUpMovementConfig = async function(config: FollowUpMovementConfig): Promise<{ success: boolean; updatedAt: Date }> {
  const response = await api.put<{ success: boolean; data: { success: boolean; updatedAt: Date } }>(
    '/ai/config/follow-up-movement-config',
    config
  );
  return response.data.data;
};

/**
 * Blacklist: números que não são respondidos pela IA e não aparecem como atendimentos.
 */
export interface BlacklistConfig {
  enabled: boolean;
  numbers: string[];
}

AIConfigService.prototype.getBlacklistConfig = async function(): Promise<BlacklistConfig> {
  const response = await api.get<{ success: boolean; data: BlacklistConfig }>('/ai/config/blacklist');
  return response.data.data;
};

AIConfigService.prototype.updateBlacklistConfig = async function(config: BlacklistConfig): Promise<BlacklistConfig> {
  const response = await api.patch<{ success: boolean; data: BlacklistConfig }>('/ai/config/blacklist', config);
  return response.data.data;
};

AIConfigService.prototype.updateOpenAIModel = async function(model: string): Promise<{ model: string; updatedAt: Date }> {
  const response = await api.put<{
    success: boolean;
    data: { model: string; updatedAt: Date };
  }>('/ai/config/model', { model });
  return response.data.data;
};

export const functionCallConfigService = new FunctionCallConfigService();
export const aiConfigService = new AIConfigService();