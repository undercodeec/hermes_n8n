import { normalizeConsent, normalizeE164Phone } from './phone-normalizer';

describe('normalizeE164Phone', () => {
  it.each([
    ['0991234567', '593991234567'],
    ['+593991234567', '593991234567'],
    ['593991234567', '593991234567'],
  ])('normalizes Ecuadorian mobile %s', (input, expected) => {
    expect(normalizeE164Phone(input)).toBe(expected);
  });

  it.each(['', '099123456', '991234567', '+000123', 'phone', '+593 99 abc'])('rejects invalid or ambiguous value %s', (input) => {
    expect(normalizeE164Phone(input)).toBeNull();
  });

  it('does not treat a missing consent as an opt-in', () => {
    expect(normalizeConsent()).toBe('UNKNOWN');
    expect(normalizeConsent('no')).toBe('UNKNOWN');
    expect(normalizeConsent('sí')).toBe('OPTED_IN');
  });
});
