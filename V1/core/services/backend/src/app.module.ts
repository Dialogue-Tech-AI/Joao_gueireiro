import { Application } from 'express';
import { AuthController } from './modules/auth/presentation/controllers/auth.controller';
import { UserAdminController } from './modules/auth/presentation/controllers/user-admin.controller';
import { WhatsAppAdminController } from './modules/whatsapp/presentation/controllers/whatsapp-admin.controller';
import { ContactsController } from './modules/whatsapp/presentation/controllers/contacts.controller';
import { AttendanceController } from './modules/attendance/presentation/controllers/attendance.controller';
import { MediaController } from './modules/message/presentation/controllers/media.controller';
import { AIInternalController } from './modules/ai/presentation/controllers/ai-internal.controller';
import { AIConfigController } from './modules/ai/presentation/controllers/ai-config.controller';
import { MultiAgentController } from './modules/ai/presentation/controllers/multi-agent.controller';
import { WorkflowController } from './modules/ai/presentation/controllers/workflow.controller';
import { FunctionCallInputController } from './modules/ai/presentation/controllers/function-call-input.controller';
import { FunctionCallConfigController } from './modules/ai/presentation/controllers/function-call-config.controller';
import { AiCostController } from './modules/ai/presentation/controllers/ai-cost.controller';
import { BibliotecaController } from './modules/ai/presentation/controllers/biblioteca.controller';
import notificationRoutes from './modules/notification/presentation/routes/notification.routes';
import { QuoteRequestController } from './modules/quote/presentation/controllers/quote-request.controller';
import { authMiddleware } from './shared/presentation/middlewares/auth.middleware';
import { requireSupervisor } from './shared/presentation/middlewares/permission.middleware';
import { errorHandlerMiddleware } from './shared/presentation/middlewares/error-handler.middleware';
import { logger } from './shared/utils/logger';

export class AppModule {
  private authController: AuthController;
  private userAdminController: UserAdminController;
  private whatsappAdminController: WhatsAppAdminController;
  private contactsController: ContactsController;
  private attendanceController: AttendanceController;
  private mediaController: MediaController;
  private aiInternalController: AIInternalController;
  private aiConfigController: AIConfigController;
  private multiAgentController: MultiAgentController;
  private workflowController: WorkflowController;
  private functionCallInputController: FunctionCallInputController;
  private functionCallConfigController: FunctionCallConfigController;
  private aiCostController: AiCostController;
  private bibliotecaController: BibliotecaController;
  private quoteRequestController: QuoteRequestController;

  constructor(private app: Application) {
    this.authController = new AuthController();
    this.userAdminController = new UserAdminController();
    this.whatsappAdminController = new WhatsAppAdminController();
    this.contactsController = new ContactsController();
    this.attendanceController = new AttendanceController();
    this.mediaController = new MediaController();
    this.aiInternalController = new AIInternalController();
    this.aiConfigController = new AIConfigController();
    this.multiAgentController = new MultiAgentController();
    this.workflowController = new WorkflowController();
    this.functionCallInputController = new FunctionCallInputController();
    this.functionCallConfigController = new FunctionCallConfigController();
    this.aiCostController = new AiCostController();
    this.bibliotecaController = new BibliotecaController();
    this.quoteRequestController = new QuoteRequestController();
    this.registerRoutes();
    this.registerErrorHandler();
  }

  private registerRoutes(): void {
    // Public routes
    this.app.use('/api/auth', this.authController.router);

    // User admin routes (require auth and SUPER_ADMIN permission)
    this.app.use('/api/users', authMiddleware, this.userAdminController.router);

    // WhatsApp routes (webhook is public, admin routes require auth)
    this.app.use('/api/whatsapp', this.whatsappAdminController.router);

    this.app.use('/api/contacts', authMiddleware, requireSupervisor, this.contactsController.router);

    // Attendance routes (require auth)
    this.app.use('/api/attendances', authMiddleware, this.attendanceController.router);

    // Media routes (require auth)
    this.app.use('/api/media', authMiddleware, this.mediaController.router);

    // Internal API routes (require internal auth key)
    this.app.use('/api/internal', this.aiInternalController.router);

    // AI Config routes (require auth and SUPER_ADMIN permission)
    this.app.use('/api/ai/config', authMiddleware, this.aiConfigController.router);

    // Multi-Agent routes (require auth and SUPER_ADMIN permission)
    this.app.use('/api/ai/multi-agent', authMiddleware, this.multiAgentController.router);

    // Workflow routes (require auth and SUPER_ADMIN permission)
    this.app.use('/api/ai/workflows', authMiddleware, this.workflowController.router);

    // Function Call Input routes (require auth and SUPER_ADMIN permission)
    this.app.use('/api/ai/inputs', authMiddleware, this.functionCallInputController.router);

    // Function Call Config routes (require auth and SUPER_ADMIN permission)
    this.app.use('/api/ai/function-call-configs', authMiddleware, this.functionCallConfigController.router);

    // Notification routes (require auth)
    this.app.use('/api/notifications', notificationRoutes);

    // Quote requests (Pedidos de Orçamento) - require auth
    this.app.use('/api/quote-requests', authMiddleware, this.quoteRequestController.router);

    // AI costs (Super Admin) - require auth, role check inside controller
    this.app.use('/api/ai-costs', authMiddleware, this.aiCostController.router);

    // Biblioteca routes (require auth and SUPER_ADMIN permission)
    this.app.use('/api/biblioteca', authMiddleware, this.bibliotecaController.router);

    // Protected routes example
    // this.app.use('/api/messages', authMiddleware, messageController.router);
    // this.app.use('/api/routing', authMiddleware, routingController.router);
    // this.app.use('/api/sellers', authMiddleware, sellerController.router);
    // this.app.use('/api/supervisors', authMiddleware, supervisorController.router);

    logger.info('All routes registered successfully');
  }

  private registerErrorHandler(): void {
    // Error handler must be last
    this.app.use(errorHandlerMiddleware);
  }
}
