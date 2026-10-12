import {
  ConversationEvaluationHarness,
  loadPhase0Cases,
  type BaselineCase,
  type EvaluationResult,
} from './phase0-evaluation-harness';
import { Phase0ReportWriter } from './phase0-report-writer';
import type { ConversationEngineId } from '../conversation-engine/conversation-engine.types';
import { Logger } from '@nestjs/common';

export const PHASE0_PROVIDER_CONCURRENCY = 1;

export async function evaluatePhase0Cases(
  cases: BaselineCase[],
  engines: ConversationEngineId[],
  harness: Pick<ConversationEvaluationHarness, 'run'>,
  append: (result: EvaluationResult) => void,
): Promise<boolean> {
  let failed = false;
  for (const item of cases) {
    for (const engine of engines) {
      const result = await harness.run(item, engine);
      append(result);
      if (result.status === 'ERROR_INFRA' || result.status === 'FAIL_CRITICAL')
        failed = true;
    }
  }
  return failed;
}

async function main(): Promise<void> {
  Logger.overrideLogger(false);
  const args = process.argv.slice(2);
  const mode = args.includes('--provider') ? 'provider' : 'offline';
  if (
    mode === 'provider' &&
    process.env.HERMES_PHASE0_PROVIDER_EVALUATION !== 'true'
  )
    throw new Error(
      'Provider mode requires HERMES_PHASE0_PROVIDER_EVALUATION=true',
    );
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const caseId = option('--case');
  const selectedEngine = option('--engine');
  if (
    selectedEngine &&
    !['nous_hermes', 'gemini_direct'].includes(selectedEngine)
  )
    throw new Error(`Unknown engine: ${selectedEngine}`);
  const engines = selectedEngine
    ? [selectedEngine as ConversationEngineId]
    : (['nous_hermes', 'gemini_direct'] as ConversationEngineId[]);
  const fixtures = loadPhase0Cases();
  const cases = fixtures.filter((item) => !caseId || item.id === caseId);
  if (!cases.length) throw new Error(`Unknown case: ${caseId}`);
  const harness = new ConversationEvaluationHarness(mode);
  const writer = new Phase0ReportWriter(mode, fixtures.length, option('--out'));
  try {
    const failed = await evaluatePhase0Cases(
      cases,
      engines,
      harness,
      (result) => writer.append(result),
    );
    writer.finish();
    if (failed) process.exitCode = 1;
  } catch (error) {
    writer.abort();
    throw error;
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
