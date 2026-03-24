import { Router, Request, Response } from 'express';
import { aiConfigService, PendingFunctionConfig } from '../../application/services/ai-config.service';
import { logger } from '../../../../shared/utils/logger';
import { redisService } from '../../../../shared/infrastructure/redis/redis.service';
import { AIMemoryResetService, ResetMemoryOptions } from '../../application/services/ai-memory-reset.service';
import { InfrastructureFactory } from '../../../../shared/infrastructure/factories/infrastructure.factory';
import config from '../../../../config/app.config';
import { messageBufferService } from '../../../message/application/services/message-buffer.service';
import { UserRole } from '../../../../shared/types/common.types';

export class AIConfigController {
  public router: Router;
  private memoryResetService: AIMemoryResetService;

  constructor() {
    this.router = Router();
    
    // Initialize memory reset service
    this.memoryResetService = new AIMemoryResetService();
    
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Get agent prompt
    this.router.get('/prompt', this.getAgentPrompt.bind(this));

    // Update agent prompt
    this.router.put('/prompt', this.updateAgentPrompt.bind(this));

    // Get pending functions config
    this.router.get('/pending-functions', this.getPendingFunctionsConfig.bind(this));

    // Update pending functions config
    this.router.put('/pending-functions', this.updatePendingFunctionsConfig.bind(this));

    // Get all configs
    this.router.get('/', this.getAllConfigs.bind(this));

    // Memory reset endpoints
    this.router.delete('/memory/reset', this.resetMemory.bind(this));
    this.router.delete('/memory/wipe-all', this.wipeAllData.bind(this));
    this.router.get('/memory/clients/:sellerId', this.getClientsBySeller.bind(this));
    this.router.get('/memory/clients/supervisor/:supervisorId', this.getClientsBySupervisor.bind(this));

    // Queue management endpoints
    this.router.delete('/queue/purge', this.purgeQueue.bind(this));
    this.router.get('/queue/stats', this.getQueueStats.bind(this));
    this.router.get('/queue/debug', this.debugQueue.bind(this));

    // Function call prompts endpoints
    this.router.get('/function-calls', this.getAllFunctionCallPrompts.bind(this));
    this.router.get('/function-calls/:toolName', this.getFunctionCallPrompt.bind(this));
    this.router.put('/function-calls/:toolName', this.updateFunctionCallPrompt.bind(this));
    this.router.delete('/function-calls/:toolName', this.deleteFunctionCallPrompt.bind(this));
    this.router.get('/function-calls/:toolName/default', this.getDefaultFunctionCallPrompt.bind(this));

    // Image description prompt endpoints
    this.router.get('/image-description-prompt', this.getImageDescriptionPrompt.bind(this));
    this.router.put('/image-description-prompt', this.updateImageDescriptionPrompt.bind(this));

    // Message buffer configuration endpoints
    this.router.get('/buffer', this.getBufferConfig.bind(this));
    this.router.put('/buffer', this.updateBufferConfig.bind(this));
    this.router.post('/buffer/typing/:attendanceId', this.handleTypingEvent.bind(this));

    // Agent temperature endpoints
    this.router.get('/temperature', this.getTemperature.bind(this));
    this.router.put('/temperature', this.updateTemperature.bind(this));

    // AI module on/off (worker consumes RabbitMQ when enabled)
    this.router.get('/ai-enabled', this.getAIEnabled.bind(this));
    this.router.put('/ai-enabled', this.updateAIEnabled.bind(this));

    // Blacklist (números não respondidos pela IA e não exibidos como atendimentos)
    this.router.get('/blacklist', this.getBlacklist.bind(this));
    this.router.patch('/blacklist', this.updateBlacklist.bind(this));

    // OpenAI model selection
    this.router.get('/model', this.getModel.bind(this));
    this.router.put('/model', this.updateModel.bind(this));

    // Auto-reopen timeout configuration
    this.router.get('/auto-reopen-timeout', this.getAutoReopenTimeout.bind(this));
    this.router.put('/auto-reopen-timeout', this.updateAutoReopenTimeout.bind(this));

    // Subdivision inactivity timeouts configuration
    this.router.get('/subdivision-inactivity-timeouts', this.getSubdivisionInactivityTimeouts.bind(this));
    this.router.put('/subdivision-inactivity-timeouts', this.updateSubdivisionInactivityTimeouts.bind(this));

    // Follow-up configuration (times and messages for inactive attendances)
    this.router.get('/follow-up-config', this.getFollowUpConfig.bind(this));
    this.router.put('/follow-up-config', this.updateFollowUpConfig.bind(this));

    // Follow-up movement configuration (when to move between divisions)
    this.router.get('/follow-up-movement-config', this.getFollowUpMovementConfig.bind(this));
    this.router.put('/follow-up-movement-config', this.updateFollowUpMovementConfig.bind(this));
  }

  private async getAgentPrompt(req: Request, res: Response): Promise<void> {
    try {
      const prompt = await aiConfigService.getAgentPrompt();

      res.json({
        success: true,
        data: {
          prompt,
        },
      });
    } catch (error: any) {
      logger.error('Error in getAgentPrompt controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar prompt do agente',
      });
    }
  }

  private async updateAgentPrompt(req: Request, res: Response): Promise<void> {
    try {
      const { prompt } = req.body;

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Prompt é obrigatório e deve ser uma string',
        });
        return;
      }

      const updated = await aiConfigService.updateAgentPrompt(prompt);

      logger.info('Agent prompt updated', {
        configId: updated.id,
        updatedAt: updated.updatedAt,
      });

      // Publish Redis event to notify ai-workers to invalidate cache
      try {
        if (redisService.isConnected()) {
          await redisService.publishConfigUpdate('agent_prompt');
          logger.info('✅ Published Redis event for prompt cache invalidation');
        } else {
          logger.warn('Redis not connected - cache invalidation will rely on TTL');
        }
      } catch (redisError: any) {
        logger.error('Failed to publish Redis event', { error: redisError.message });
        // Don't fail the request if Redis publish fails
      }

      res.json({
        success: true,
        data: {
          id: updated.id,
          prompt: updated.value,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error: any) {
      logger.error('Error in updateAgentPrompt controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar prompt do agente',
      });
    }
  }

  private async getPendingFunctionsConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = await aiConfigService.getPendingFunctionsConfig();

      res.json({
        success: true,
        data: {
          config,
        },
      });
    } catch (error: any) {
      logger.error('Error in getPendingFunctionsConfig controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar configurações de pendências',
      });
    }
  }

  private async updatePendingFunctionsConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = req.body.config as PendingFunctionConfig;

      if (!config || typeof config !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Configuração é obrigatória e deve ser um objeto',
        });
        return;
      }

      // Validate structure
      const requiredKeys = ['orcamento', 'fechamento', 'garantias', 'encomendas', 'chamado_humano'];
      for (const key of requiredKeys) {
        if (!(key in config)) {
          res.status(400).json({
            success: false,
            error: `Configuração deve incluir a chave: ${key}`,
          });
          return;
        }
        if (typeof config[key as keyof PendingFunctionConfig] !== 'object') {
          res.status(400).json({
            success: false,
            error: `A chave ${key} deve ser um objeto`,
          });
          return;
        }
        if (!('enabled' in config[key as keyof PendingFunctionConfig])) {
          res.status(400).json({
            success: false,
            error: `A chave ${key} deve ter a propriedade 'enabled'`,
          });
          return;
        }
      }

      const updated = await aiConfigService.updatePendingFunctionsConfig(config);

      logger.info('Pending functions config updated', {
        configId: updated.id,
        updatedAt: updated.updatedAt,
      });

      res.json({
        success: true,
        data: {
          id: updated.id,
          config: JSON.parse(updated.value) as PendingFunctionConfig,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error: any) {
      logger.error('Error in updatePendingFunctionsConfig controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar configurações de pendências',
      });
    }
  }

  private async getAllConfigs(req: Request, res: Response): Promise<void> {
    try {
      const configs = await aiConfigService.getAllConfigs();

      res.json({
        success: true,
        data: configs,
      });
    } catch (error: any) {
      logger.error('Error in getAllConfigs controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar configurações',
      });
    }
  }

  private async getImageDescriptionPrompt(req: Request, res: Response): Promise<void> {
    try {
      const prompt = await aiConfigService.getImageDescriptionPrompt();

      res.json({
        success: true,
        data: {
          prompt,
        },
      });
    } catch (error: any) {
      logger.error('Error in getImageDescriptionPrompt controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar prompt de descrição de imagem',
      });
    }
  }

  private async updateImageDescriptionPrompt(req: Request, res: Response): Promise<void> {
    try {
      const { prompt } = req.body;

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Prompt é obrigatório e deve ser uma string',
        });
        return;
      }

      const updated = await aiConfigService.updateImageDescriptionPrompt(prompt);

      logger.info('Image description prompt updated', {
        configId: updated.id,
        updatedAt: updated.updatedAt,
      });

      // Publish Redis event to notify ai-workers to invalidate cache
      try {
        if (redisService.isConnected()) {
          await redisService.publishConfigUpdate('image_description_prompt');
          logger.info('✅ Published Redis event for image description prompt cache invalidation');
        } else {
          logger.warn('Redis not connected - cache invalidation will rely on TTL');
        }
      } catch (redisError: any) {
        logger.warn('Could not publish Redis event for image description prompt', {
          error: redisError.message,
        });
      }

      res.json({
        success: true,
        data: {
          id: updated.id,
          prompt: updated.value,
          updatedAt: updated.updatedAt,
        },
        message: 'Prompt de descrição de imagem atualizado com sucesso',
      });
    } catch (error: any) {
      logger.error('Error in updateImageDescriptionPrompt controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar prompt de descrição de imagem',
      });
    }
  }

  /**
   * Reset AI memory for testing
   * DELETE /ai/config/memory/reset
   */
  private async resetMemory(req: Request, res: Response): Promise<void> {
    try {
      const {
        supervisorId,
        sellerId,
        clientPhone,
        resetUnassigned,
        resetAll,
        options,
      }: {
        supervisorId?: string;
        sellerId?: string;
        clientPhone?: string;
        resetUnassigned?: boolean;
        resetAll?: boolean;
        options: ResetMemoryOptions;
      } = req.body;

      // Validate options
      if (!options || typeof options !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Opções de reset são obrigatórias',
        });
        return;
      }

      logger.info('Memory reset requested', {
        supervisorId,
        sellerId,
        clientPhone,
        options,
        userId: (req as any).user?.id,
      });

      let result;

      try {
        // Priority: resetAll > clientPhone > sellerId > supervisorId > resetUnassigned
        if (resetAll) {
          // Reset ALL memory - deletes everything
          logger.warn('⚠️ RESET ALL MEMORY REQUESTED', {
            userId: (req as any).user?.id,
            options,
          });
          result = await this.memoryResetService.resetAllMemory(options);
        } else if (clientPhone) {
          result = await this.memoryResetService.resetMemoryByClient(
            clientPhone,
            sellerId,
            options,
          );
        } else if (sellerId) {
          result = await this.memoryResetService.resetMemoryBySeller(sellerId, options);
        } else if (supervisorId) {
          // Validate supervisorId exists
          if (!supervisorId || supervisorId.trim() === '') {
            res.status(400).json({
              success: false,
              error: 'supervisorId inválido',
            });
            return;
          }
          result = await this.memoryResetService.resetMemoryBySupervisor(
            supervisorId,
            options,
          );
        } else if (resetUnassigned) {
          // Reset unassigned attendances (not routed yet)
          result = await this.memoryResetService.resetMemoryForUnassigned(options);
        } else {
          res.status(400).json({
            success: false,
            error: 'Pelo menos um filtro deve ser fornecido (resetAll, supervisorId, sellerId, clientPhone ou resetUnassigned)',
          });
          return;
        }
      } catch (serviceError: any) {
        logger.error('Error in memory reset service', {
          error: serviceError.message,
          stack: serviceError.stack,
          supervisorId,
          sellerId,
          clientPhone,
        });
        throw serviceError; // Re-throw to be caught by outer catch
      }

      logger.info('Memory reset completed', {
        result,
        userId: (req as any).user?.id,
      });

      res.json({
        success: true,
        data: result,
        message: `Memória resetada com sucesso! ${result.deleted.messages} mensagens, ${result.deleted.attendances} resumos, ${result.deleted.embeddings} embeddings removidos.`,
      });
    } catch (error: any) {
      logger.error('Error in resetMemory controller', {
        error: error.message,
        stack: error.stack,
        supervisorId: req.body?.supervisorId,
        sellerId: req.body?.sellerId,
        clientPhone: req.body?.clientPhone,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao resetar memória da IA',
        details: error.message, // Include error details for debugging
      });
    }
  }

  /**
   * Wipe all data: memory, attendances, clients, quote requests.
   * DELETE /ai/config/memory/wipe-all
   * Apenas SUPER_ADMIN.
   */
  private async wipeAllData(req: Request, res: Response): Promise<void> {
    try {
      const userRole = (req as any).user?.role as UserRole;
      if (userRole !== UserRole.SUPER_ADMIN) {
        res.status(403).json({ success: false, error: 'Apenas Super Admin pode executar esta ação' });
        return;
      }

      logger.warn('⚠️ WIPE ALL DATA requested by user', { userId: (req as any).user?.sub });

      const result = await this.memoryResetService.wipeAllData();

      res.json({
        success: true,
        data: result,
        message: `Sistema completamente limpo! ${result.deleted.messages} mensagens, ${result.deleted.quoteRequests} pedidos de orçamento, ${result.deleted.attendances} atendimentos e ${result.deleted.embeddings} embeddings removidos.`,
      });
    } catch (error: any) {
      logger.error('Error in wipeAllData controller', { error: error.message, stack: error.stack });
      res.status(500).json({
        success: false,
        error: 'Erro ao apagar todos os dados',
        details: error.message,
      });
    }
  }

  /**
   * Get clients by seller
   * GET /ai/config/memory/clients/:sellerId
   */
  private async getClientsBySeller(req: Request, res: Response): Promise<void> {
    try {
      const { sellerId } = req.params;

      if (!sellerId) {
        res.status(400).json({
          success: false,
          error: 'sellerId é obrigatório',
        });
        return;
      }

      const clients = await this.memoryResetService.getClientsBySeller(sellerId);

      res.json({
        success: true,
        data: {
          clients,
        },
      });
    } catch (error: any) {
      logger.error('Error in getClientsBySeller controller', {
        error: error.message,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar clientes',
      });
    }
  }

  /**
   * Get clients by supervisor
   * GET /ai/config/memory/clients/supervisor/:supervisorId
   */
  private async getClientsBySupervisor(req: Request, res: Response): Promise<void> {
    try {
      const { supervisorId } = req.params;

      if (!supervisorId) {
        res.status(400).json({
          success: false,
          error: 'supervisorId é obrigatório',
        });
        return;
      }

      const clients = await this.memoryResetService.getClientsBySupervisor(supervisorId);

      res.json({
        success: true,
        data: {
          clients,
        },
      });
    } catch (error: any) {
      logger.error('Error in getClientsBySupervisor controller', {
        error: error.message,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar clientes',
      });
    }
  }

  /**
   * Purge AI messages queue
   * DELETE /ai/config/queue/purge
   */
  private async purgeQueue(req: Request, res: Response): Promise<void> {
    try {
      const { queueName } = req.body;

      // Default to actual queue name that AI worker uses (hardcoded in Python)
      // The AI worker consumes from 'ai-messages', not the configured queue name
      const targetQueue = queueName || 'ai-messages';

      logger.info('Purging queue', {
        queue: targetQueue,
        userId: (req as any).user?.id,
      });

      const queueService = InfrastructureFactory.createQueue();
      
      // Get message count before purge
      const messageCount = await queueService.getMessageCount(targetQueue);
      
      // Purge the queue
      await queueService.purgeQueue(targetQueue);

      logger.info('Queue purged successfully', {
        queue: targetQueue,
        messagesDeleted: messageCount,
        userId: (req as any).user?.id,
      });

      res.json({
        success: true,
        data: {
          queue: targetQueue,
          messagesDeleted: messageCount,
        },
        message: `Fila ${targetQueue} limpa com sucesso! ${messageCount} mensagens removidas.`,
      });
    } catch (error: any) {
      logger.error('Error in purgeQueue controller', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao limpar fila do RabbitMQ',
      });
    }
  }

  /**
   * Get queue statistics
   * GET /ai/config/queue/stats
   */
  private async getQueueStats(req: Request, res: Response): Promise<void> {
    try {
      const queueService = InfrastructureFactory.createQueue();
      
      // IMPORTANT: The AI worker uses 'ai-messages' hardcoded in Python
      // So we need to check that queue, not the configured one
      // The configured queue name might be different (e.g., 'altese-ai-requests')
      const actualAiQueue = 'ai-messages'; // This is what the AI worker actually consumes from
      const configuredAiQueue = config.rabbitmq.queues.ai;
      
      const queueNames = {
        ai: actualAiQueue, // Use actual queue name that AI worker uses
        aiConfigured: configuredAiQueue, // Keep for reference
        aiResponses: config.rabbitmq.queues.aiResponses,
        messages: config.rabbitmq.queues.messages,
        notifications: config.rabbitmq.queues.notifications,
      };
      
      logger.info('Getting queue statistics', { 
        queueNames,
        note: 'AI worker uses hardcoded \"ai-messages\" queue',
      });
      
      // Em produção com USE_AWS_QUEUE=true, o InfrastructureFactory usa SQSQueue.
      // Nessa configuração, só temos filas SQS para AI (ai-messages / ai-responses).
      // As filas altese-messages / altese-notifications continuam em RabbitMQ e
      // NÃO existem como SQS – tentar consultá-las em SQS gera InvalidAddress.
      const isSqsMode = config.app.isProduction && config.aws.useQueue;
      
      let aiMessages = 0;
      let aiResponses = 0;
      let messages = 0;
      let notifications = 0;

      if (isSqsMode) {
        // Só consultar as filas que realmente existem em SQS
        [aiMessages, aiResponses] = await Promise.all([
          queueService.getMessageCount(actualAiQueue),
          queueService.getMessageCount(queueNames.aiResponses),
        ]);
        // messages/notifications permanecem 0 (são filas RabbitMQ locais)
      } else {
        // Ambiente local (RabbitMQ) ou produção sem USE_AWS_QUEUE:
        // todas as filas são RabbitMQ e implementam getMessageCount normalmente.
        [aiMessages, aiResponses, messages, notifications] = await Promise.all([
          queueService.getMessageCount(actualAiQueue),
          queueService.getMessageCount(queueNames.aiResponses),
          queueService.getMessageCount(queueNames.messages),
          queueService.getMessageCount(queueNames.notifications),
        ]);
      }
      
      const stats = {
        aiMessages,
        aiResponses,
        messages,
        notifications,
      };

      logger.info('Queue statistics retrieved', { 
        stats,
        queueNames,
        note: `Using actual queue '${actualAiQueue}' (AI worker consumes from this)`,
      });

      res.json({
        success: true,
        data: stats,
      });
    } catch (error: any) {
      logger.error('Error in getQueueStats controller', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar estatísticas das filas',
      });
    }
  }

  /**
   * Debug queue connection and names
   * GET /ai/config/queue/debug
   */
  private async debugQueue(req: Request, res: Response): Promise<void> {
    try {
      const queueService = InfrastructureFactory.createQueue();
      
      // Check both configured and actual queue names
      const actualAiQueue = 'ai-messages'; // What AI worker actually uses
      const configuredAiQueue = config.rabbitmq.queues.ai;
      
      const queueNames = {
        ai: actualAiQueue, // Actual queue used by AI worker
        aiConfigured: configuredAiQueue, // Configured queue (for reference)
        aiResponses: config.rabbitmq.queues.aiResponses,
        messages: config.rabbitmq.queues.messages,
        notifications: config.rabbitmq.queues.notifications,
      };
      
      logger.info('Debug queue - checking all queues', { 
        queueNames,
        note: 'AI worker uses hardcoded "ai-messages" queue',
      });
      
      // Try to get counts and also check if queues exist
      const results: any = {};
      
      // Check actual AI queue first
      try {
        await queueService.assertQueue(actualAiQueue);
        const count = await queueService.getMessageCount(actualAiQueue);
        results.ai = {
          queueName: actualAiQueue,
          messageCount: count,
          exists: true,
          error: null,
          note: 'Actual queue used by AI worker',
        };
      } catch (error: any) {
        results.ai = {
          queueName: actualAiQueue,
          messageCount: 0,
          exists: false,
          error: error.message,
          note: 'Actual queue used by AI worker',
        };
      }
      
      // Also check configured queue for reference
      if (configuredAiQueue !== actualAiQueue) {
        try {
          await queueService.assertQueue(configuredAiQueue);
          const count = await queueService.getMessageCount(configuredAiQueue);
          results.aiConfigured = {
            queueName: configuredAiQueue,
            messageCount: count,
            exists: true,
            error: null,
            note: 'Configured queue (not used by AI worker)',
          };
        } catch (error: any) {
          results.aiConfigured = {
            queueName: configuredAiQueue,
            messageCount: 0,
            exists: false,
            error: error.message,
            note: 'Configured queue (not used by AI worker)',
          };
        }
      }
      
      // Check other queues
      for (const [key, queueName] of Object.entries({
        aiResponses: queueNames.aiResponses,
        messages: queueNames.messages,
        notifications: queueNames.notifications,
      })) {
        try {
          // Assert queue first
          await queueService.assertQueue(queueName);
          
          // Get count
          const count = await queueService.getMessageCount(queueName);
          
          results[key] = {
            queueName,
            messageCount: count,
            exists: true,
            error: null,
          };
        } catch (error: any) {
          results[key] = {
            queueName,
            messageCount: 0,
            exists: false,
            error: error.message,
          };
        }
      }

      logger.info('Queue debug results', { results });

      res.json({
        success: true,
        data: {
          queueNames,
          results,
          config: {
            rabbitmqHost: config.rabbitmq.host,
            rabbitmqPort: config.rabbitmq.port,
            rabbitmqVhost: config.rabbitmq.vhost,
          },
        },
      });
    } catch (error: any) {
      logger.error('Error in debugQueue controller', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao debugar filas',
        details: error.message,
      });
    }
  }

  /**
   * Get all function call prompts
   * GET /ai/config/function-calls
   */
  private async getAllFunctionCallPrompts(req: Request, res: Response): Promise<void> {
    try {
      const prompts = await aiConfigService.getAllFunctionCallPrompts();

      res.json({
        success: true,
        data: prompts,
      });
    } catch (error: any) {
      logger.error('Error in getAllFunctionCallPrompts controller', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar prompts de function calls',
      });
    }
  }

  /**
   * Get function call prompt
   * GET /ai/config/function-calls/:toolName
   */
  private async getFunctionCallPrompt(req: Request, res: Response): Promise<void> {
    try {
      const { toolName } = req.params;

      if (!toolName) {
        res.status(400).json({
          success: false,
          error: 'toolName é obrigatório',
        });
        return;
      }

      const prompt = await aiConfigService.getFunctionCallPrompt(toolName);

      res.json({
        success: true,
        data: {
          toolName,
          prompt: prompt || null, // null if not found (AI Worker will use default)
        },
      });
    } catch (error: any) {
      logger.error('Error in getFunctionCallPrompt controller', {
        error: error.message,
        toolName: req.params.toolName,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar prompt da function call',
      });
    }
  }

  /**
   * Update function call prompt
   * PUT /ai/config/function-calls/:toolName
   */
  private async updateFunctionCallPrompt(req: Request, res: Response): Promise<void> {
    try {
      const { toolName } = req.params;
      const { prompt } = req.body;

      if (!toolName) {
        res.status(400).json({
          success: false,
          error: 'toolName é obrigatório',
        });
        return;
      }

      // Allow empty prompt for creation, but must be a string
      if (prompt !== undefined && typeof prompt !== 'string') {
        res.status(400).json({
          success: false,
          error: 'prompt deve ser uma string',
        });
        return;
      }
      
      // Use empty string if prompt is undefined
      const promptValue = prompt || '';

      logger.info('Updating function call prompt', {
        toolName,
        promptLength: promptValue.length,
        userId: (req as any).user?.id,
      });

      const updated = await aiConfigService.updateFunctionCallPrompt(toolName, promptValue);

      // Publish Redis event for cache invalidation
      try {
        await redisService.publishConfigUpdate('function_call', toolName);
        logger.info('Redis event published for function call prompt update', { toolName });
      } catch (redisError: any) {
        logger.warn('Failed to publish Redis event (non-critical)', {
          error: redisError.message,
          toolName,
        });
      }

      res.json({
        success: true,
        data: {
          toolName,
          prompt: updated.value,
          updatedAt: updated.updatedAt,
        },
        message: `Prompt da function call ${toolName} atualizado com sucesso!`,
      });
    } catch (error: any) {
      logger.error('Error in updateFunctionCallPrompt controller', {
        error: error.message,
        stack: error.stack,
        toolName: req.params.toolName,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar prompt da function call',
      });
    }
  }

  /**
   * Get default function call prompt
   * GET /ai/config/function-calls/:toolName/default
   */
  private async getDefaultFunctionCallPrompt(req: Request, res: Response): Promise<void> {
    try {
      const { toolName } = req.params;

      if (!toolName) {
        res.status(400).json({
          success: false,
          error: 'toolName é obrigatório',
        });
        return;
      }

      // Default prompts are in ai-worker/tools/default_prompts.py
      // This endpoint is for reference/documentation
      res.json({
        success: true,
        data: {
          toolName,
          note: 'Prompt padrão está definido em ai-worker/tools/default_prompts.py',
          location: 'ai-worker/tools/default_prompts.py',
        },
      });
    } catch (error: any) {
      logger.error('Error in getDefaultFunctionCallPrompt controller', {
        error: error.message,
        toolName: req.params.toolName,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar prompt padrão',
      });
    }
  }

  /**
   * Delete function call prompt
   * DELETE /ai/config/function-calls/:toolName
   */
  private async deleteFunctionCallPrompt(req: Request, res: Response): Promise<void> {
    try {
      const { toolName } = req.params;

      if (!toolName) {
        res.status(400).json({
          success: false,
          error: 'toolName é obrigatório',
        });
        return;
      }

      logger.info('Deleting function call prompt', {
        toolName,
        userId: (req as any).user?.id,
      });

      try {
        await aiConfigService.deleteFunctionCallPrompt(toolName);
      } catch (error: any) {
        // If error indicates not found, return success anyway (cleanup was attempted)
        if (error.message && error.message.includes('não encontrada')) {
          logger.info('Function call not found, but cleanup completed', { toolName });
          res.json({
            success: true,
            message: `Function call "${toolName}" não foi encontrada, mas todas as referências foram removidas.`,
          });
          return;
        }
        // Re-throw other errors
        throw error;
      }

      // Publish Redis event for cache invalidation
      try {
        await redisService.publishConfigUpdate('function_call', toolName);
        logger.info('Redis event published for function call prompt deletion', { toolName });
      } catch (redisError: any) {
        logger.warn('Failed to publish Redis event (non-critical)', {
          error: redisError.message,
          toolName,
        });
      }

      res.json({
        success: true,
        message: `Function call "${toolName}" deletada com sucesso!`,
      });
    } catch (error: any) {
      logger.error('Error in deleteFunctionCallPrompt controller', {
        error: error.message,
        stack: error.stack,
        toolName: req.params.toolName,
      });
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao deletar function call',
      });
    }
  }

  /**
   * Get message buffer configuration
   * GET /ai/config/buffer
   */
  private async getBufferConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = await aiConfigService.getBufferConfig();

      res.json({
        success: true,
        data: config,
      });
    } catch (error: any) {
      logger.error('Error in getBufferConfig controller', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar configuração de buffer',
      });
    }
  }

  /**
   * Update message buffer configuration
   * PUT /ai/config/buffer
   */
  private async updateBufferConfig(req: Request, res: Response): Promise<void> {
    try {
      const { enabled, bufferTimeMs } = req.body;

      // Validate input
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'enabled deve ser um booleano',
        });
        return;
      }

      if (typeof bufferTimeMs !== 'number' || bufferTimeMs < 3000 || bufferTimeMs > 15000) {
        res.status(400).json({
          success: false,
          error: 'bufferTimeMs deve ser um número entre 3000 e 15000 (3-15 segundos)',
        });
        return;
      }

      logger.info('Updating buffer configuration', {
        enabled,
        bufferTimeMs,
        userId: (req as any).user?.id,
      });

      const updated = await aiConfigService.updateBufferConfig({
        enabled,
        bufferTimeMs,
      });

      res.json({
        success: true,
        data: {
          enabled: updated.enabled,
          bufferTimeMs: updated.bufferTimeMs,
          updatedAt: updated.updatedAt,
        },
        message: 'Configuração de buffer atualizada com sucesso!',
      });
    } catch (error: any) {
      logger.error('Error in updateBufferConfig controller', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar configuração de buffer',
      });
    }
  }

  /**
   * Get agent temperature
   * GET /ai/config/temperature
   */
  private async getTemperature(req: Request, res: Response): Promise<void> {
    try {
      const temperature = await aiConfigService.getAgentTemperature();
      res.json({
        success: true,
        data: { temperature },
      });
    } catch (error: any) {
      logger.error('Error in getTemperature controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar temperatura do agente',
      });
    }
  }

  /**
   * Update agent temperature
   * PUT /ai/config/temperature
   */
  private async updateTemperature(req: Request, res: Response): Promise<void> {
    try {
      const { temperature } = req.body;
      if (typeof temperature !== 'number' || temperature < 0 || temperature > 2) {
        res.status(400).json({
          success: false,
          error: 'temperature deve ser um número entre 0 e 2',
        });
        return;
      }
      const updated = await aiConfigService.updateAgentTemperature(temperature);
      try {
        if (redisService.isConnected()) {
          await redisService.publishConfigUpdate('agent_temperature');
          logger.info('✅ Published Redis event for temperature update');
        }
      } catch (redisError: any) {
        logger.error('Failed to publish Redis event', { error: redisError.message });
      }
      res.json({
        success: true,
        data: {
          temperature: updated.temperature,
          updatedAt: updated.updatedAt,
        },
        message: 'Temperatura do agente atualizada com sucesso!',
      });
    } catch (error: any) {
      logger.error('Error in updateTemperature controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar temperatura do agente',
      });
    }
  }

  /**
   * Get AI module enabled (worker consumes RabbitMQ when true)
   * GET /ai/config/ai-enabled
   */
  private async getAIEnabled(req: Request, res: Response): Promise<void> {
    try {
      const enabled = await aiConfigService.getAIModuleEnabled();
      res.json({ success: true, data: { enabled } });
    } catch (error: any) {
      logger.error('Error in getAIEnabled controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar estado da IA',
      });
    }
  }

  /**
   * Update AI module enabled
   * PUT /ai/config/ai-enabled
   */
  private async updateAIEnabled(req: Request, res: Response): Promise<void> {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'enabled deve ser um booleano',
        });
        return;
      }
      const updated = await aiConfigService.updateAIModuleEnabled(enabled);
      try {
        if (redisService.isConnected()) {
          await redisService.publishConfigUpdate('ai_enabled');
          logger.info('✅ Published Redis event for ai_enabled update');
        }
      } catch (redisError: any) {
        logger.error('Failed to publish Redis event', { error: redisError.message });
      }
      res.json({
        success: true,
        data: { enabled: updated.enabled, updatedAt: updated.updatedAt },
        message: enabled ? 'IA ligada – worker voltará a consumir a fila.' : 'IA desligada – worker parou de consumir a fila.',
      });
    } catch (error: any) {
      logger.error('Error in updateAIEnabled controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar estado da IA',
      });
    }
  }

  /**
   * Get blacklist config
   * GET /ai/config/blacklist
   */
  private async getBlacklist(req: Request, res: Response): Promise<void> {
    try {
      const data = await aiConfigService.getBlacklistConfig();
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('Error in getBlacklist controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar blacklist',
      });
    }
  }

  /**
   * Update blacklist config
   * PATCH /ai/config/blacklist
   * Body: { enabled: boolean, numbers: string[] }
   */
  private async updateBlacklist(req: Request, res: Response): Promise<void> {
    try {
      const { enabled, numbers } = req.body;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'enabled deve ser um booleano',
        });
        return;
      }
      const data = await aiConfigService.updateBlacklistConfig({
        enabled,
        numbers: Array.isArray(numbers) ? numbers : [],
      });
      res.json({
        success: true,
        data,
        message: data.enabled
          ? `Blacklist ativada com ${data.numbers.length} número(s).`
          : 'Blacklist desativada.',
      });
    } catch (error: any) {
      logger.error('Error in updateBlacklist controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar blacklist',
      });
    }
  }

  /**
   * Get OpenAI model
   * GET /ai/config/model
   */
  private async getModel(req: Request, res: Response): Promise<void> {
    try {
      const model = await aiConfigService.getOpenAIModel();
      res.json({ success: true, data: { model } });
    } catch (error: any) {
      logger.error('Error in getModel controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar modelo OpenAI',
      });
    }
  }

  /**
   * Update OpenAI model
   * PUT /ai/config/model
   */
  private async updateModel(req: Request, res: Response): Promise<void> {
    try {
      const { model } = req.body;
      if (!model || typeof model !== 'string' || !model.trim()) {
        res.status(400).json({
          success: false,
          error: 'model é obrigatório e deve ser uma string',
        });
        return;
      }
      const updated = await aiConfigService.updateOpenAIModel(model.trim());
      try {
        if (redisService.isConnected()) {
          await redisService.publishConfigUpdate('openai_model');
          logger.info('✅ Published Redis event for openai_model update');
        }
      } catch (redisError: any) {
        logger.error('Failed to publish Redis event', { error: redisError.message });
      }
      res.json({
        success: true,
        data: { model: updated.model, updatedAt: updated.updatedAt },
        message: 'Modelo OpenAI atualizado. O worker usará o novo modelo na próxima mensagem.',
      });
    } catch (error: any) {
      logger.error('Error in updateModel controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao atualizar modelo OpenAI',
      });
    }
  }

  /**
   * Handle typing event to reset buffer timer
   * POST /ai/config/buffer/typing/:attendanceId
   */
  private async handleTypingEvent(req: Request, res: Response): Promise<void> {
    try {
      const { attendanceId } = req.params;

      if (!attendanceId) {
        res.status(400).json({
          success: false,
          error: 'attendanceId é obrigatório',
        });
        return;
      }

      logger.debug('Typing event received', { attendanceId });

      await messageBufferService.onTypingEvent(attendanceId as any);

      res.json({
        success: true,
        message: 'Typing event processado',
      });
    } catch (error: any) {
      logger.error('Error in handleTypingEvent controller', {
        error: error.message,
        attendanceId: req.params.attendanceId,
      });
      res.status(500).json({
        success: false,
        error: 'Erro ao processar typing event',
      });
    }
  }

  /**
   * Get auto-reopen timeout configuration
   * GET /ai/config/auto-reopen-timeout
   */
  private async getAutoReopenTimeout(req: Request, res: Response): Promise<void> {
    try {
      const timeoutMinutes = await aiConfigService.getAutoReopenTimeout();
      res.json({
        success: true,
        data: { timeoutMinutes },
      });
    } catch (error: any) {
      logger.error('Error in getAutoReopenTimeout controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Erro ao buscar configuração de reabertura automática',
      });
    }
  }

  /**
   * Update auto-reopen timeout configuration
   * PUT /ai/config/auto-reopen-timeout
   */
  private async updateAutoReopenTimeout(req: Request, res: Response): Promise<void> {
    try {
      const { timeoutMinutes } = req.body;
      if (typeof timeoutMinutes !== 'number' || timeoutMinutes < 1 || timeoutMinutes > 480) {
        res.status(400).json({
          success: false,
          error: 'timeoutMinutes deve ser um número entre 1 e 480 (minutos)',
        });
        return;
      }

      const updated = await aiConfigService.updateAutoReopenTimeout(timeoutMinutes);
      
      try {
        if (redisService.isConnected()) {
          await redisService.publishConfigUpdate('auto_reopen_timeout');
          logger.info('✅ Published Redis event for auto_reopen_timeout update');
        }
      } catch (redisError: any) {
        logger.error('Failed to publish Redis event', { error: redisError.message });
      }

      res.json({
        success: true,
        data: updated,
      });
    } catch (error: any) {
      logger.error('Error in updateAutoReopenTimeout controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao atualizar tempo de reabertura automática',
      });
    }
  }

  /**
   * GET /ai/config/subdivision-inactivity-timeouts
   * Get subdivision inactivity timeouts configuration
   */
  private async getSubdivisionInactivityTimeouts(req: Request, res: Response): Promise<void> {
    try {
      const timeouts = await aiConfigService.getSubdivisionInactivityTimeouts();
      res.json({
        success: true,
        data: { timeouts },
      });
    } catch (error: any) {
      logger.error('Error in getSubdivisionInactivityTimeouts controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao buscar tempos de inatividade por subdivisão',
      });
    }
  }

  /**
   * PUT /ai/config/subdivision-inactivity-timeouts
   * Update subdivision inactivity timeouts configuration
   */
  private async updateSubdivisionInactivityTimeouts(req: Request, res: Response): Promise<void> {
    try {
      const { timeouts } = req.body as { timeouts: Record<string, number> };
      
      if (!timeouts || typeof timeouts !== 'object') {
        res.status(400).json({
          success: false,
          error: 'timeouts deve ser um objeto com chaves de subdivisão e valores em minutos',
        });
        return;
      }
      
      const updated = await aiConfigService.updateSubdivisionInactivityTimeouts(timeouts);
      res.json({
        success: true,
        data: updated,
      });
    } catch (error: any) {
      logger.error('Error in updateSubdivisionInactivityTimeouts controller', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao atualizar tempos de inatividade por subdivisão',
      });
    }
  }

  /**
   * GET /ai/config/follow-up-config
   */
  private async getFollowUpConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = await aiConfigService.getFollowUpConfig();
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('Error in getFollowUpConfig', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao buscar configuração de follow-up',
      });
    }
  }

  /**
   * PUT /ai/config/follow-up-config
   */
  private async updateFollowUpConfig(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as {
        firstDelayMinutes?: number;
        secondDelayMinutes?: number;
        closeDelayMinutes?: number;
        firstMessage?: string;
        secondMessage?: string;
      };
      const config = await aiConfigService.getFollowUpConfig();
      const updated = await aiConfigService.updateFollowUpConfig({
        firstDelayMinutes: body.firstDelayMinutes ?? config.firstDelayMinutes,
        secondDelayMinutes: body.secondDelayMinutes ?? config.secondDelayMinutes,
        closeDelayMinutes: body.closeDelayMinutes ?? config.closeDelayMinutes,
        firstMessage: body.firstMessage ?? config.firstMessage,
        secondMessage: body.secondMessage ?? config.secondMessage,
      });
      res.json({ success: true, data: updated });
    } catch (error: any) {
      logger.error('Error in updateFollowUpConfig', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message || 'Erro ao atualizar configuração de follow-up',
      });
    }
  }

  /**
   * GET /ai/config/follow-up-movement-config
   */
  private async getFollowUpMovementConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = await aiConfigService.getFollowUpMovementConfig();
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('Error in getFollowUpMovementConfig', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao buscar configuração de movimentação',
      });
    }
  }

  /**
   * PUT /ai/config/follow-up-movement-config
   */
  private async updateFollowUpMovementConfig(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as {
        moveOpenToFirstFollowUpMinutes?: number;
        moveToFechadosAfterSecondFollowUpMinutes?: number;
      };
      const config = await aiConfigService.getFollowUpMovementConfig();
      const updated = await aiConfigService.updateFollowUpMovementConfig({
        moveOpenToFirstFollowUpMinutes: body.moveOpenToFirstFollowUpMinutes ?? config.moveOpenToFirstFollowUpMinutes,
        moveToFechadosAfterSecondFollowUpMinutes: body.moveToFechadosAfterSecondFollowUpMinutes ?? config.moveToFechadosAfterSecondFollowUpMinutes,
      });
      res.json({ success: true, data: updated });
    } catch (error: any) {
      logger.error('Error in updateFollowUpMovementConfig', { error: error.message });
      res.status(400).json({
        success: false,
        error: error.message || 'Erro ao atualizar configuração de movimentação',
      });
    }
  }
}