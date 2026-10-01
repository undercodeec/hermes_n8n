import { monetaryValuesIn } from './monetary-values';
import { monetaryAmountsIn } from './commercial-catalog';

describe('canonical monetary parsing', () => {
  it.each([
    ['$360', '360.00'],
    ['$360.00', '360.00'],
    ['$ 360', '360.00'],
    ['US$360', '360.00'],
    ['USD 360', '360.00'],
    ['USD360', '360.00'],
    ['USD $360.00', '360.00'],
    ['360 USD', '360.00'],
    ['360 dólares', '360.00'],
    ['360 dolares', '360.00'],
    ['360,00 USD', '360.00'],
    ['$1,010', '1010.00'],
    ['USD 1,010.00', '1010.00'],
    ['1.010,00 USD', '1010.00'],
    ['USD 360.00,', '360.00'],
    ['USD 360.00.', '360.00'],
  ])('normalizes %s without changing its value', (text, amount) => {
    expect(monetaryValuesIn(text)).toEqual([
      { raw: text.replace(/[.,]+$/, ''), index: 0, currency: 'USD', amount },
    ]);
    expect(monetaryAmountsIn(text)).toEqual([Number(amount)]);
  });

  it('retains currency and position and excludes bare quantities', () => {
    expect(monetaryValuesIn('Hay 360 productos y cuesta EUR360,00.')).toEqual([
      { raw: 'EUR360,00', index: 27, currency: 'EUR', amount: '360.00' },
    ]);
    expect(monetaryValuesIn('10 días; 5 páginas')).toEqual([]);
  });

  it.each([
    'USD 360€',
    '$360€',
    'USD360€',
    'USD 360 €',
    'USD 360EUR',
    'EUR360$',
    '€360 USD',
    '360 USD€',
    '360 dólares €',
    'USD 360e3',
    'USD 360 EUR',
    'USD 360 euros',
    '$360 EUR',
    'EUR 360 USD',
    'USD 3,60,00',
    'USD 360abc',
    '1e360 USD',
  ])('detects %s without authorizing a partial amount', (text) => {
    const values = monetaryValuesIn(text);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value.amount === undefined)).toBe(true);
  });

  it.each(['USD 360', '$360', '€360', 'EUR 360'])(
    'retains consistent currency: %s',
    (text) => {
      expect(monetaryValuesIn(text)[0].amount).toBe('360.00');
      expect(monetaryValuesIn(text)[0].currency).toBe(
        /[€]|EUR/.test(text) ? 'EUR' : 'USD',
      );
    },
  );
});
