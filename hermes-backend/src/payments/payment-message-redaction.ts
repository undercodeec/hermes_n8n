export function redactPaymentMessageForAi(
  content: string,
  metadata?: unknown,
): string {
  const action =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).action
      : undefined;
  if (action === 'TRANSFER_INSTRUCTIONS')
    return '[Datos bancarios de transferencia enviados al cliente]';
  return content
    .replace(/(\bcuenta\s*:\s*)[0-9 -]{6,34}/giu, '$1[número oculto]')
    .replace(/\b\d{8,20}\b/gu, '[número oculto]');
}
