import { writeFileSync, mkdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, freemem, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  assertF2ModelLock,
  F2_BACKEND_CONTRACT,
  F2_MAX_CALLS,
  F2_MODEL,
  F2_REPETITIONS,
  F2Invocation,
  F2ObservedError,
  F2Usage,
  matchesF2RequestedSchemaEnvelope,
  plannedF2Calls,
  prepareFrozenF2Corpus,
  PreparedF2Fixture,
  runF2RealWithInjectedInvoker,
  summarizeF2Results,
} from '../learning/f2-provider-evaluation';
import { prepareReviewInput } from '../learning/review-input';
import { buildReviewProviderRequest } from '../learning/review-provider-request';
import { ReviewModelService } from '../learning/review-model.service';
import { installF2OfflineNetworkDeny } from '../learning/f2-offline-network-deny';

const args = new Set(process.argv.slice(2));
const real = args.has('--execute-real');
if (
  [...args].some(
    (arg) => !['--execute-real', '--acknowledge-budget=14'].includes(arg),
  )
)
  throw new Error('F2_UNKNOWN_ARGUMENT');

function resourceSnapshot() {
  let diskFreeBytes: number | 'N/D' = 'N/D';
  try {
    const disk = statfsSync(process.cwd());
    diskFreeBytes = disk.bavail * disk.bsize;
  } catch {
    // Filesystems without statfs support remain explicitly unknown.
  }
  return {
    cpuCount: cpus().length,
    processCpuUsageMicroseconds: process.cpuUsage(),
    processRssBytes: process.memoryUsage().rss,
    hostFreeMemoryBytes: freemem(),
    hostTotalMemoryBytes: totalmem(),
    hostSwapUsedBytes: 'N/D',
    diskFreeBytes,
  };
}

function writeArtifact(name: string, data: unknown): string {
  const directory = join(process.cwd(), 'artifacts', 'f2-provider-evaluation');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return path;
}

function availableToken(value: unknown): number | 'N/D' {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 'N/D';
}

function usageOf(
  value:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined,
): F2Usage {
  return {
    inputTokens: availableToken(value?.prompt_tokens),
    outputTokens: availableToken(value?.completion_tokens),
    totalTokens: availableToken(value?.total_tokens),
  };
}

async function main(): Promise<void> {
  if (!real) installF2OfflineNetworkDeny();
  if (real && !args.has('--acknowledge-budget=14'))
    throw new Error('F2_REAL_BUDGET_ACK_REQUIRED');
  const fixtures = prepareFrozenF2Corpus();
  const plannedCalls = plannedF2Calls(fixtures);
  const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
  if (
    real &&
    execFileSync('git', ['status', '--porcelain'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim()
  )
    throw new Error('F2_REAL_WORKTREE_NOT_CLEAN');
  const common = {
    harnessVersion: 'f2-provider-evaluation-v1',
    harnessCommit,
    backendContractRevision: F2_BACKEND_CONTRACT,
    provider: 'Gemini via OpenAI-compatible reviewer endpoint',
    model: F2_MODEL,
    fixtureCount: fixtures.length,
    fixtureHashes: Object.fromEntries(
      fixtures.map((fixture) => [fixture.id, fixture.sha256]),
    ),
    repetitions: F2_REPETITIONS,
    attemptsPerRun: 1,
    maxCalls: F2_MAX_CALLS,
    retries: 0,
    plannedCalls,
  };
  if (!real) {
    const path = writeArtifact('dry-run.json', {
      ...common,
      mode: 'OFFLINE',
      realCalls: 0,
      networkProviderCalls: 0,
      externalTraffic: 0,
      databaseWrites: 0,
      learningItem: 'N/A_NO_DB',
      learningEvidence: 'N/A_NO_DB',
      requests: fixtures.map((fixture) => ({
        fixtureId: fixture.id,
        fixtureVersion: fixture.version,
        description: fixture.description,
        expectedProperty: fixture.expectedProperty,
        criticality: fixture.criticality,
        sha256: fixture.sha256,
        request: fixture.request,
      })),
    });
    process.stdout.write(
      JSON.stringify({
        mode: 'OFFLINE',
        fixturesLoaded: fixtures.length,
        repetitions: F2_REPETITIONS,
        plannedCalls,
        realCalls: 0,
        externalTraffic: 0,
        databaseWrites: 0,
        artifact: path,
      }) + '\n',
    );
    return;
  }

  // No fallback to HERMES_MODEL or a generic default is permitted.
  assertF2ModelLock(process.env.LEARNING_REVIEW_MODEL);
  for (const flag of [
    'LEARNING_REVIEW_ENABLED',
    'LEARNING_RETRIEVAL_ENABLED',
    'LEARNING_SUMMARY_ENABLED',
    'LEARNING_SHADOW_ENABLED',
  ]) {
    if (process.env[flag] && process.env[flag] !== 'false')
      throw new Error('F2_LEARNING_FLAG_NOT_OFF');
  }
  if (process.env.LEARNING_REVIEW_CANARY_FEEDBACK_IDS?.trim())
    throw new Error('F2_CANARY_ALLOWLIST_NOT_EMPTY');
  const url = process.env.HERMES_API_URL;
  const key = process.env.HERMES_API_KEY;
  if (!url || !key) throw new Error('F2_PROVIDER_CONFIGURATION_MISSING');
  const parsedUrl = new URL(url);
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.username ||
    parsedUrl.password
  )
    throw new Error('F2_PROVIDER_URL_INVALID');
  // A redirect must not turn one budget slot into multiple HTTP requests.
  axios.defaults.maxRedirects = 0;

  const settings: Record<string, string> = {
    HERMES_API_URL: url,
    HERMES_API_KEY: key,
    LEARNING_REVIEW_MODEL: F2_MODEL,
  };
  const config = {
    get: (name: string, fallback?: string) => settings[name] ?? fallback,
  } as ConfigService;
  const client = new ReviewModelService(config);
  const artifactDirectory = join(
    process.cwd(),
    'artifacts',
    'f2-provider-evaluation',
  );
  mkdirSync(artifactDirectory, { recursive: true });
  const ledgerPath = join(artifactDirectory, 'real-call-ledger.json');
  let callsReserved = 0;
  // A ledger left by a prior run or crash blocks any automatic rerun.
  try {
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ...common, callsReserved, state: 'STARTED' }) + '\n',
      { encoding: 'utf8', flag: 'wx', flush: true },
    );
  } catch {
    throw new Error('F2_REAL_LEDGER_EXISTS_OR_UNWRITABLE');
  }
  const before = resourceSnapshot();
  const results = await runF2RealWithInjectedInvoker(
    fixtures,
    async (fixture: PreparedF2Fixture): Promise<F2Invocation> => {
      const { input } = prepareReviewInput(fixture.messages);
      const built = buildReviewProviderRequest(
        F2_MODEL,
        input,
        fixture.reasonCode,
        fixture.suggestedReply,
      );
      if (JSON.stringify(built) !== JSON.stringify(fixture.request))
        throw new Error('F2_REQUEST_DRIFT');
      let status: number | null = null;
      let finishReason: string | null = null;
      let rawContent: string | undefined;
      let usage = usageOf(undefined);
      try {
        const output = await client.review(
          input,
          fixture.reasonCode,
          fixture.suggestedReply,
          (response, httpStatus) => {
            status = httpStatus;
            finishReason = response.choices?.[0]?.finish_reason || null;
            rawContent = response.choices?.[0]?.message?.content;
            usage = usageOf(response.usage);
          },
        );
        if (!rawContent || !matchesF2RequestedSchemaEnvelope(rawContent))
          throw new Error('F2_SCHEMA_ACCEPTED_OUTSIDE_REQUEST');
        return {
          output,
          httpStatus: status ?? 200,
          finishReason,
          usage,
        };
      } catch (error) {
        if (error instanceof Error) {
          (error as F2ObservedError).f2Observation = {
            httpStatus: status,
            finishReason,
            usage,
          };
        }
        throw error;
      }
    },
    (fixture, repetition, attemptNumber) => {
      if (attemptNumber !== callsReserved + 1 || attemptNumber > F2_MAX_CALLS)
        throw new Error('F2_CALL_BUDGET_EXHAUSTED');
      callsReserved = attemptNumber;
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          ...common,
          callsReserved,
          state: 'IN_PROGRESS',
          lastReservedFixture: fixture.id,
          lastReservedRepetition: repetition,
        }) + '\n',
        { encoding: 'utf8', flag: 'w', flush: true },
      );
    },
  );
  const path = writeArtifact(`real-run-${Date.now()}.json`, {
    ...common,
    mode: 'REAL',
    summary: summarizeF2Results(results),
    results,
    resources: { before, after: resourceSnapshot() },
  });
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      ...common,
      callsReserved,
      state: 'FINISHED',
      resultPath: path,
    }) + '\n',
    { encoding: 'utf8', flag: 'w', flush: true },
  );
  process.stdout.write(
    JSON.stringify({
      mode: 'REAL',
      ...summarizeF2Results(results),
      artifact: path,
    }) + '\n',
  );
}

void main().catch((error: unknown) => {
  // Error codes only: never print URLs, request bodies, or secret values.
  const message = error instanceof Error ? error.message.split(':')[0] : '';
  const code = /^F2_[A-Z0-9_]+$/.test(message) ? message : 'UNKNOWN';
  process.stderr.write(`F2_PROVIDER_EVALUATION_FAILED:${code}\n`);
  process.exitCode = 1;
});
