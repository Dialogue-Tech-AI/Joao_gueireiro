import { AttendanceInactivityService } from '../../application/services/attendance-inactivity.service';
import { logger } from '../../../../shared/utils/logger';

export class InactivityCheckJob {
  private inactivityService: AttendanceInactivityService;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  constructor() {
    this.inactivityService = new AttendanceInactivityService();
  }

  /**
   * Start the inactivity check job
   * Runs every 15 minutes
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Inactivity check job already running');
      return;
    }

    logger.info('Starting inactivity check job (runs every 15 minutes)');

    // Run immediately on start
    this.run();

    // Then run every 15 minutes
    this.intervalId = setInterval(() => {
      this.run();
    }, this.INTERVAL_MS);
  }

  /**
   * Stop the inactivity check job
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped inactivity check job');
    }
  }

  /**
   * Run the inactivity check
   */
  private async run(): Promise<void> {
    try {
      // Check and send follow-up for inactive attendances (waiting for client)
      const followUpsSent = await this.inactivityService.checkAndCloseInactiveAttendances();
      // Close attendances where all cases are resolved/cancelled
      const closedByCases = await this.inactivityService.tryCloseByCasesResolved();
      // Check and return inactive assumed attendances to AI (1 hour without human messages)
      const returnedCount = await this.inactivityService.checkAndReturnInactiveAssumedAttendances();
      // Check and close balcão attendances with expired FC timer
      const closedByBalcaoTimer = await this.inactivityService.checkAndCloseBalcaoByTimer();
      // Check and close balcão attendances by general inactivity
      const closedByBalcaoInactivity = await this.inactivityService.checkAndCloseBalcaoByInactivity();
      // Check and close e-commerce attendances with expired timer
      const closedByEcommerceTimer = await this.inactivityService.checkAndCloseEcommerceByTimer();
      // Check and close attendances by subdivision inactivity (configurable per subdivision)
      const closedBySubdivisionInactivity = await this.inactivityService.checkAndCloseBySubdivisionInactivity();
      
      if (followUpsSent > 0 || closedByCases > 0 || returnedCount > 0 || closedByBalcaoTimer > 0 || closedByBalcaoInactivity > 0 || closedByEcommerceTimer > 0 || closedBySubdivisionInactivity > 0) {
        logger.info('Inactivity check job completed', { 
          followUpsSent,
          closedByCases,
          returnedCount,
          closedByBalcaoTimer,
          closedByBalcaoInactivity,
          closedByEcommerceTimer,
          closedBySubdivisionInactivity,
        });
      }
    } catch (error: any) {
      logger.error('Error in inactivity check job', {
        error: error.message,
        stack: error.stack,
      });
    }
  }
}
