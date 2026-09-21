import { splitWhatsAppMessage } from './whatsapp-message-splitter';

describe('splitWhatsAppMessage', () => {
  it('keeps concise replies in a single WhatsApp message', () => {
    expect(splitWhatsAppMessage('Con gusto le ayudamos.')).toEqual([
      'Con gusto le ayudamos.',
    ]);
  });

  it('splits a long explanation at sentence boundaries', () => {
    const parts = splitWhatsAppMessage(
      'Primero le explicamos la opción recomendada con claridad. '.repeat(6) +
        'Después detallamos cómo se relaciona con su negocio. '.repeat(5),
      260,
    );

    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.length > 0)).toBe(true);
    expect(parts.join(' ')).toContain('Después detallamos');
  });

  it('preserves an exceptionally long reply in bounded parts', () => {
    const source = 'Una explicación extensa. '.repeat(160).trim();
    const parts = splitWhatsAppMessage(source);

    expect(parts.join(' ')).toBe(source);
    expect(parts.length).toBeLessThanOrEqual(9);
    expect(parts.every((part) => part.length <= 1000)).toBe(true);
  });

  it('splits several thousand characters without loss and respects the part limit', () => {
    const source = 'Una oración comercial completa. '.repeat(160).trim();
    const parts = splitWhatsAppMessage(source, 700, 9, 1000);

    expect(parts.join(' ')).toBe(source);
    expect(parts.every((part) => part.length <= 1000)).toBe(true);
  });

  it('packs a safe reply near the guard limit into at most nine parts', () => {
    const sentence = `${'detalle '.repeat(73)}final.`;
    const source = Array.from({ length: 10 }, () => sentence).join(' ');

    const parts = splitWhatsAppMessage(source, 520, 9, 1000);

    expect(source.length).toBeLessThanOrEqual(6000);
    expect(parts.length).toBeLessThanOrEqual(9);
    expect(parts.every((part) => part.length <= 1000)).toBe(true);
    expect(parts.join(' ')).toBe(source);
  });

  it('preserves prices and URLs containing internal periods', () => {
    const source =
      `${'Consulte el plan de autoridad por USD $1.010 en https://undercode.ec/planes. '.repeat(16)}`.trim();

    const parts = splitWhatsAppMessage(source, 300, 9, 1000);

    expect(parts.join(' ')).toBe(source);
  });
});
