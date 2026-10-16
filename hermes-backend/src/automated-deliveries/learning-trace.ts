import type { PrismaService } from '../prisma/prisma.service';

/** Reconstruct one inference from persisted delivery rows, without looking up current LearningItem state. */
export type LearningTraceRow = {
  id: string;
  operationKey: string;
  deliveryKind: string;
  partIndex: number;
  conversationId: string;
  sourceMessageId: string;
  status: string;
  attempts: number;
  outboundMessageId: string | null;
  wamid: string | null;
  metadata: unknown;
};

export type LearningTrace = {
  conversationId: string;
  sourceMessageId: string;
  traceId: string;
  engine: 'gemini_direct' | 'nous_hermes';
  providerModel: string;
  promptVersion?: string;
  learningExposed: Array<{ id: string; version: number }>;
  deliveries: Array<{
    id: string;
    operationKey: string;
    partIndex: number;
    status: string;
    attempts: number;
    outboundMessageId: string | null;
    wamid: string | null;
  }>;
  deliveredConfirmed: boolean;
  exposureAnalyticsEligible: boolean;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('MALFORMED_LEARNING_TRACE');
  return value as Record<string, unknown>;
}

export function reconstructLearningTrace(
  rows: LearningTraceRow[],
): LearningTrace {
  if (!rows.length) throw new Error('MISSING_DELIVERY');
  const first = rows.find((row) => row.partIndex === 0);
  if (!first || first.deliveryKind !== 'HERMES_REPLY')
    throw new Error('MISSING_INFERENCE_PART');
  const parts = [...rows].sort((a, b) => a.partIndex - b.partIndex);
  if (
    parts.some(
      (row, index) =>
        row.partIndex !== index ||
        row.deliveryKind !== 'HERMES_REPLY' ||
        row.conversationId !== first.conversationId ||
        row.sourceMessageId !== first.sourceMessageId ||
        row.operationKey !== `${first.sourceMessageId}:HERMES_REPLY:${index}`,
    )
  )
    throw new Error('INCONSISTENT_DELIVERY_BATCH');

  const metadata = record(first.metadata);
  const engine = metadata.conversationEngine;
  const traceId = metadata.traceId;
  const providerModel = metadata.providerModel;
  const promptVersion = metadata.promptVersion;
  if (
    (engine !== 'gemini_direct' && engine !== 'nous_hermes') ||
    typeof traceId !== 'string' ||
    !traceId ||
    traceId !== first.sourceMessageId ||
    typeof providerModel !== 'string' ||
    !providerModel ||
    (promptVersion !== undefined &&
      (typeof promptVersion !== 'string' || !promptVersion))
  )
    throw new Error('MALFORMED_LEARNING_TRACE');
  const rawExposure = metadata.learningExposed ?? [];
  if (!Array.isArray(rawExposure)) throw new Error('MALFORMED_LEARNING_TRACE');
  const seen = new Set<string>();
  const learningExposed = rawExposure.map((raw) => {
    const item = record(raw);
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.version !== 'number' ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1 ||
      Object.keys(item).some((key) => key !== 'id' && key !== 'version')
    )
      throw new Error('MALFORMED_LEARNING_TRACE');
    const identity = `${item.id}:${item.version}`;
    if (seen.has(identity)) throw new Error('DUPLICATE_LEARNING_EXPOSURE');
    seen.add(identity);
    return { id: item.id, version: item.version };
  });
  return {
    conversationId: first.conversationId,
    sourceMessageId: first.sourceMessageId,
    traceId,
    engine,
    providerModel,
    ...(promptVersion ? { promptVersion } : {}),
    learningExposed,
    deliveries: parts.map((row) => ({
      id: row.id,
      operationKey: row.operationKey,
      partIndex: row.partIndex,
      status: row.status,
      attempts: row.attempts,
      outboundMessageId: row.outboundMessageId,
      wamid: row.wamid,
    })),
    deliveredConfirmed: parts.every((row) => row.status === 'CONFIRMED'),
    exposureAnalyticsEligible: learningExposed.length > 0,
  };
}

/** A read-only audit query: the source inbound ID is the stable logical turn key. */
export async function loadLearningTrace(
  prisma: PrismaService,
  sourceMessageId: string,
): Promise<LearningTrace> {
  const rows = await prisma.automatedDelivery.findMany({
    where: { sourceMessageId, deliveryKind: 'HERMES_REPLY' },
    orderBy: { partIndex: 'asc' },
  });
  return reconstructLearningTrace(rows);
}

export function confirmedExposures(
  traces: LearningTrace[],
  id: string,
  version: number,
): LearningTrace[] {
  return traces.filter(
    (trace) =>
      trace.deliveredConfirmed &&
      trace.learningExposed.some(
        (item) => item.id === id && item.version === version,
      ),
  );
}

export function inferenceExposures(
  traces: LearningTrace[],
  id: string,
  version: number,
): LearningTrace[] {
  return traces.filter((trace) =>
    trace.learningExposed.some(
      (item) => item.id === id && item.version === version,
    ),
  );
}
