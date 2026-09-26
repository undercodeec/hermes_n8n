import { PrismaService } from '../src/prisma/prisma.service';
import {
  CommercialAuthorityService,
  commercialSnapshotKnowledge,
} from '../src/hermes/commercial-authority.service';
import { CommercialPolicyService } from '../src/hermes/commercial-policy.service';

describe('Commercial solution selection with seeded PostgreSQL', () => {
  let prisma: PrismaService;
  let authority: CommercialAuthorityService;

  beforeAll(async () => {
    if (!process.env.DATABASE_INTEGRATION_URL) {
      throw new Error('DATABASE_INTEGRATION_URL is required');
    }
    process.env.DATABASE_URL = process.env.DATABASE_INTEGRATION_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    authority = new CommercialAuthorityService(prisma);
  });

  afterAll(async () => prisma?.$disconnect());

  it.each([
    [
      'Quiero promocionar mi negocio. ¿Qué opciones y precios tienen?',
      ['LANDING_PAGE', 'WEBSITE'],
      ['250.00', '600.00', '1500.00', '360.00', '510.00', '1010.00'],
    ],
    [
      'Necesito una página web para mi empresa. ¿Qué precios tienen?',
      ['WEBSITE'],
      ['360.00', '510.00', '1010.00'],
    ],
    [
      'Quiero vender zapatos por internet. ¿Qué precios tienen?',
      ['ONLINE_STORE'],
      ['550.00', '850.00', '3490.00'],
    ],
    [
      'Tengo reparación de lavadoras y zapatos. Para reparaciones quiero promocionar mis servicios y para zapatos quiero vender.',
      ['ONLINE_STORE', 'LANDING_PAGE', 'WEBSITE'],
      [
        '250.00',
        '600.00',
        '1500.00',
        '360.00',
        '510.00',
        '1010.00',
        '550.00',
        '850.00',
        '3490.00',
      ],
    ],
  ])(
    'delivers authorized offers for %s',
    async (message, expectedKinds, expectedAmounts) => {
      const snapshot = await authority.snapshot({
        customerMessage: message,
        priceRequested: true,
      });
      expect(snapshot.relevantServiceCodes).toEqual(expectedKinds);
      expect(snapshot.offers.map((offer) => offer.amount).sort()).toEqual(
        [...expectedAmounts].sort(),
      );
      expect(
        snapshot.offers.every((offer) => offer.marketScope === 'GLOBAL'),
      ).toBe(true);
      expect(
        commercialSnapshotKnowledge(snapshot)
          .slice(0, snapshot.offers.length)
          .every((item) => item.includes('CRM_APPROVED_PRICE_LIST')),
      ).toBe(true);
    },
  );

  it('keeps an ambiguous catalog separate from online checkout', async () => {
    const message = 'Quiero mostrar mis productos';
    const policy = new CommercialPolicyService().analyze(message, new Date());
    const snapshot = await authority.snapshot({
      customerMessage: message,
      priceRequested: false,
    });

    expect(policy.guidance.requiredClarification).toBe(
      'CATALOG_VS_ONLINE_SALES',
    );
    expect(snapshot.offers).toEqual([]);
  });
});
