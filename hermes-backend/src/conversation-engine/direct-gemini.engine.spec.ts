import { HermesService } from '../hermes/hermes.service';
import { DirectGeminiEngine } from './direct-gemini.engine';
import type { ConversationTurnInput } from './conversation-engine.types';
import type { HermesRequestDto } from '../hermes/dto/hermes-request.dto';

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
      getPromptVersion: jest.fn().mockReturnValue('prompt-digest-a'),
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
    expect(
      (generateResponse.mock.calls as Array<[HermesRequestDto]>)[0][0]
        .approvedLearning,
    ).toBeUndefined();
    expect(result).toEqual(
      expect.objectContaining({
        replyText: '¿En qué podemos ayudarle?',
        engine: 'gemini_direct',
        providerModel: 'gemini-3.8-flash',
        promptVersion: 'prompt-digest-a',
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
      getPromptVersion: jest.fn().mockReturnValue('prompt-digest-a'),
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

  it('passes approved learning separately and reports exposure without guidance', async () => {
    const generateResponse = jest.fn().mockResolvedValue({
      response: 'Respuesta.',
      learningExposed: [{ id: 'safe', version: 3 }],
    });
    const engine = new DirectGeminiEngine({
      generateResponse,
      getProviderModel: () => 'fake',
      getPromptVersion: () => 'prompt-digest-a',
    } as unknown as HermesService);
    const approvedLearning = [
      {
        id: 'safe',
        version: 3,
        kind: 'STYLE',
        trigger: 'pregunta actual',
        guidance: 'Responder primero la pregunta',
      },
    ];
    const result = await engine.respond({
      conversationId: 'c',
      inboundMessageId: 'm',
      customerMessage: 'pregunta actual',
      approvedContext: {
        recentMessages: [],
        approvedKnowledge: ['Precio oficial'],
        approvedLearning,
        commercialSnapshot: {
          marketSource: 'UNKNOWN',
          relevantServiceCodes: [],
          offers: [],
          needsMarketClarification: false,
        },
        handoffActive: false,
        contactName: 'Cliente',
      },
    });
    const request = (
      generateResponse.mock.calls as Array<[HermesRequestDto]>
    )[0][0];
    expect(request.approvedLearning).toEqual(approvedLearning);
    expect(request.commercialSnapshot?.offers).toEqual([]);
    expect(result.learningExposed).toEqual([{ id: 'safe', version: 3 }]);
    expect(JSON.stringify(result.learningExposed)).not.toContain(
      'Responder primero',
    );
  });

  it('does not turn selected learning into exposure after a pre-provider failure', async () => {
    const engine = new DirectGeminiEngine({
      generateResponse: jest.fn().mockResolvedValue({
        response: 'No se pudo completar.',
        diagnostic: { code: 'PROVIDER_UNAVAILABLE' },
      }),
      getProviderModel: () => 'fake',
      getPromptVersion: () => 'digest',
    } as unknown as HermesService);
    const result = await engine.respond({
      conversationId: 'c',
      inboundMessageId: 'm',
      customerMessage: 'pregunta actual',
      approvedContext: {
        recentMessages: [],
        approvedKnowledge: [],
        approvedLearning: [
          {
            id: 'selected-only',
            version: 1,
            kind: 'STYLE',
            trigger: 'pregunta actual',
            guidance: 'Responder primero',
          },
        ],
        handoffActive: false,
        contactName: 'Cliente',
      },
    });
    expect(result.learningExposed).toBeUndefined();
  });
});
