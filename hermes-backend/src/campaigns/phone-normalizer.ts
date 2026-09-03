/** Canonical WhatsApp identifier: E.164 digits without the leading plus. */
export function normalizeE164Phone(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const compact = raw.replace(/[\s\-()]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  const hasInternationalPrefix = compact.startsWith('+');
  let digits = compact.replace(/^\+/, '');
  // Ecuadorian local mobile numbers are unambiguous only with the 09 prefix.
  if (/^09\d{8}$/.test(digits)) digits = `593${digits.slice(1)}`;

  // A bare international number other than Ecuador's explicit 593 prefix is
  // ambiguous in a CSV. Require + for those values rather than guessing.
  if (!hasInternationalPrefix && !digits.startsWith('593')) return null;

  // E.164 has a 1-15 digit subscriber identifier and cannot start with zero.
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return digits;
}

export function normalizeConsent(value?: string): 'OPTED_IN' | 'UNKNOWN' {
  const normalized = value?.trim().toLocaleLowerCase('es') || '';
  return ['si', 'sí', 'yes', 'true', '1', 'opted_in'].includes(normalized)
    ? 'OPTED_IN'
    : 'UNKNOWN';
}

export function maskPhone(phone: string): string {
  if (phone.length < 5) return '***';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
