import { updateSupport } from '../../scripts/update-commercial-support-12m';

describe('manual twelve-month PriceList scope patch', () => {
  it.each([
    ['un mes de soporte.', false],
    ['1 mes de soporte técnico.', false],
    ['tres meses de soporte.', false],
    ['3 meses de soporte técnico.', false],
    ['soporte VIP por seis meses.', true],
    ['soporte VIP por 6 meses.', true],
  ])('replaces only the support term in %s', (term, vip) => {
    const before = `Incluye dominio y hosting por un año, ${term}`;
    const after = updateSupport(before, vip);
    expect(after).toContain('Incluye dominio y hosting por un año');
    expect(after).toContain(
      vip
        ? '12 meses de soporte VIP prioritario posteriores a la entrega'
        : '12 meses de soporte técnico posteriores a la entrega',
    );
    expect(updateSupport(after, vip)).toBe(after);
  });

  it('adds support to inherited plans without changing their features', () => {
    const before = 'Incluye Landing Básica, textos persuasivos y Analytics.';
    expect(updateSupport(before, false)).toBe(
      'Incluye Landing Básica, textos persuasivos y Analytics. 12 meses de soporte técnico posteriores a la entrega.',
    );
  });

  it('blocks unexpected support conditions', () => {
    expect(() => updateSupport('soporte ilimitado', false)).toThrow();
    expect(() =>
      updateSupport('un mes de soporte; tres meses de soporte', false),
    ).toThrow();
    expect(() => updateSupport('soporte VIP por seis meses', false)).toThrow();
    expect(() => updateSupport('soporte no incluido', false)).toThrow();
    expect(() =>
      updateSupport(
        '12 meses de soporte técnico posteriores a la entrega; un mes de soporte',
        false,
      ),
    ).toThrow();
    expect(() =>
      updateSupport(
        '12 meses de soporte técnico posteriores a la entrega y soporte VIP por seis meses',
        false,
      ),
    ).toThrow();
    expect(() =>
      updateSupport(
        '12 meses de soporte VIP prioritario posteriores a la entrega',
        false,
      ),
    ).toThrow();
  });
});
