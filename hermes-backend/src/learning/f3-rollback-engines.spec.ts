import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { HermesService } from '../hermes/hermes.service';
import { AgentOutputValidator } from '../conversation-engine/agent-output.validator';
import type { ConversationTurnInput } from '../conversation-engine/conversation-engine.types';
import { DirectGeminiEngine } from '../conversation-engine/direct-gemini.engine';
import { NousHermesTransport } from '../conversation-engine/nous-hermes.transport';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const learning = [
  {
    id: '123e4567-e89b-42d3-a456-426614174000',
    version: 4,
    kind: 'STYLE',
    trigger: 'consulta punto',
    guidance: 'Hacer una pregunta pertinente.',
  },
];
const input = (enabled: boolean): ConversationTurnInput => ({
  conversationId: 'synthetic-conversation',
  inboundMessageId: 'synthetic-inbound',
  customerMessage: 'consulta punto',
  approvedContext: {
    contactName: 'Cliente',
    recentMessages: [{ role: 'user', text: 'Contexto sintético' }],
    approvedKnowledge: ['Conocimiento autorizado sintético'],
    ...(enabled ? { approvedLearning: learning } : {}),
    commercialSnapshot: {
      marketSource: 'UNKNOWN',
      relevantServiceCodes: [],
      offers: [],
      needsMarketClarification: false,
    },
    handoffActive: false,
  },
});
const stages = [false, true, false, false, false, true] as const;

describe('F3 rollback through the actual engine adapters with local fakes', () => {
  it('Gemini Direct emits no learning in OFF requests and returns to the exact baseline', async () => {
    const requests: unknown[] = [];
    const durations: number[] = [];
    const fake = {
      generateResponse: jest.fn(
        (request: { approvedLearning?: typeof learning }) => {
          requests.push(request);
          return Promise.resolve({
            response: 'Respuesta sintética',
            learningExposed: request.approvedLearning?.map(
              ({ id, version }) => ({ id, version }),
            ),
          });
        },
      ),
      getProviderModel: () => 'fake-gemini',
      getPromptVersion: () => 'synthetic-digest',
    } as unknown as HermesService;
    const engine = new DirectGeminiEngine(fake);
    const exposures: number[] = [];
    for (const enabled of stages) {
      const started = performance.now();
      const result = await engine.respond(input(enabled));
      durations.push(performance.now() - started);
      exposures.push(result.learningExposed?.length ?? 0);
      expect(result.engine).toBe('gemini_direct');
      expect(result.promptVersion).toBe('synthetic-digest');
    }
    expect(exposures).toEqual([0, 1, 0, 0, 0, 1]);
    expect(requests[2]).toEqual(requests[0]);
    expect(requests[3]).toEqual(requests[0]);
    expect(requests[4]).toEqual(requests[0]);
    const performanceSamples: Record<string, number[]> = {};
    for (const [label, enabled] of [
      ['baselineOff', false],
      ['retrievalOn', true],
      ['firstOff', false],
      ['repeatedOff', false],
      ['reenabledOn', true],
    ] as const) {
      performanceSamples[label] = [];
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        await engine.respond(input(enabled));
        performanceSamples[label].push(performance.now() - started);
      }
    }
    if (process.env.F3_ROLLBACK_GEMINI_EVIDENCE_PATH)
      writeFileSync(
        process.env.F3_ROLLBACK_GEMINI_EVIDENCE_PATH,
        JSON.stringify(
          {
            engine: 'gemini_direct',
            sequence: stages,
            exposures,
            requestLearningCounts: requests
              .slice(0, stages.length)
              .map(
                (request) =>
                  (request as { approvedLearning?: unknown[] }).approvedLearning
                    ?.length ?? 0,
              ),
            baselineHash: hash(requests[0]),
            postRollbackHash: hash(requests[2]),
            durationsMs: durations,
            performanceSamples,
          },
          null,
          2,
        ),
      );
  });

  it('Nous serializes no learning after OFF and preserves its state, budget and digest', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        model: 'hermes-agent',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({ replyText: 'Respuesta sintética' }),
            },
          },
        ],
      },
    });
    try {
      const transport = new NousHermesTransport(
        new ConfigService({}),
        new AgentOutputValidator(),
        { read: () => Promise.resolve('synthetic-secret') },
      );
      const states: Array<Record<string, unknown>> = [];
      const durations: number[] = [];
      const exposures: number[] = [];
      const promptVersions: string[] = [];
      for (const enabled of stages) {
        const started = performance.now();
        const result = await transport.execute(input(enabled));
        durations.push(performance.now() - started);
        exposures.push(result.learningExposed?.length ?? 0);
        promptVersions.push(result.promptVersion ?? '');
        const request = post.mock.calls.at(-1)?.[1] as {
          messages: Array<{ content: string }>;
        };
        states.push(
          JSON.parse(request.messages.at(-1)!.content) as Record<
            string,
            unknown
          >,
        );
        expect(result.engine).toBe('nous_hermes');
        expect(result.promptVersion).toMatch(/^[0-9a-f]{12}$/);
      }
      expect(exposures).toEqual([0, 1, 0, 0, 0, 1]);
      expect(states[2]).toEqual(states[0]);
      expect(states[3]).toEqual(states[0]);
      expect(states[4]).toEqual(states[0]);
      expect(promptVersions[2]).toBe(promptVersions[0]);
      const performanceSamples: Record<string, number[]> = {};
      for (const [label, enabled] of [
        ['baselineOff', false],
        ['retrievalOn', true],
        ['firstOff', false],
        ['repeatedOff', false],
        ['reenabledOn', true],
      ] as const) {
        performanceSamples[label] = [];
        for (let i = 0; i < 20; i++) {
          const started = performance.now();
          await transport.execute(input(enabled));
          performanceSamples[label].push(performance.now() - started);
        }
      }
      if (process.env.F3_ROLLBACK_NOUS_EVIDENCE_PATH)
        writeFileSync(
          process.env.F3_ROLLBACK_NOUS_EVIDENCE_PATH,
          JSON.stringify(
            {
              engine: 'nous_hermes',
              sequence: stages,
              exposures,
              requestLearningCounts: states.map(
                (state) =>
                  (state.approvedState as { approvedLearning?: unknown[] })
                    .approvedLearning?.length ?? 0,
              ),
              baselineHash: hash(states[0]),
              postRollbackHash: hash(states[2]),
              promptVersions,
              durationsMs: durations,
              performanceSamples,
            },
            null,
            2,
          ),
        );
    } finally {
      post.mockRestore();
    }
  });
});
