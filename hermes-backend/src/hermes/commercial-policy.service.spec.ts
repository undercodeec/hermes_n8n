import {
  CommercialPolicyDecision,
  CommercialPolicyService,
} from './commercial-policy.service';
import { normalizeCommonSpanishTypos } from './spanish-text-normalizer';

describe('CommercialPolicyService', () => {
  const service = new CommercialPolicyService();
  const receivedAt = new Date('2026-09-18T20:00:00.000Z');
  const sectorCases = [
    ['reparación de refrigeradores', 'sitio web'],
    ['restaurante', 'sitio web'],
    ['abogado o consultor', 'landing'],
    ['floristería', 'catálogo sin pagos'],
    ['comercio', 'tienda con pagos online'],
    ['servicio profesional', 'sitio web'],
  ] as const;
  const sufficientDecision = (): CommercialPolicyDecision => ({
    intent: 'consulta_servicio',
    pendingQuestions: [],
    requestsHuman: false,
    requestsCall: false,
    hasRelativeCallTime: false,
    guidance: {
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

  it('removes unsupported discounts, payment terms and delivery promises while preserving supported content', () => {
    const result = service.repairNousCommercialClaims(
      'El sitio web presenta sus servicios. Le doy 20% de descuento. Entrega garantizada en 2 semanas. Puede pagar en 12 cuotas.',
      ['Sitio web para presentar servicios.'],
    );
    expect(result.response).toBe('El sitio web presenta sus servicios.');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'UNAUTHORIZED_DISCOUNT',
        'UNAUTHORIZED_TIMELINE',
        'UNAUTHORIZED_PAYMENT_TERMS',
      ]),
    );
  });

  it('preserves a generic promotion claim when a current CRM offer is promotional', () => {
    const result = service.repairNousCommercialClaims(
      'Hay una promoción vigente para este sitio web.',
      ['Promoción autorizada para sitio web.'],
      true,
    );
    expect(result.response).toBe(
      'Hay una promoción vigente para este sitio web.',
    );
    expect(result.reasons).toEqual([]);
  });

  it('removes a delivery promise expressed in words', () => {
    const result = service.repairNousCommercialClaims(
      'La tienda permite comprar por internet. Se la entregamos en una semana.',
      ['Tienda online con carrito y pago.'],
    );
    expect(result.response).toBe('La tienda permite comprar por internet.');
    expect(result.reasons).toContain('UNAUTHORIZED_TIMELINE');
  });

  it('removes an unlisted inclusion but retains a catalog-backed one', () => {
    const result = service.repairNousCommercialClaims(
      'Incluye dominio y hosting. Incluye un CRM empresarial.',
      ['El plan incluye dominio y hosting por un año.'],
    );
    expect(result.response).toBe('Incluye dominio y hosting.');
    expect(result.reasons).toContain('UNAUTHORIZED_INCLUSION');
  });

  it('does not hand off when the customer explicitly refuses a person', () => {
    expect(
      service.analyze(
        'No quiero hablar con una persona; solo información',
        receivedAt,
      ).requestsHuman,
    ).toBe(false);
  });

  it.each(sectorCases)(
    '%s receives the same decision for equivalent evidence',
    (sector) => {
      const decision = service.analyze(
        `Mi negocio es ${sector}`,
        receivedAt,
        [],
        {
          conversationHistory: [
            {
              role: 'user',
              content: 'Necesito una presencia web para promocionarme',
            },
            { role: 'assistant', content: '¿A qué se dedica su negocio?' },
          ],
          commercialProfile: {
            service: 'sitio web',
            need: 'promocionar servicios o productos',
          },
        },
      );
      expect(decision.guidance.sufficientContext).toBe(true);
      expect(decision.guidance.allowDiscoveryQuestion).toBe(false);
    },
  );

  it.each([
    [
      'Aplicación móvil para que nuestros socios consulten pedidos',
      'general',
      false,
    ],
    [
      'Software a medida integrado con inventario para el equipo de bodega',
      'general',
      true,
    ],
    ['¿Cuánto cuesta un sitio web?', 'price', false],
    ['¿Cuánto cuesta y cuánto tarda un sistema a medida?', 'price', false],
    ['Antes explíqueme qué incluye el hosting', 'infrastructure', false],
    ['Quiero hablar con una persona', 'general', false],
    ['¿Desde dónde trabaja UnderCodeEC?', 'business_location', false],
  ] as const)(
    'maps %s to topic %s and meeting=%s',
    (message, currentTopic, allowMeetingOffer) => {
      const decision = service.analyze(message, receivedAt);

      expect(decision.guidance.currentTopic).toBe(currentTopic);
      expect(decision.guidance.allowMeetingOffer).toBe(allowMeetingOffer);
      if (message.includes('cuánto cuesta y cuánto tarda')) {
        expect(decision.pendingQuestions).toEqual(['price', 'timeline']);
      }
      if (message === 'Quiero hablar con una persona') {
        expect(decision.requestsHuman).toBe(true);
      }
      if (message.startsWith('Software a medida')) {
        expect(decision.guidance.allowPlanRecommendation).toBe(false);
        expect(decision.pendingQuestions).toEqual([]);
      }
    },
  );

  it('does not treat a solution name or negated activity as the business answer', () => {
    const context = {
      conversationHistory: [
        { role: 'assistant', content: '¿A qué se dedica su negocio?' },
      ],
      commercialProfile: {
        service: 'sitio web',
        need: 'promocionar servicios o productos',
      },
    };

    for (const answer of ['landing', 'sitio web', 'No tengo negocio']) {
      expect(
        service.analyze(answer, receivedAt, [], context).guidance
          .sufficientContext,
      ).toBe(false);
    }
  });

  it('treats a lone question mark as confusion instead of permission to recommend a plan', () => {
    const decision = service.analyze('?', receivedAt, [], {
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

    expect(decision.guidance).toEqual(
      expect.objectContaining({
        currentTopic: 'clarification',
        directAnswerRequired: true,
        allowDiscoveryQuestion: false,
        allowMeetingOffer: false,
        allowPlanRecommendation: false,
      }),
    );
  });

  it('classifies an exact UnderCodeEC address request as organization location', () => {
    const decision = service.analyze(
      '¿Cuál es la dirección física exacta de UnderCodeEC?',
      receivedAt,
    );

    expect(decision.guidance.currentTopic).toBe('business_location');
    expect(decision.guidance.directAnswerRequired).toBe(true);
    expect(decision.guidance.allowDiscoveryQuestion).toBe(false);
  });

  it('does not restore a response made only of a blocked question', () => {
    const decision = sufficientDecision();

    expect(
      service.enforceQuestionPolicy('¿Cuál es su presupuesto?', decision),
    ).not.toContain('presupuesto');
  });

  it('keeps useful content and removes the blocked question', () => {
    const decision = sufficientDecision();

    expect(
      service.enforceQuestionPolicy(
        'Podemos avanzar con la valoración. ¿Cuál es su presupuesto?',
        decision,
      ),
    ).toBe('Podemos avanzar con la valoración.');
  });

  it('filters only affirmative unrequested meeting offers', () => {
    const decision = sufficientDecision();
    const enforce = (response: string) =>
      service.enforceResponsePolicy(
        {
          response,
          detectedIntent: 'consulta_servicio',
          nextAction: 'sin_accion',
        },
        decision,
      ).response;

    expect(
      enforce('Podemos coordinar una reunión con el equipo.'),
    ).not.toContain('reunión');
    expect(
      enforce(
        'La solución cubre el alcance. Podemos coordinar una reunión con el equipo.',
      ),
    ).toBe('La solución cubre el alcance.');
    expect(enforce('No necesita una reunión con el equipo.')).toBe(
      'No necesita una reunión con el equipo.',
    );
  });

  it('keeps price and timeline as explicit pending questions', () => {
    const decision = service.analyze(
      'Necesito una web, ¿cuánto cuesta y cuánto tarda?',
      receivedAt,
    );

    expect(decision.intent).toBe('consulta_precio');
    expect(decision.pendingQuestions).toEqual(['price', 'timeline']);
  });

  it('defers website price authority to the CRM snapshot', () => {
    const decision = service.analyze(
      '¿Cuánto cuesta un sitio web?',
      receivedAt,
    );

    expect(decision.guidance.directAnswerRequired).toBe(true);
    expect(decision.guidance.priceAnswerRequired).toBe(true);
    expect(decision.guidance.allowPriceAnswer).toBe(false);
    expect(decision.guidance.allowPlanRecommendation).toBe(false);
  });

  it('does not authorize a price when the requested service has no published value', () => {
    const decision = service.analyze(
      '¿Cuánto cuesta un software a medida para logística?',
      receivedAt,
    );

    expect(decision.guidance.priceAnswerRequired).toBe(true);
    expect(decision.guidance.allowPriceAnswer).toBe(false);
  });

  it.each([
    '¿Dónde están ubicados?',
    '¿Desde dónde trabajan?',
    '¿En qué país queda UnderCodeEC?',
    '¿Tienen sede física?',
  ])('treats organization location as a direct topic: %s', (message) => {
    const decision = service.analyze(message, receivedAt);

    expect(decision.guidance.currentTopic).toBe('business_location');
    expect(decision.guidance.directAnswerRequired).toBe(true);
    expect(decision.guidance.allowDiscoveryQuestion).toBe(false);
  });

  it('does not confuse the customer business location with UnderCodeEC location', () => {
    const decision = service.analyze(
      'Mi restaurante está ubicado en Cuenca y necesito una web',
      receivedAt,
    );

    expect(decision.guidance.currentTopic).not.toBe('business_location');
  });

  it.each([
    'Reparaciones de refrigeradores',
    'Restaurante de comida ecuatoriana',
    'Servicios de asesoría legal',
    'Venta de arreglos florales',
  ])(
    'recognizes a substantive answer to the business question: %s',
    (message) => {
      const decision = service.analyze(message, receivedAt, [], {
        conversationHistory: [
          {
            role: 'user',
            content: 'Necesito un sitio web para promocionarme',
          },
          { role: 'assistant', content: '¿A qué se dedica su negocio?' },
        ],
        commercialProfile: {
          service: 'sitio web',
          need: 'promocionar el negocio',
        },
      });

      expect(decision.guidance.recentQuestionTopics).toContain('business');
      expect(decision.guidance.sufficientContext).toBe(true);
    },
  );

  it('does not treat one isolated word as sufficient scope', () => {
    const decision = service.analyze('Restaurante', receivedAt, [], {
      conversationHistory: [
        { role: 'assistant', content: '¿A qué se dedica su negocio?' },
      ],
      commercialProfile: { service: 'sitio web' },
    });

    expect(decision.guidance.sufficientContext).toBe(false);
  });

  it('normalizes only explicit high-confidence commercial typo variants', () => {
    expect(
      normalizeCommonSpanishTypos(
        'nesesito conocer el presio de un sitio wep para mi restorante',
      ),
    ).toBe('necesito conocer el precio de un sitio web para mi restaurante');
  });

  it('normalizes diacritics before recognizing a substantive business answer', () => {
    const decision = service.analyze(
      'Reparaciónes de refrigeradores',
      receivedAt,
      [],
      {
        conversationHistory: [
          { role: 'assistant', content: '¿A qué se dedica su negocio?' },
        ],
        commercialProfile: {
          service: 'sitio web',
          need: 'promocionar el negocio',
        },
      },
    );

    expect(decision.guidance.sufficientContext).toBe(true);
  });

  it('resolves a relative callback time from the provider timestamp', () => {
    const decision = service.analyze('¿En veinte minutos puede?', receivedAt);

    expect(decision.requestsCall).toBe(true);
    expect(decision.requestedCallAt?.toISOString()).toBe(
      '2026-09-18T20:20:00.000Z',
    );
  });

  it('recognizes an explicit request for a person', () => {
    expect(
      service.analyze('Quiero hablar con una persona.', receivedAt)
        .requestsHuman,
    ).toBe(true);
  });

  it('preserves an earlier unresolved price request on a follow-up', () => {
    const decision = service.analyze('Tengo diez productos.', receivedAt, [
      'price',
    ]);
    expect(decision.pendingQuestions).toContain('price');
  });

  it('marks price as addressed when the answer transparently requires a quote', () => {
    expect(
      service.remainingPendingQuestions(
        ['price', 'timeline'],
        'No tenemos una cifra autorizada para este alcance; el precio requiere una cotización del equipo.',
      ),
    ).toEqual(['timeline']);
  });

  it('distinguishes project installments from checkout payments', () => {
    const project = service.analyze(
      '¿Puedo pagar el proyecto 50% al inicio y 50% contra entrega?',
      receivedAt,
    );
    const checkout = service.analyze(
      '¿Mis clientes pueden pagar con tarjeta dentro de la tienda?',
      receivedAt,
    );

    expect(project.intent).toBe('consulta_pago_proyecto');
    expect(project.guidance.paymentContext).toBe('PROJECT_PAYMENT');
    expect(checkout.intent).toBe('consulta_cobro_tienda');
    expect(checkout.guidance.paymentContext).toBe('STORE_CHECKOUT');
  });

  it('prioritizes a new infrastructure question over an old discovery question', () => {
    const decision = service.analyze(
      '¿Y el hosting qué incluye?',
      receivedAt,
      [],
      {
        conversationHistory: [
          {
            role: 'assistant',
            content: '¿Qué método de pago usarán sus compradores?',
          },
        ],
      },
    );

    expect(decision.guidance.currentTopic).toBe('infrastructure');
    expect(decision.guidance.topicShift).toBe(true);
    expect(decision.guidance.directAnswerRequired).toBe(true);
    expect(decision.guidance.allowDiscoveryQuestion).toBe(false);
  });

  it('removes a repeated discovery question after answering the current topic', () => {
    const decision = service.analyze('¿Qué es el hosting?', receivedAt, [], {
      conversationHistory: [
        {
          role: 'assistant',
          content: '¿Qué método de pago usarán sus compradores?',
        },
      ],
    });

    expect(
      service.enforceQuestionPolicy(
        'El hosting es el espacio donde funciona su sitio web. ¿Qué método de pago usarán sus compradores?',
        decision,
      ),
    ).toBe('El hosting es el espacio donde funciona su sitio web.');
  });

  it('does not append generic project discovery to a direct payment answer', () => {
    const decision = service.analyze(
      '¿Puedo pagar el proyecto 50/50?',
      receivedAt,
    );

    expect(
      service.enforceQuestionPolicy(
        'El equipo debe confirmar las condiciones en la propuesta. ¿Qué tipo de proyecto tiene en mente?',
        decision,
      ),
    ).toBe('El equipo debe confirmar las condiciones en la propuesta.');
  });

  it('stops discovery when the persisted scope is already sufficient', () => {
    const decision = service.analyze(
      'También ofrecemos repuestos.',
      receivedAt,
      [],
      {
        commercialProfile: {
          service: 'sitio web',
          need: 'promocionar reparación de lavadoras a domicilio',
          sector: 'reparación de electrodomésticos',
        },
      },
    );

    expect(decision.guidance.sufficientContext).toBe(true);
    expect(decision.guidance.allowDiscoveryQuestion).toBe(false);
  });

  it('requires clarification before treating a visible catalog as ecommerce', () => {
    const decision = service.analyze(
      'Tengo una tienda de ropa y quiero que mis clientes puedan ver mis productos.',
      receivedAt,
    );

    expect(decision.guidance.requiredClarification).toBe(
      'CATALOG_VS_ONLINE_SALES',
    );
    expect(decision.guidance.allowPlanRecommendation).toBe(false);
    expect(decision.guidance.allowDiscoveryQuestion).toBe(true);
  });

  it('clarifies whether a displayed catalog should also accept online sales', () => {
    const decision = service.analyze('Quiero mostrar un catálogo', receivedAt);

    expect(decision.guidance.requiredClarification).toBe(
      'CATALOG_VS_ONLINE_SALES',
    );
  });

  it('replaces a premature store-plan recommendation with the required distinction', () => {
    const decision = service.analyze(
      'Quiero mostrar los productos de mi tienda.',
      receivedAt,
    );

    const result = service.enforceResponsePolicy(
      {
        response: 'Le recomiendo la Tienda de Lanzamiento por USD $550.',
        detectedIntent: 'consulta_servicio',
        nextAction: 'sin_accion',
        suggestedTags: ['tienda_online'],
        commercialProfile: {
          service: 'Tienda Online',
          recommendedPlan: 'Tienda de Lanzamiento',
          paymentNeeds: 'Pago en línea',
        },
        tokensUsed: 10,
        costEstimate: 0,
      },
      decision,
    );

    expect(result.response).toContain('solamente vean el catálogo');
    expect(result.response).toContain('comprar y pagar directamente');
    expect(result.commercialProfile?.recommendedPlan).toBeUndefined();
    expect(result.commercialProfile?.paymentNeeds).toBeUndefined();
    expect(result.commercialProfile?.service).toBeUndefined();
    expect(result.commercialProfile?.need).toContain('falta confirmar');
    expect(result.suggestedTags).toBeUndefined();
  });

  it('keeps the catalog-versus-sales clarification pending after a product count answer', () => {
    const decision = service.analyze(
      'Unos 10 a 15 productos.',
      receivedAt,
      [],
      {
        conversationHistory: [
          {
            role: 'user',
            content: 'Quiero que mis clientes puedan ver mis productos.',
          },
          {
            role: 'assistant',
            content:
              '¿Desea solo exhibir el catálogo o también vender y cobrar en la página?',
          },
        ],
        commercialProfile: {
          need: 'Mostrar productos en internet; falta confirmar catálogo o venta online',
        },
      },
    );

    expect(decision.guidance.requiredClarification).toBe(
      'CATALOG_VS_ONLINE_SALES',
    );
    expect(decision.guidance.allowPlanRecommendation).toBe(false);
  });

  it('recognizes explicit online selling but waits for enough plan criteria', () => {
    const decision = service.analyze(
      'Quiero vender mis productos y cobrar online en la página.',
      receivedAt,
    );

    expect(decision.guidance.requiredClarification).toBeUndefined();
    expect(decision.guidance.allowPlanRecommendation).toBe(false);
  });

  it('allows a store plan after product volume and checkout needs are known', () => {
    const decision = service.analyze(
      'Serán unos 15 productos y necesito cobrar con tarjeta.',
      receivedAt,
      [],
      {
        commercialProfile: {
          service: 'Tienda Online',
          need: 'Vender y cobrar en línea',
        },
      },
    );

    expect(decision.guidance.requiredClarification).toBeUndefined();
    expect(decision.guidance.allowPlanRecommendation).toBe(true);
  });

  it('removes an unrequested meeting offer from a sufficient response', () => {
    const decision = service.analyze(
      'También ofrecemos repuestos.',
      receivedAt,
      [],
      {
        commercialProfile: {
          service: 'sitio web',
          need: 'promocionar reparación de lavadoras a domicilio',
          sector: 'reparación de electrodomésticos',
        },
      },
    );

    const result = service.enforceResponsePolicy(
      {
        response:
          'La web puede destacar el servicio a domicilio y los repuestos. Podemos coordinar una conversación con el equipo.',
        detectedIntent: 'consulta_servicio',
        nextAction: 'proponer_reunion',
        tokensUsed: 10,
        costEstimate: 0,
      },
      decision,
    );

    expect(result.response).toBe(
      'La web puede destacar el servicio a domicilio y los repuestos.',
    );
    expect(result.nextAction).toBe('sin_accion');
  });

  it('allows a meeting offer when a sufficiently defined custom system needs valuation', () => {
    const decision = service.analyze(
      'Debe integrarse con nuestro inventario.',
      receivedAt,
      [],
      {
        commercialProfile: {
          service: 'software a medida',
          need: 'automatizar pedidos y facturación',
          users: 'equipo comercial y bodega',
        },
      },
    );

    expect(decision.guidance.allowMeetingOffer).toBe(true);
  });

  it('offers landing and website as brief alternatives for a promotional presence', () => {
    const decision = service.analyze(
      'Quiero que puedan ver mis servicios y promocionar mi negocio.',
      receivedAt,
      [],
      {
        commercialProfile: {
          service: 'sitio web',
          need: 'promocionar reparación de lavadoras',
          sector: 'reparación de electrodomésticos',
        },
      },
    );

    expect(decision.guidance.offerWebAlternatives).toBe(true);
    expect(decision.guidance.allowPlanRecommendation).toBe(true);
    expect(decision.guidance.allowPlanDetails).toBe(false);

    const enforced = service.enforceResponsePolicy(
      {
        response:
          'Puede valorar una Landing Básica de $250 o un Plan de Lanzamiento de $360.',
        detectedIntent: 'consulta_servicio',
        nextAction: 'sin_accion',
        commercialProfile: { recommendedPlan: 'Plan de Lanzamiento' },
      },
      decision,
    );
    expect(enforced.commercialProfile?.recommendedPlan).toBeUndefined();
  });

  it('recognizes common service spelling errors without losing the web recommendation', () => {
    const decision = service.analyze('Mostrar servisiso', receivedAt, [], {
      commercialProfile: {
        service: 'sitio web',
        need: 'promocionar el negocio de reparaciones',
        sector: 'reparaciones técnicas',
      },
    });

    expect(decision.guidance.sufficientContext).toBe(true);
    expect(decision.guidance.offerWebAlternatives).toBe(true);
    expect(decision.guidance.allowPlanRecommendation).toBe(true);
    expect(decision.guidance.allowDiscoveryQuestion).toBe(false);
  });

  it('allows details only for the plan explicitly selected by the client', () => {
    const decision = service.analyze(
      'Me interesa la Landing Básica, ¿qué incluye?',
      receivedAt,
      [],
      {
        conversationHistory: [
          {
            role: 'assistant',
            content:
              'Puede elegir una Landing Básica de $250 o un Plan de Lanzamiento de $360.',
          },
        ],
      },
    );

    expect(decision.guidance.currentTopic).toBe('plan_details');
    expect(decision.guidance.directAnswerRequired).toBe(true);
    expect(decision.guidance.interestedPlan).toBe('LANDING_PAGE');
    expect(decision.guidance.allowPlanDetails).toBe(true);
    expect(decision.guidance.allowPlanRecommendation).toBe(true);
    expect(decision.guidance.offerWebAlternatives).toBe(false);
  });

  it('does not guess a plan when a detail question follows two alternatives', () => {
    const decision = service.analyze('¿Qué incluye?', receivedAt, [], {
      conversationHistory: [
        {
          role: 'assistant',
          content:
            'Puede elegir una Landing Básica de $250 o un Plan de Lanzamiento de $360.',
        },
      ],
    });

    expect(decision.guidance.interestedPlan).toBeUndefined();
    expect(decision.guidance.allowPlanDetails).toBe(false);
  });

  it('understands a selected web option by its quoted price', () => {
    const decision = service.analyze(
      'Me interesa la de $250, ¿qué incluye?',
      receivedAt,
      [],
      {
        conversationHistory: [
          {
            role: 'assistant',
            content:
              'Puede elegir una Landing Básica de $250 o un Plan de Lanzamiento de $360.',
          },
        ],
      },
    );

    expect(decision.guidance.interestedPlan).toBe('LANDING_PAGE');
    expect(decision.guidance.allowPlanDetails).toBe(true);
  });

  it('understands colloquial questions about what a selected plan includes', () => {
    const decision = service.analyze(
      'La landing de 250, ¿qué nomás viene?',
      receivedAt,
    );

    expect(decision.guidance.currentTopic).toBe('plan_details');
    expect(decision.guidance.interestedPlan).toBe('LANDING_PAGE');
    expect(decision.guidance.allowPlanDetails).toBe(true);
  });
});
