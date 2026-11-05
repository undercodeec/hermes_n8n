import { Prisma } from '@prisma/client';
import {
  GLOBAL_LANDING_SCOPE_AFTER,
  GLOBAL_LANDING_SCOPE_BEFORE,
  inspectGlobalLandingSupport,
} from '../../scripts/update-global-landing-support-12m';

type State = Parameters<typeof inspectGlobalLandingSupport>[0];
const base = (changes: Record<string, unknown> = {}) => ({
  id: 'commercial-price-landing-basic-global-v1',
  productId: 'commercial-product-landing-basic',
  price: new Prisma.Decimal('250.00'),
  currency: 'USD',
  market: null,
  priceType: 'FIXED',
  taxMode: 'INCLUDED',
  taxLabel: 'IVA',
  taxRatePercent: null,
  policyVersion: 'global-v1',
  supersedesPriceListId: null,
  isActive: true,
  isPromotion: false,
  validFrom: new Date('2026-01-01'),
  validUntil: null,
  scope: GLOBAL_LANDING_SCOPE_BEFORE,
  ...changes,
});
const promotion = (changes: Record<string, unknown> = {}) => ({
  id: 'commercial-price-landing-black-friday-80-global-v1',
  productId: 'commercial-product-landing-basic',
  price: new Prisma.Decimal('80.00'),
  currency: 'USD',
  market: null,
  priceType: 'FIXED',
  policyVersion: 'black-friday-landing-80-v1',
  supersedesPriceListId: 'commercial-price-landing-basic-global-v1',
  isActive: true,
  isPromotion: true,
  validFrom: new Date('2026-01-01'),
  validUntil: null,
  scope:
    'Captación de leads; landing page de una sola sección; diseño responsive para celulares; botón flotante de WhatsApp y llamada directa; formulario de contacto o captura de prospectos; apartado de beneficios del servicio o producto; dominio .com y hosting básico por 1 año; 5 correos corporativos; SEO técnico base; 12 meses de soporte técnico posteriores a la entrega.',
  ...changes,
});
function state(
  baseChanges: Record<string, unknown> = {},
  promotionChanges: Record<string, unknown> = {},
): State {
  const prices = [base(baseChanges), promotion(promotionChanges)];
  return {
    products: [
      {
        id: 'commercial-product-landing-basic',
        sku: 'commercial-landing-basic',
        isActive: true,
        serviceCode: 'LANDING_PAGE',
        priceLists: prices,
      },
    ],
    reservedPrices: prices,
  } as State;
}

describe('Option B GLOBAL Landing Básica preflight', () => {
  it('proposes only a scope change for the existing USD 250 tariff', () => {
    expect(inspectGlobalLandingSupport(state())).toEqual({
      failures: [],
      change: {
        id: 'commercial-price-landing-basic-global-v1',
        before: GLOBAL_LANDING_SCOPE_BEFORE,
        after: GLOBAL_LANDING_SCOPE_AFTER,
      },
    });
    expect(GLOBAL_LANDING_SCOPE_AFTER).toContain(
      '12 meses de soporte técnico posteriores a la entrega',
    );
  });

  it('is idempotent after twelve months are already present', () => {
    expect(
      inspectGlobalLandingSupport(state({ scope: GLOBAL_LANDING_SCOPE_AFTER })),
    ).toEqual({ failures: [], change: undefined });
  });

  it.each([
    [{ price: new Prisma.Decimal('251.00') }, {}],
    [{ market: 'EC' }, {}],
    [{ taxMode: 'EXCLUDED' }, {}],
    [{ policyVersion: 'other' }, {}],
    [{ scope: `${GLOBAL_LANDING_SCOPE_AFTER} Un mes de soporte.` }, {}],
    [{ validUntil: new Date('2026-01-02') }, {}],
    [{}, { price: new Prisma.Decimal('81.00') }],
    [{}, { supersedesPriceListId: 'other' }],
    [{}, { scope: promotion().scope.replace('12 meses', '1 mes') }],
    [{}, { scope: promotion().scope.replace('SEO técnico base', 'SEO VIP') }],
  ])(
    'blocks a divergent base or Black Friday row',
    (baseChange, promoChange) => {
      expect(
        inspectGlobalLandingSupport(state(baseChange, promoChange)).failures,
      ).not.toHaveLength(0);
    },
  );

  it('blocks missing or conflicting Product and PriceList identity', () => {
    const missing = state();
    missing.products = [];
    expect(inspectGlobalLandingSupport(missing).failures).not.toHaveLength(0);
    const conflict = state();
    conflict.reservedPrices[0].productId = 'another-product';
    expect(inspectGlobalLandingSupport(conflict).failures).not.toHaveLength(0);
    const noPromotion = state();
    noPromotion.products[0].priceLists = [
      noPromotion.products[0].priceLists[0],
    ];
    expect(inspectGlobalLandingSupport(noPromotion).failures).not.toHaveLength(
      0,
    );
    const duplicate = state();
    duplicate.products[0].priceLists.push({
      ...duplicate.products[0].priceLists[0],
      id: 'another-global-base',
    });
    expect(inspectGlobalLandingSupport(duplicate).failures).not.toHaveLength(0);
    const unexpectedEc = state();
    unexpectedEc.products[0].priceLists.push({
      ...unexpectedEc.products[0].priceLists[0],
      id: 'unexpected-ec-base',
      market: 'EC',
    });
    expect(inspectGlobalLandingSupport(unexpectedEc).failures).toContain(
      'Unexpected EC Landing Básica tariff requires market review',
    );
  });
});
