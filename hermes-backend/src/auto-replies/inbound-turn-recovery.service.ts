import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { AUTO_REPLY_QUEUE, AutoReplyJobData } from './auto-reply.constants';
import { InboundTurnService } from './inbound-turn.service';

@Injectable()
export class InboundTurnRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InboundTurnRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;

  constructor(
    private readonly turns: InboundTurnService,
    @InjectQueue(AUTO_REPLY_QUEUE)
    private readonly queue: Queue<AutoReplyJobData>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.scan(), 5000);
    this.timer.unref();
    void this.scan();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const turns = await this.turns.recoverable();
      for (const turn of turns) {
        await this.queue.add(
          'send-auto-reply',
          {
            conversationId: turn.conversationId,
            contactId: turn.contactId,
            inboundMessageId: turn.lastMessageId,
            inboundTurnId: turn.id,
          },
          {
            jobId: `turn-recovery-${turn.id}-${Math.floor(Date.now() / 5000)}`,
          },
        );
      }
    } catch (error) {
      this.logger.warn(
        `No se pudieron recuperar turnos pendientes: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.scanning = false;
    }
  }
}
