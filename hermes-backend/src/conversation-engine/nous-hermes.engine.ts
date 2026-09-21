import { Injectable } from '@nestjs/common';
import type {
  ConversationEngine,
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NousHermesTransport } from './nous-hermes.transport';

@Injectable()
export class NousHermesEngine implements ConversationEngine {
  readonly id = 'nous_hermes' as const;

  constructor(private readonly transport: NousHermesTransport) {}

  respond(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    return this.transport.execute(input);
  }
}
