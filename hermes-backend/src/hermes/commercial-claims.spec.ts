import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
} from '@prisma/client';
import type {
  AuthorizedOffer,
  CommercialSnapshot,
} from './commercial-authority.service';
import {
  answerExplicitPriceIfMissing,
  reviewCommercialClaims,
} from './commercial-claims';

describe('commercial claims', () => {
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

  it('preserves a valid reply and removes an invented price sentence', () => {
    const reviewed = reviewCommercialClaims(
      'El Plan de Lanzamiento cuesta USD $999. Organiza sus servicios en varias páginas.',
      snapshot(),
    );
    expect(reviewed.response).toBe('Organiza sus servicios en varias páginas.');
    expect(reviewed.reasons).toContain('PRICE_NOT_AUTHORIZED');
  });

  it('rejects a store price attributed to the only authorized website offer', () => {
    expect(
      reviewCommercialClaims('La tienda cuesta USD $360.', snapshot()).reasons,
    ).toContain('PRICE_NOT_AUTHORIZED');
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
