import { ConfigService } from '@nestjs/config';
import { activeCanaryRun } from './canary-run.policy';

const target = 'ca1e7a6f-72b6-4a5c-948a-5156dcaa143e';
const now = new Date('2026-10-25T15:00:00.000Z');

function config(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    F3_SINGLE_GENERATION_CANARY_ENABLED: 'true',
    F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: target,
    F3_GEMINI_CAPS_ENABLED: 'true',
    F3_CANARY_RUN_GUARD_ENABLED: 'true',
    F3_CANARY_RUN_ID: '94b0841c-7ca5-4623-9c52-4ca93a82debc',
    F3_CANARY_RUN_START_UTC: '2026-10-25T14:59:00.000Z',
    F3_CANARY_RUN_DEADLINE_UTC: '2026-10-25T15:01:00.000Z',
    ...overrides,
  };
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as ConfigService;
}

describe('explicit F3 Gemini run policy', () => {
  it('is off by default and does not affect another conversation', () => {
    expect(
      activeCanaryRun(
        config({ F3_CANARY_RUN_GUARD_ENABLED: 'false' }),
        target,
        now,
      ),
    ).toBeNull();
    expect(
      activeCanaryRun(config(), 'e4703499-1d9f-489e-a9a6-b2b880154bbb', now),
    ).toBeNull();
  });

  it('accepts one exact QA conversation inside the configured window', () => {
    expect(activeCanaryRun(config(), target, now)?.id).toBe(
      '94b0841c-7ca5-4623-9c52-4ca93a82debc',
    );
  });

  it.each([
    { F3_CANARY_RUN_ID: 'not-a-uuid' },
    { F3_CANARY_RUN_START_UTC: '2026-10-25T15:00:01.000Z' },
    { F3_CANARY_RUN_DEADLINE_UTC: '2026-10-25T15:00:00.000Z' },
    { F3_GEMINI_CAPS_ENABLED: 'false' },
    { F3_CANARY_RUN_GUARD_ENABLED: 'yes' },
  ])('fails closed on invalid or expired configuration', (override) => {
    expect(() => activeCanaryRun(config(override), target, now)).toThrow(
      'CANARY_RUN_CONFIGURATION_INVALID',
    );
  });
});
