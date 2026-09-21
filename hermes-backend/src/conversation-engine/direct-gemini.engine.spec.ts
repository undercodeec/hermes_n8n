import { HermesService } from '../hermes/hermes.service';
import { DirectGeminiEngine } from './direct-gemini.engine';
import type { ConversationTurnInput } from './conversation-engine.types';

describe('DirectGeminiEngine', () => {
  it('preserves the existing Hermes request and response semantics', async () => {
    const generateResponse = jest.fn().mockResolvedValue({
      response: '¿En qué podemos ayudarle?',
      tokensUsed: 12,
      costEstimate: 0.001,
      detectedIntent: 'info_general',
      nextAction: 'continuar_descubrimiento',
      commercialProfile: { sector: 'reparación' },
    });
    const hermes = {
      generateResponse,
      getProviderModel: jest.fn().mockReturnValue('gemini-3.8-flash'),
    } as unknown as HermesService;
    const engine = new DirectGeminiEngine(hermes);
    const input: ConversationTurnInput = {
      conversationId: 'conversation-1',
      inboundMessageId: 'inbound-1',
      customerMessage: 'Quiero promocionar mi negocio',
      approvedContext: {
        recentMessages: [{ role: 'user', text: 'Reparo lavadoras' }],
        commercialProfile: { sector: 'reparación' },
        approvedKnowledge: [],
        handoffActive: false,
        contactName: 'Ana',
        currentIntent: 'consulta_servicio',
      },
    };

    const result = await engine.respond(input);

    expect(generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        correlationId: 'inbound-1',
        messageContent: 'Quiero promocionar mi negocio',
        conversationHistory: [{ role: 'user', content: 'Reparo lavadoras' }],
        commercialProfile: { sector: 'reparación' },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        replyText: '¿En qué podemos ayudarle?',
        engine: 'gemini_direct',
        providerModel: 'gemini-3.8-flash',
        traceId: 'inbound-1',
        proposedActions: [{ type: 'none' }],
        usage: { totalTokens: 12 },
      }),
    );
  });

  it('does not invent an empty commercial profile when none was persisted', async () => {
    const generateResponse = jest.fn().mockResolvedValue({
      response: 'Hola, ¿cómo podemos ayudarle?',
    });
    const engine = new DirectGeminiEngine({
      generateResponse,
      getProviderModel: jest.fn().mockReturnValue('gemini-3.8-flash'),
    } as unknown as HermesService);

    await engine.respond({
      conversationId: 'conversation-1',
      inboundMessageId: 'inbound-1',
      customerMessage: 'Hola',
      approvedContext: {
        recentMessages: [],
        approvedKnowledge: [],
        handoffActive: false,
        contactName: 'Cliente',
      },
    });

    expect(generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({ commercialProfile: undefined }),
    );
  });
});
