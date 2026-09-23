import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CommercialPolicyService } from './commercial-policy.service';
import { HermesService } from './hermes.service';
import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
} from '@prisma/client';
import type {
  AuthorizedOffer,
  CommercialSnapshot,
} from './commercial-authority.service';

type HermesRequestBody = {
  messages: Array<{ role: string; content: string }>;
  response_format: {
    type: string;
    json_schema: {
      schema: { properties: { detectedIntent: { enum: string[] } } };
    };
  };
  max_tokens: number;
  temperature?: number;
  reasoning_effort?: string;
};

type HermesProviderResponse = {
  data: {
    choices: Array<{
      message: { content: string };
      finish_reason?: string;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };
};

describe('HermesService commercial contract', () => {
  const offer = (
    name: string,
    amount: string,
    serviceCode: string,
  ): AuthorizedOffer => ({
    id: name,
    name,
    serviceCode,
    market: CommercialMarket.EC,
    marketScope: 'MARKET',
    priceType: CommercialPriceType.FIXED,
    amount,
    currency: 'USD',
    taxMode: CommercialTaxMode.INCLUDED,
    taxLabel: 'IVA',
    scope: 'Fixture de prueba',
    policyVersion: 'test-only',
    promotion: false,
  });
  const snapshot = (offers: AuthorizedOffer[]): CommercialSnapshot => ({
    market: CommercialMarket.EC,
    marketSource: 'CURRENT',
    relevantServiceCodes: offers.map((item) => item.serviceCode),
    offers,
    needsMarketClarification: false,
  });
  function setup(content: string | string[], model = 'gemini-test') {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          HERMES_API_URL:
            'https://generativelanguage.googleapis.com/v1beta/openai/',
          HERMES_API_KEY: 'test-key',
          HERMES_MODEL: model,
          HERMES_STRUCTURED_OUTPUT: 'true',
        };
        return values[key] ?? fallback;
      }),
    } as unknown as ConfigService;
    const prisma = {
      knowledgeDocument: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      salesPlaybook: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new HermesService(config, prisma);
    const contents = Array.isArray(content) ? content : [content];
    let responseIndex = 0;
    const post = jest.fn(
      (
        ...request: [string, HermesRequestBody]
      ): Promise<HermesProviderResponse> => {
        void request;
        const responseContent =
          contents[responseIndex++] ?? contents.at(-1) ?? '';
        return Promise.resolve({
          data: {
            choices: [{ message: { content: responseContent } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          },
        });
      },
    );
    (
      service as unknown as {
        httpClient: { post: typeof post };
      }
    ).httpClient.post = post;
    return { service, post };
  }

  it('sends the current inbound message exactly once and requests JSON schema', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response: 'Cuénteme qué necesita.',
        detectedIntent: 'info_general',
        suggestedTags: [],
        nextAction: 'continuar_descubrimiento',
        commercialProfile: {},
      }),
    );

    await service.generateResponse({
      contactName: 'Ana',
      messageContent: 'Mensaje actual',
      conversationHistory: [{ role: 'user', content: 'Mensaje anterior' }],
    });

    const body = post.mock.calls[0][1];
    expect(
      body.messages.filter(
        (message: { content: string }) => message.content === 'Mensaje actual',
      ),
    ).toHaveLength(1);
    expect(body.response_format.type).toBe('json_schema');
  });

  it('includes the concise web discovery and pending handoff rules', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response:
          'Con estos datos podemos valorar una web enfocada en promocionar la reparación de lavadoras a domicilio y los repuestos.',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'proponer_reunion',
        commercialProfile: {},
      }),
    );

    await service.generateResponse({
      messageContent: 'Servicio a domicilio y repuestos',
      conversationHistory: [
        { role: 'user', content: 'Necesito una página web' },
        { role: 'assistant', content: '¿A qué se dedica tu negocio?' },
        {
          role: 'user',
          content: 'Reparación de lavadoras. Quiero promocionarme.',
        },
      ],
    });

    const systemMessage = post.mock.calls[0][1].messages[0].content;
    expect(systemMessage).toContain('¿A qué se dedica su negocio?');
    expect(systemMessage).toContain(
      'sin abrir otra entrevista ni forzar una reunión',
    );
    expect(systemMessage).toContain(
      'su petición ya autoriza iniciar la derivación',
    );
    expect(systemMessage).toContain(
      'Una pregunta de descubrimiento anterior no es una obligación',
    );
    expect(systemMessage).toContain(
      'Distinga siempre dos conversaciones diferentes sobre pagos',
    );
    expect(systemMessage).not.toContain(
      'Para una web, averigua primero su objetivo',
    );
  });

  it('passes the backend conversational policy and the two payment intents to the model', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response:
          'El equipo debe confirmar las condiciones de pago del proyecto.',
        detectedIntent: 'consulta_pago_proyecto',
        suggestedTags: [],
        nextAction: 'sin_accion',
        commercialProfile: {},
      }),
    );

    const guidance = {
      currentTopic: 'project_payment',
      directAnswerRequired: true,
      allowDiscoveryQuestion: false,
      topicShift: true,
      recentQuestionTopics: ['store_payment'],
      sufficientContext: true,
      allowMeetingOffer: false,
      allowPlanRecommendation: true,
      allowPriceAnswer: false,
      priceAnswerRequired: false,
      allowPlanDetails: false,
      offerWebAlternatives: false,
      paymentContext: 'PROJECT_PAYMENT' as const,
    };
    const result = await service.generateResponse({
      messageContent: '¿Puedo pagar 50/50?',
      conversationHistory: [],
      currentIntent: 'consulta_pago_proyecto',
      conversationGuidance: guidance,
    });

    const body = post.mock.calls[0][1];
    const systemMessage = body.messages[0].content;
    expect(systemMessage).toContain('Política conversacional calculada');
    expect(systemMessage).toContain('"allowDiscoveryQuestion":false');
    expect(
      body.response_format.json_schema.schema.properties.detectedIntent.enum,
    ).toEqual(
      expect.arrayContaining([
        'consulta_cobro_tienda',
        'consulta_pago_proyecto',
      ]),
    );
    expect(result.detectedIntent).toBe('consulta_pago_proyecto');
  });

  it('does not ask again for a WhatsApp number already known by the backend', async () => {
    const { service } = setup(
      JSON.stringify({
        response: '¿Puede confirmar su número de teléfono?',
        detectedIntent: 'agendar_cita',
        suggestedTags: [],
        nextAction: 'solicitar_confirmacion_reunion',
        commercialProfile: {},
      }),
    );

    const result = await service.generateResponse({
      contactName: 'Ana',
      messageContent: 'Quiero que me llamen',
      conversationHistory: [],
      contact: { id: 'contact-1', hasUsablePhone: true, hasEmail: false },
    });

    expect(result.response).toBe('Podemos continuar por este mismo chat.');
    expect(result.response).not.toMatch(/confirmar.*número|horario/i);
  });

  it('does not turn a redundant WhatsApp request into an unsolicited call', async () => {
    const { service } = setup(
      JSON.stringify({
        response:
          'Podemos preparar una web para mostrar sus arreglos. ¿Puede compartir su número de WhatsApp?',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'continuar_descubrimiento',
        commercialProfile: {
          service: 'Sitio web',
          sector: 'Floristería',
          need: 'Mostrar arreglos florales',
        },
      }),
    );

    const result = await service.generateResponse({
      contactName: 'Christopher',
      messageContent: 'Mostrar mis arreglos florales',
      conversationHistory: [],
      contact: { id: 'contact-1', hasUsablePhone: true, hasEmail: false },
      conversationGuidance: {
        currentTopic: 'general',
        directAnswerRequired: false,
        allowDiscoveryQuestion: false,
        topicShift: false,
        recentQuestionTopics: [],
        sufficientContext: true,
        allowMeetingOffer: false,
        allowPlanRecommendation: true,
        allowPriceAnswer: false,
        priceAnswerRequired: false,
        allowPlanDetails: false,
        offerWebAlternatives: false,
      },
    });

    expect(result.response).toBe(
      'Podemos preparar una web para mostrar sus arreglos. Podemos continuar por este mismo chat.',
    );
    expect(result.response).not.toMatch(/horario|llamada|reunión/i);
    expect(result.detectedIntent).toBe('consulta_servicio');
    expect(result.nextAction).toBe('continuar_descubrimiento');
  });

  it('uses only relevant CRM store plans and keeps ecommerce discovery facts', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response:
          'Para orientarle mejor, ¿cuántos productos estima publicar inicialmente?',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'continuar_descubrimiento',
        commercialProfile: {
          service: 'Tienda Online',
          need: 'Vender productos por internet',
          productCount: '30 productos',
          corporateEmailNeeds: '3 cuentas',
        },
      }),
    );

    const result = await service.generateResponse({
      contactName: 'Ana',
      messageContent:
        'Quiero una tienda online para unos 30 productos y necesito 3 correos corporativos',
      conversationHistory: [],
      commercialSnapshot: snapshot([
        offer('Tienda de Lanzamiento', '550.00', 'ONLINE_STORE'),
        offer('Tienda de Crecimiento', '850.00', 'ONLINE_STORE'),
      ]),
    });

    const body = post.mock.calls[0][1];
    const systemMessage = body.messages[0].content;
    expect(systemMessage).toContain('Tienda de Lanzamiento');
    expect(systemMessage).toContain('Tienda de Crecimiento');
    expect(systemMessage).not.toContain('USD $40');
    expect(result.commercialProfile).toEqual(
      expect.objectContaining({
        service: 'Tienda Online',
        productCount: '30 productos',
        corporateEmailNeeds: '3 cuentas',
      }),
    );
  });

  it('uses a retryable technical response without promising a handoff when the provider returns invalid JSON', async () => {
    const { service, post } = setup([
      'respuesta sin JSON',
      '{\n  "response": "Hola, Ana. ¡Claro que',
    ]);

    const result = await service.generateResponse({
      contactName: 'Ana',
      messageContent: 'Necesito una web',
      conversationHistory: [],
    });

    expect(result.detectedIntent).toBe('error');
    expect(result.nextAction).toBe('sin_accion');
    expect(result.response).toContain(
      'no pude completar la respuesta en este momento',
    );
    expect(result.response).not.toContain('derivar');
    expect(result.response).not.toContain('respuesta sin JSON');
    expect(result.response).not.toContain('"response"');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retries an incomplete structured response and returns only the complete message', async () => {
    const complete = JSON.stringify({
      response: 'Hola, Jonathan. Claro que podemos ayudarle.',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const { service, post } = setup([
      '{\n  "response": "Hola, Jonathan. ¡Claro que',
      complete,
    ]);

    const result = await service.generateResponse({
      contactName: 'Jonathan',
      messageContent: 'Necesito información',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].max_tokens).toBe(2048);
    expect(post.mock.calls[1][1].max_tokens).toBe(4096);
    expect(result.response).toBe('Hola, Jonathan. Claro que podemos ayudarle.');
    expect(result.tokensUsed).toBe(240);
  });

  it('retries a transient provider failure before using the technical fallback', async () => {
    const complete = JSON.stringify({
      response: 'Podemos continuar con su solicitud.',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service, post } = setup(complete);
    post.mockReset();
    post.mockRejectedValueOnce(new Error('HTTP 503'));
    post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { content: complete }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      },
    });

    const result = await service.generateResponse({
      messageContent: 'Necesito información',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.detectedIntent).toBe('info_general');
    expect(result.response).toBe('Podemos continuar con su solicitud.');
  });

  it('accepts customer tuteo while keeping the formal system instruction', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response: 'Con gusto le explico las opciones disponibles.',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'sin_accion',
        commercialProfile: {},
      }),
    );

    const result = await service.generateResponse({
      messageContent: 'Oye, ¿me ayudas con una web pa mi negocio?',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.response).toContain('le explico');
    const systemMessage = post.mock.calls[0][1].messages[0].content;
    expect(systemMessage).toContain('trato profesional de «usted»');
  });

  it('formalizes a simple accidental tuteo locally without another provider call', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response: 'Te explico las dos opciones publicadas para tu sitio web.',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'sin_accion',
        commercialProfile: {},
      }),
    );

    const result = await service.generateResponse({
      messageContent: 'Explícame las opciones',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.response).toBe(
      'Le explico las dos opciones publicadas para su sitio web.',
    );
  });

  it('uses a contextual formal fallback when both style rewrites use tuteo', async () => {
    const informal = JSON.stringify({
      response: 'Puedes contarme qué quieres lograr.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: { company: 'Inventada SA' },
    });
    const { service, post } = setup([informal, informal]);

    const result = await service.generateResponse({
      messageContent: 'Necesito una web',
      conversationHistory: [],
      commercialProfile: { service: 'sitio web' },
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.response).not.toMatch(
      /puedes|quieres|inconveniente temporal/i,
    );
    expect(result.response).toMatch(/usted|su solicitud|su proyecto/i);
    expect(result.commercialProfile).toEqual({ service: 'sitio web' });
  });

  it('recovers an organization-location answer from authorized context', async () => {
    const invalid = JSON.stringify({
      response:
        'Nuestra oficina queda en una dirección que no está autorizada.',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service } = setup([invalid, invalid]);

    const result = await service.generateResponse({
      messageContent: '¿Desde dónde trabajan?',
      conversationHistory: [],
      conversationGuidance: {
        currentTopic: 'business_location',
        directAnswerRequired: true,
        allowDiscoveryQuestion: false,
        topicShift: false,
        recentQuestionTopics: [],
        sufficientContext: false,
        allowMeetingOffer: false,
        allowPlanRecommendation: false,
        allowPriceAnswer: false,
        priceAnswerRequired: false,
        allowPlanDetails: false,
        offerWebAlternatives: false,
      },
    });

    expect(result.response).toContain('remota');
    expect(result.response).toContain('Quito, Ecuador');
    expect(result.response).not.toMatch(/calle|dirección exacta|oficina en/i);
    expect(result.diagnostic?.category).toBe('POLICY_VIOLATION');
  });

  it('requires confirmation for an exact address without inventing street data', async () => {
    const invalid = JSON.stringify({
      response: 'Nuestra oficina está en la avenida Inventada 123, Quito.',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service } = setup([invalid, invalid]);

    const messageContent =
      '¿Cuál es la dirección física exacta de UnderCodeEC?';
    const policy = new CommercialPolicyService().analyze(
      messageContent,
      new Date('2026-09-20T18:00:00.000Z'),
    );
    const result = await service.generateResponse({
      messageContent,
      conversationHistory: [],
      conversationGuidance: policy.guidance,
    });

    expect(result.response).toMatch(
      /dirección (?:física )?exacta.*requiere confirmación/i,
    );
    expect(result.response).not.toMatch(/avenida Inventada|calle \w+|\b123\b/i);
  });

  it('answers published prices without saving a recommended plan', async () => {
    const priced = JSON.stringify({
      response: 'El sitio web publicado empieza en USD $360.',
      detectedIntent: 'consulta_precio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: { recommendedPlan: 'Plan de Lanzamiento' },
    });
    const { service, post } = setup(priced);

    const result = await service.generateResponse({
      messageContent: '¿Cuánto cuesta un sitio web?',
      conversationHistory: [],
      commercialSnapshot: snapshot([
        offer('Plan de Lanzamiento', '360.00', 'WEBSITE'),
      ]),
      conversationGuidance: {
        currentTopic: 'price',
        directAnswerRequired: true,
        allowDiscoveryQuestion: false,
        topicShift: false,
        recentQuestionTopics: [],
        sufficientContext: false,
        allowMeetingOffer: false,
        allowPlanRecommendation: false,
        allowPriceAnswer: true,
        priceAnswerRequired: true,
        allowPlanDetails: false,
        offerWebAlternatives: false,
      },
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.response).toContain('USD $360');
    expect(result.commercialProfile?.recommendedPlan).toBeUndefined();
  });

  it('rejects an unauthorized price written after the amount', async () => {
    const invalid = JSON.stringify({
      response: 'El sitio web cuesta 999 USD.',
      detectedIntent: 'consulta_precio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service, post } = setup([invalid, invalid]);
    const messageContent = '¿Cuánto cuesta un sitio web?';
    const policy = new CommercialPolicyService().analyze(
      messageContent,
      new Date('2026-09-20T18:00:00.000Z'),
    );

    const result = await service.generateResponse({
      messageContent,
      conversationHistory: [],
      commercialSnapshot: snapshot([
        offer('Plan de Lanzamiento', '360.00', 'WEBSITE'),
      ]),
      conversationGuidance: policy.guidance,
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.response).toContain('USD $360');
    expect(result.diagnostic?.code).toBe('UNAUTHORIZED_PRICE');
  });

  it('accepts the authorized basic-hosting renewal price', async () => {
    const valid = JSON.stringify({
      response: 'La renovación del hosting básico cuesta USD $40 al año.',
      detectedIntent: 'consulta_precio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service, post } = setup(valid);
    const messageContent =
      '¿Cuánto cuesta renovar el hosting básico después del primer año?';
    const policy = new CommercialPolicyService().analyze(
      messageContent,
      new Date('2026-09-20T18:00:00.000Z'),
    );

    const result = await service.generateResponse({
      messageContent,
      conversationHistory: [],
      commercialSnapshot: snapshot([
        offer('Renovación hosting básico', '40.00', 'HOSTING_RENEWAL'),
      ]),
      conversationGuidance: policy.guidance,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.response).toContain('USD $40');
    expect(result.diagnostic).toBeUndefined();
  });

  it('recovers an invented delivery commitment with human confirmation', async () => {
    const invalid = JSON.stringify({
      response: 'Su sitio web estará listo en 3 días.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service, post } = setup([invalid, invalid]);
    const messageContent = '¿Cuánto tarda un sitio web?';
    const policy = new CommercialPolicyService().analyze(
      messageContent,
      new Date('2026-09-20T18:00:00.000Z'),
    );

    const result = await service.generateResponse({
      messageContent,
      conversationHistory: [],
      conversationGuidance: policy.guidance,
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.response).toContain('requiere confirmación');
    expect(result.diagnostic).toEqual(
      expect.objectContaining({
        code: 'UNAUTHORIZED_TIMELINE',
        requiresHumanReview: true,
      }),
    );
  });

  it('accepts a negative meeting statement without retrying', async () => {
    const valid = JSON.stringify({
      response: 'No necesita una reunión con el equipo.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service, post } = setup(valid);
    const policy = new CommercialPolicyService().analyze(
      'También debe organizar expedientes.',
      new Date('2026-09-20T18:00:00.000Z'),
      [],
      {
        commercialProfile: {
          service: 'portal interno',
          need: 'organizar expedientes',
          sector: 'servicio legal',
        },
      },
    );

    const result = await service.generateResponse({
      messageContent: 'También debe organizar expedientes.',
      conversationHistory: [],
      commercialProfile: {
        service: 'portal interno',
        need: 'organizar expedientes',
        sector: 'servicio legal',
      },
      conversationGuidance: policy.guidance,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.response).toBe('No necesita una reunión con el equipo.');
    expect(result.diagnostic).toBeUndefined();
  });

  it('keeps the persisted profile when both policy responses carry a rejected profile', async () => {
    const invalid = JSON.stringify({
      response: 'Le recomiendo el Plan inventado por USD $9999.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {
        company: 'Inventada SA',
        budget: 'USD $9999',
        recommendedPlan: 'Plan inventado',
      },
    });
    const { service } = setup([invalid, invalid]);

    const result = await service.generateResponse({
      messageContent: 'Necesito información sobre una web',
      conversationHistory: [],
      commercialProfile: { service: 'sitio web' },
      conversationGuidance: {
        currentTopic: 'general',
        directAnswerRequired: false,
        allowDiscoveryQuestion: true,
        topicShift: false,
        recentQuestionTopics: [],
        sufficientContext: false,
        allowMeetingOffer: false,
        allowPlanRecommendation: false,
        allowPriceAnswer: false,
        priceAnswerRequired: false,
        allowPlanDetails: false,
        offerWebAlternatives: false,
      },
    });

    expect(result.commercialProfile).toEqual({ service: 'sitio web' });
    expect(result.diagnostic).toEqual(
      expect.objectContaining({
        category: 'POLICY_VIOLATION',
        recovered: true,
      }),
    );
  });

  it('retries a response that uses tuteo and adds a focused correction', async () => {
    const informal = JSON.stringify({
      response: 'Cuéntame qué necesitas y te ayudo.',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const formal = JSON.stringify({
      response: 'Cuénteme qué necesita y con gusto le ayudo.',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const { service, post } = setup([informal, formal]);

    const result = await service.generateResponse({
      messageContent: 'Necesito información',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.response).toBe('Cuénteme qué necesita y con gusto le ayudo.');
    expect(
      post.mock.calls[1][1].messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Preserve todo el contenido comercial'),
      ),
    ).toBe(true);
  });

  it('recovers a formal second attempt locally when it only starts with a mechanical opening', async () => {
    const informal = JSON.stringify({
      response: 'Cuéntame qué necesitas y te ayudo.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const mechanical = JSON.stringify({
      response:
        'Entendido. Para mostrar sus servicios, podemos preparar un sitio web enfocado en su negocio.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: { service: 'Sitio web' },
    });
    const { service, post } = setup([informal, mechanical]);

    const result = await service.generateResponse({
      messageContent: 'Mostrar servisiso',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.detectedIntent).toBe('consulta_servicio');
    expect(result.response).toBe(
      'Para mostrar sus servicios, podemos preparar un sitio web enfocado en su negocio.',
    );
  });

  it('retries an automatic meeting offer when backend policy forbids it', async () => {
    const meeting = JSON.stringify({
      response: 'Podemos coordinar una reunión con el equipo.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'proponer_reunion',
      commercialProfile: {},
    });
    const recommendation = JSON.stringify({
      response:
        'Con estos datos podemos preparar una web enfocada en sus servicios.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service, post } = setup([meeting, recommendation]);

    const result = await service.generateResponse({
      messageContent: 'También ofrecemos repuestos.',
      conversationHistory: [],
      conversationGuidance: {
        currentTopic: 'general',
        directAnswerRequired: false,
        allowDiscoveryQuestion: false,
        topicShift: false,
        recentQuestionTopics: [],
        sufficientContext: true,
        allowMeetingOffer: false,
        allowPlanRecommendation: true,
        allowPriceAnswer: false,
        priceAnswerRequired: false,
        allowPlanDetails: false,
        offerWebAlternatives: false,
      },
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.nextAction).toBe('sin_accion');
    expect(result.response).not.toMatch(/reunión|llamada/i);
  });

  it('uses Gemini 3 defaults instead of forcing a low sampling temperature', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response: 'Cuénteme en qué podemos ayudarle.',
        detectedIntent: 'info_general',
        suggestedTags: [],
        nextAction: 'continuar_descubrimiento',
        commercialProfile: {},
      }),
      'gemini-3.8-flash',
    );

    await service.generateResponse({
      messageContent: 'Buenos días',
      conversationHistory: [],
    });

    expect(post.mock.calls[0][1].temperature).toBeUndefined();
    expect(post.mock.calls[0][1].reasoning_effort).toBe('low');
  });

  it('cleans a mechanical opening locally when the rest is useful', async () => {
    const templated = JSON.stringify({
      response: '¡Perfecto! Podemos ayudarle con su proyecto.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const natural = JSON.stringify({
      response: 'Podemos ayudarle con su proyecto.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {},
    });
    const { service, post } = setup([templated, natural]);

    const result = await service.generateResponse({
      messageContent: 'Necesito una web',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.response).toBe('Podemos ayudarle con su proyecto.');
  });

  it('retries a plan recommendation made before enough criteria are known', async () => {
    const premature = JSON.stringify({
      response: 'Le recomiendo la Tienda de Lanzamiento por USD $550.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: { recommendedPlan: 'Tienda de Lanzamiento' },
    });
    const discovery = JSON.stringify({
      response:
        'Antes de recomendarle un plan, ¿necesita que sus clientes paguen directamente en la página?',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const { service, post } = setup([premature, discovery]);

    const result = await service.generateResponse({
      messageContent: 'Quiero mostrar unos 15 productos.',
      conversationHistory: [],
      conversationGuidance: {
        currentTopic: 'store_goal',
        directAnswerRequired: false,
        allowDiscoveryQuestion: true,
        topicShift: false,
        recentQuestionTopics: [],
        sufficientContext: false,
        allowMeetingOffer: false,
        allowPlanRecommendation: false,
        allowPriceAnswer: false,
        priceAnswerRequired: false,
        allowPlanDetails: false,
        offerWebAlternatives: false,
      },
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.response).toContain('Antes de recomendarle un plan');
    expect(result.commercialProfile?.recommendedPlan).toBeUndefined();
  });

  it('removes a corporate welcome from an otherwise natural greeting', async () => {
    const welcome = JSON.stringify({
      response:
        'Buenos días. Bienvenido a UnderCodeEC. ¿En qué podemos ayudarle?',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const { service, post } = setup(welcome);

    const result = await service.generateResponse({
      contactName: 'Christopher',
      messageContent: 'Buenos días',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.response).toBe('Buenos días. ¿En qué podemos ayudarle?');
  });

  it('turns a generic first-contact service inquiry into a natural opening', async () => {
    const genericReply = JSON.stringify({
      response:
        'Hola, con gusto le ayudo. En UnderCodeEC desarrollamos páginas y sitios web, aplicaciones móviles y software a medida. ¿Qué tipo de proyecto o solución tiene en mente?',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const { service } = setup(genericReply);

    const result = await service.generateResponse({
      contactName: 'Christopher',
      messageContent:
        'Hola, quisiera obtener información sobre los servicios de UnderCodeEC.',
      conversationHistory: [],
    });

    expect(result.response).toBe(
      'Hola, Christopher. ¿En qué podemos ayudarle?',
    );
  });

  it('keeps a direct answer when the first contact names a concrete service', async () => {
    const directReply = JSON.stringify({
      response:
        'Con gusto le ayudamos con su sitio web. ¿A qué se dedica su negocio?',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: { service: 'Sitio web' },
    });
    const { service } = setup(directReply);

    const result = await service.generateResponse({
      contactName: 'Christopher',
      messageContent: 'Hola, quisiera información sobre una página web.',
      conversationHistory: [],
    });

    expect(result.response).toBe(
      'Con gusto le ayudamos con su sitio web. ¿A qué se dedica su negocio?',
    );
  });

  it('removes an internal sector label leaked into the customer reply', async () => {
    const { service } = setup(
      JSON.stringify({
        response:
          'Sector. Su objetivo principal es vender ramos directamente en la web o mostrar su catálogo y recibir consultas por WhatsApp?',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'continuar_descubrimiento',
        commercialProfile: {
          service: 'sitio web',
          sector: 'floristería',
        },
      }),
    );

    const result = await service.generateResponse({
      contactName: 'Christopher',
      messageContent: 'Es una floristería',
      conversationHistory: [
        { role: 'user', content: 'Busco un sitio web, ¿me podría ayudar?' },
        {
          role: 'assistant',
          content:
            'Con gusto le ayudamos con su sitio web. ¿A qué se dedica su negocio?',
        },
      ],
    });

    expect(result.response).toBe(
      '¿Su objetivo principal es vender ramos directamente en la web o mostrar su catálogo y recibir consultas por WhatsApp?',
    );
  });

  it('repairs the conversation instead of recommending a plan after a confused question mark', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response:
          'Para mostrar sus arreglos florales, la opción adecuada es nuestro Plan de Lanzamiento.',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'sin_accion',
        commercialProfile: {
          service: 'sitio web',
          sector: 'floristería',
          need: 'mostrar arreglos florales',
          recommendedPlan: 'Plan de Lanzamiento',
        },
      }),
    );

    const result = await service.generateResponse({
      contactName: 'Christopher',
      messageContent: '?',
      conversationHistory: [
        { role: 'user', content: 'Mostrar mis arreglos florales' },
        {
          role: 'assistant',
          content:
            'Podemos usar este mismo número de WhatsApp para continuar. ¿Qué horario le viene bien?',
        },
      ],
      commercialProfile: {
        service: 'sitio web',
        sector: 'floristería',
        need: 'mostrar arreglos florales',
      },
    });

    expect(result.response).toBe(
      'Disculpe la confusión. No es necesario agendar una llamada; podemos continuar por este mismo chat con la información de su sitio web.',
    );
    expect(result.response).not.toMatch(/plan de lanzamiento|horario/i);
    expect(result.commercialProfile?.recommendedPlan).toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });

  it('repairs missing opening question marks and joins a continued question with a comma', async () => {
    const malformed = JSON.stringify({
      response:
        'Con gusto le ayudamos con el desarrollo de su sitio web. a qué se dedica su negocio?',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: { service: 'Sitio web' },
    });
    const { service, post } = setup(malformed);

    const result = await service.generateResponse({
      messageContent: '¿Me podrían ayudar con un sitio web?',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.response).toBe(
      'Con gusto le ayudamos con el desarrollo de su sitio web, ¿a qué se dedica su negocio?',
    );
  });

  it('adds the opening mark to a standalone question', async () => {
    const malformed = JSON.stringify({
      response: 'Buenas noches, Christopher. En qué podemos ayudarle hoy?',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const { service } = setup(malformed);

    const result = await service.generateResponse({
      contactName: 'Christopher',
      messageContent: 'Buenas noches',
      conversationHistory: [],
    });

    expect(result.response).toBe(
      'Buenas noches, Christopher. ¿En qué podemos ayudarle hoy?',
    );
  });

  it('retries a full plan dump and presents two brief promotional-web options', async () => {
    const fullPlan = JSON.stringify({
      response:
        'El Plan de Lanzamiento cuesta USD $360 e incluye hasta 5 páginas, dominio, hosting, SSL, correos corporativos, formulario, WhatsApp, Google y soporte.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: { recommendedPlan: 'Plan de Lanzamiento' },
    });
    const options = JSON.stringify({
      response:
        'Puede empezar con una Landing Básica de USD $275 si desea concentrar sus servicios, o con el Plan de Lanzamiento de USD $425 si prefiere un sitio web. ¿Cuál de las dos opciones le interesa conocer?',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const { service, post } = setup([fullPlan, options]);

    const result = await service.generateResponse({
      messageContent: 'Quiero promocionar mis servicios.',
      conversationHistory: [],
      commercialSnapshot: snapshot([
        offer('Landing Básica', '275.00', 'LANDING_PAGE'),
        offer('Plan de Lanzamiento', '425.00', 'WEBSITE'),
      ]),
      conversationGuidance: {
        currentTopic: 'general',
        directAnswerRequired: false,
        allowDiscoveryQuestion: false,
        topicShift: false,
        recentQuestionTopics: [],
        sufficientContext: true,
        allowMeetingOffer: false,
        allowPlanRecommendation: true,
        allowPriceAnswer: false,
        priceAnswerRequired: false,
        allowPlanDetails: false,
        offerWebAlternatives: true,
      },
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.response).toContain('Landing Básica de USD $275');
    expect(result.response).toContain('Plan de Lanzamiento de USD $425');
    expect(result.response).not.toContain('dominio');
  });

  it('recovers locally with CRM offer names when both attempts omit web alternatives', async () => {
    const incomplete = JSON.stringify({
      response:
        'El Plan de Lanzamiento le permite mostrar sus servicios en un sitio web.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: { recommendedPlan: 'Plan de Lanzamiento' },
    });
    const { service, post } = setup([incomplete, incomplete]);

    const result = await service.generateResponse({
      messageContent: 'Mostrar servicios',
      conversationHistory: [],
      commercialSnapshot: snapshot([
        offer('Landing Básica', '275.00', 'LANDING_PAGE'),
        offer('Plan de Lanzamiento', '425.00', 'WEBSITE'),
      ]),
      conversationGuidance: {
        currentTopic: 'general',
        directAnswerRequired: false,
        allowDiscoveryQuestion: false,
        topicShift: false,
        recentQuestionTopics: [],
        sufficientContext: true,
        allowMeetingOffer: false,
        allowPlanRecommendation: true,
        allowPriceAnswer: false,
        priceAnswerRequired: false,
        allowPlanDetails: false,
        offerWebAlternatives: true,
      },
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.detectedIntent).toBe('consulta_servicio');
    expect(result.nextAction).toBe('continuar_descubrimiento');
    expect(result.response).toContain('Landing Básica');
    expect(result.response).toContain('Plan de Lanzamiento');
    expect(result.response).not.toMatch(/USD|\$/);
    expect(result.commercialProfile?.recommendedPlan).toBeUndefined();
  });

  it('uses a contextual commercial fallback when both model attempts violate policy', async () => {
    const informal = JSON.stringify({
      response: 'Cuéntame qué quieres lograr con tu web.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: { service: 'Sitio web' },
    });
    const prematurePlan = JSON.stringify({
      response: 'Te recomiendo el Plan de Lanzamiento por USD $360.',
      detectedIntent: 'consulta_servicio',
      suggestedTags: [],
      nextAction: 'sin_accion',
      commercialProfile: {
        service: 'Sitio web',
        recommendedPlan: 'Plan de Lanzamiento',
      },
    });
    const { service, post } = setup([informal, prematurePlan]);

    const result = await service.generateResponse({
      messageContent: 'Reparaciónes de refrigeradores',
      conversationHistory: [
        { role: 'user', content: 'Estoy buscando un sitio web' },
        {
          role: 'assistant',
          content: '¿A qué se dedica su negocio?',
        },
      ],
      conversationGuidance: {
        currentTopic: 'general',
        directAnswerRequired: false,
        allowDiscoveryQuestion: true,
        topicShift: false,
        recentQuestionTopics: ['business'],
        sufficientContext: false,
        allowMeetingOffer: false,
        allowPlanRecommendation: false,
        allowPriceAnswer: false,
        priceAnswerRequired: false,
        allowPlanDetails: false,
        offerWebAlternatives: false,
      },
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.detectedIntent).toBe('info_general');
    expect(result.nextAction).toBe('continuar_descubrimiento');
    expect(result.response).toContain('resultado principal');
    expect(result.response).not.toContain('inconveniente temporal');
    expect(result.commercialProfile?.recommendedPlan).toBeUndefined();
  });
});
