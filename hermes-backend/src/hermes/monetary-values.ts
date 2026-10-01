export type MonetaryValue = {
  raw: string;
  index: number;
  currency: 'USD' | 'EUR';
  /** Decimal amount with two places; undefined for malformed numeric syntax. */
  amount?: string;
};

function normalizeAmount(raw: string): string | undefined {
  const digits = raw.match(/\d[\d.,]*/u)?.[0].replace(/[.,]+$/, '');
  if (!digits) return undefined;
  let decimal: string;
  if (/^\d+$/.test(digits)) decimal = digits;
  else if (/^\d+[.,]\d{1,2}$/.test(digits)) decimal = digits.replace(',', '.');
  else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(digits))
    decimal = digits.replaceAll(',', '');
  else if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(digits))
    decimal = digits.replaceAll('.', '').replace(',', '.');
  else return undefined;
  const amount = Number(decimal);
  return Number.isFinite(amount) &&
    Number.isSafeInteger(Math.round(amount * 100))
    ? amount.toFixed(2)
    : undefined;
}

/** Detection is not authorization: callers must still validate against the snapshot. */
export function monetaryValuesIn(text: string): MonetaryValue[] {
  const number = String.raw`\d[\d.,]*(?:e[+-]?\d+)?`;
  const currency = String.raw`(?:USD|EUR|d[oó]lares?|euros?)`;
  const suffix = String.raw`(?:\s*(?:${currency}(?!\w)|[$€](?!\s*\d)))*`;
  const pattern = new RegExp(
    String.raw`(?:\b${currency}\s*[$€]?\s*${number}|(?:US\s*)?[$€]\s*${number}|\b${number}\s*${currency}(?!\w)|\b${number}\s*€)${suffix}`,
    'giu',
  );
  return [...text.matchAll(pattern)].map((match) => {
    const raw = match[0].replace(/[.,]+$/, '');
    const euro = /€|EUR|euros?/iu.test(raw);
    const dollar = /\$|USD|d[oó]lares?/iu.test(raw);
    const incompatible =
      (euro && dollar) ||
      /\d[eE][+-]?\d/u.test(raw) ||
      /[\p{L}\p{N}_.,]/u.test(text[match.index - 1] ?? '') ||
      /[\p{L}\p{N}_]/u.test(text[match.index + match[0].length] ?? '');
    return {
      raw,
      index: match.index,
      currency: euro ? 'EUR' : 'USD',
      amount: incompatible ? undefined : normalizeAmount(raw),
    };
  });
}
