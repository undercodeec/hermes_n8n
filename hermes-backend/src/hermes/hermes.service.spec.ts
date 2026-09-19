import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { HermesService } from './hermes.service';

describe('HermesService commercial contract', () => {
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
    const post = jest.fn();
    for (const responseContent of contents) {
      post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: responseContent } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        },
      });
    }
    (service as any).httpClient.post = post;
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

    const systemMessage = post.mock.calls[0][1].messages[0].content as string;
    expect(systemMessage).toContain('¿A qué se dedica su negocio?');
    expect(systemMessage).toContain(
      'no abras otra ronda de descubrimiento sobre contacto o interacciones',
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
      paymentContext: 'PROJECT_PAYMENT' as const,
    };
    const result = await service.generateResponse({
      messageContent: '¿Puedo pagar 50/50?',
      conversationHistory: [],
      currentIntent: 'consulta_pago_proyecto',
      conversationGuidance: guidance,
    });

    const body = post.mock.calls[0][1];
    const systemMessage = body.messages[0].content as string;
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

    expect(result.response).toContain('este mismo número de WhatsApp');
    expect(result.response).not.toMatch(/confirmar tu número/i);
  });

  it('adds the store plans to context and keeps ecommerce discovery facts', async () => {
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
    });

    const body = post.mock.calls[0][1];
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toContain('Tienda de Lanzamiento — USD $550');
    expect(systemMessage).toContain('Tienda de Crecimiento — USD $850');
    expect(systemMessage).toContain('USD $40 al año');
    expect(result.commercialProfile).toEqual(
      expect.objectContaining({
        service: 'Tienda Online',
        productCount: '30 productos',
        corporateEmailNeeds: '3 cuentas',
      }),
    );
  });

  it('uses a safe handoff response when the provider returns invalid JSON', async () => {
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
    expect(result.nextAction).toBe('derivar_humano');
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
    expect(post.mock.calls[1][1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('usa tuteo'),
        }),
      ]),
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

  it('retries a mechanical opening even when the rest is formally written', async () => {
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

    expect(post).toHaveBeenCalledTimes(2);
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
      },
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.response).toContain('Antes de recomendarle un plan');
    expect(result.commercialProfile?.recommendedPlan).toBeUndefined();
  });
});
