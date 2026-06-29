import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { N8N_QUEUE } from './n8n.constants';
import { N8nConfig } from './n8n.config';
import { N8nDispatcher } from './n8n.dispatcher';
import { N8nQueueProcessor } from './n8n.queue.processor';
import { N8nTestController } from './n8n.controller';
import { PingListener } from './listeners/ping.listener';
import { ConversationListener } from './listeners/conversation.listener';

/**
 * Módulo de integración con n8n. Registra la cola `n8n-events` con su política
 * de reintentos, el processor que la consume, el dispatcher de transporte y los
 * listeners que mapean eventos de dominio a jobs.
 *
 * Los servicios de dominio NUNCA importan este módulo ni el dispatcher: sólo
 * emiten eventos vía EventEmitter2. Así el acoplamiento queda en un único punto.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: N8N_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false, // dejar fallos en cola para inspección manual
      },
    }),
  ],
  controllers: [N8nTestController],
  providers: [
    N8nConfig,
    N8nDispatcher,
    N8nQueueProcessor,
    PingListener,
    ConversationListener,
  ],
})
export class N8nModule {}
