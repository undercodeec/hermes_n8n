import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NOUS_HERMES_INFERENCE_QUEUE } from './nous-hermes.constants';
import { NousHermesTransport } from './nous-hermes.transport';

@Processor(NOUS_HERMES_INFERENCE_QUEUE, { concurrency: 1 })
export class NousHermesProcessor extends WorkerHost {
  constructor(private readonly transport: NousHermesTransport) {
    super();
  }

  process(job: Job<ConversationTurnInput>): Promise<ConversationTurnResult> {
    return this.transport.execute(job.data);
  }
}
