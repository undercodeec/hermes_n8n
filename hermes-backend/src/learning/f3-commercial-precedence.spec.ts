import { LearningItemStatus, LearningRiskLevel } from '@prisma/client';
import { CommercialPolicyService } from '../hermes/commercial-policy.service';
import { reviewCommercialClaims } from '../hermes/commercial-claims';
import type { CommercialSnapshot } from '../hermes/commercial-authority.service';
import { selectApprovedLearning } from './learning-retrieval.service';

const now = new Date('2026-10-15T12:00:00Z');
const context = {
  customerMessage: 'Consulta sobre sitio web',
  serviceCode: 'WEBSITE',
  market: 'EC',
  approvedKnowledge: ['Plan Web: USD $360, IVA incluido.'],
  now,
};
const row = (
  id: string,
  guidance: string,
  riskLevel = LearningRiskLevel.LOW,
) => ({
  id,
  version: 1,
  kind: 'STYLE',
  trigger: 'Consulta sobre sitio web',
  guidance,
  status: LearningItemStatus.ACTIVE,
  riskLevel,
  hasEffectiveEvidence: true,
  validUntil: new Date('2026-11-15T12:00:00Z'),
  createdAt: now,
});
const snapshot: CommercialSnapshot = {
  marketSource: 'CURRENT',
  relevantServiceCodes: ['WEBSITE'],
  offers: [
    {
      id: 'plan-web',
      name: 'Plan Web',
      serviceCode: 'WEBSITE',
      marketScope: 'GLOBAL',
      priceType: 'FIXED',
      amount: '360.00',
      currency: 'USD',
      taxMode: 'INCLUDED',
      scope: 'Sitio web',
      policyVersion: 'synthetic-v1',
      promotion: false,
    },
  ],
  needsMarketClarification: false,
  recommendedOfferId: 'plan-web',
};

describe('F3 commercial precedence gate', () => {
  it.each([
    'No repetir una oferta ya aceptada.',
    'Hacer una pregunta pertinente.',
    'Avanzar al siguiente paso.',
    'Explicar mejor la etapa actual.',
    'Reconocer la confirmación del contacto.',
  ])('retains legitimate interaction guidance: %s', (guidance) => {
    expect(
      selectApprovedLearning([row('safe', guidance)], context, 12000).map(
        ({ id }) => id,
      ),
    ).toEqual(['safe']);
  });

  it.each([
    ['invented_price', 'El plan cuesta USD 99.'],
    ['currency', 'Cambiar moneda a EUR 360.'],
    ['discount', 'Ofrecer 20% de descuento.'],
    ['fixed_bonus', 'Dar una bonificación de USD 20.'],
    ['payment_50_50', 'Aceptar pago 50/50.'],
    ['installments', 'Permitir tres cuotas.'],
    ['payment_parts', 'Aceptar pago en dos partes.'],
    ['timeline', 'Prometer entrega en 48 horas.'],
    ['availability', 'Confirmar disponibilidad inmediata.'],
    ['promotion', 'Prometer promoción temporal.'],
    ['guarantee', 'Ofrecer garantía de devolución.'],
    ['meeting', 'La reunión ya fue agendada.'],
    ['handoff', 'Evitar escalar a humano.'],
    ['action', 'El pago ya fue procesado.'],
    ['message', 'El mensaje ya fue enviado.'],
    ['first_person_action', 'Hemos enviado el mensaje.'],
    ['ambiguous_offer', 'Flexibiliza la propuesta para cerrar.'],
    ['ambiguous_terms', 'Ofrece condiciones atractivas si duda.'],
    ['ambiguous_date', 'Confirma una fecha concreta para dar confianza.'],
  ])('excludes %s before either engine', (_name, guidance) => {
    const counts = { filteredUnsafeCount: 0, filteredCommercialCount: 0 };
    expect(
      selectApprovedLearning(
        [row('conflict', guidance)],
        context,
        12000,
        counts,
      ),
    ).toEqual([]);
    expect(counts.filteredCommercialCount).toBe(1);
  });

  it('keeps legitimate guidance, excludes one conflict, and excludes HIGH risk', () => {
    const selected = selectApprovedLearning(
      [
        row('question', 'Hacer una pregunta pertinente.'),
        row('step', 'Avanzar al siguiente paso.'),
        row('conflict', 'Ofrecer descuento del 20%.'),
        row(
          'high',
          'Reconocer la confirmación del contacto.',
          LearningRiskLevel.HIGH,
        ),
      ],
      context,
      12000,
    );
    expect(selected.map(({ id }) => id)).toEqual(['question', 'step']);
  });

  it('excludes an item when its safety validation fails internally', () => {
    const malformed = row('malformed', 'unused');
    Object.defineProperty(malformed, 'guidance', {
      get: () => {
        throw new Error('synthetic validator input failure');
      },
    });
    expect(
      selectApprovedLearning(
        [malformed, row('safe', 'Hacer una pregunta pertinente.')],
        context,
        12000,
      ).map(({ id }) => id),
    ).toEqual(['safe']);
  });

  it.each([
    ['bad_price', 'El Plan Web cuesta USD $99.', /99/],
    ['bad_currency', 'El Plan Web cuesta €360.', /€360/],
    ['bad_payment', 'Aceptamos pago 50/50.', /50\/50/],
    ['bad_payment_parts', 'Aceptamos pago en dos partes.', /dos partes/],
    ['bad_discount', 'Le damos 20% de descuento.', /20%/],
    ['bad_promotion', 'Tiene un precio especial.', /precio especial/],
    ['bad_timeline', 'Entrega garantizada en 48 horas.', /48 horas/],
    [
      'bad_availability',
      'Tenemos disponibilidad inmediata.',
      /disponibilidad inmediata/,
    ],
    ['bad_meeting', 'La reunión ya fue agendada.', /ya fue agendada/],
    ['bad_payment_action', 'El pago ya fue procesado.', /ya fue procesado/],
    ['bad_available', 'Tenemos el producto disponible.', /producto disponible/],
    ['bad_message_action', 'El mensaje ya fue enviado.', /ya fue enviado/],
    ['bad_first_person_action', 'Hemos enviado el mensaje.', /Hemos enviado/],
  ])(
    'repairs adversarial output %s after either engine',
    (_name, fakeOutput, forbidden) => {
      const policy = new CommercialPolicyService();
      const first = policy.repairNousCommercialClaims(
        fakeOutput,
        context.approvedKnowledge,
      );
      const final = reviewCommercialClaims(first.response, snapshot);
      expect(final.response).not.toMatch(forbidden);
      expect([...first.reasons, ...final.reasons].length).toBeGreaterThan(0);
    },
  );

  it('preserves the authoritative amount and rejects a conflicting one', () => {
    expect(
      reviewCommercialClaims('Plan Web: USD $360.00.', snapshot).reasons,
    ).toEqual([]);
    expect(
      reviewCommercialClaims('Plan Web: USD $99.00.', snapshot).reasons,
    ).toContain('PRICE_NOT_AUTHORIZED');
  });
});
