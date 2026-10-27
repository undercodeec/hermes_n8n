import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type {
  ConversationEngine,
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NOUS_HERMES_INFERENCE_QUEUE } from './nous-hermes.constants';
import { NousHermesQueueEvents } from './nous-hermes.queue-events';
import { InboundTurnService } from '../auto-replies/inbound-turn.service';
import { isSingleGenerationCanaryConversation } from '../auto-replies/single-generation-canary.policy';
import { nousPilotBudgetMode } from './nous-pilot-budget.policy';

export class NousQueuePendingError extends Error {
  constructor() {
    super('NOUS_QUEUE_PENDING');
    this.name = 'NousQueuePendingError';
  }
}

@Injectable()
export class NousHermesEngine implements ConversationEngine {
  readonly id = 'nous_hermes' as const;
  private readonly logger = new Logger(NousHermesEngine.name);

  constructor(
    private readonly config: ConfigService,
    @InjectQueue(NOUS_HERMES_INFERENCE_QUEUE)
    private readonly queue: Queue<
      ConversationTurnInput,
      ConversationTurnResult,
      string
    >,
    private readonly queueEvents: NousHermesQueueEvents,
    @Optional() private readonly inboundTurns?: InboundTurnService,
  ) {}

  async respond(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    const guarded = isSingleGenerationCanaryConversation(
      this.config,
      input.conversationId,
    );
    if (guarded !== Boolean(input.singleGenerationCanary))
      throw new Error('CANARY_NOUS_SCOPE_OR_CLAIM_MISMATCH');
    if (!guarded && !input.normalNousClaim)
      throw new Error('NOUS_DISPATCH_CLAIM_REQUIRED');
    if (
      this.config.get<string>('NOUS_PILOT_OPERATIONS_ENABLED', 'true') !==
        'true' ||
      (input.assignedEngine === 'nous_hermes' &&
        this.config.get<string>('NOUS_PILOT_COMMERCIAL_ENABLED', 'false') !==
          'true')
    ) {
      return this.failureResult(
        input,
        'NOUS_PILOT_STOPPED',
        'Nous operations are stopped by configuration',
        'OUTPUT_BLOCKED',
        0,
        true,
      );
    }
    if (input.approvedContext.handoffActive) {
      return this.failureResult(
        input,
        'NOUS_HERMES_HANDOFF_ACTIVE',
        'Agent invocation denied because human handoff is active',
        'OUTPUT_BLOCKED',
        0,
        false,
      );
    }
    if (input.assignedEngine === 'nous_hermes') {
      const monitorOnly = nousPilotBudgetMode(this.config) === 'MONITOR_ONLY';
      let waiting: number | undefined;
      try {
        waiting = await this.queue.getWaitingCount();
      } catch (error) {
        if (!monitorOnly) throw error;
        this.logger.warn(
          JSON.stringify({ event: 'nous_pilot_queue_meter_unavailable' }),
        );
      }
      const threshold = this.positiveInteger(
        'NOUS_PILOT_QUEUE_ALERT_WAITING',
        5,
      );
      if (waiting !== undefined && waiting >= threshold) {
        if (
          !monitorOnly ||
          waiting === threshold ||
          waiting % threshold === 0
        ) {
          this.logger.warn(
            JSON.stringify({
              event: 'nous_pilot_saturation',
              waiting,
              threshold,
            }),
          );
        }
        if (!monitorOnly) {
          return this.failureResult(
            input,
            'NOUS_PILOT_SATURATED',
            'Nous pilot queue is saturated',
            'OUTPUT_BLOCKED',
            0,
            true,
          );
        }
      }
    }

    const attempts = input.singleGenerationCanary
      ? 1
      : this.positiveInteger('NOUS_HERMES_MAX_ATTEMPTS', 3);
    const delay = this.positiveInteger('NOUS_HERMES_BACKOFF_MS', 1500);
    const waitTimeout = this.positiveInteger(
      'NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS',
      120000,
    );
    const monitorOnly =
      input.assignedEngine === 'nous_hermes' &&
      nousPilotBudgetMode(this.config) === 'MONITOR_ONLY';

    let job: Job<ConversationTurnInput, ConversationTurnResult>;
    try {
      if (monitorOnly) {
        if (
          !this.inboundTurns ||
          !input.normalNousClaim ||
          !(await this.inboundTurns.markNousQueued({
            turnId: input.normalNousClaim.turnId,
            sourceMessageId: input.inboundMessageId,
            processingToken: input.normalNousClaim.processingToken,
          }))
        )
          throw new Error('NOUS_QUEUE_CLAIM_LOST');
      }
      job = await this.queue.add('infer', input, {
        jobId: `nous-${input.inboundMessageId}`,
        attempts,
        backoff: { type: 'exponential', delay },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch {
      if (input.singleGenerationCanary) {
        await this.blockAmbiguousCanary(input);
        throw new Error('CANARY_NOUS_QUEUE_AMBIGUOUS');
      }
      await this.blockUnknownNormal(input);
      throw new Error('NOUS_QUEUE_ADMISSION_AMBIGUOUS');
    }

    try {
      const result = await job.waitUntilFinished(
        this.queueEvents.queueEvents,
        waitTimeout,
      );
      if (monitorOnly) {
        this.logger.log(
          JSON.stringify({
            event: 'nous_pilot_queue_result',
            queueWaitMs:
              job.processedOn && job.timestamp
                ? Math.max(0, job.processedOn - job.timestamp)
                : null,
            totalMs: job.timestamp
              ? Math.max(0, Date.now() - job.timestamp)
              : null,
          }),
        );
      }
      return result;
    } catch (error) {
      if (monitorOnly) {
        try {
          const persisted = await this.inboundTurns!.readNousResult(
            input.normalNousClaim!.turnId,
            input.inboundMessageId,
          );
          if (persisted) return persisted;
        } catch {
          this.logger.warn(
            JSON.stringify({ event: 'nous_pilot_result_meter_unavailable' }),
          );
        }
      }
      if (
        monitorOnly &&
        error instanceof Error &&
        error.message.includes('timed out before finishing')
      ) {
        let state: string;
        try {
          state = await job.getState();
        } catch {
          state = 'unknown';
        }
        if (state === 'waiting' || state === 'delayed') {
          this.logger.warn(
            JSON.stringify({ event: 'nous_pilot_queue_detached', state }),
          );
          throw new NousQueuePendingError();
        }
        if (state === 'active') {
          try {
            const current = await this.queue.getJob(job.id ?? '');
            if (
              current?.processedOn &&
              Date.now() - current.processedOn < waitTimeout
            ) {
              this.logger.warn(
                JSON.stringify({ event: 'nous_pilot_queue_detached', state }),
              );
              throw new NousQueuePendingError();
            }
          } catch (stateError) {
            if (stateError instanceof NousQueuePendingError) throw stateError;
          }
        }
        // Completion and the state probe can race; a durable result wins.
        try {
          const persisted = await this.inboundTurns!.readNousResult(
            input.normalNousClaim!.turnId,
            input.inboundMessageId,
          );
          if (persisted) return persisted;
        } catch {
          // An unreadable durable result remains ambiguous.
        }
      }
      if (input.singleGenerationCanary) {
        await this.blockAmbiguousCanary(input);
        throw new Error('CANARY_NOUS_RESULT_AMBIGUOUS');
      }
      await this.blockUnknownNormal(input);
      throw new Error('NOUS_QUEUE_RESULT_AMBIGUOUS');
    }
  }

  private async blockUnknownNormal(
    input: ConversationTurnInput,
  ): Promise<void> {
    if (!this.inboundTurns || !input.normalNousClaim)
      throw new Error('NOUS_TURN_GUARD_UNAVAILABLE');
    await this.inboundTurns.blockAmbiguous(
      input.normalNousClaim.turnId,
      input.normalNousClaim.processingToken,
      true,
    );
  }

  private async blockAmbiguousCanary(
    input: ConversationTurnInput,
  ): Promise<void> {
    if (!this.inboundTurns || !input.singleGenerationCanary)
      throw new Error('CANARY_TURN_GUARD_UNAVAILABLE');
    await this.inboundTurns.blockAmbiguous(
      input.singleGenerationCanary.turnId,
      input.singleGenerationCanary.processingToken,
    );
  }

  private failureResult(
    input: ConversationTurnInput,
    code: string,
    summary: string,
    category: 'OUTPUT_BLOCKED' | 'PROVIDER_ERROR',
    attempts: number,
    requiresHumanReview: boolean,
    trace: {
      learningExposed?: Array<{ id: string; version: number }>;
      promptVersion?: string;
    } = {},
  ): ConversationTurnResult {
    return {
      replyText: 'Disculpe, no pude completar la respuesta en este momento.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'unknown',
      ...(trace.promptVersion ? { promptVersion: trace.promptVersion } : {}),
      traceId: input.inboundMessageId,
      ...(trace.learningExposed?.length
        ? { learningExposed: trace.learningExposed }
        : {}),
      business: {
        detectedIntent: 'error',
        nextAction: 'sin_accion',
        commercialProfile: {
          ...(input.approvedContext.commercialProfile ?? {}),
        },
      },
      diagnostic: {
        category,
        code,
        summary,
        attempts,
        recovered: false,
        requiresHumanReview,
      },
    };
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string | number>(key, fallback));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
}
