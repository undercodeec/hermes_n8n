import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NOUS_HERMES_INFERENCE_QUEUE } from './nous-hermes.constants';
import { NousHermesTransport } from './nous-hermes.transport';
import { InboundTurnService } from '../auto-replies/inbound-turn.service';
import { nousPilotBudgetMode } from './nous-pilot-budget.policy';

@Processor(NOUS_HERMES_INFERENCE_QUEUE, { concurrency: 1 })
export class NousHermesProcessor extends WorkerHost {
  constructor(
    private readonly transport: NousHermesTransport,
    @Optional() private readonly turns?: InboundTurnService,
    @Optional() private readonly config?: ConfigService,
  ) {
    super();
  }

  async process(
    job: Job<ConversationTurnInput>,
  ): Promise<ConversationTurnResult> {
    const result = await this.transport.execute(job.data);
    if (
      job.data.assignedEngine === 'nous_hermes' &&
      this.config &&
      nousPilotBudgetMode(this.config) === 'MONITOR_ONLY' &&
      !result.diagnostic
    ) {
      if (
        !this.turns ||
        !job.data.normalNousClaim ||
        !(await this.turns.storeNousResult({
          turnId: job.data.normalNousClaim.turnId,
          sourceMessageId: job.data.inboundMessageId,
          processingToken: job.data.normalNousClaim.processingToken,
          result,
        }))
      )
        throw new Error('NOUS_RESULT_PERSISTENCE_DENIED');
    }
    return result;
  }
}
