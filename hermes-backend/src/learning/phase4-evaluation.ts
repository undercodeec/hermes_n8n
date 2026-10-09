export type Phase4Engine = 'gemini_direct' | 'nous_hermes';
export type Phase4Variant = 'baseline' | 'summary';

export type Phase4Case = {
  id: string;
  critical: boolean;
  initialCustomerFact: string;
  correction?: string;
  interveningMessages: number;
  question: string;
  summaryCandidate: string;
  requiredTerms: string[];
  forbiddenTerms: string[];
  forbidUnauthorizedPrice: boolean;
};

export type Phase4Fixture = {
  version: number;
  dataClassification: 'synthetic';
  cases: Phase4Case[];
};

export type Phase4RecordedOutput = {
  caseId: string;
  engine: Phase4Engine;
  variant: Phase4Variant;
  finalReply: string;
  providerModel: string;
  promptVersion: string;
  snapshotVersion: string;
  policyApplied: boolean;
  deliverySimulated: boolean;
  latencyMs: number;
  costEstimateUsd: number | null;
  executedActions: string[];
  observedCommercialOutcome: string | null;
};

export type Phase4Report = {
  fixtureVersion: number;
  cases: number;
  engines: Array<{
    engine: Phase4Engine;
    pairedCases: number;
    baselinePassed: number;
    summaryPassed: number;
    improvements: number;
    criticalRegressions: string[];
    latencyP95Ms: { baseline: number; summary: number };
    estimatedCostUsd: { baseline: number | null; summary: number | null };
    executedActions: { baseline: number; summary: number };
    observedOutcomesPresent: { baseline: number; summary: number };
  }>;
  gate:
    | 'CANDIDATE_FOR_HUMAN_REVIEW'
    | 'INCOMPLETE_ENGINE_COVERAGE'
    | 'NO_MEASURED_IMPROVEMENT'
    | 'CRITICAL_REGRESSION';
  humanReview: 'PENDING';
  activation: 'BLOCKED';
};

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es');

export function syntheticHistory(item: Phase4Case): string[] {
  const history = [item.initialCustomerFact];
  if (item.correction) history.push(item.correction);
  for (let index = 0; index < item.interveningMessages; index += 1)
    history.push(`Turno sintético de seguimiento ${index + 1}.`);
  return history;
}

export function scorePhase4Reply(
  item: Phase4Case,
  finalReply: string,
): boolean {
  const reply = normalize(finalReply);
  if (!item.requiredTerms.every((term) => reply.includes(normalize(term))))
    return false;
  if (item.forbiddenTerms.some((term) => reply.includes(normalize(term))))
    return false;
  if (
    item.forbidUnauthorizedPrice &&
    /(?:[$€£]\s*\d|\b(?:usd|eur)\s*\d|\b\d{2,}(?:[.,]\d{2})?\s*(?:usd|eur|dolares|euros)\b|\b(?:precio|cuesta|valor)\b.{0,20}\b\d{2,}\b)/i.test(
      reply,
    )
  )
    return false;
  return true;
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function costOf(values: Phase4RecordedOutput[]): number | null {
  return values.every((item) => item.costEstimateUsd !== null)
    ? values.reduce((sum, item) => sum + (item.costEstimateUsd ?? 0), 0)
    : null;
}

export function evaluatePhase4(
  fixture: Phase4Fixture,
  outputs: Phase4RecordedOutput[],
): Phase4Report {
  if (
    fixture.dataClassification !== 'synthetic' ||
    fixture.version !== 1 ||
    !Array.isArray(fixture.cases) ||
    !fixture.cases.length
  )
    throw new Error('PHASE4_FIXTURE_INVALID');
  if (!Array.isArray(outputs)) throw new Error('PHASE4_OUTPUT_INVALID');
  const caseIds = new Set<string>();
  for (const item of fixture.cases) {
    if (
      !item.id ||
      caseIds.has(item.id) ||
      !Number.isSafeInteger(item.interveningMessages) ||
      item.interveningMessages < 20 ||
      !Array.isArray(item.requiredTerms) ||
      !Array.isArray(item.forbiddenTerms) ||
      !item.summaryCandidate
    )
      throw new Error('PHASE4_FIXTURE_INVALID');
    caseIds.add(item.id);
    if (syntheticHistory(item).slice(-20).includes(item.initialCustomerFact))
      throw new Error('PHASE4_CASE_NOT_LONG');
  }
  const seen = new Set<string>();
  const engines = new Set<Phase4Engine>();
  for (const output of outputs) {
    if (
      !caseIds.has(output.caseId) ||
      !['gemini_direct', 'nous_hermes'].includes(output.engine) ||
      !['baseline', 'summary'].includes(output.variant)
    )
      throw new Error('PHASE4_OUTPUT_INVALID');
    const key = `${output.engine}:${output.caseId}:${output.variant}`;
    if (seen.has(key)) throw new Error('PHASE4_DUPLICATE_OUTPUT');
    seen.add(key);
    engines.add(output.engine);
    if (
      !output.policyApplied ||
      !output.deliverySimulated ||
      !output.providerModel ||
      !output.promptVersion ||
      !output.snapshotVersion ||
      !Number.isFinite(output.latencyMs) ||
      output.latencyMs < 0 ||
      (output.costEstimateUsd !== null &&
        (!Number.isFinite(output.costEstimateUsd) ||
          output.costEstimateUsd < 0)) ||
      !Array.isArray(output.executedActions) ||
      !output.executedActions.every((action) => typeof action === 'string') ||
      typeof output.finalReply !== 'string' ||
      !output.finalReply.trim() ||
      (output.observedCommercialOutcome !== null &&
        typeof output.observedCommercialOutcome !== 'string')
    )
      throw new Error('PHASE4_OUTPUT_INVALID');
  }
  if (engines.size === 0) throw new Error('PHASE4_NO_RESULTS');
  const engineReports: Phase4Report['engines'] = [];
  for (const engine of [...engines].sort()) {
    const baseline: Phase4RecordedOutput[] = [];
    const summary: Phase4RecordedOutput[] = [];
    let baselinePassed = 0;
    let summaryPassed = 0;
    let improvements = 0;
    const criticalRegressions: string[] = [];
    for (const item of fixture.cases) {
      const before = outputs.find(
        (result) =>
          result.engine === engine &&
          result.caseId === item.id &&
          result.variant === 'baseline',
      );
      const after = outputs.find(
        (result) =>
          result.engine === engine &&
          result.caseId === item.id &&
          result.variant === 'summary',
      );
      if (!before || !after) throw new Error('PHASE4_PAIR_MISSING');
      if (
        before.providerModel !== after.providerModel ||
        before.promptVersion !== after.promptVersion ||
        before.snapshotVersion !== after.snapshotVersion
      )
        throw new Error('PHASE4_PAIR_NOT_COMPARABLE');
      baseline.push(before);
      summary.push(after);
      const beforePass = scorePhase4Reply(item, before.finalReply);
      const afterPass = scorePhase4Reply(item, after.finalReply);
      if (beforePass) baselinePassed += 1;
      if (afterPass) summaryPassed += 1;
      if (!beforePass && afterPass) improvements += 1;
      if (item.critical && beforePass && !afterPass)
        criticalRegressions.push(item.id);
    }
    engineReports.push({
      engine,
      pairedCases: fixture.cases.length,
      baselinePassed,
      summaryPassed,
      improvements,
      criticalRegressions,
      latencyP95Ms: {
        baseline: percentile95(baseline.map((item) => item.latencyMs)),
        summary: percentile95(summary.map((item) => item.latencyMs)),
      },
      estimatedCostUsd: {
        baseline: costOf(baseline),
        summary: costOf(summary),
      },
      executedActions: {
        baseline: baseline.reduce(
          (sum, item) => sum + item.executedActions.length,
          0,
        ),
        summary: summary.reduce(
          (sum, item) => sum + item.executedActions.length,
          0,
        ),
      },
      observedOutcomesPresent: {
        baseline: baseline.filter(
          (item) => item.observedCommercialOutcome !== null,
        ).length,
        summary: summary.filter(
          (item) => item.observedCommercialOutcome !== null,
        ).length,
      },
    });
  }
  return {
    fixtureVersion: fixture.version,
    cases: fixture.cases.length,
    engines: engineReports,
    gate: engineReports.some((item) => item.criticalRegressions.length)
      ? 'CRITICAL_REGRESSION'
      : engines.size < 2
        ? 'INCOMPLETE_ENGINE_COVERAGE'
        : engineReports.every((item) => item.improvements > 0)
          ? 'CANDIDATE_FOR_HUMAN_REVIEW'
          : 'NO_MEASURED_IMPROVEMENT',
    humanReview: 'PENDING',
    activation: 'BLOCKED',
  };
}
