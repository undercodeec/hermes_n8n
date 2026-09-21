import { Module } from '@nestjs/common';
import { HermesModule } from '../hermes/hermes.module';
import { AgentOutputValidator } from './agent-output.validator';
import { ConversationEngineService } from './conversation-engine.service';
import { DirectGeminiEngine } from './direct-gemini.engine';
import { NousHermesEngine } from './nous-hermes.engine';
import {
  NousHermesSecretReader,
  NousHermesTransport,
} from './nous-hermes.transport';

@Module({
  imports: [HermesModule],
  providers: [
    AgentOutputValidator,
    DirectGeminiEngine,
    NousHermesSecretReader,
    NousHermesTransport,
    NousHermesEngine,
    ConversationEngineService,
  ],
  exports: [ConversationEngineService],
})
export class ConversationEngineModule {}
