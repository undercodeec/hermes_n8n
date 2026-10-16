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
    @InjectQueue(NOUS_HERMES_INFERENCE_QUEUE)
    private readonly queue: Queue<
      ConversationTurnInput,
      ConversationTurnResult,
      string
    >,
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
          this.rateLimitTrace(error),
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
        (error.message === 'Nous Hermes rate limit' ||
          error.message.startsWith('Nous Hermes rate limit|')))
    );
  }

  private rateLimitTrace(error: unknown): {
    learningExposed?: Array<{ id: string; version: number }>;
    promptVersion?: string;
  } {
    if (!(error instanceof Error)) return {};
    const encoded = error.message.split('|', 2)[1];
    if (!encoded) return {};
    try {
      const trace = JSON.parse(encoded) as {
        learningExposed?: Array<{ id: string; version: number }>;
        promptVersion?: string;
      };
      const validExposure =
        Array.isArray(trace.learningExposed) &&
        trace.learningExposed.length <= 3 &&
        trace.learningExposed.every(
          (item) =>
            item &&
            typeof item.id === 'string' &&
            item.id.length > 0 &&
            item.id.length <= 100 &&
            Number.isSafeInteger(item.version) &&
            item.version > 0 &&
            Object.keys(item).every((key) => key === 'id' || key === 'version'),
        );
      return {
        ...(validExposure ? { learningExposed: trace.learningExposed } : {}),
        ...(typeof trace.promptVersion === 'string' &&
        trace.promptVersion.length > 0 &&
        trace.promptVersion.length <= 64
          ? { promptVersion: trace.promptVersion }
          : {}),
      };
    } catch {
      return {};
    }
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
