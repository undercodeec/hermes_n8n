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
    return this.resolve(input.conversationId, input.assignedEngine).respond(
      input,
    );
  }

  selectedEngine(
    conversationId: string,
    assignedEngine?: ConversationEngineId,
  ): ConversationEngineId {
    return this.resolve(conversationId, assignedEngine).id;
  }

  private resolve(
    conversationId: string,
    assignedEngine?: ConversationEngineId,
  ): ConversationEngine {
    if (assignedEngine === 'gemini_direct') return this.directGemini;
    if (assignedEngine === 'nous_hermes') return this.nousHermes;
    if (assignedEngine)
      throw new ConversationEngineConfigurationError('Invalid assigned engine');
    const configured = this.config
      .get<string>('HERMES_CONVERSATION_ENGINE', 'gemini_direct')
      .trim();
    if (configured === 'gemini_direct') return this.directGemini;
    if (configured !== 'nous_hermes') {
      throw new ConversationEngineConfigurationError(
        `Unknown HERMES_CONVERSATION_ENGINE: ${configured}`,
      );
    }

    if (
      this.config.get<string>('NOUS_HERMES_OPEN_INBOUND_TEST', 'false') ===
      'true'
    ) {
      return this.nousHermes;
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
