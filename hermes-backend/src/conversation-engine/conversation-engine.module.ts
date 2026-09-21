import { Module } from '@nestjs/common';
import { HermesModule } from '../hermes/hermes.module';
import { AgentOutputValidator } from './agent-output.validator';
import { ConversationEngineService } from './conversation-engine.service';
import { DirectGeminiEngine } from './direct-gemini.engine';
import { NousHermesEngine } from './nous-hermes.engine';

@Module({
  imports: [HermesModule],
  providers: [
    AgentOutputValidator,
    DirectGeminiEngine,
    NousHermesEngine,
    ConversationEngineService,
  ],
  exports: [ConversationEngineService],
})
export class ConversationEngineModule {}
