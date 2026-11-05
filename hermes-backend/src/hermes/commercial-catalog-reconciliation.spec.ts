import { Prisma } from '@prisma/client';
import {
  catalog,
  inspectReconciliation,
} from '../../scripts/reconcile-commercial-catalog';

type State = Parameters<typeof inspectReconciliation>[0];
const state = (products: unknown[] = [], reservedPrices: unknown[] = []) =>
  ({ products, reservedPrices }) as State;
const product = (slug = 'website-launch', prices: unknown[] = []) => {
  const plan = catalog.find((item) => item.slug === slug)!;
  return {
    id: `commercial-product-${slug}`,
    sku: `commercial-${slug}`,
    name: plan.name,
    category: plan.category,
    serviceCode: plan.serviceCode,
    isActive: true,
    metadata: {
      commercialTerms: {
        renewalUsdPerYear:
          slug === 'website-authority' || slug === 'store-elite' ? 80 : 40,
        estimatedBusinessDays:
          slug === 'website-launch' || slug === 'store-launch' ? 10 : 20,
      },
    },
    priceLists: prices,
  };
};
const price = (
  slug = 'website-launch',
  changes: Record<string, unknown> = {},
) => {
  const plan = catalog.find((item) => item.slug === slug)!;
  return {
    id: `commercial-price-${slug}-ec-12m-v1`,
    productId: `commercial-product-${slug}`,
    price: new Prisma.Decimal(plan.price),
    market: 'EC',
    currency: 'USD',
    priceType: 'FIXED',
    taxMode: 'INCLUDED',
    taxLabel: 'IVA',
    taxRatePercent: null,
    scope: plan.scope,
    policyVersion: 'ec-commercial-12m-v1',
    isPromotion: false,
    supersedesPriceListId: null,
    validUntil: null,
    restrictions: null,
    isActive: true,
    ...changes,
  };
};

describe('manual EC catalog reconciliation preflight', () => {
  it('finds the eight absent products and tariffs without applying anything', () => {
    const result = inspectReconciliation(state());
    expect(result.failures).toEqual([]);
    expect(result.missing).toHaveLength(8);
    expect(result.missing.every((item) => item.product && item.price)).toBe(
      true,
    );
  });

  it('preserves an existing Product ID and identifies only its missing tariff', () => {
    const result = inspectReconciliation(state([product()]));
    expect(result.missing[0]).toEqual({
      slug: 'website-launch',
      product: false,
      price: true,
    });
  });

  it('is idempotent when every row matches the EC approval', () => {
    const products = catalog.map((plan) =>
      product(plan.slug, [price(plan.slug)]),
    );
    expect(
      inspectReconciliation(
        state(
          products,
          products.map((item) => item.priceLists[0]),
        ),
      ),
    ).toEqual({ missing: [], failures: [] });
  });

  it.each([
    { market: null },
    { currency: 'EUR' },
    { taxMode: 'EXCLUDED' },
    { taxLabel: '7 %' },
    { price: new Prisma.Decimal('999.00') },
    { scope: 'Un mes de soporte' },
    { isPromotion: true },
    { policyVersion: 'unapproved' },
  ])('blocks an existing divergent tariff: %j', (change) => {
    const row = price('website-launch', change);
    const result = inspectReconciliation(
      state([product('website-launch', [row])], [row]),
    );
    expect(result.failures).toContain(
      'website-launch: existing EC tariff differs from approved definition',
    );
  });

  it('blocks another active tariff that could expose USD outside Ecuador', () => {
    const global = price('website-launch', { id: 'old-global', market: null });
    const result = inspectReconciliation(
      state([product('website-launch', [global])]),
    );
    expect(result.failures[0]).toContain('another active tariff');
  });
});
