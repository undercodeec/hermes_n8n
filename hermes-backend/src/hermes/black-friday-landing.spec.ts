import {
  isGeneralBlackFridayInquiry,
  recognizesBlackFridayLanding,
} from './black-friday-landing';

describe('Black Friday landing recognition', () => {
  it.each([
    'Vi su promoción de Black Friday',
    'Quiero información de la página de $80',
    '¿Qué me dan por los 80 dólares?',
    '¿Qué incluye la landing de 80?',
  ])('recognizes an explicit campaign request: %s', (message) => {
    expect(recognizesBlackFridayLanding(message)).toBe(true);
  });

  it('retains campaign context for a specific follow-up', () => {
    expect(
      recognizesBlackFridayLanding('¿Incluye dominio?', [
        'Vi su promoción de Black Friday',
      ]),
    ).toBe(true);
  });

  it.each([
    'Quiero una página web para mi negocio',
    'Necesito una landing page normal',
    'Tengo 80 productos para una tienda online',
  ])(
    'does not infer Black Friday from a generic web request: %s',
    (message) => {
      expect(recognizesBlackFridayLanding(message)).toBe(false);
    },
  );

  it('ends campaign context when the customer changes to a store', () => {
    expect(
      recognizesBlackFridayLanding('Ahora necesito una tienda online', [
        'Vi su promoción de Black Friday',
      ]),
    ).toBe(false);
  });

  it.each([
    'Tengo 80 dólares de presupuesto para mi tienda online',
    'Quiero un sitio web de 80 páginas',
  ])('does not treat a budget or page count as the offer: %s', (message) => {
    expect(recognizesBlackFridayLanding(message)).toBe(false);
  });

  it.each([
    'Tengo un restaurante',
    '¿Cómo se paga?',
    '¿La página web incluye dominio?',
    'Soy dentista',
    'Es para una peluquería',
    '¿Incluye tienda online?',
  ])('retains the current campaign for a related follow-up: %s', (message) => {
    expect(
      recognizesBlackFridayLanding(message, [
        'Vi su promoción de Black Friday',
      ]),
    ).toBe(true);
  });

  it('returns to the normal landing when the customer explicitly requests it', () => {
    expect(
      recognizesBlackFridayLanding('Necesito una landing page normal', [
        'Vi su promoción de Black Friday',
      ]),
    ).toBe(false);
  });

  it('does not revive an old campaign after a newer store request', () => {
    expect(
      recognizesBlackFridayLanding('¿Qué incluye?', [
        'Vi su promoción de Black Friday',
        'Ahora necesito una tienda online',
      ]),
    ).toBe(false);
  });

  it('keeps the campaign through several related follow-ups', () => {
    expect(
      recognizesBlackFridayLanding('¿Y el soporte?', [
        'Vi su promoción de Black Friday',
        '¿Incluye dominio?',
        '¿Incluye hosting?',
        'Tengo un restaurante',
        '¿Cuántos correos hay?',
      ]),
    ).toBe(true);
  });

  it('requests the campaign price for a general inquiry but not a single feature', () => {
    expect(isGeneralBlackFridayInquiry('Vi su promoción de Black Friday')).toBe(
      true,
    );
    expect(
      isGeneralBlackFridayInquiry('Quiero información de la página de $80'),
    ).toBe(true);
    expect(isGeneralBlackFridayInquiry('¿La promoción incluye dominio?')).toBe(
      false,
    );
    expect(isGeneralBlackFridayInquiry('¿Qué me dan por los $80?')).toBe(false);
  });
});
