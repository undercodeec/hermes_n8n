/** A locally supplied, time-limited upper bound. Configuration is not proof of provider billing. */
export type F3GeminiBudget = {
  mode?: 'HARD' | 'ESTIMATED';
  model: string;
  targetConversationId: string;
  validUntil: string;
  serviceWindowExpiresAt: string;
  channel: 'CLOUD_API';
  category: 'SERVICE';
  sourceUrl: string;
  auditedAt: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  countCallUsdMax: number | null;
  metaUsdPerPartMax: number | null;
  bspUsdPerPartMax: number | null;
  marginUsd: number | null;
  maxParts: number;
  upperBoundUsd: number | null;
};

/** Audited planning estimate. Meta/BSP cost remains unknown until observed. */
export function parseF3EstimatedBudget(
  raw: unknown,
  model: string,
  conversationId: string | undefined,
  configuredTarget: string,
  windowStartRaw: string,
  receivedAtRaw: string | undefined,
  actualServiceWindowExpiresAt: string | undefined,
  now = Date.now(),
): F3GeminiBudget | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  if (
    model !== 'gemini-3.8-flash' ||
    value.model !== model ||
    !conversationId ||
    conversationId !== configuredTarget ||
    value.targetConversationId !== conversationId ||
    value.sourceUrl !== 'https://ai.google.dev/gemini-api/docs/pricing' ||
    value.inputUsdPerMillion !== 0.75 ||
    value.outputUsdPerMillion !== 3.75 ||
    !Number.isSafeInteger(value.maxParts) ||
    Number(value.maxParts) < 1 ||
    Number(value.maxParts) > 9
  )
    return undefined;
  const start = Date.parse(windowStartRaw);
  const received = Date.parse(String(receivedAtRaw));
  const serviceEnd = Date.parse(String(actualServiceWindowExpiresAt));
  const audited = Date.parse(String(value.auditedAt));
  if (![start, received, serviceEnd, audited].every(Number.isFinite))
    return undefined;
  if (
    start > now ||
    now - start >= 30 * 60_000 ||
    received < start ||
    received > now ||
    serviceEnd <= now ||
    serviceEnd - received > 86_400_000 ||
    audited > now ||
    now - audited > 86_400_000
  )
    return undefined;
  const validUntil = new Date(
    Math.min(start + 30 * 60_000, serviceEnd),
  ).toISOString();
  return {
    model,
    mode: 'ESTIMATED',
    targetConversationId: conversationId,
    validUntil,
    serviceWindowExpiresAt: new Date(serviceEnd).toISOString(),
    channel: 'CLOUD_API',
    category: 'SERVICE',
    sourceUrl: value.sourceUrl,
    auditedAt: value.auditedAt as string,
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 3.75,
    countCallUsdMax: null,
    metaUsdPerPartMax: null,
    bspUsdPerPartMax: null,
    marginUsd: null,
    maxParts: Number(value.maxParts),
    upperBoundUsd: null,
  };
}

export type F3CallTrace = {
  requestId: string | null;
  sourceMessageId: string;
  model: string;
  countTokenCount: number;
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  countUsageDelta: number;
  durationMs: number;
  estimatedGeminiUsd: number;
  rateSourceUrl: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  metaBspUsd: null;
};

export function parseF3GeminiBudget(
  raw: unknown,
  model: string,
  conversationId: string | undefined,
  actualServiceWindowExpiresAt: string | undefined,
  now = Date.now(),
): F3GeminiBudget | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  if (value.model !== model || value.targetConversationId !== conversationId)
    return undefined;
  if (value.channel !== 'CLOUD_API' || value.category !== 'SERVICE')
    return undefined;
  if (
    typeof value.sourceUrl !== 'string' ||
    !/^https:\/\//.test(value.sourceUrl)
  )
    return undefined;
  const validUntil = Date.parse(String(value.validUntil));
  const serviceWindowExpiresAt = Date.parse(
    String(value.serviceWindowExpiresAt),
  );
  const actualWindowEnd = Date.parse(String(actualServiceWindowExpiresAt));
  const auditedAt = Date.parse(String(value.auditedAt));
  if (
    ![validUntil, serviceWindowExpiresAt, actualWindowEnd, auditedAt].every(
      Number.isFinite,
    )
  )
    return undefined;
  if (serviceWindowExpiresAt > actualWindowEnd) return undefined;
  if (actualWindowEnd <= now || actualWindowEnd - now > 86_400_000)
    return undefined;
  if (
    validUntil <= now ||
    serviceWindowExpiresAt <= now ||
    auditedAt > now ||
    now - auditedAt > 86_400_000
  )
    return undefined;
  if (serviceWindowExpiresAt - now > 86_400_000) return undefined;
  const rates = [
    value.inputUsdPerMillion,
    value.outputUsdPerMillion,
    value.countCallUsdMax,
    value.metaUsdPerPartMax,
    value.bspUsdPerPartMax,
    value.marginUsd,
  ];
  if (
    rates.some(
      (rate) => typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0,
    )
  )
    return undefined;
  if (
    !Number.isSafeInteger(value.maxParts) ||
    Number(value.maxParts) < 1 ||
    Number(value.maxParts) > 9
  )
    return undefined;
  // One count request, one generation, at most one physical attempt per part.
  const upperBoundUsd =
    (12_000 * Number(value.inputUsdPerMillion) +
      1_500 * Number(value.outputUsdPerMillion)) /
      1_000_000 +
    Number(value.countCallUsdMax) +
    Number(value.maxParts) *
      (Number(value.metaUsdPerPartMax) + Number(value.bspUsdPerPartMax)) +
    Number(value.marginUsd);
  if (!Number.isFinite(upperBoundUsd) || upperBoundUsd > 1) return undefined;
  return { ...value, upperBoundUsd } as F3GeminiBudget;
}
