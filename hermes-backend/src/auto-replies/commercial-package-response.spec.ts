import { CommercialPriceType, CommercialTaxMode } from '@prisma/client';
import type {
  AuthorizedOffer,
  CommercialSnapshot,
} from '../hermes/commercial-authority.service';
import {
  commercialPackageParts,
  packageCard,
} from './commercial-package-response';

const names = [
  ['WEBSITE', 'Plan de Lanzamiento', '360.00'],
  ['WEBSITE', 'Plan de Crecimiento', '510.00'],
  ['WEBSITE', 'Plan de Autoridad', '1010.00'],
  ['ONLINE_STORE', 'Tienda de Lanzamiento', '550.00'],
  ['ONLINE_STORE', 'Tienda de Crecimiento', '850.00'],
  ['ONLINE_STORE', 'Tienda Élite', '3490.00'],
  ['LANDING_PAGE', 'Landing Básica', '250.00'],
  ['LANDING_PAGE', 'Landing Pro', '600.00'],
  ['LANDING_PAGE', 'Landing Premium', '1500.00'],
] as const;

const offers: AuthorizedOffer[] = names.map(
  ([serviceCode, name, amount], index) => ({
    id: `synthetic-${index}`,
    name,
    serviceCode,
    marketScope: 'GLOBAL',
    priceType: CommercialPriceType.FIXED,
    amount,
    currency: 'USD',
    taxMode: CommercialTaxMode.INCLUDED,
    taxLabel: 'IVA',
    scope:
      index === 1
        ? 'Incluye el Plan de Lanzamiento, hasta ocho páginas, 12 meses de soporte técnico posteriores a la entrega.'
        : index === 2 || index === 5
          ? `Incluye ${index === 2 ? 'el Plan de Crecimiento' : 'Tienda de Crecimiento'}, seguridad reforzada, 12 meses de soporte VIP prioritario posteriores a la entrega.`
          : index === 7 || index === 8
            ? 'Incluye Landing Básica, textos persuasivos, 12 meses de soporte técnico posteriores a la entrega.'
            : 'Diseño responsive, dominio y hosting por un año, 12 meses de soporte técnico posteriores a la entrega.',
    policyVersion: 'synthetic-12m',
    promotion: false,
  }),
);

function snapshot(selected = offers): CommercialSnapshot {
  return {
    marketSource: 'UNKNOWN',
    relevantServiceCodes: ['WEBSITE'],
    offers: selected,
    needsMarketClarification: false,
  };
}

describe('CRM package WhatsApp cards', () => {
  it.each([
    ['¿Qué planes tienen para páginas web?', 'WEBSITE'],
    ['¿Qué planes tienen para tienda online?', 'ONLINE_STORE'],
    ['¿Qué planes tienen para Landing Page?', 'LANDING_PAGE'],
  ])('shows three authorized %s plans with support', (message, code) => {
    const parts = commercialPackageParts({
      message,
      snapshot: snapshot(),
      priceRequested: false,
      maxParts: 3,
    });
    expect(parts).toHaveLength(3);
    expect(parts?.join(' ')).toContain('12 meses de soporte');
    expect(parts?.join(' ')).toContain('IVA incluido');
    expect(parts?.join(' ')).not.toContain('**');
    expect(parts?.every((part) => part.includes('*'))).toBe(true);
    expect(parts?.join(' ')).not.toMatch(/EUR|€|7 %/u);
    expect(parts?.join(' ')).toContain(
      code === 'WEBSITE'
        ? 'PLAN DE AUTORIDAD'
        : code === 'ONLINE_STORE'
          ? 'TIENDA ÉLITE'
          : 'LANDING PREMIUM',
    );
  });

  it('does not invent a missing third tariff', () => {
    expect(
      commercialPackageParts({
        message: '¿Qué planes tienen para páginas web?',
        snapshot: snapshot(offers.slice(0, 2)),
        priceRequested: false,
        maxParts: 3,
      }),
    ).toBeUndefined();
  });

  it('keeps Premium inheritance at Básica and VIP only for authorized plans', () => {
    const premium = packageCard(offers[8], offers, true);
    expect(premium).not.toContain('Landing Pro');
    expect(packageCard(offers[2], offers, false)).toContain('VIP prioritario');
    expect(packageCard(offers[5], offers, false)).toContain('VIP prioritario');
  });

  it('shows two base references for custom scope without pricing the additional work', () => {
    const result = commercialPackageParts({
      message: 'No tengo dominio web, quisiera saber costos',
      snapshot: { ...snapshot(), additionalScope: ['Reservas automatizadas'] },
      priceRequested: true,
      maxParts: 3,
    });
    expect(result).toHaveLength(2);
    expect(result?.join(' ')).toContain('360,00');
    expect(result?.join(' ')).toContain('510,00');
    expect(result?.join(' ')).not.toContain('1010,00');
  });

  it('does not infer tax treatment for EUR', () => {
    const eur: AuthorizedOffer = {
      ...offers[0],
      id: 'synthetic-eur',
      currency: 'EUR',
      taxMode: CommercialTaxMode.NOT_APPLICABLE,
      taxLabel: undefined,
    };
    expect(packageCard(eur, [eur], false)).toContain('EUR €360,00');
    expect(packageCard(eur, [eur], false)).not.toContain('IVA');
  });
});
