import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { N8N_QUEUE } from './n8n.constants';
import { N8nDispatcher } from './n8n.dispatcher';
import { N8nConfig } from './n8n.config';
import { N8nEventPayload } from './n8n.types';

/**
 * Consume los jobs de la cola `n8n-events` y los entrega al dispatcher.
 * Si el evento no tiene webhook configurado, se descarta (no se reintenta).
 * Si el dispatch falla, el throw del dispatcher hace que BullMQ reintente.
 */
@Processor(N8N_QUEUE)
export class N8nQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(N8nQueueProcessor.name);

  constructor(
    private readonly dispatcher: N8nDispatcher,
    private readonly cfg: N8nConfig,
  ) {
    super();
  }

  async process(job: Job<N8nEventPayload>): Promise<void> {
    const path = this.cfg.resolveWebhookPath(job.data.event);
    if (!path) {
      this.logger.warn(
        `No webhook configurado para evento '${job.data.event}' — descartado (${job.data.eventId})`,
      );
      return;
    }
    await this.dispatcher.dispatch(path, job.data);
  }
}
