/* eslint-disable @typescript-eslint/require-await -- async doubles exercise the harness boundary */
jest.mock('../meta/meta.service', () => {
  const actual = jest.requireActual<typeof import('../meta/meta.service')>(
    '../meta/meta.service',
  );
  return {
    ...actual,
    MetaService: class ForbiddenMetaService {
      constructor() {
        throw new Error('REAL_META_CONSTRUCTOR_FORBIDDEN');
      }
    },
  };
});
import {
  ConversationEvaluationHarness,
  loadPhase0Cases,
} from './phase0-evaluation-harness';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from '../conversation-engine/conversation-engine.types';

const cases = loadPhase0Cases();
const find = (id: string) => cases.find((item) => item.id === id)!;
const nousResult = (
  input: ConversationTurnInput,
  replyText: string,
): ConversationTurnResult => ({
  replyText,
  engine: 'nous_hermes',
  providerModel: 'phase0-test',
  traceId: input.inboundMessageId,
  proposedActions: [{ type: 'none' }],
});

describe('Phase 0 final output evaluation', () => {
  const harness = new ConversationEvaluationHarness();

  it('never constructs the real Meta delivery dependency', async () => {
    const result = await harness.run(
      find('isolated-greeting'),
      'gemini_direct',
    );
    expect(result.errors).toEqual([]);
    expect(result.delivery.metaCalls).toBe(0);
  });

  it('loads exactly the 24 synthetic baseline fixtures without production data', () => {
    expect(cases).toHaveLength(24);
    expect(new Set(cases.map((item) => item.id)).size).toBe(24);
    expect(cases.every((item) => Array.isArray(item.expected))).toBe(true);
  });

  it('runs the same case through both engines and captures the final fake delivery', async () => {
    const pair = await Promise.all([
      harness.run(find('direct-price'), 'nous_hermes'),
      harness.run(find('direct-price'), 'gemini_direct'),
    ]);
    for (const result of pair) {
      expect(result.finalText).toBe(result.delivery.parts.join(' '));
      expect(result.delivery.metaCalls).toBe(0);
      expect(result.delivery.mode).toBe('FAKE');
      expect(result.delivery.syntheticIds).toHaveLength(
        result.delivery.parts.length,
      );
      expect(result.finalText).toContain('137.00');
      expect(
        result.assertions.find(
          (check) => check.name === 'authorized_price_correct',
        )?.passed,
      ).toBe(true);
      expect(
        result.assertions.find(
          (check) => check.name === 'market_currency_consistent',
        )?.passed,
      ).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it('fails immediately if the AutoReply flow accesses Meta', async () => {
    const result = await harness.run(
      { ...find('isolated-greeting'), simulateMetaAccess: true },
      'nous_hermes',
    );
    expect(result.status).toBe('ERROR_INFRA');
    expect(result.errors.join(' ')).toContain('PHASE0_META_ACCESS_BLOCKED');
    expect(result.delivery.metaCalls).toBe(0);
  });

  it('requires an explicit provider opt-in before any provider is constructed', () => {
    const previous = process.env.HERMES_PHASE0_PROVIDER_EVALUATION;
    delete process.env.HERMES_PHASE0_PROVIDER_EVALUATION;
    try {
      expect(() => new ConversationEvaluationHarness('provider')).toThrow(
        'HERMES_PHASE0_PROVIDER_EVALUATION=true',
      );
    } finally {
      if (previous === undefined)
        delete process.env.HERMES_PHASE0_PROVIDER_EVALUATION;
      else process.env.HERMES_PHASE0_PROVIDER_EVALUATION = previous;
    }
  });

  it('evaluates the corrected final text rather than the raw price proposal', async () => {
    const result = await harness.run(
      find('direct-price'),
      'nous_hermes',
      async (input) => nousResult(input, 'La landing cuesta USD 9999.'),
    );
    expect(result.finalText).not.toContain('9999');
    expect(result.delivery.parts.join(' ')).toBe(result.finalText);
    expect(
      result.assertions.find((check) => check.name === 'no_unapproved_price')
        ?.passed,
    ).toBe(true);
  });

  it('records a rejected ungrounded proposal', async () => {
    const result = await harness.run(
      find('isolated-greeting'),
      'nous_hermes',
      async (input) => ({
        ...nousResult(input, 'Hola, ¿en qué podemos ayudarle?'),
        business: { commercialProfile: { service: 'software secreto' } },
      }),
    );
    expect(result.proposalRejections.length).toBeGreaterThan(0);
  });

  it('handles explicit human handoff before calling either engine', async () => {
    for (const engine of ['nous_hermes', 'gemini_direct'] as const) {
      const result = await harness.run(
        find('human-request'),
        engine,
        async () => {
          throw new Error('engine must not be called');
        },
      );
      expect(result.errors).toEqual([]);
      expect(
        result.assertions.find((check) => check.name === 'no_ai_call')?.passed,
      ).toBe(true);
      expect(result.delivery.parts[0]).toContain('persona');
    }
  });

  it('runs campaign opt-out through webhook routing without calling an engine or preparing a reply', async () => {
    const result = await harness.run(find('campaign-opt-out'), 'nous_hermes');
    expect(result.status).not.toBe('FAIL_CRITICAL');
    expect(result.finalText).toBe('');
    expect(result.delivery.syntheticIds).toEqual([]);
    expect(
      result.assertions.find((check) => check.name === 'campaign_opt_out')
        ?.passed,
    ).toBe(true);
    expect(
      result.assertions.find((check) => check.name === 'no_ai_call')?.passed,
    ).toBe(true);
  });

  it('applies the production delivery eligibility rule to a closed 24h window', async () => {
    const result = await harness.run(
      find('closed-24h-window'),
      'gemini_direct',
    );
    expect(result.delivery.suppressedReason).toBe('WHATSAPP_TEMPLATE_REQUIRED');
    expect(result.delivery.syntheticIds).toEqual([]);
    expect(
      result.assertions.find((check) => check.name === 'no_free_text_send')
        ?.passed,
    ).toBe(true);
  });

  it('routes owned-project support to human handoff before the engine', async () => {
    const result = await harness.run(
      find('support-owned-project'),
      'nous_hermes',
      async () => {
        throw new Error('engine must not be called');
      },
    );
    expect(result.errors).toEqual([]);
    expect(
      result.assertions.find((check) => check.name === 'support_handoff')
        ?.passed,
    ).toBe(true);
  });

  it('blocks an unsafe inbound before an engine is called', async () => {
    const result = await harness.run(
      find('unsafe-out-of-scope'),
      'nous_hermes',
      async () => {
        throw new Error('engine must not be called');
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.guards).toContain('INBOUND_BLOCK:OUT_OF_SCOPE');
    expect(
      result.assertions.find((check) => check.name === 'guard_block')?.passed,
    ).toBe(true);
  });

  it('classifies engine failure as infrastructure error', async () => {
    const result = await harness.run(
      find('isolated-greeting'),
      'nous_hermes',
      async () => {
        throw new Error('synthetic engine failure');
      },
    );
    expect(result.status).toBe('ERROR_INFRA');
    expect(result.errors).toContain('synthetic engine failure');
  });
});
