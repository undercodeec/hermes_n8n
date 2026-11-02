import type { AuthorizedOffer } from '../hermes/commercial-authority.service';
import {
  asksForBlackFridayDetails,
  blackFridayDetailParts,
  blackFridaySpecificAnswer,
} from './black-friday-visual-response';

const scope =
  'Captación de leads; landing page de una sola sección; diseño responsive para celulares; botón flotante de WhatsApp y llamada directa; formulario de contacto o captura de prospectos; apartado de beneficios del servicio o producto; dominio .com y hosting básico por 1 año; 5 correos corporativos; SEO técnico base; 1 mes de soporte posterior a la entrega.';
const offer = { scope } as AuthorizedOffer;

describe('Black Friday visual response', () => {
  it('reserves the complete list for broad detail requests', () => {
    expect(asksForBlackFridayDetails('¿Qué incluye la promoción?')).toBe(true);
    expect(asksForBlackFridayDetails('¿Qué incluye?')).toBe(true);
    expect(asksForBlackFridayDetails('¿Incluye hosting?')).toBe(false);
    expect(asksForBlackFridayDetails('¿Cuánto soporte incluye?')).toBe(false);
  });

  it('formats ten approved items as three ordered WhatsApp messages', () => {
    const parts = blackFridayDetailParts({
      offer,
      recentMessages: [],
      maxParts: 3,
    });
    expect(parts).toHaveLength(3);
    expect(parts?.[0]).toMatch(/Black Friday/u);
    expect(parts?.[1].split('\n')).toEqual([
      '🎯 Captación de clientes potenciales',
      '🖥️ Landing Page de una sola sección',
      '📱 Diseño responsive, optimizado para celulares',
      '💬 Botón flotante de WhatsApp y llamada directa',
      '📝 Formulario de contacto o captura de prospectos',
      '⭐ Sección de beneficios del servicio o producto',
      '🌍 Dominio .com y hosting básico por 1 año',
      '📧 5 correos corporativos',
      '🔍 SEO técnico base',
      '🛠️ *1 mes de soporte posterior a la entrega*',
    ]);
    expect(parts?.[2]).toBe('¿A qué se dedica su negocio?');
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
      expect(parts?.join(' ')).toContain('¿A qué se dedica su negocio?');
      expect(parts?.every((part) => part.length <= 1000)).toBe(true);
    },
  );

  it('only presents a year of support when the current scope says so', () => {
    const annual = {
      scope: scope.replace('1 mes de soporte', '12 meses de soporte'),
    } as AuthorizedOffer;
    expect(
      blackFridayDetailParts({ offer, recentMessages: [], maxParts: 3 })?.[1],
    ).not.toContain('1 año de soporte');
    expect(
      blackFridayDetailParts({
        offer: annual,
        recentMessages: [],
        maxParts: 3,
      })?.[1],
    ).toContain('🛠️ *1 año de soporte técnico posterior a la entrega*');
  });

  it('answers specific items without a catalog and avoids repeated discovery', () => {
    expect(blackFridaySpecificAnswer('¿Incluye hosting?', offer)).toMatch(
      /dominio \.com y hosting básico por 1 año/u,
    );
    expect(
      blackFridaySpecificAnswer('¿Cuánto soporte incluye?', offer),
    ).toMatch(/1 mes de soporte/u);
    expect(
      blackFridayDetailParts({
        offer,
        recentMessages: [
          { role: 'assistant', content: '¿A qué se dedica su negocio?' },
        ],
        maxParts: 3,
      }),
    ).toHaveLength(2);
    expect(
      blackFridayDetailParts({
        offer,
        profile: { sector: 'barbería' },
        recentMessages: [],
        maxParts: 3,
      })?.[2],
    ).toMatch(/servicios de barbería/u);
  });
});
