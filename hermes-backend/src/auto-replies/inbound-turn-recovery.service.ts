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
import {
  InboundTurnService,
  NOUS_DISPATCH_AMBIGUOUS,
  NOUS_QUEUE_OUTCOME_UNKNOWN,
  NORMAL_NOUS_GENERATION_ENGINE,
  PENDING_NOUS_RECOVERY_PAGE_SIZE,
  PendingNousRecoveryCursor,
} from './inbound-turn.service';
import { TasksService } from '../tasks/tasks.service';
import { HandoffReason } from '@prisma/client';
import { HandoffService } from '../handoff/handoff.service';
import { NOUS_HERMES_INFERENCE_QUEUE } from '../conversation-engine/nous-hermes.constants';
import type { ConversationTurnInput } from '../conversation-engine/conversation-engine.types';
import { InboundTurnStatus } from '@prisma/client';

@Injectable()
export class InboundTurnRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InboundTurnRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private pendingNousCursor?: PendingNousRecoveryCursor;
  private readonly pendingLoggedAt = new Map<string, number>();

  constructor(
    private readonly turns: InboundTurnService,
    @InjectQueue(AUTO_REPLY_QUEUE)
    private readonly queue: Queue<AutoReplyJobData>,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly handoffs?: HandoffService,
    @Optional()
    @InjectQueue(NOUS_HERMES_INFERENCE_QUEUE)
    private readonly nousQueue?: Queue<ConversationTurnInput>,
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
        if (turn.nousQueuedAt && turn.nousResultAt) {
          if (
            turn.status === InboundTurnStatus.PROCESSING &&
            !(await this.turns.releaseCompletedNousResult(turn.id))
          )
            continue;
        } else if (
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
      const pendingNous = await this.turns.stalePendingNous(
        new Date(),
        this.pendingNousCursor,
      );
      for (const turn of pendingNous) {
        if (!this.nousQueue) throw new Error('NOUS_QUEUE_RECOVERY_UNAVAILABLE');
        const job = await this.nousQueue.getJob(`nous-${turn.lastMessageId}`);
        const state = job ? await job.getState() : 'missing';
        if (state === 'waiting' || state === 'delayed' || state === 'active') {
          const last = this.pendingLoggedAt.get(turn.id) ?? 0;
          if (Date.now() - last >= 60_000) {
            this.pendingLoggedAt.set(turn.id, Date.now());
            this.logger.warn(
              JSON.stringify({
                event: 'nous_pending_recovery',
                turnId: turn.id,
                state,
                ageMs: Date.now() - turn.nousQueuedAt!.getTime(),
              }),
            );
          }
        } else if (
          await this.turns.blockAmbiguous(
            turn.id,
            turn.processingToken ?? undefined,
            true,
          )
        ) {
          const reason = turn.providerDispatchReservedAt
            ? NOUS_DISPATCH_AMBIGUOUS
            : NOUS_QUEUE_OUTCOME_UNKNOWN;
          await this.requestNousReview({
            ...turn,
            generationBlockReason: reason,
          });
        }
        this.pendingNousCursor = {
          processingAt: turn.processingAt!,
          id: turn.id,
        };
      }
      if (pendingNous.length < PENDING_NOUS_RECOVERY_PAGE_SIZE)
        this.pendingNousCursor = undefined;
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
