/** A display name is optional context, never a required form of address. */
export function safeCustomerFirstName(
  value: string | null | undefined,
): string | undefined {
  const first = value
    ?.trim()
    .match(/^([\p{L}\p{M}][\p{L}\p{M}'-]{0,39})(?:\s|$)/u)?.[1];
  if (
    !first ||
    /^(?:mr|mrs|sr|sra|cliente|contacto|unknown|desconocido|usuario|undercodeec)$/iu.test(
      first,
    )
  ) {
    return undefined;
  }
  return first;
}
