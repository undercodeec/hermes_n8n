import { CommercialPolicyService } from './commercial-policy.service';

describe('CommercialPolicyService', () => {
  const service = new CommercialPolicyService();
  const receivedAt = new Date('2026-09-18T20:00:00.000Z');

  it('keeps price and timeline as explicit pending questions', () => {
    const decision = service.analyze(
      'Necesito una web, ¿cuánto cuesta y cuánto tarda?',
      receivedAt,
    );

    expect(decision.intent).toBe('consulta_precio');
    expect(decision.pendingQuestions).toEqual(['price', 'timeline']);
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
});
