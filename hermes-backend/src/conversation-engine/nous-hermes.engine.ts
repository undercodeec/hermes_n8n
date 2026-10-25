import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
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

    const attempts = input.singleGenerationCanary
      ? 1
      : this.positiveInteger('NOUS_HERMES_MAX_ATTEMPTS', 3);
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
      if (input.singleGenerationCanary) {
        await this.blockAmbiguousCanary(input);
        throw new Error('CANARY_NOUS_QUEUE_AMBIGUOUS');
      }
      await this.blockUnknownNormal(input);
      throw new Error('NOUS_QUEUE_ADMISSION_AMBIGUOUS');
    }

    try {
      return await job.waitUntilFinished(
        this.queueEvents.queueEvents,
        waitTimeout,
      );
    } catch {
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
