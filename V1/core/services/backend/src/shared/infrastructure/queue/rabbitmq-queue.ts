import amqp from 'amqplib';
import { IQueue } from './queue.interface';
import config from '../../../config/app.config';
import { logger } from '../../utils/logger';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

export class RabbitMQQueue implements IQueue {
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;
  private isConnecting = false;
  private readonly connectionWaitTimeoutMs = 15000;
  private readonly connectionPollIntervalMs = 100;

  constructor() {
    this.connect();
  }

  private async connect(): Promise<void> {
    if (this.isConnecting || this.connection) {
      return;
    }

    this.isConnecting = true;

    try {
      const connectionString = `amqp://${config.rabbitmq.username}:${config.rabbitmq.password}@${config.rabbitmq.host}:${config.rabbitmq.port}${config.rabbitmq.vhost}`;
      
      this.connection = await amqp.connect(connectionString, {
        heartbeat: 60,
      });

      this.channel = await this.connection.createChannel();
      await this.channel.prefetch(10);

      this.connection.on('error', (error) => {
        logger.error('RabbitMQ connection error:', error);
        this.reconnect();
      });

      this.connection.on('close', () => {
        logger.warn('RabbitMQ connection closed. Reconnecting...');
        this.reconnect();
      });

      logger.info('RabbitMQ queue connected successfully');

      // Assert default queues
      await this.assertQueue(config.rabbitmq.queues.messages);
      await this.assertQueue(config.rabbitmq.queues.ai);
      await this.assertQueue(config.rabbitmq.queues.notifications);
    } catch (error) {
      logger.error('Failed to connect to RabbitMQ:', error);
      this.reconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  private async reconnect(): Promise<void> {
    this.connection = null;
    this.channel = null;
    
    setTimeout(() => {
      logger.info('Attempting to reconnect to RabbitMQ...');
      this.connect();
    }, 5000);
  }

  private async ensureConnection(): Promise<void> {
    // Fast path when connection/channel already exist and are healthy.
    if (this.connection && this.channel) {
      const conn = this.connection as { connection?: { destroyed?: boolean } } | null;
      if (!conn?.connection?.destroyed) {
        return;
      }
      logger.warn('RabbitMQ connection was destroyed, reconnecting...');
      this.connection = null;
      this.channel = null;
    }

    // Trigger connect if nothing is in flight.
    if (!this.isConnecting) {
      await this.connect();
    }

    // Wait for in-flight connection attempts to complete.
    const startedAt = Date.now();
    while ((!this.connection || !this.channel || this.isConnecting) && Date.now() - startedAt < this.connectionWaitTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, this.connectionPollIntervalMs));
      if (!this.connection && !this.isConnecting) {
        await this.connect();
      }
    }

    if (!this.connection || !this.channel) {
      throw new Error('RabbitMQ connection/channel not ready after waiting');
    }

    // Verify connection is still alive after wait.
    const conn = this.connection as { connection?: { destroyed?: boolean } } | null;
    if (conn?.connection?.destroyed) {
      logger.warn('RabbitMQ connection became destroyed after wait, reconnecting...');
      this.connection = null;
      this.channel = null;
      await this.connect();
      if (!this.connection || !this.channel) {
        throw new Error('RabbitMQ connection/channel unavailable after reconnect');
      }
    }
  }

  async publish(queue: string, message: unknown): Promise<void> {
    try {
      await this.ensureConnection();
      
      if (!this.channel) {
        throw new Error('RabbitMQ channel not available');
      }

      await this.assertQueue(queue);
      
      const messageBuffer = Buffer.from(JSON.stringify(message));
      this.channel.sendToQueue(queue, messageBuffer, {
        persistent: true,
        // Don't send timestamp - causes parsing errors in Python consumer
      });

      logger.debug(`Message published to queue ${queue}`);
    } catch (error) {
      logger.error(`Error publishing message to queue ${queue}:`, error);
      throw error;
    }
  }

  async consume(queue: string, callback: (message: unknown) => Promise<void>): Promise<void> {
    try {
      await this.ensureConnection();
      
      if (!this.channel) {
        throw new Error('RabbitMQ channel not available');
      }

      await this.assertQueue(queue);

      await this.channel.consume(
        queue,
        async (msg) => {
          if (!msg) {
            return;
          }

          try {
            const content = JSON.parse(msg.content.toString());
            await callback(content);
            
            // Acknowledge message
            this.channel?.ack(msg);
            logger.debug(`Message consumed from queue ${queue}`);
          } catch (error) {
            logger.error(`Error processing message from queue ${queue}:`, error);
            
            // Reject and requeue message (up to 3 times)
            const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1;
            
            if (retryCount < 3) {
              this.channel?.nack(msg, false, true);
            } else {
              // Send to dead letter queue or discard
              this.channel?.nack(msg, false, false);
              logger.error(`Message discarded after ${retryCount} retries`);
            }
          }
        },
        {
          noAck: false,
        }
      );

      logger.info(`Started consuming from queue: ${queue}`);
    } catch (error) {
      logger.error(`Error consuming from queue ${queue}:`, error);
      throw error;
    }
  }

  async assertQueue(queue: string): Promise<void> {
    try {
      await this.ensureConnection();
      
      if (!this.channel) {
        throw new Error('RabbitMQ channel not available');
      }

      const result = await this.channel.assertQueue(queue, {
        durable: true,
        arguments: {
          'x-queue-type': 'classic',
        },
      });
      
      logger.debug(`Queue ${queue} asserted`, {
        queue: result.queue,
        messageCount: result.messageCount,
        consumerCount: result.consumerCount,
      });
    } catch (error) {
      logger.error(`Error asserting queue ${queue}:`, error);
      throw error;
    }
  }

  async getMessageCount(queue: string): Promise<number> {
    try {
      await this.ensureConnection();
      
      if (!this.channel) {
        logger.error('RabbitMQ channel not available');
        throw new Error('RabbitMQ channel not available');
      }

      // Assert queue first to ensure it exists
      await this.assertQueue(queue);

      // Check queue and get message count
      // checkQueue returns queue info including messageCount
      const queueInfo = await this.channel.checkQueue(queue);
      const count = queueInfo?.messageCount ?? 0;
      
      logger.info(`Queue ${queue} message count: ${count}`, {
        queue,
        messageCount: count,
        consumerCount: queueInfo?.consumerCount ?? 0,
      });
      
      return count;
    } catch (error: any) {
      logger.error(`Error getting message count for queue ${queue}:`, {
        error: error.message,
        stack: error.stack,
        queue,
      });
      // Return 0 on error instead of throwing
      return 0;
    }
  }

  async purgeQueue(queue: string): Promise<void> {
    try {
      await this.ensureConnection();
      
      if (!this.channel) {
        throw new Error('RabbitMQ channel not available');
      }

      // Assert queue first to ensure it exists
      await this.assertQueue(queue);

      // Get count before purging for logging
      const queueInfo = await this.channel.checkQueue(queue);
      const messageCount = queueInfo?.messageCount ?? 0;

      // Purge the queue
      await this.channel.purgeQueue(queue);
      
      logger.info(`Queue ${queue} purged successfully`, {
        queue,
        messagesDeleted: messageCount,
      });
    } catch (error: any) {
      logger.error(`Error purging queue ${queue}:`, {
        error: error.message,
        stack: error.stack,
        queue,
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      
      if (this.connection && typeof (this.connection as any).close === 'function') {
        await (this.connection as any).close();
      }
      
      logger.info('RabbitMQ queue disconnected');
    } catch (error) {
      logger.error('Error disconnecting from RabbitMQ:', error);
      throw error;
    }
  }
}
