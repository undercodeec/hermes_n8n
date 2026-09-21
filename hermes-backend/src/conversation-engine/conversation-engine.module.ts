import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { HermesModule } from '../hermes/hermes.module';
import { AgentOutputValidator } from './agent-output.validator';
import { ConversationEngineService } from './conversation-engine.service';
import { DirectGeminiEngine } from './direct-gemini.engine';
import { NOUS_HERMES_INFERENCE_QUEUE } from './nous-hermes.constants';
import { NousHermesEngine } from './nous-hermes.engine';
import { NousHermesProcessor } from './nous-hermes.processor';
import { NousHermesQueueEvents } from './nous-hermes.queue-events';
import { NousHermesQueuePolicy } from './nous-hermes.queue-policy';
import {
  NousHermesSecretReader,
  NousHermesTransport,
} from './nous-hermes.transport';

@Module({
  imports: [
    HermesModule,
    BullModule.registerQueue({ name: NOUS_HERMES_INFERENCE_QUEUE }),
  ],
  providers: [
    AgentOutputValidator,
    DirectGeminiEngine,
    NousHermesSecretReader,
    NousHermesTransport,
    NousHermesProcessor,
    NousHermesQueueEvents,
    NousHermesQueuePolicy,
    NousHermesEngine,
    ConversationEngineService,
  ],
  exports: [ConversationEngineService],
})
export class ConversationEngineModule {}
