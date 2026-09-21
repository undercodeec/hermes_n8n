import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type {
  ConversationEngine,
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NOUS_HERMES_INFERENCE_QUEUE } from './nous-hermes.constants';
import { NousHermesQueueEvents } from './nous-hermes.queue-events';
import { NousHermesRateLimitError } from './nous-hermes.transport';

@Injectable()
export class NousHermesEngine implements ConversationEngine {
  readonly id = 'nous_hermes' as const;

  constructor(
    private readonly config: ConfigService,
    @InjectQueue(NOUS_HERMES_INFERENCE_QUEUE) private readonly queue: Queue,
    private readonly queueEvents: NousHermesQueueEvents,
  ) {}

  async respond(input: ConversationTurnInput): Promise<ConversationTurnResult> {
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

    const attempts = this.positiveInteger('NOUS_HERMES_MAX_ATTEMPTS', 3);
    const delay = this.positiveInteger('NOUS_HERMES_BACKOFF_MS', 1500);
    const waitTimeout = this.positiveInteger(
      'NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS',
      120000,
    );

    let job: Job<ConversationTurnInput, ConversationTurnResult>;
    try {
      job = await this.queue.add('infer', input, {
        jobId: `nous-${input.inboundMessageId}`,
        attempts,
        backoff: { type: 'exponential', delay },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch {
      return this.queueUnavailable(input);
    }

    try {
      return await job.waitUntilFinished(
        this.queueEvents.queueEvents,
        waitTimeout,
      );
    } catch (error) {
      if (this.isTerminalRateLimit(error)) {
        return this.failureResult(
          input,
          'NOUS_HERMES_RATE_LIMITED',
          'Agent inference remained rate limited after bounded retries',
          'PROVIDER_ERROR',
          attempts,
          true,
        );
      }
      return this.queueUnavailable(input);
    }
  }

  private queueUnavailable(
    input: ConversationTurnInput,
  ): ConversationTurnResult {
    return this.failureResult(
      input,
      'NOUS_HERMES_QUEUE_UNAVAILABLE',
      'Agent inference queue is unavailable',
      'PROVIDER_ERROR',
      0,
      true,
    );
  }

  private isTerminalRateLimit(error: unknown): boolean {
    return (
      error instanceof NousHermesRateLimitError ||
      (error instanceof Error &&
        error.message === new NousHermesRateLimitError().message)
    );
  }

  private failureResult(
    input: ConversationTurnInput,
    code: string,
    summary: string,
    category: 'OUTPUT_BLOCKED' | 'PROVIDER_ERROR',
    attempts: number,
    requiresHumanReview: boolean,
  ): ConversationTurnResult {
    return {
      replyText: 'Disculpe, no pude completar la respuesta en este momento.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'unknown',
      traceId: input.inboundMessageId,
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
