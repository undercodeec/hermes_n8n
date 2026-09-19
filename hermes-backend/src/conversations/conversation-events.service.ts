import {
  Injectable,
  Logger,
  MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { interval, map, merge, Observable, of, Subject } from 'rxjs';

export type CustomerMessageEvent = {
  messageId: string;
  conversationId: string;
  contactId: string;
  contactName: string;
  content: string;
  messageType: string;
  createdAt: string;
};

@Injectable()
export class ConversationEventsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ConversationEventsService.name);
  private readonly customerMessages = new Subject<MessageEvent>();
  private readonly channel = 'hermes:crm:customer-messages';
  private publisher?: Redis;
  private subscriber?: Redis;
  private subscriberReady = false;

  constructor(@Optional() private readonly config?: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config?.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL no está configurado; los eventos del CRM serán locales al proceso',
      );
      return;
    }

    const options = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    } as const;
    this.publisher = new Redis(redisUrl, options);
    this.subscriber = new Redis(redisUrl, options);
    this.publisher.on('error', (error) =>
      this.logger.warn(`Redis publisher no disponible: ${error.message}`),
    );
    this.subscriber.on('error', (error) =>
      this.logger.warn(`Redis subscriber no disponible: ${error.message}`),
    );
    this.subscriber.on('ready', () => {
      void this.ensureSubscription();
    });
    this.subscriber.on('close', () => {
      this.subscriberReady = false;
    });
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== this.channel) return;
      try {
        const event = JSON.parse(payload) as CustomerMessageEvent;
        if (!event.messageId || !event.conversationId) return;
        this.emitLocally(event);
      } catch {
        this.logger.warn('Se descartó un evento Redis inválido del CRM');
      }
    });

    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.ensureSubscription();
    } catch (error) {
      this.subscriberReady = false;
      this.logger.warn(
        `No se pudo activar Redis Pub/Sub para el CRM: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriberReady = false;
    await Promise.allSettled([
      this.closeRedis(this.subscriber),
      this.closeRedis(this.publisher),
    ]);
  }

  async publishCustomerMessage(event: CustomerMessageEvent): Promise<void> {
    if (this.publisher?.status === 'ready') {
      try {
        await this.publisher.publish(this.channel, JSON.stringify(event));
        if (!this.subscriberReady) this.emitLocally(event);
        return;
      } catch (error) {
        this.logger.warn(
          `No se pudo publicar el evento CRM en Redis: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.emitLocally(event);
  }

  private emitLocally(event: CustomerMessageEvent): void {
    this.customerMessages.next({ type: 'customer_message', data: event });
  }

  private async ensureSubscription(): Promise<void> {
    if (!this.subscriber || this.subscriber.status !== 'ready') return;
    try {
      await this.subscriber.subscribe(this.channel);
      if (!this.subscriberReady) {
        this.logger.log(`Eventos CRM distribuidos activos en ${this.channel}`);
      }
      this.subscriberReady = true;
    } catch (error) {
      this.subscriberReady = false;
      this.logger.warn(
        `No se pudo suscribir a eventos CRM: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  stream(): Observable<MessageEvent> {
    return merge(
      of({
        type: 'connected',
        data: {
          connectedAt: new Date().toISOString(),
          release: this.config?.get<string>('HERMES_RELEASE', 'development'),
        },
        retry: 3000,
      }),
      this.customerMessages.asObservable(),
      interval(25000).pipe(
        map(() => ({
          type: 'heartbeat',
          data: { at: new Date().toISOString() },
        })),
      ),
    );
  }

  private async closeRedis(client?: Redis): Promise<void> {
    if (!client || client.status === 'end') return;
    if (client.status === 'ready') {
      await client.quit();
      return;
    }
    client.disconnect();
  }
}
