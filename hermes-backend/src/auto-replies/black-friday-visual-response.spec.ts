import { CommercialPriceType } from '@prisma/client';
import type { AuthorizedOffer } from '../hermes/commercial-authority.service';
import { resolveCustomerSalutation } from '../hermes/customer-salutation';
import {
  asksForBlackFridayDetails,
  blackFridayDetailParts,
  blackFridaySpecificAnswer,
} from './black-friday-visual-response';

const scope =
  'Captación de leads; landing page de una sola sección; diseño responsive para celulares; botón flotante de WhatsApp y llamada directa; formulario de contacto o captura de prospectos; apartado de beneficios del servicio o producto; dominio .com y hosting básico por 1 año; 5 correos corporativos; SEO técnico base; 12 meses de soporte técnico posteriores a la entrega.';
const offer: AuthorizedOffer = {
  id: 'black-friday-test',
  name: 'Black Friday Landing Page',
  serviceCode: 'LANDING_PAGE',
  marketScope: 'GLOBAL',
  priceType: CommercialPriceType.FIXED,
  amount: '80.00',
  currency: 'USD',
  scope,
  policyVersion: 'black-friday-landing-80-v1',
  promotion: true,
};

describe('Black Friday visual response', () => {
  it('prepares one information message and one independent commercial question', () => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [],
      maxParts: 2,
    });
    expect(parts).toHaveLength(2);
    expect(parts?.[0]).toContain('Black Friday por USD $80');
    expect(
      parts?.[0]
        .split('\n')
        .filter((line) => /^[🎯🖥📱💬📝⭐🌍📧🔍🛠]/u.test(line)),
    ).toHaveLength(10);
    expect(parts?.[0]).toContain('\n');
    expect(parts?.[0]).not.toContain('¿Qué tipo de proyecto');
    expect(parts?.[1]).toBe(
      'Cuénteme, por favor, ¿qué tipo de proyecto o solución tiene en mente?',
    );
  });

  it('keeps the approved details in one part and omits the question under a one-part cap', () => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [],
      maxParts: 1,
    });
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toContain(
      '🛠️ *1 año de soporte técnico posterior a la entrega*',
    );
    expect(parts?.[0]).not.toMatch(/¿[^?]+\?/u);
  });

  it.each([
    ['2026-11-07T09:19:00.000Z', 'Carlos', 'Buenos días, estimado Carlos.'],
    ['2026-11-07T17:00:00.000Z', 'María', 'Buenas tardes, estimada María.'],
    ['2026-11-08T00:00:00.000Z', null, 'Buenas noches.'],
    ['2026-11-07T17:00:00.000Z', 'Empresa Turística', 'Buenas tardes.'],
    ['2026-11-07T09:19:00.000Z', 'Alex', 'Buenos días, Alex.'],
  ])(
    'uses Guayaquil local time and safe address for %s / %s',
    (instant, name, expected) => {
      const parts = blackFridayDetailParts({
        offer,
        recentMessages: [],
        maxParts: 2,
        now: new Date(instant),
        salutation: resolveCustomerSalutation(name),
      });
      expect(parts?.[0].startsWith(expected)).toBe(true);
    },
  );

  it.each([
    ['2026-11-07T05:00:00.000Z', 'Buenos días.'],
    ['2026-11-07T16:59:00.000Z', 'Buenos días.'],
    ['2026-11-07T17:00:00.000Z', 'Buenas tardes.'],
    ['2026-11-07T23:59:00.000Z', 'Buenas tardes.'],
    ['2026-11-08T00:00:00.000Z', 'Buenas noches.'],
    ['2026-11-08T04:59:00.000Z', 'Buenas noches.'],
  ])('uses the documented Guayaquil boundary at %s', (instant, expected) => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [],
      maxParts: 2,
      now: new Date(instant),
    });
    expect(parts?.[0].startsWith(expected)).toBe(true);
  });

  it('uses a validated client time zone for a new opening without repeating formal address', () => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [],
      maxParts: 2,
      now: new Date('2026-11-07T17:00:00.000Z'),
      timeZone: 'Europe/Madrid',
      salutation: resolveCustomerSalutation('Carlos'),
      firstReply: false,
      customerMessage: 'Hola, quiero información de Black Friday',
    });
    expect(parts?.[0]).toMatch(/^Buenas tardes\. /u);
    expect(parts?.[0]).not.toContain('estimado Carlos');
  });

  it('omits the initial greeting on a later detail request', () => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [
        { role: 'assistant', content: 'La promoción cuesta USD $80.' },
      ],
      maxParts: 2,
      now: new Date('2026-11-07T17:00:00.000Z'),
      salutation: resolveCustomerSalutation('Carlos'),
      firstReply: false,
      customerMessage: '¿Me comparte las características?',
    });
    expect(parts?.[0]).toMatch(/^Con gusto le comparto los detalles/u);
    expect(parts?.[0]).not.toMatch(
      /Buenos días|Buenas tardes|Buenas noches|estimado Carlos/u,
    );
  });

  it('does not repeat a pending discovery question', () => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [
        {
          role: 'assistant',
          content:
            'Cuénteme, por favor, ¿qué tipo de proyecto o solución tiene en mente?',
        },
      ],
      maxParts: 2,
      firstReply: false,
      customerMessage: '¿Qué incluye la promoción Black Friday?',
    });
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).not.toContain(
      'Quedo atento a su respuesta para orientarle.',
    );
    expect(parts?.[0]).toMatch(/^Con gusto le comparto los detalles/u);
  });

  it('does not repeat an unaccented pending discovery question', () => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [
        { role: 'assistant', content: '¿A que se dedica su negocio?' },
      ],
      maxParts: 2,
    });
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).not.toContain(
      'Quedo atento a su respuesta para orientarle.',
    );
  });

  it('asks a relevant next question when the customer already described the business', () => {
    const parts = blackFridayDetailParts({
      offer,
      customerMessage: 'Quiero información de Black Friday para mi barbería',
      recentMessages: [],
      maxParts: 2,
    });
    expect(parts?.[1]).toBe(
      '¿Qué objetivo desea priorizar con la landing page?',
    );
  });

  it('advances after the customer answers an earlier project question', () => {
    const parts = blackFridayDetailParts({
      offer,
      customerMessage: 'La promoción es para mi barbería',
      recentMessages: [
        {
          role: 'assistant',
          content:
            'Cuénteme, por favor, ¿qué tipo de proyecto o solución tiene en mente?',
        },
      ],
      maxParts: 2,
    });
    expect(parts?.[1]).toBe(
      '¿Qué objetivo desea priorizar con la landing page?',
    );
  });

  it('does not treat the landing page service code as the customer business', () => {
    const parts = blackFridayDetailParts({
      offer,
      profile: { service: 'LANDING_PAGE' },
      recentMessages: [],
      maxParts: 2,
    });
    expect(parts?.[1]).toBe(
      'Cuénteme, por favor, ¿qué tipo de proyecto o solución tiene en mente?',
    );
  });

  it('reserves the complete list for broad detail requests', () => {
    expect(asksForBlackFridayDetails('¿Qué incluye la promoción?')).toBe(true);
    expect(asksForBlackFridayDetails('¿Qué incluye?')).toBe(true);
    expect(asksForBlackFridayDetails('¿Incluye hosting?')).toBe(false);
    expect(asksForBlackFridayDetails('¿Cuánto soporte incluye?')).toBe(false);
    expect(asksForBlackFridayDetails('¿Cuáles son los beneficios?')).toBe(true);
    expect(asksForBlackFridayDetails('¿Me comparte las características?')).toBe(
      true,
    );
    expect(asksForBlackFridayDetails('¿Qué incluye Black Friday?')).toBe(true);
  });

  it('formats ten approved items in the first of two ordered WhatsApp messages', () => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [],
      maxParts: 3,
    });
    expect(parts).toHaveLength(2);
    expect(parts?.[0]).toMatch(/Black Friday/u);
    expect(parts?.[0].split('\n').slice(-10)).toEqual([
      '🎯 Captación de clientes potenciales',
      '🖥️ Landing Page de una sola sección',
      '📱 Diseño responsive, optimizado para celulares',
      '💬 Botón flotante de WhatsApp y llamada directa',
      '📝 Formulario de contacto o captura de prospectos',
      '⭐ Sección de beneficios del servicio o producto',
      '🌍 Dominio .com y hosting básico por 1 año',
      '📧 5 correos corporativos',
      '🔍 SEO técnico base',
      '🛠️ *1 año de soporte técnico posterior a la entrega*',
    ]);
    expect(parts?.[1]).toBe(
      'Cuénteme, por favor, ¿qué tipo de proyecto o solución tiene en mente?',
    );
    expect(parts?.join(' ')).not.toContain('\\');
    expect(parts?.join(' ')).not.toContain('**');
  });

  it.each([2, 1])(
    'compacts every benefit safely under a %i-part budget',
    (maxParts) => {
      const parts = blackFridayDetailParts({
        offer,
        recentMessages: [],
        maxParts,
      });
      expect(parts).toHaveLength(maxParts);
      expect(
        parts?.join('\n').match(/[🎯🖥📱💬📝⭐🌍📧🔍🛠]/gu)?.length,
      ).toBeGreaterThanOrEqual(10);
      if (maxParts === 2) expect(parts?.[1]).toContain('¿qué tipo de proyecto');
      else expect(parts?.[0]).not.toMatch(/¿[^?]+\?/u);
      expect(parts?.every((part) => part.length <= 1000)).toBe(true);
    },
  );

  it.each([
    '12 meses de soporte técnico posterior a la entrega',
    '12 meses de soporte técnico posteriores a la entrega',
    '1 año de soporte técnico posterior a la entrega',
    '1 año de soporte técnico posteriores a la entrega',
  ])('formats the authorized annual support variant: %s', (support) => {
    const annual = {
      ...offer,
      scope: scope.replace(
        '12 meses de soporte técnico posteriores a la entrega',
        support,
      ),
    };
    expect(
      blackFridayDetailParts({
        offer: annual,
        recentMessages: [],
        maxParts: 3,
      })?.[0],
    ).toContain('🛠️ *1 año de soporte técnico posterior a la entrega*');
  });

  it('keeps a month while the selected PriceList still has the old clause', () => {
    const oldOffer = {
      ...offer,
      scope: scope.replace(
        '12 meses de soporte técnico posteriores a la entrega',
        '1 mes de soporte posterior a la entrega',
      ),
    };
    expect(
      blackFridayDetailParts({
        offer: oldOffer,
        recentMessages: [],
        maxParts: 3,
      })?.[0],
    ).toContain('🛠️ *1 mes de soporte posterior a la entrega*');
    expect(
      blackFridaySpecificAnswer('¿Cuánto soporte incluye?', oldOffer),
    ).toMatch(/1 mes de soporte/u);
  });

  it('answers specific items without a catalog and avoids repeated discovery', () => {
    expect(blackFridaySpecificAnswer('¿Incluye hosting?', offer)).toMatch(
      /dominio \.com y hosting básico por 1 año/u,
    );
    expect(
      blackFridaySpecificAnswer('¿Cuánto soporte incluye?', offer),
    ).toMatch(/12 meses de soporte técnico posteriores a la entrega/u);
    expect(
      blackFridayDetailParts({
        offer,
        recentMessages: [
          { role: 'assistant', content: '¿A qué se dedica su negocio?' },
        ],
        maxParts: 3,
      }),
    ).toHaveLength(1);
    expect(
      blackFridayDetailParts({
        offer,
        profile: { sector: 'barbería' },
        recentMessages: [],
        maxParts: 3,
      })?.[1],
    ).toMatch(/servicios de barbería/u);
  });
});
