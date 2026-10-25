import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { AUTO_REPLY_QUEUE, AutoReplyJobData } from './auto-reply.constants';
import { InboundTurnService } from './inbound-turn.service';
import {
  NOUS_DISPATCH_AMBIGUOUS,
  NORMAL_NOUS_GENERATION_ENGINE,
} from './inbound-turn.service';
import { TasksService } from '../tasks/tasks.service';
import { HandoffReason } from '@prisma/client';
import { HandoffService } from '../handoff/handoff.service';

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
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly handoffs?: HandoffService,
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
        if (
          turn.generationReservedAt &&
          (await this.turns.blockAmbiguous(turn.id))
        ) {
          this.logger.warn(
            JSON.stringify({
              event:
                turn.generationEngine === NORMAL_NOUS_GENERATION_ENGINE
                  ? 'nous_generation_blocked'
                  : 'canary_generation_blocked',
              turnId: turn.id,
              sourceMessageId: turn.generationSourceMessageId,
              reasonCode:
                turn.generationEngine === NORMAL_NOUS_GENERATION_ENGINE
                  ? NOUS_DISPATCH_AMBIGUOUS
                  : 'CANARY_BLOCKED_AMBIGUOUS_GENERATION',
            }),
          );
          if (turn.generationEngine === NORMAL_NOUS_GENERATION_ENGINE)
            await this.requestNousReview(turn);
          continue;
        }
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
      for (const turn of await this.turns.pendingNousReviews())
        await this.requestNousReview(turn);
    } catch (error) {
      this.logger.warn(
        `No se pudieron recuperar turnos pendientes: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.scanning = false;
    }
  }

  private async requestNousReview(turn: {
    id: string;
    conversationId: string;
    contactId: string;
    lastMessageId: string;
    generationSourceMessageId: string | null;
    generationBlockReason: string | null;
  }): Promise<void> {
    if (!this.tasks) return;
    const reason = turn.generationBlockReason ?? NOUS_DISPATCH_AMBIGUOUS;
    try {
      await this.tasks.requestHermesReview({
        conversationId: turn.conversationId,
        contactId: turn.contactId,
        sourceMessageId: turn.generationSourceMessageId ?? turn.lastMessageId,
        category: 'PROVIDER_ERROR',
        code: reason,
        summary: 'Resultado de Nous incierto; revisar y continuar manualmente.',
      });
      if (this.handoffs) {
        try {
          await this.handoffs.create({
            conversationId: turn.conversationId,
            reason: HandoffReason.INFO_ERROR,
            reasonDetail:
              'Nous no confirmó la generación; requiere atención humana.',
          });
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
        }
      }
      await this.turns.markNousReviewed(turn.id, reason);
    } catch {
      this.logger.warn(
        JSON.stringify({
          event: 'nous_review_task_pending_recovery',
          turnId: turn.id,
        }),
      );
    }
  }
}
