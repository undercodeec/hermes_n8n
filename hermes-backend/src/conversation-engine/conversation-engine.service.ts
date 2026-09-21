import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DirectGeminiEngine } from './direct-gemini.engine';
import { NousHermesEngine } from './nous-hermes.engine';
import {
  ConversationEngineConfigurationError,
  type ConversationEngine,
  type ConversationEngineId,
  type ConversationTurnInput,
  type ConversationTurnResult,
} from './conversation-engine.types';

@Injectable()
export class ConversationEngineService {
  constructor(
    private readonly config: ConfigService,
    private readonly directGemini: DirectGeminiEngine,
    private readonly nousHermes: NousHermesEngine,
  ) {}

  async respond(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    return this.resolve(input.conversationId).respond(input);
  }

  selectedEngine(conversationId: string): ConversationEngineId {
    return this.resolve(conversationId).id;
  }

  private resolve(conversationId: string): ConversationEngine {
    const configured = this.config
      .get<string>('HERMES_CONVERSATION_ENGINE', 'gemini_direct')
      .trim();
    if (configured === 'gemini_direct') return this.directGemini;
    if (configured !== 'nous_hermes') {
      throw new ConversationEngineConfigurationError(
        `Unknown HERMES_CONVERSATION_ENGINE: ${configured}`,
      );
    }

    const allowlist = new Set(
      (this.config.get<string>('NOUS_HERMES_CONVERSATION_ALLOWLIST', '') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    return allowlist.has(conversationId) ? this.nousHermes : this.directGemini;
  }
}
