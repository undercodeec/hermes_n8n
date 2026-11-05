const ordinary = '12 meses de soporte técnico posteriores a la entrega';
const vip = '12 meses de soporte VIP prioritario posteriores a la entrega';

/** Rewrites one recognized support clause and rejects contradictory terms. */
export function updateSupport(scope: string, isVip: boolean): string {
  const desired = isVip ? vip : ordinary;
  if (/\b(?:ilimitado|24\s*\/\s*7|mantenimiento evolutivo)\b/iu.test(scope))
    throw new Error('Unsupported support condition requires commercial review');
  const matches = [
    ...scope.matchAll(
      /\b(?:(?:un|una|1|tres|3|seis|6|doce|12)\s+mes(?:es)?|(?:un|1)\s+año)\s+de\s+soporte(?:\s+(?:técnico|VIP|prioritario)){0,2}(?:\s+posterior(?:es)?\s+a\s+la\s+entrega)?|\bsoporte(?:\s+(?:técnico|VIP|prioritario)){0,2}\s+por\s+(?:un|1|tres|3|seis|6|doce|12)\s+mes(?:es)?/giu,
    ),
  ];
  if (
    matches.length > 1 ||
    matches.length !== [...scope.matchAll(/\bsoporte\b/giu)].length
  )
    throw new Error('Multiple support terms require review');
  if (matches.length === 1) {
    const old = matches[0][0];
    if (!isVip && /\bVIP\b/iu.test(old))
      throw new Error('Unexpected VIP support on ordinary plan');
    if (old === desired) return scope;
    return scope.replace(old, desired);
  }
  if (/\bsoporte\b/iu.test(scope))
    throw new Error('Unrecognized support term requires commercial review');
  return `${scope.trim().replace(/[.\s]+$/u, '')}. ${desired}.`;
}
