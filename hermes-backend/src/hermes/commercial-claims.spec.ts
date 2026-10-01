import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
} from '@prisma/client';
import { CommercialPolicyService } from './commercial-policy.service';
import type {
  AuthorizedOffer,
  CommercialSnapshot,
} from './commercial-authority.service';
import {
  answerExplicitPriceIfMissing,
  reviewCommercialClaims,
  reconcileCommercialIntent,
} from './commercial-claims';

describe('commercial claims', () => {
  it.each([
    ['USD 360 IVA incluido.', false, 'consulta_precio'],
    ['El precio requiere valoración.', false, 'consulta_precio'],
    ['¿Qué desea mostrar en la web?', false, 'info_general'],
    ['Se registró la solicitud.', true, 'cotizacion'],
  ])(
    'reconciles the final semantic function: %s',
    (text, quoteCreated, intent) => {
      expect(
        reconcileCommercialIntent('consulta_precio', text, true, quoteCreated),
      ).toBe(intent);
    },
  );
  const offer: AuthorizedOffer = {
    id: 'test-offer',
    name: 'Plan de Lanzamiento',
    serviceCode: 'WEBSITE',
    market: CommercialMarket.EC,
    marketScope: 'MARKET',
    priceType: CommercialPriceType.FIXED,
    amount: '360.00',
    currency: 'USD',
    taxMode: CommercialTaxMode.INCLUDED,
    taxLabel: 'IVA',
    scope: 'Hasta cinco páginas',
    policyVersion: 'test-only',
    promotion: false,
  };
  const snapshot = (
    offers: AuthorizedOffer[] = [offer],
  ): CommercialSnapshot => ({
    market: CommercialMarket.EC,
    marketSource: 'CURRENT',
    relevantServiceCodes: ['WEBSITE'],
    offers,
    needsMarketClarification: false,
  });

  it.each([
    'USD 360e3',
    'USD 360€',
    '$360€',
    'USD360€',
    'USD 360 €',
    'USD 360EUR',
    'EUR360$',
    '€360 USD',
    '360 USD€',
    '360 dólares €',
    'USD 360 EUR',
    'USD 360 euros',
    '$360 EUR',
    'EUR 360 USD',
    'USD 3,60,00',
  ])('rejects incompatible monetary expressions: %s', (money) => {
    expect(reviewCommercialClaims(money, snapshot()).reasons).toContain(
      'PRICE_NOT_AUTHORIZED',
    );
  });

  it('isolates buyer exceptions for combinations of subjects, conjunctions and payment terms', () => {
    const buyers = [
      'El comprador',
      'El cliente final',
      'El consumidor',
      'Quien compra',
      'El cliente del negocio',
      'Sus clientes',
    ];
    const contracts = [
      'el proyecto',
      'el sitio',
      'la web',
      'la página',
      'la aplicación',
      'el software',
      'el desarrollo',
      'el servicio contratado',
      'el trabajo',
      'la implementación',
      'nuestro equipo',
    ];
    const terms = [
      'se paga en cuotas',
      'se paga al finalizar',
      'se paga después',
      'no requiere anticipo',
      'sin anticipo',
    ];
    const policy = new CommercialPolicyService();
    for (const buyer of buyers)
      for (const contract of contracts)
        for (const term of terms)
          for (const join of [' y ', '; ']) {
            const valid = `${buyer} paga al recibir`;
            const text = `${valid}${join}${contract} ${term}.`;
            for (const review of [
              reviewCommercialClaims(text, snapshot()),
              policy.repairNousCommercialClaims(text, []),
            ]) {
              expect(review.reasons).toContain('UNAUTHORIZED_PAYMENT_TERMS');
              expect(review.response).toContain(valid);
              expect(review.response).not.toContain(term);
            }
          }
  });

  it.each([
    'El comprador paga contra entrega y la web se paga en cuotas.',
    'El comprador paga al recibir y el sitio se paga al finalizar.',
    'Sus compradores pagan con tarjeta; usted puede pagarnos en cuotas.',
    'El comprador paga contra entrega y la aplicación se paga después.',
    'El cliente final paga al recibir; el desarrollo no requiere anticipo.',
  ])('removes provider terms while retaining the buyer clause: %s', (text) => {
    const buyer = text.split(/ y |;/)[0];
    for (const result of [
      reviewCommercialClaims(text, snapshot()),
      new CommercialPolicyService().repairNousCommercialClaims(text, []),
    ]) {
      expect(result.response).toBe(`${buyer}.`);
      expect(result.reasons).toContain('UNAUTHORIZED_PAYMENT_TERMS');
    }
  });

  it.each([
    'El comprador paga contra entrega.',
    'El comprador no paga por adelantado y paga al recibir.',
    'Sus clientes pueden pagar cuando reciben su pedido.',
  ])('preserves buyer-only payment clauses: %s', (text) => {
    expect(reviewCommercialClaims(text, snapshot())).toEqual({
      response: text,
      reasons: [],
    });
    expect(
      new CommercialPolicyService().repairNousCommercialClaims(text, [])
        .response,
    ).toBe(text);
  });

  it.each([
    'no incluye IVA',
    'IVA excluido',
    'IVA excluida',
    'IVA excluidos',
    'IVA excluidas',
    'más el IVA',
    '+ el IVA',
    'más IVA',
    'sin IVA',
  ])('enforces excluded-tax language: %s', (tax) => {
    expect(
      reviewCommercialClaims(`USD 360 ${tax}`, snapshot()).reasons,
    ).toContain('TAX_CLAIM_NOT_AUTHORIZED');
    expect(
      reviewCommercialClaims(
        `USD 360 ${tax}`,
        snapshot([{ ...offer, taxMode: CommercialTaxMode.EXCLUDED }]),
      ).reasons,
    ).toEqual([]);
  });
  it.each([
    'IVA incluido',
    'IVA incluida',
    'IVA incluidos',
    'IVA incluidas',
    'impuestos incluidos',
    'incluye IVA',
  ])('enforces included-tax language: %s', (tax) => {
    expect(
      reviewCommercialClaims(`USD 360 ${tax}`, snapshot()).reasons,
    ).toEqual([]);
    expect(
      reviewCommercialClaims(
        `USD 360 ${tax}`,
        snapshot([{ ...offer, taxMode: CommercialTaxMode.EXCLUDED }]),
      ).reasons,
    ).toContain('TAX_CLAIM_NOT_AUTHORIZED');
  });

  it.each([
    'El precio está entre Plan A USD 360 y Plan B USD 510.',
    'Plan A cuesta USD 360 y el precio está entre Plan A USD 360 y Plan B USD 510.',
    'Plan A cuesta USD 360 y Plan B cuesta USD 510 y el precio va de Plan A USD 360 a Plan B USD 510.',
    'El proyecto cuesta Plan A USD 360–Plan B USD 510.',
    'El proyecto cuesta Plan A USD 360 hasta Plan B USD 510.',
  ])('rejects a range anywhere in two to four monetary tokens: %s', (text) => {
    expect(
      reviewCommercialClaims(
        text,
        snapshot([
          { ...offer, name: 'Plan A' },
          { ...offer, id: 'b', name: 'Plan B', amount: '510.00' },
        ]),
      ).reasons,
    ).toContain('PRICE_NOT_AUTHORIZED');
  });
  it('preserves repeated independent plan comparisons', () => {
    const text =
      'Plan A cuesta USD 360 y Plan B cuesta USD 510. Plan A: USD 360; Plan B: USD 510.';
    expect(
      reviewCommercialClaims(
        text,
        snapshot([
          { ...offer, name: 'Plan A' },
          { ...offer, id: 'b', name: 'Plan B', amount: '510.00' },
        ]),
      ),
    ).toEqual({ response: text, reasons: [] });
  });

  it.each([
    'Todo incluido.',
    'Incluye todo.',
    'Ese sería el precio completo.',
    'Con eso queda cubierto todo el proyecto.',
  ])('rejects total coverage linked to an adjacent price: %s', (claim) => {
    const result = reviewCommercialClaims(`USD 360. ${claim}`, {
      ...snapshot(),
      additionalScope: ['Agendamiento personalizado'],
    });
    expect(result.reasons).toContain('INCLUSION_NOT_AUTHORIZED');
    expect(result.response).not.toContain(claim);
    expect(result.response).toContain('USD 360');
  });
  it.each([
    'El agendamiento se valora aparte.',
    'El retiro a domicilio requiere valoración adicional.',
  ])('preserves separate additional valuation: %s', (claim) => {
    const text = `USD 360 IVA incluido. ${claim}`;
    expect(
      reviewCommercialClaims(text, {
        ...snapshot(),
        additionalScope: ['Agendamiento personalizado'],
      }),
    ).toEqual({ response: text, reasons: [] });
  });
  it.each(['desde', 'a partir de', 'desde aproximadamente'])(
    'rejects FIXED with %s and accepts FROM',
    (prefix) => {
      const text = `${prefix} USD 360`;
      expect(reviewCommercialClaims(text, snapshot()).reasons).toContain(
        'PRICE_NOT_AUTHORIZED',
      );
      expect(
        reviewCommercialClaims(
          text,
          snapshot([{ ...offer, priceType: CommercialPriceType.FROM }]),
        ).reasons,
      ).toEqual([]);
    },
  );
  it('requires FROM on each individual offer', () => {
    expect(
      reviewCommercialClaims(
        'cuesta USD 360',
        snapshot([{ ...offer, priceType: CommercialPriceType.FROM }]),
      ).reasons,
    ).toContain('PRICE_NOT_AUTHORIZED');
    const other = { ...offer, id: 'other', name: 'Plan B', amount: '510.00' };
    const text = 'Plan de Lanzamiento desde USD 360 y Plan B cuesta USD 510.';
    expect(
      reviewCommercialClaims(
        text,
        snapshot([{ ...offer, priceType: CommercialPriceType.FROM }, other]),
      ).reasons,
    ).toEqual([]);
    expect(
      reviewCommercialClaims(
        'Plan de Lanzamiento a partir de USD 360 y Plan B a partir de USD 510.',
        snapshot(
          [offer, other].map((item) => ({
            ...item,
            priceType: CommercialPriceType.FROM,
          })),
        ),
      ).reasons,
    ).toEqual([]);
  });
  it('removes only the provider payment clause in the shared commercial review', () => {
    const result = reviewCommercialClaims(
      'El comprador paga contra entrega y usted puede pagarnos en cuotas.',
      snapshot(),
    );
    expect(result.response).toBe('El comprador paga contra entrega.');
    expect(result.reasons).toContain('UNAUTHORIZED_PAYMENT_TERMS');
  });
  it('does not let a negated inclusion override a positive inclusion for scheduling', () => {
    const context = {
      ...snapshot(),
      additionalScope: ['Agendamiento personalizado de retiros'],
    };
    expect(
      reviewCommercialClaims(
        'No incluye hosting y el agendamiento está incluido.',
        context,
      ).reasons,
    ).toContain('INCLUSION_NOT_AUTHORIZED');
    expect(
      reviewCommercialClaims(
        'USD 360 incluye IVA y no incluye agendamiento.',
        context,
      ).reasons,
    ).toEqual([]);
  });
  it.each(['+ IVA', 'más IVA', 'sin IVA', 'IVA no incluido'])(
    'matches structured tax mode: %s',
    (tax) => {
      expect(
        reviewCommercialClaims(`USD 360 ${tax}`, snapshot()).reasons,
      ).toContain('TAX_CLAIM_NOT_AUTHORIZED');
      expect(
        reviewCommercialClaims(
          `USD 360 ${tax}`,
          snapshot([{ ...offer, taxMode: CommercialTaxMode.EXCLUDED }]),
        ).reasons,
      ).toEqual([]);
    },
  );
  it('rejects inclusion even when another clause defers its price', () => {
    const result = reviewCommercialClaims(
      'El agendamiento está incluido, pero el precio requiere valoración aparte.',
      {
        ...snapshot(),
        additionalScope: ['Agendamiento personalizado de retiros'],
      },
    );
    expect(result.reasons).toContain('INCLUSION_NOT_AUTHORIZED');
    expect(result.response).not.toContain('está incluido');
  });
  it.each([
    'El sitio web base cuesta USD 360 IVA incluido; el agendamiento requiere valoración adicional.',
    'USD 360 IVA incluido, con agendamiento por valorar.',
  ])('keeps tax inclusion distinct from additional scope: %s', (text) => {
    expect(
      reviewCommercialClaims(text, {
        ...snapshot(),
        additionalScope: ['Agendamiento personalizado de retiros'],
      }),
    ).toEqual({ response: text, reasons: [] });
  });
  it.each([
    'El proyecto cuesta entre USD 360 y USD 510.',
    'Un sitio web estaría entre USD 360 y USD 510.',
    'Entre Plan de Lanzamiento USD 360 y Plan B USD 510.',
  ])('never synthesizes a range from two offers: %s', (text) => {
    const offers = [
      offer,
      { ...offer, id: 'other', name: 'Plan B', amount: '510.00' },
    ];
    expect(reviewCommercialClaims(text, snapshot(offers)).reasons).toContain(
      'PRICE_NOT_AUTHORIZED',
    );
    expect(
      reviewCommercialClaims(
        'Plan de Lanzamiento cuesta USD 360 y Plan B cuesta USD 510.',
        snapshot(offers),
      ).reasons,
    ).toEqual([]);
  });
  it('preserves a valid reply and removes an invented price sentence', () => {
    const reviewed = reviewCommercialClaims(
      'El Plan de Lanzamiento cuesta USD $999. Organiza sus servicios en varias páginas.',
      snapshot(),
    );
    expect(reviewed.response).toBe('Organiza sus servicios en varias páginas.');
    expect(reviewed.reasons).toContain('PRICE_NOT_AUTHORIZED');
  });

  it.each([
    'USD 360.00',
    'USD 360.00,',
    '360 USD',
    '$360',
    '360,00 USD',
    'USD360',
    '360 dolares',
  ])('uses the same authorized amount for %s', (money) => {
    const text = `Plan de Lanzamiento: ${money} IVA incluido.`;
    expect(reviewCommercialClaims(text, snapshot())).toEqual({
      response: text,
      reasons: [],
    });
  });

  it('rejects a store price attributed to the only authorized website offer', () => {
    expect(
      reviewCommercialClaims('La tienda cuesta USD $360.', snapshot()).reasons,
    ).toContain('PRICE_NOT_AUTHORIZED');
  });

  it.each(['USD 999.00,', '999 dolares', 'EUR360', 'USD 3,60,00'])(
    'does not authorize %s',
    (money) => {
      expect(
        reviewCommercialClaims(`Plan de Lanzamiento: ${money}.`, snapshot())
          .reasons,
      ).toContain('PRICE_NOT_AUTHORIZED');
    },
  );

  it('does not authorize custom scheduling using the base website amount', () => {
    const context = {
      ...snapshot(),
      additionalScope: ['Agendamiento personalizado de retiros'],
    };
    const reviewed = reviewCommercialClaims(
      'Plan de Lanzamiento: USD 360.00 IVA incluido. El agendamiento personalizado está incluido.',
      context,
    );
    expect(reviewed.response).toBe(
      'Plan de Lanzamiento: USD 360.00 IVA incluido.',
    );
    expect(reviewed.reasons).toContain('INCLUSION_NOT_AUTHORIZED');
    expect(
      reviewCommercialClaims('El proyecto completo cuesta USD 360.00.', context)
        .reasons,
    ).toContain('INCLUSION_NOT_AUTHORIZED');
  });

  it('never inserts a price into a recommendation without an explicit price question', () => {
    expect(
      answerExplicitPriceIfMissing(
        'Le recomiendo una web sencilla.',
        snapshot(),
        false,
      ),
    ).toBe('Le recomiendo una web sencilla.');
  });

  it('repairs an omitted price only for a direct question with one authorized offer', () => {
    expect(
      answerExplicitPriceIfMissing(
        'Puede ayudarle a vender.',
        snapshot(),
        true,
      ),
    ).toContain('USD $360.00');
  });

  it('answers the selected plan price when other authorized plans exist', () => {
    const growth = {
      ...offer,
      id: 'growth',
      name: 'Plan de Crecimiento',
      amount: '510.00',
    };
    expect(
      answerExplicitPriceIfMissing(
        '',
        { ...snapshot([offer, growth]), recommendedOfferId: 'growth' },
        true,
      ),
    ).toContain('Plan de Crecimiento: USD $510.00');
  });

  it('permits only the renewal amount authorized for the selected tier', () => {
    const premium = {
      ...offer,
      id: 'premium',
      name: 'Plan de Autoridad',
      renewalUsdPerYear: 80,
    };
    const context = { ...snapshot([premium]), recommendedOfferId: 'premium' };
    expect(
      reviewCommercialClaims(
        'La renovación de hosting y dominio es USD $80 al año.',
        context,
      ).reasons,
    ).toEqual([]);
    expect(
      reviewCommercialClaims(
        'La renovación de hosting y dominio es USD $40 al año.',
        context,
      ).reasons,
    ).toContain('PRICE_NOT_AUTHORIZED');
  });

  it('asks once for the market when price depends on it', () => {
    expect(
      answerExplicitPriceIfMissing(
        'El valor requiere valoración.',
        {
          marketSource: 'UNKNOWN',
          relevantServiceCodes: ['WEBSITE'],
          offers: [],
          needsMarketClarification: true,
        },
        true,
      ),
    ).toBe('¿El proyecto sería para Ecuador o España?');
  });

  it('requires a visible desde marker for a FROM price before a long plan name', () => {
    const fromOffer = {
      ...offer,
      name: 'Plan Empresarial de Lanzamiento',
      priceType: CommercialPriceType.FROM,
    };
    const text =
      'Desde Plan Empresarial de Lanzamiento: USD $360 para este alcance.';
    expect(reviewCommercialClaims(text, snapshot([fromOffer])).response).toBe(
      text,
    );
  });

  it('does not turn a quote-only service into a price answer', () => {
    const quoteOffer = {
      ...offer,
      priceType: CommercialPriceType.QUOTE_REQUIRED,
      amount: undefined,
    };
    expect(
      answerExplicitPriceIfMissing(
        'Requiere valoración.',
        snapshot([quoteOffer]),
        true,
      ),
    ).toBe('Requiere valoración.');
    expect(
      reviewCommercialClaims('Cuesta USD $360.', snapshot([quoteOffer]))
        .reasons,
    ).toContain('PRICE_NOT_AUTHORIZED');
  });

  it('answers a direct quote-only price question when the agent omits valuation', () => {
    const quoteOffer = {
      ...offer,
      priceType: CommercialPriceType.QUOTE_REQUIRED,
      amount: undefined,
    };
    expect(
      answerExplicitPriceIfMissing(
        'Podemos ayudarle.',
        snapshot([quoteOffer]),
        true,
      ),
    ).toMatch(/requiere valoraci[oó]n/i);
  });

  it('blocks expired or unapproved promotions and tax claims', () => {
    expect(
      reviewCommercialClaims('Hay un descuento especial.', snapshot()).reasons,
    ).toContain('PROMOTION_NOT_AUTHORIZED');
    expect(reviewCommercialClaims('Es más IVA.', snapshot()).reasons).toContain(
      'TAX_CLAIM_NOT_AUTHORIZED',
    );
  });

  it('keeps a true IVA statement about one named offer when another offer differs', () => {
    const excluded = {
      ...offer,
      id: 'other',
      name: 'Tienda de Lanzamiento',
      serviceCode: 'ONLINE_STORE',
      taxMode: CommercialTaxMode.EXCLUDED,
    };
    const text = 'El Plan de Lanzamiento tiene IVA incluido.';
    expect(
      reviewCommercialClaims(text, snapshot([offer, excluded])).response,
    ).toBe(text);
  });

  it('does not transfer a promotion to another named plan', () => {
    const promotion = { ...offer, promotion: true };
    const other = {
      ...offer,
      id: 'other',
      name: 'Tienda de Lanzamiento',
      serviceCode: 'ONLINE_STORE',
    };
    expect(
      reviewCommercialClaims(
        'La Tienda de Lanzamiento tiene descuento.',
        snapshot([promotion, other]),
      ).reasons,
    ).toContain('PROMOTION_NOT_AUTHORIZED');
  });

  it('rejects an IVA percentage absent from the authorized policy', () => {
    expect(
      reviewCommercialClaims(
        'El Plan de Lanzamiento tiene IVA 21%.',
        snapshot(),
      ).reasons,
    ).toContain('TAX_CLAIM_NOT_AUTHORIZED');
  });
});
