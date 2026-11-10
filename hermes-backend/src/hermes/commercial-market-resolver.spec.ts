import { CommercialMarket } from '@prisma/client';
import { CommercialMarketResolver } from './commercial-market-resolver';

describe('CommercialMarketResolver', () => {
  const resolver = new CommercialMarketResolver();

  it('does not let a historical dual-market message resolve through a prior project or Spanish phone', () => {
    expect(
      resolver.resolve({
        customerMessage: '¿Cuánto cuesta?',
        recentCustomerMessages: [
          'El proyecto es para Ecuador',
          'Quiero opciones para Ecuador y España',
        ],
        profile: { market: CommercialMarket.EC },
        waId: '34612345678',
      }),
    ).toMatchObject({
      source: 'UNKNOWN',
      hasExplicitMarketConflict: true,
      phoneCountry: CommercialMarket.ES,
    });
  });

  it('keeps an unequivocal historical Ecuador project above a Spanish phone', () => {
    expect(
      resolver.resolve({
        customerMessage: '¿Cuánto cuesta?',
        recentCustomerMessages: ['El proyecto es para Ecuador'],
        waId: '34612345678',
      }),
    ).toMatchObject({
      market: CommercialMarket.EC,
      source: 'CRM_CONFIRMED',
      projectCountry: CommercialMarket.EC,
    });
  });

  it('treats contradictory historical country mentions as a conflict', () => {
    expect(
      resolver.resolve({
        customerMessage: '¿Cuánto cuesta?',
        recentCustomerMessages: [
          'El proyecto es para Ecuador',
          'Ahora el proyecto sería para España',
        ],
        waId: '34612345678',
      }),
    ).toMatchObject({
      source: 'UNKNOWN',
      hasExplicitMarketConflict: true,
    });
  });
});
