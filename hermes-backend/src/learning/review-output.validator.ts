export type ReviewCandidate = {
  kind: string;
  trigger: string;
  guidance: string;
  serviceCode?: string;
  market?: string;
  evidenceMessageIds: string[];
};

export type ReviewOutput = {
  issueCode: string | null;
  summary: string;
  counterexample: string | null;
  confidence: number;
  candidate: ReviewCandidate | null;
};

const forbidden =
  /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d\s().-]{7,}\d)|[$€£])/i;

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text && text.length <= max && !forbidden.test(text) ? text : null;
}

export function parseReviewOutput(
  raw: unknown,
  allowedMessageIds: Set<string>,
): ReviewOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('REVIEW_OUTPUT_INVALID');
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'issueCode',
          'summary',
          'counterexample',
          'confidence',
          'candidate',
        ].includes(key),
    ) ||
    ![
      'issueCode',
      'summary',
      'counterexample',
      'confidence',
      'candidate',
    ].every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new Error('REVIEW_OUTPUT_INVALID');
  const summary = shortText(value.summary, 500);
  const counterexample =
    value.counterexample === null ? null : shortText(value.counterexample, 500);
  const issueCode =
    value.issueCode === null ? null : shortText(value.issueCode, 60);
  const confidence = value.confidence;
  if (
    !summary ||
    (value.counterexample !== null && !counterexample) ||
    (value.issueCode !== null && !issueCode) ||
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    throw new Error('REVIEW_OUTPUT_INVALID');

  if (value.candidate === null)
    return { summary, counterexample, issueCode, confidence, candidate: null };
  if (
    !value.candidate ||
    typeof value.candidate !== 'object' ||
    Array.isArray(value.candidate)
  )
    throw new Error('REVIEW_CANDIDATE_INVALID');
  const candidate = value.candidate as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) =>
        ![
          'kind',
          'trigger',
          'guidance',
          'serviceCode',
          'market',
          'evidenceMessageIds',
        ].includes(key),
    )
  )
    throw new Error('REVIEW_CANDIDATE_INVALID');
  const kind = shortText(candidate.kind, 60);
  const trigger = shortText(candidate.trigger, 200);
  const guidance = shortText(candidate.guidance, 500);
  const serviceCode =
    candidate.serviceCode == null
      ? undefined
      : shortText(candidate.serviceCode, 60);
  const market =
    candidate.market == null ? undefined : shortText(candidate.market, 60);
  const evidenceMessageIds = candidate.evidenceMessageIds;
  if (
    !kind ||
    !trigger ||
    !guidance ||
    (candidate.serviceCode != null && !serviceCode) ||
    (candidate.market != null && !market) ||
    !Array.isArray(evidenceMessageIds) ||
    evidenceMessageIds.length === 0 ||
    evidenceMessageIds.length > 5 ||
    !evidenceMessageIds.every(
      (id: unknown) => typeof id === 'string' && allowedMessageIds.has(id),
    )
  )
    throw new Error('REVIEW_CANDIDATE_INVALID');
  return {
    issueCode,
    summary,
    counterexample,
    confidence,
    candidate: {
      kind,
      trigger,
      guidance,
      serviceCode: serviceCode || undefined,
      market: market || undefined,
      evidenceMessageIds: evidenceMessageIds as string[],
    },
  };
}
