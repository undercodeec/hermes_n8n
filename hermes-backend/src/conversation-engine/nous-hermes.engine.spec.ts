import type { ConversationTurnInput } from './conversation-engine.types';
import { NousHermesEngine } from './nous-hermes.engine';
import {
  NousHermesRateLimitError,
  NousHermesTransport,
} from './nous-hermes.transport';

const input: ConversationTurnInput = {
  conversationId: 'conversation-1',
  inboundMessageId: 'inbound-1',
  customerMessage: 'Hola',
  approvedContext: {
    recentMessages: [],
    approvedKnowledge: [],
    handoffActive: false,
    contactName: 'Ana',
  },
};

describe('NousHermesEngine', () => {
  it('delegates the exact turn to the private transport', async () => {
    const result = {
      replyText: 'Respuesta.',
      proposedActions: [{ type: 'none' as const }],
      engine: 'nous_hermes' as const,
      providerModel: 'hermes-agent',
      traceId: 'inbound-1',
    };
    const transport = { execute: jest.fn().mockResolvedValue(result) };
    const engine = new NousHermesEngine(
      transport as unknown as NousHermesTransport,
    );

    await expect(engine.respond(input)).resolves.toBe(result);
    expect(transport.execute).toHaveBeenCalledWith(input);
  });

  it('preserves the typed rate-limit signal for the queue layer', async () => {
    const transport = {
      execute: jest.fn().mockRejectedValue(new NousHermesRateLimitError()),
    };
    const engine = new NousHermesEngine(
      transport as unknown as NousHermesTransport,
    );

    await expect(engine.respond(input)).rejects.toBeInstanceOf(
      NousHermesRateLimitError,
    );
  });
});
