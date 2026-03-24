import axios from 'axios';
import { logger } from '../../../shared/utils/logger';
import config from '../../../config/app.config';
import { InfrastructureFactory } from '../../../shared/infrastructure/factories/infrastructure.factory';
import { FunctionCallInputService } from '../application/services/function-call-input.service';
import { createRegistrarPosVendaEcommerceProcessor } from '../application/services/registrar-posvenda-ecommerce.processor';
import { createRegistrarPosVendaTelefoneFixoProcessor } from '../application/services/registrar-posvenda-telefone-fixo.processor';
import { createRoteamentoBalcaoProcessor } from '../application/services/roteamento-balcao.processor';
import { createRegistrarGarantiaCallCenterProcessor } from '../application/services/registrar-garantia-callcenter.processor';
import { createRegistrarTrocaCallCenterProcessor } from '../application/services/registrar-troca-callcenter.processor';
import { createRegistrarEstornoCallCenterProcessor } from '../application/services/registrar-estorno-callcenter.processor';
import { createIdentificarMarcaProcessor } from '../application/services/identificar-marca.processor';
import { createPedidoOrcamentoProcessor } from '../application/services/pedido-orcamento.processor';
import { createRespostaPerguntaOrcamentoProcessor } from '../application/services/resposta-pergunta-orcamento.processor';
import { createTrocarAtendimentoAtivoProcessor } from '../application/services/trocar-atendimento-ativo.processor';
import { createFechaAtendimentoBalcaoProcessor } from '../application/services/fecha-atendimento-balcao.processor';
import { createAlocaEcommerceProcessor } from '../application/services/aloca-ecommerce.processor';
import { createAlocaBalcaoProcessor } from '../application/services/aloca-balcao.processor';
import { createAlocaFixoProcessor } from '../application/services/aloca-fixo.processor';
import { createEnviaEcommerceProcessor } from '../application/services/envia-ecommerce.processor';
import { createRecuperarAtendimentoProcessor } from '../application/services/recuperar-atendimento.processor';
import { createRoteiamarcaProcessor } from '../application/services/roteiamarca.processor';
import { createAlocaGerentesProcessor } from '../application/services/aloca-gerentes.processor';
import { createEnviaCasosGerentesProcessor } from '../application/services/envia-casos-gerentes.processor';
import { createAlocaProteseCapilarProcessor } from '../application/services/aloca-protese-capilar.processor';
import { createAlocaOutrosAssuntosProcessor } from '../application/services/aloca-outros-assuntos.processor';
import { createInteresseAiSubdivisionProcessor } from '../application/services/interesse-ai-subdivision.processor';
import { createAgendamentoAiSubdivisionProcessor } from '../application/services/agendamento-ai-subdivision.processor';
import { FunctionCallConfigService } from '../application/services/function-call-config.service';
import { ProcessExecutionService } from '../application/services/process-execution.service';
import type { FunctionCallProcessorHandler } from '../domain/interfaces/function-call-processor.interface';

export type { FunctionCallProcessorHandler };

/**
 * Worker que consome a fila function_call_process e publica respostas em function_call_response.
 * Usa IQueue (RabbitMQ ou SQS conforme config) para compatibilidade com AWS.
 * Mensagem de entrada deve ter no body: function_call_name, correlation_id, attendance_id, result, client_phone, etc.
 * Resposta publicada em function_call_response: { correlation_id, output, data, processed }.
 */
export class FunctionCallProcessorWorker {
  private queueService = InfrastructureFactory.createQueue();
  private queueProcess = config.rabbitmq.queues.functionCallProcess ?? 'function_call_process';
  private queueResponse = config.rabbitmq.queues.functionCallResponse ?? 'function_call_response';
  private inputService = new FunctionCallInputService();
  private configService = new FunctionCallConfigService();
  private processExecutionService = new ProcessExecutionService();

  private processors = new Map<string, FunctionCallProcessorHandler>();

  registerProcessor(functionCallName: string, handler: FunctionCallProcessorHandler): void {
    this.processors.set(functionCallName, handler);
    logger.info(`Function call processor registered: ${functionCallName}`);
  }

  async start(): Promise<void> {
    try {
      this.registerProcessor('registrarposvendaecommerce', createRegistrarPosVendaEcommerceProcessor());
      this.registerProcessor('registrarposvendatelefonefixo', createRegistrarPosVendaTelefoneFixoProcessor());
      this.registerProcessor('roteamentobalcao', createRoteamentoBalcaoProcessor());
      this.registerProcessor('registrargarantiacallcenter', createRegistrarGarantiaCallCenterProcessor());
      this.registerProcessor('registrartrocacallcenter', createRegistrarTrocaCallCenterProcessor());
      this.registerProcessor('registrarestornocallcenter', createRegistrarEstornoCallCenterProcessor());
      this.registerProcessor('identificamarca', createIdentificarMarcaProcessor());
      const pedidoOrcamentoProcessor = createPedidoOrcamentoProcessor();
      this.registerProcessor('pedidoorcamento', pedidoOrcamentoProcessor);
      this.registerProcessor('pedido-orcamento', pedidoOrcamentoProcessor);
      this.registerProcessor('respostaperguntaorcamento', createRespostaPerguntaOrcamentoProcessor());
      this.registerProcessor('trocaratendimentoativo', createTrocarAtendimentoAtivoProcessor());
      this.registerProcessor('fechaatendimentobalcao', createFechaAtendimentoBalcaoProcessor());
      this.registerProcessor('alocaecommerce', createAlocaEcommerceProcessor());
      this.registerProcessor('alocabalcao', createAlocaBalcaoProcessor());
      const alocaFixoProcessor = createAlocaFixoProcessor();
      this.registerProcessor('alocafixo', alocaFixoProcessor);
      this.registerProcessor('aloca-fixo', alocaFixoProcessor);
      this.registerProcessor('manutencao', alocaFixoProcessor);
      this.registerProcessor('alocamanutencao', alocaFixoProcessor);
      this.registerProcessor('aloca-manutencao', alocaFixoProcessor);
      this.registerProcessor('enviaecommerce', createEnviaEcommerceProcessor());
      this.registerProcessor('recuperaratendimento', createRecuperarAtendimentoProcessor());
      this.registerProcessor('roteiamarca', createRoteiamarcaProcessor());
      this.registerProcessor('alocagerentes', createAlocaGerentesProcessor());
      this.registerProcessor('enviacasosgerentes', createEnviaCasosGerentesProcessor());
      const alocaOutrosAssuntosProcessor = createAlocaOutrosAssuntosProcessor();
      this.registerProcessor('outrosassuntos', alocaOutrosAssuntosProcessor);
      this.registerProcessor('outros-assuntos', alocaOutrosAssuntosProcessor);
      this.registerProcessor('alocaoutrosassuntos', alocaOutrosAssuntosProcessor);
      this.registerProcessor('aloca-outros-assuntos', alocaOutrosAssuntosProcessor);
      const alocaProteseCapilarProcessor = createAlocaProteseCapilarProcessor();
      this.registerProcessor('alocaprotesecapilar', alocaProteseCapilarProcessor);
      this.registerProcessor('aloca-protese-capilar', alocaProteseCapilarProcessor);
      this.registerProcessor('protesecapilar', alocaProteseCapilarProcessor);
      this.registerProcessor('protese-capilar', alocaProteseCapilarProcessor);

      const interesseFlashDay = createInteresseAiSubdivisionProcessor('flash-day');
      const interesseLocacao = createInteresseAiSubdivisionProcessor('locacao-estudio');
      const interesseCaptacao = createInteresseAiSubdivisionProcessor('captacao-videos');
      this.registerProcessor('interesse_flash_day', interesseFlashDay);
      this.registerProcessor('interesse-flash-day', interesseFlashDay);
      this.registerProcessor('interesse_locacao_estudio', interesseLocacao);
      this.registerProcessor('interesse-locacao-estudio', interesseLocacao);
      this.registerProcessor('interesse_captacao_videos', interesseCaptacao);
      this.registerProcessor('interesse-captacao-videos', interesseCaptacao);

      const agFlashDay = createAgendamentoAiSubdivisionProcessor('flash-day');
      const agLocacao = createAgendamentoAiSubdivisionProcessor('locacao-estudio');
      const agCaptacao = createAgendamentoAiSubdivisionProcessor('captacao-videos');
      this.registerProcessor('agendamento_flash_day', agFlashDay);
      this.registerProcessor('agendamento-flash-day', agFlashDay);
      this.registerProcessor('agendamento_locacao_estudio', agLocacao);
      this.registerProcessor('agendamento-locacao-estudio', agLocacao);
      this.registerProcessor('agendamento_captacao_videos', agCaptacao);
      this.registerProcessor('agendamento-captacao-videos', agCaptacao);

      await this.queueService.assertQueue(this.queueProcess);
      await this.queueService.assertQueue(this.queueResponse);

      await this.queueService.consume(this.queueProcess, async (message: unknown) => {
        const payload = message as Record<string, unknown>;
        const functionCallName = String(payload.function_call_name ?? '').trim() || this.getFunctionCallNameFromRouting(payload);
        const correlationId = payload.correlation_id as string | undefined;

        let result: { output: string | null; data?: Record<string, unknown>; processed: boolean };
        try {
          logger.info(`Processing function call: ${functionCallName}`, {
            functionCallName,
            attendanceId: payload.attendance_id,
            correlationId,
          });

          // Fallback inteligente para FCs customizadas de roteamento humano
          const normalizedFc = functionCallName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const dynamicProteseHandler =
            normalizedFc.includes('protese') && normalizedFc.includes('capilar')
              ? createAlocaProteseCapilarProcessor()
              : null;
          const dynamicManutencaoHandler =
            normalizedFc.includes('manutencao')
              ? createAlocaFixoProcessor()
              : null;
          const dynamicOutrosHandler =
            normalizedFc.includes('outros') && normalizedFc.includes('assuntos')
              ? createAlocaOutrosAssuntosProcessor()
              : null;
          const handler =
            this.processors.get(functionCallName) ??
            dynamicProteseHandler ??
            dynamicManutencaoHandler ??
            dynamicOutrosHandler ??
            this.defaultProcessor.bind(this);
          result = await handler({
            function_call_name: functionCallName,
            result: String(payload.result ?? ''),
            attendance_id: String(payload.attendance_id ?? ''),
            client_phone: String(payload.client_phone ?? ''),
            correlation_id: correlationId,
          });
        } catch (err: any) {
          logger.error(`Error processing function call ${functionCallName}: ${err?.message}`, {
            error: err?.message,
            stack: err?.stack,
          });
          result = { output: null, processed: false, data: { error: err?.message ?? 'Unknown error' } };
        }

        if (correlationId) {
          try {
            await this.queueService.publish(this.queueResponse, {
              correlation_id: correlationId,
              output: result.output,
              data: result.data,
              processed: result.processed,
            });
            logger.info(`Response sent for ${functionCallName}`, { correlationId });
          } catch (sendErr: any) {
            logger.error(`Failed to send response for ${functionCallName}: ${sendErr?.message}`);
            throw sendErr;
          }
        }

        const fcConfig = await this.configService.getByFunctionCallName(functionCallName);
        if (fcConfig?.processId) {
          try {
            await this.processExecutionService.executeProcess(fcConfig.processId, {
              attendance_id: String(payload.attendance_id ?? ''),
              client_phone: String(payload.client_phone ?? ''),
              result: String(payload.result ?? ''),
              data: result?.data as Record<string, unknown> | undefined,
              ...payload,
            });
          } catch (processErr: any) {
            logger.error(`Failed to execute linked process for ${functionCallName}: ${processErr?.message}`);
          }
        }

        const hasOutput = payload.has_output === true;
        const isSync = payload.is_sync === true;
        if (hasOutput && !isSync && result.output) {
          try {
            const port = config.app?.port ?? 3000;
            const baseUrl = `http://127.0.0.1:${port}`;
            await axios.post(
              `${baseUrl}/api/internal/send-tool-response`,
              {
                attendanceId: String(payload.attendance_id ?? ''),
                content: result.output,
                senderName: 'Altese AI',
              },
              {
                headers: { 'x-internal-auth': config.internal?.apiKey ?? '' },
                timeout: 10000,
              }
            );
            logger.info(`Tool response sent to client (async) for ${functionCallName}`, {
              attendanceId: payload.attendance_id,
            });
          } catch (sendErr: any) {
            logger.error(`Failed to send async tool response to client for ${functionCallName}: ${sendErr?.message}`, {
              attendanceId: payload.attendance_id,
              error: sendErr?.message,
            });
          }
        }

        logger.debug(`Message processed for ${functionCallName}`);
      });

      logger.info('FunctionCallProcessorWorker started and consuming messages');
    } catch (error: any) {
      logger.error(`Error starting FunctionCallProcessorWorker: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /** Fallback when function_call_name is not in body (e.g. RabbitMQ routing key only). */
  private getFunctionCallNameFromRouting(payload: Record<string, unknown>): string {
    const routing = payload.routing_key as string | undefined;
    if (routing && typeof routing === 'string' && routing.startsWith('function_call.')) {
      return routing.replace('function_call.', '');
    }
    return 'unknown';
  }

  private async defaultProcessor(payload: {
    function_call_name: string;
    result: string;
    attendance_id: string;
    client_phone: string;
  }): Promise<{ output: string | null; data?: Record<string, unknown>; processed: boolean }> {
    const functionCallName = payload.function_call_name;
    const resultRaw = payload.result;

    let functionCallResult: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(resultRaw || '{}');
      functionCallResult = typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed };
    } catch {
      functionCallResult = { raw: resultRaw };
    }

    let output: string | null = null;
    const matchingInput = await this.inputService.getMatchingInput(
      functionCallName,
      functionCallResult as Record<string, any>
    );
    if (matchingInput) {
      output = this.inputService.formatInput(matchingInput, functionCallResult as Record<string, any>);
      logger.info('Input matched and formatted', {
        functionCallName,
        inputId: matchingInput.id,
        outputLength: output?.length ?? 0,
      });
    } else {
      logger.debug('No matching input for function call (inputs are optional)', { functionCallName });
    }

    return {
      output,
      data: { ...(functionCallResult as Record<string, unknown>), client_phone: payload.client_phone },
      processed: true,
    };
  }

  async stop(): Promise<void> {
    // IQueue is shared; do not disconnect here to avoid affecting other consumers
    logger.info('FunctionCallProcessorWorker stopped');
  }
}
