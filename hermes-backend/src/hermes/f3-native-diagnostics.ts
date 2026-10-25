import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

export type NativeStage =
  | 'SELECTED_FOR_CONTEXT'
  | 'INCLUDED_IN_COUNT_PAYLOAD'
  | 'COUNT_HTTP_ATTEMPTED'
  | 'COUNT_HTTP_RESPONSE_OBSERVED'
  | 'INCLUDED_IN_GENERATE_PAYLOAD'
  | 'GENERATE_HTTP_ATTEMPTED'
  | 'GENERATE_HTTP_RESPONSE_OBSERVED'
  | 'COUNT_COMPLETED'
  | 'DISPATCH_RESERVED'
  | 'HTTP_ATTEMPT_STARTING_LOCAL'
  | 'HTTP_RESPONSE_OBSERVED'
  | 'RESPONSE_VALIDATION_FAILED'
  | 'CANDIDATE_VALIDATED'
  | 'GENERATION_SUPPRESSED'
  | 'GENERATION_ACCEPTED';

export type NativeFailureClass =
  | 'HTTP_400'
  | 'HTTP_401'
  | 'HTTP_403'
  | 'HTTP_429'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'HTTP_OTHER'
  | 'DNS'
  | 'TIMEOUT'
  | 'TLS'
  | 'TRANSPORT'
  | 'CANDIDATES_ZERO'
  | 'CANDIDATES_MULTIPLE'
  | 'FINISH_NOT_STOP'
  | 'STOP_WITHOUT_TEXT'
  | 'USAGE_MISSING_OR_INVALID'
  | 'USAGE_LIMIT_EXCEEDED'
  | 'MODEL_VERSION_MISMATCH'
  | 'PARSER_INVALID'
  | 'DISPATCH_RESERVATION_FAILED'
  | 'PERSISTENCE_FAILED'
  | 'UNKNOWN';

export type F3NativeDiagnosticEvent = {
  stage: NativeStage;
  failureClass?: NativeFailureClass;
  reasonCode?: string;
  httpStatus?: number;
  transportCode?: string;
  providerErrorCode?: number;
  providerStatus?: string;
  countTokenCount?: number;
  candidatesCount?: number;
  finishReason?: string;
  textPresent?: boolean;
  usagePresent?: boolean;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  modelVersionMatch?: boolean;
  requestAttemptedLocal?: boolean;
  httpResponseObserved?: boolean;
  providerReceipt?: 'UNKNOWN';
  billingReconciled?: 'UNKNOWN';
  durationMs?: number;
  consideredCount?: number;
  selectedCount?: number;
  learningItems?: Array<{ id: string; version: number }>;
  selectionFailed?: boolean;
  retrievalEnabled?: boolean;
  exposureStatus?: 'UNKNOWN' | 'CONFIRMED';
};

const TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ERR_NETWORK',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

const PROVIDER_STATUSES = new Set([
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'NOT_FOUND',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'INTERNAL',
  'UNKNOWN',
]);

const FINISH_REASONS = new Set([
  'STOP',
  'MAX_TOKENS',
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MALFORMED_FUNCTION_CALL',
  'OTHER',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'IMAGE_SAFETY',
]);

const FAILURE_CLASSES = new Set<NativeFailureClass>([
  'HTTP_400',
  'HTTP_401',
  'HTTP_403',
  'HTTP_429',
  'HTTP_4XX',
  'HTTP_5XX',
  'HTTP_OTHER',
  'DNS',
  'TIMEOUT',
  'TLS',
  'TRANSPORT',
  'CANDIDATES_ZERO',
  'CANDIDATES_MULTIPLE',
  'FINISH_NOT_STOP',
  'STOP_WITHOUT_TEXT',
  'USAGE_MISSING_OR_INVALID',
  'USAGE_LIMIT_EXCEEDED',
  'MODEL_VERSION_MISMATCH',
  'PARSER_INVALID',
  'DISPATCH_RESERVATION_FAILED',
  'PERSISTENCE_FAILED',
  'UNKNOWN',
]);

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function safeFinishReason(value: unknown): string | undefined {
  return typeof value === 'string' && FINISH_REASONS.has(value)
    ? value
    : value === undefined || value === null
      ? undefined
      : 'UNKNOWN';
}

export function safeNativeError(
  error: unknown,
): Pick<
  F3NativeDiagnosticEvent,
  | 'failureClass'
  | 'httpStatus'
  | 'transportCode'
  | 'providerErrorCode'
  | 'providerStatus'
> {
  if (!axios.isAxiosError(error)) return { failureClass: 'UNKNOWN' };
  const httpStatus = safeHttpStatus(error.response?.status);
  const transportCode =
    typeof error.code === 'string' && TRANSPORT_CODES.has(error.code)
      ? error.code
      : undefined;
  const providerData: unknown = error.response?.data;
  const providerError =
    providerData &&
    typeof providerData === 'object' &&
    !Array.isArray(providerData)
      ? (providerData as Record<string, unknown>).error
      : undefined;
  const providerFields =
    providerError &&
    typeof providerError === 'object' &&
    !Array.isArray(providerError)
      ? (providerError as Record<string, unknown>)
      : {};
  const providerErrorCode = safeHttpStatus(providerFields.code);
  const providerStatus =
    typeof providerFields.status === 'string' &&
    PROVIDER_STATUSES.has(providerFields.status)
      ? providerFields.status
      : undefined;
  const failureClass: NativeFailureClass =
    httpStatus !== undefined
      ? httpStatus === 400
        ? 'HTTP_400'
        : httpStatus === 401
          ? 'HTTP_401'
          : httpStatus === 403
            ? 'HTTP_403'
            : httpStatus === 429
              ? 'HTTP_429'
              : httpStatus >= 500
                ? 'HTTP_5XX'
                : httpStatus >= 400
                  ? 'HTTP_4XX'
                  : 'HTTP_OTHER'
      : transportCode === 'ENOTFOUND' || transportCode === 'EAI_AGAIN'
        ? 'DNS'
        : transportCode === 'ECONNABORTED' || transportCode === 'ETIMEDOUT'
          ? 'TIMEOUT'
          : transportCode === 'CERT_HAS_EXPIRED' ||
              transportCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
              transportCode === 'DEPTH_ZERO_SELF_SIGNED_CERT'
            ? 'TLS'
            : transportCode
              ? 'TRANSPORT'
              : 'UNKNOWN';
  return {
    failureClass,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(transportCode ? { transportCode } : {}),
    ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
    ...(providerStatus ? { providerStatus } : {}),
  };
}

export function safeNativeEvent(
  sourceMessageId: string,
  event: F3NativeDiagnosticEvent,
) {
  const safe: Record<string, unknown> = {
    sourceMessageId,
    stage: event.stage,
    at: new Date().toISOString(),
    providerReceipt: 'UNKNOWN',
    billingReconciled: 'UNKNOWN',
  };
  if (event.failureClass && FAILURE_CLASSES.has(event.failureClass))
    safe.failureClass = event.failureClass;
  if (event.reasonCode && /^[A-Z0-9_]{1,64}$/.test(event.reasonCode))
    safe.reasonCode = event.reasonCode;
  for (const field of ['httpStatus', 'providerErrorCode'] as const) {
    const value = safeHttpStatus(event[field]);
    if (value !== undefined) safe[field] = value;
  }
  for (const field of [
    'countTokenCount',
    'candidatesCount',
    'promptTokenCount',
    'candidatesTokenCount',
    'thoughtsTokenCount',
    'durationMs',
    'consideredCount',
    'selectedCount',
  ] as const) {
    const value = safeCount(event[field]);
    if (value !== undefined) safe[field] = value;
  }
  if (event.transportCode && TRANSPORT_CODES.has(event.transportCode))
    safe.transportCode = event.transportCode;
  if (event.providerStatus && PROVIDER_STATUSES.has(event.providerStatus))
    safe.providerStatus = event.providerStatus;
  if (event.finishReason !== undefined)
    safe.finishReason = safeFinishReason(event.finishReason);
  for (const field of [
    'textPresent',
    'usagePresent',
    'modelVersionMatch',
    'requestAttemptedLocal',
    'httpResponseObserved',
    'selectionFailed',
    'retrievalEnabled',
  ] as const) {
    if (typeof event[field] === 'boolean') safe[field] = event[field];
  }
  if (
    event.exposureStatus === 'UNKNOWN' ||
    event.exposureStatus === 'CONFIRMED'
  )
    safe.exposureStatus = event.exposureStatus;
  if (
    Array.isArray(event.learningItems) &&
    event.learningItems.length <= 3 &&
    event.learningItems.every(
      (item) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          item.id,
        ) &&
        Number.isSafeInteger(item.version) &&
        item.version > 0,
    )
  )
    safe.learningItems = event.learningItems.map(({ id, version }) => ({
      id,
      version,
    }));
  return safe;
}

/** Atomic JSON append on an existing inbound row. The JSON field requires no migration. */
export async function appendNativeDiagnostic(
  prisma: PrismaService,
  sourceMessageId: string,
  event: F3NativeDiagnosticEvent,
): Promise<void> {
  if (
    event.stage === 'SELECTED_FOR_CONTEXT' &&
    (!Number.isSafeInteger(event.consideredCount) ||
      !Number.isSafeInteger(event.selectedCount) ||
      (event.consideredCount ?? -1) < 0 ||
      (event.selectedCount ?? -1) < 0 ||
      (event.selectedCount ?? 0) > (event.consideredCount ?? -1) ||
      (event.selectedCount ?? 0) > 3 ||
      !Array.isArray(event.learningItems) ||
      event.learningItems.length > (event.selectedCount ?? 0) ||
      event.learningItems.length > 3 ||
      typeof event.selectionFailed !== 'boolean' ||
      typeof event.retrievalEnabled !== 'boolean' ||
      safeNativeEvent(sourceMessageId, event).learningItems === undefined)
  )
    throw new Error('F3_DIAGNOSTIC_PERSISTENCE_FAILED');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sourceMessageId,
    )
  )
    throw new Error('F3_DIAGNOSTIC_PERSISTENCE_FAILED');
  const raw = JSON.stringify(safeNativeEvent(sourceMessageId, event));
  try {
    const updated = await prisma.$executeRaw`
      UPDATE messages
      SET metadata = jsonb_set(
        CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
        '{f3NativeDiagnostics}',
        (CASE WHEN jsonb_typeof(metadata->'f3NativeDiagnostics') = 'array'
          THEN metadata->'f3NativeDiagnostics' ELSE '[]'::jsonb END) || ${raw}::jsonb,
        true
      )
      WHERE id = ${sourceMessageId} AND direction::text = 'INBOUND'
        AND (CASE WHEN ${event.stage === 'SELECTED_FOR_CONTEXT'}
          OR COALESCE(metadata->'f3NativeDiagnostics' @> '[{"stage":"SELECTED_FOR_CONTEXT"}]'::jsonb, false)
          THEN (CASE WHEN jsonb_typeof(metadata->'f3NativeDiagnostics') = 'array'
            THEN jsonb_array_length(metadata->'f3NativeDiagnostics') ELSE 0 END) < 32
          ELSE true END)
    `;
    if (updated !== 1) throw new Error('F3_DIAGNOSTIC_PERSISTENCE_FAILED');
  } catch {
    throw new Error('F3_DIAGNOSTIC_PERSISTENCE_FAILED');
  }
}
