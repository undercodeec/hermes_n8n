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
  return {
    category: diagnostic.category,
    code: diagnostic.code,
    summary: sanitizeDiagnosticSummary(diagnostic.summary),
    attempts: diagnostic.attempts,
    recovered: diagnostic.recovered,
    requiresHumanReview: diagnostic.requiresHumanReview,
    sourceMessageId,
    ...(taskId ? { taskId } : {}),
    occurredAt: occurredAt.toISOString(),
  };
}
