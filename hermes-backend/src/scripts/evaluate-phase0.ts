import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConversationEvaluationHarness,
  loadPhase0Cases,
} from './phase0-evaluation-harness';
import type { ConversationEngineId } from '../conversation-engine/conversation-engine.types';
import { Logger } from '@nestjs/common';

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
  const cases = loadPhase0Cases().filter(
    (item) => !caseId || item.id === caseId,
  );
  if (!cases.length) throw new Error(`Unknown case: ${caseId}`);
  const harness = new ConversationEvaluationHarness(mode);
  const results = [];
  for (const item of cases)
    for (const engine of engines) results.push(await harness.run(item, engine));
  const report = {
    mode,
    fixtureCount: loadPhase0Cases().length,
    evaluated: results.length,
    results,
  };
  const out = option('--out');
  if (out)
    writeFileSync(resolve(out), JSON.stringify(report, null, 2) + '\n', {
      flag: 'w',
    });
  else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (
    results.some(
      (result) =>
        result.status === 'ERROR_INFRA' || result.status === 'FAIL_CRITICAL',
    )
  )
    process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
