export type HermesDiagnosticCategory =
  | 'POLICY_VIOLATION'
  | 'PROVIDER_ERROR'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'OUTPUT_BLOCKED'
  | 'CONTEXT_ERROR';

export type HermesDiagnostic = {
  category: HermesDiagnosticCategory;
  code: string;
  summary: string;
  attempts: number;
  recovered: boolean;
  requiresHumanReview: boolean;
};

export type HermesIncidentMetadata = HermesDiagnostic & {
  sourceMessageId: string;
  taskId?: string;
  occurredAt: string;
};

const PROVIDER_FAILURE = {
  category: 'PROVIDER_ERROR',
  code: 'HERMES_PROVIDER_UNAVAILABLE',
  summary: 'No se pudo completar la respuesta del proveedor.',
} as const;

const INVALID_PROVIDER_RESPONSE = {
  category: 'INVALID_PROVIDER_RESPONSE',
  code: 'HERMES_INVALID_PROVIDER_RESPONSE',
  summary: 'El proveedor devolvió una respuesta inválida.',
} as const;

const NOUS_PROVIDER_CODES = new Set([
  'NOUS_HERMES_TIMEOUT',
  'NOUS_HERMES_AUTH_REJECTED',
  'NOUS_HERMES_UNAVAILABLE',
  'NOUS_HERMES_REQUEST_FAILED',
  'NOUS_HERMES_RATE_LIMITED',
  'NOUS_HERMES_QUEUE_UNAVAILABLE',
]);

type DiagnosticFields = Pick<HermesDiagnostic, 'category' | 'code' | 'summary'>;

export function safeDiagnosticFields(
  fields: DiagnosticFields,
): DiagnosticFields {
  if (
    fields.category === 'INVALID_PROVIDER_RESPONSE' ||
    fields.code === INVALID_PROVIDER_RESPONSE.code ||
    fields.code === 'NOUS_HERMES_INVALID_RESPONSE'
  ) {
    return fields.code === 'NOUS_HERMES_INVALID_RESPONSE'
      ? { ...INVALID_PROVIDER_RESPONSE, code: 'NOUS_HERMES_INVALID_RESPONSE' }
      : INVALID_PROVIDER_RESPONSE;
  }
  if (
    fields.category === 'PROVIDER_ERROR' ||
    fields.code === PROVIDER_FAILURE.code
  ) {
    return NOUS_PROVIDER_CODES.has(fields.code)
      ? { ...PROVIDER_FAILURE, code: fields.code }
      : PROVIDER_FAILURE;
  }
  return fields;
}

export function safeProviderDiagnostic(
  diagnostic: HermesDiagnostic,
): HermesDiagnostic {
  const fields = safeDiagnosticFields(diagnostic);
  if (fields === diagnostic) return diagnostic;
  return {
    ...fields,
    attempts:
      Number.isSafeInteger(diagnostic.attempts) && diagnostic.attempts >= 0
        ? Math.min(diagnostic.attempts, 3)
        : 0,
    recovered: false,
    requiresHumanReview: true,
  };
}

export function sanitizeDiagnosticSummary(value: unknown): string {
  let text = '';
  if (value instanceof Error) text = value.message;
  else if (typeof value === 'string') text = value;
  else if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    text = String(value);
  }
  return text
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|token|secret|password|authorization|prompt)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(
      /(api[_-]?key|token|secret|password|authorization|prompt)\s*[=:]\s*[^\s,}]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300);
}

export function toIncidentMetadata(
  diagnostic: HermesDiagnostic,
  sourceMessageId: string,
  taskId?: string,
  occurredAt: Date = new Date(),
): HermesIncidentMetadata {
  const safeDiagnostic = safeProviderDiagnostic(diagnostic);
  return {
    category: safeDiagnostic.category,
    code: safeDiagnostic.code,
    summary: sanitizeDiagnosticSummary(safeDiagnostic.summary),
    attempts: safeDiagnostic.attempts,
    recovered: safeDiagnostic.recovered,
    requiresHumanReview: diagnostic.requiresHumanReview === true,
    sourceMessageId,
    ...(taskId ? { taskId } : {}),
    occurredAt: occurredAt.toISOString(),
  };
}

const DIAGNOSTIC_CATEGORIES = new Set<HermesDiagnosticCategory>([
  'POLICY_VIOLATION',
  'PROVIDER_ERROR',
  'INVALID_PROVIDER_RESPONSE',
  'OUTPUT_BLOCKED',
  'CONTEXT_ERROR',
]);

export function safeStoredIncident(
  value: unknown,
): HermesIncidentMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const incident = value as Record<string, unknown>;
  if (
    typeof incident.category !== 'string' ||
    !DIAGNOSTIC_CATEGORIES.has(incident.category as HermesDiagnosticCategory) ||
    typeof incident.code !== 'string' ||
    typeof incident.summary !== 'string'
  ) {
    return null;
  }
  const fields = safeDiagnosticFields({
    category: incident.category as HermesDiagnosticCategory,
    code: incident.code,
    summary: incident.summary,
  });
  return {
    category: fields.category,
    code: sanitizeDiagnosticSummary(fields.code),
    summary: sanitizeDiagnosticSummary(fields.summary),
    attempts:
      typeof incident.attempts === 'number' &&
      Number.isSafeInteger(incident.attempts) &&
      incident.attempts >= 0
        ? Math.min(incident.attempts, 3)
        : 0,
    recovered: incident.recovered === true,
    requiresHumanReview: incident.requiresHumanReview === true,
    sourceMessageId:
      typeof incident.sourceMessageId === 'string'
        ? sanitizeDiagnosticSummary(incident.sourceMessageId)
        : '',
    ...(typeof incident.taskId === 'string'
      ? { taskId: sanitizeDiagnosticSummary(incident.taskId) }
      : {}),
    occurredAt:
      typeof incident.occurredAt === 'string'
        ? sanitizeDiagnosticSummary(incident.occurredAt)
        : '',
  };
}
