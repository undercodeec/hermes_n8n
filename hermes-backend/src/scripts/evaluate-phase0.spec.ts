import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ConversationEvaluationHarness,
  loadPhase0Cases,
} from './phase0-evaluation-harness';
import type { EvaluationResult } from './phase0-evaluation-harness';
import {
  evaluatePhase0Cases,
  PHASE0_PROVIDER_CONCURRENCY,
} from './evaluate-phase0';
import { Phase0ReportWriter } from './phase0-report-writer';

const fixture = loadPhase0Cases().find(
  (item) => item.id === 'isolated-greeting',
)!;

describe('Phase 0 sequential report runner', () => {
  it('runs one engine at a time, writes each result, and keeps default concurrency at one', async () => {
    expect(PHASE0_PROVIDER_CONCURRENCY).toBe(1);
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const result = await new ConversationEvaluationHarness().run(
      fixture,
      'nous_hermes',
    );
    const harness = {
      run: async (item: typeof fixture, engine: typeof result.engine) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return { ...result, caseId: item.id, engine };
      },
    };
    const failed = await evaluatePhase0Cases(
      [fixture, { ...fixture, id: 'second' }],
      ['nous_hermes', 'gemini_direct'],
      harness,
      (item) => order.push(`${item.caseId}:${item.engine}`),
    );
    expect(failed).toBe(false);
    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      'isolated-greeting:nous_hermes',
      'isolated-greeting:gemini_direct',
      'second:nous_hermes',
      'second:gemini_direct',
    ]);
  });

  it('writes results incrementally and closes the temporary file on completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'phase0-report-'));
    const output = join(directory, 'report.json');
    try {
      const result = await new ConversationEvaluationHarness().run(
        fixture,
        'nous_hermes',
      );
      const writer = new Phase0ReportWriter('offline', 24, output);
      writer.append(result);
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(directory)).toHaveLength(1);
      writer.finish();
      const report = JSON.parse(readFileSync(output, 'utf8')) as {
        fixtureCount: number;
        evaluated: number;
        results: EvaluationResult[];
      };
      expect(report.fixtureCount).toBe(24);
      expect(report.evaluated).toBe(1);
      expect(report.results[0].delivery.metaCalls).toBe(0);
      expect(readdirSync(directory)).toEqual(['report.json']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves all 48 offline classifications', async () => {
    const counts: Record<string, number> = {};
    let metaCalls = 0;
    const fixtures = loadPhase0Cases();
    await evaluatePhase0Cases(
      fixtures,
      ['nous_hermes', 'gemini_direct'],
      new ConversationEvaluationHarness(),
      (result) => {
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        metaCalls += result.delivery.metaCalls;
      },
    );
    expect(fixtures).toHaveLength(24);
    expect(counts).toEqual({ PASS: 29, FAIL_QUALITY: 19 });
    expect(metaCalls).toBe(0);
  });

  it('starts the compiled provider CLI only with explicit opt-in', () => {
    const executable = join(
      process.cwd(),
      'dist',
      'scripts',
      'evaluate-phase0.js',
    );
    expect(existsSync(executable)).toBe(true);
    const withoutOptIn = spawnSync(
      process.execPath,
      [
        executable,
        '--provider',
        '--case',
        'campaign-opt-out',
        '--engine',
        'nous_hermes',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, HERMES_PHASE0_PROVIDER_EVALUATION: '' },
      },
    );
    expect(withoutOptIn.status).toBe(1);
    expect(withoutOptIn.stderr).toContain(
      'HERMES_PHASE0_PROVIDER_EVALUATION=true',
    );
    const withOptIn = spawnSync(
      process.execPath,
      [
        executable,
        '--provider',
        '--case',
        'campaign-opt-out',
        '--engine',
        'nous_hermes',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, HERMES_PHASE0_PROVIDER_EVALUATION: 'true' },
      },
    );
    expect(withOptIn.status).toBe(0);
    const report = JSON.parse(withOptIn.stdout) as {
      evaluated: number;
      results: EvaluationResult[];
    };
    expect(report.evaluated).toBe(1);
    expect(report.results[0].delivery.metaCalls).toBe(0);
  });

  it('keeps the Meta blocker active in compiled JavaScript', () => {
    const harnessPath = join(
      process.cwd(),
      'dist',
      'scripts',
      'phase0-evaluation-harness.js',
    );
    const script = `
      const { Logger } = require('@nestjs/common');
      Logger.overrideLogger(false);
      const h = require(${JSON.stringify(harnessPath)});
      const item = h.loadPhase0Cases().find((entry) => entry.id === 'isolated-greeting');
      new h.ConversationEvaluationHarness().run(
        { ...item, simulateMetaAccess: true }, 'nous_hermes'
      ).then((result) => process.stdout.write(JSON.stringify({
        status: result.status,
        errors: result.errors,
        metaCalls: result.delivery.metaCalls,
      })));
    `;
    const completed = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(completed.status).toBe(0);
    const result = JSON.parse(completed.stdout) as {
      status: string;
      errors: string[];
      metaCalls: number;
    };
    expect(result.status).toBe('ERROR_INFRA');
    expect(result.errors.join(' ')).toContain('PHASE0_META_ACCESS_BLOCKED');
    expect(result.metaCalls).toBe(0);
  });
});
