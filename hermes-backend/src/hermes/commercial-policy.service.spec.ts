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
});
