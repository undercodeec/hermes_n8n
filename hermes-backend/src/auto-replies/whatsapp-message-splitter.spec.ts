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

  it('never creates more than three parts for an exceptionally long reply', () => {
    const parts = splitWhatsAppMessage('Una explicación extensa. '.repeat(100));

    expect(parts).toHaveLength(3);
  });
});
