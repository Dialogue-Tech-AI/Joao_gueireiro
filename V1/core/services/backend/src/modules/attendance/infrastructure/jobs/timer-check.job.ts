import { AttendanceInactivityService } from '../../application/services/attendance-inactivity.service';
import { logger } from '../../../../shared/utils/logger';

/**
 * Timer Check Job
 * 
 * Verifica timers de fechamento (e-commerce e balcão) com maior frequência
 * para garantir que atendimentos sejam fechados no momento exato do timer.
 * 
 * Roda a cada 1 minuto para suportar timers de até 1 minuto.
 */
export class TimerCheckJob {
  private inactivityService: AttendanceInactivityService;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly INTERVAL_MS = 60 * 1000; // 1 minuto

  constructor() {
    this.inactivityService = new AttendanceInactivityService();
  }

  /**
   * Start the timer check job
   * Runs every 1 minute
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Timer check job already running');
      return;
    }

    logger.info('Starting timer check job (runs every 1 minute)');

    // Run immediately on start
    this.run();

    // Then run every 1 minute
    this.intervalId = setInterval(() => {
      this.run();
    }, this.INTERVAL_MS);
  }

  /**
   * Stop the timer check job
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped timer check job');
    }
  }

  /**
   * Run the timer check
   * Only checks timers (e-commerce and balcão) for faster execution
   * Also checks subdivision inactivity (runs more frequently for better precision)
   */
  private async run(): Promise<void> {
    try {
      // Check and send follow-up for inactive attendances (runs every 1 minute)
      const followUpsSent = await this.inactivityService.checkAndCloseInactiveAttendances();
      // Check and close balcão attendances with expired FC timer
      const closedByBalcaoTimer = await this.inactivityService.checkAndCloseBalcaoByTimer();
      // Check and close e-commerce attendances with expired timer
      const closedByEcommerceTimer = await this.inactivityService.checkAndCloseEcommerceByTimer();
      // Check and close attendances by subdivision inactivity (configurable per subdivision)
      const closedBySubdivisionInactivity = await this.inactivityService.checkAndCloseBySubdivisionInactivity();
      
      if (followUpsSent > 0 || closedByBalcaoTimer > 0 || closedByEcommerceTimer > 0 || closedBySubdivisionInactivity > 0) {
        logger.info('Timer check job completed', { 
          followUpsSent,
          closedByBalcaoTimer,
          closedByEcommerceTimer,
          closedBySubdivisionInactivity,
        });
      }
    } catch (error: any) {
      logger.error('Error in timer check job', {
        error: error.message,
        stack: error.stack,
      });
    }
  }
}
