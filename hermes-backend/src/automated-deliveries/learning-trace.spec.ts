import {
  confirmedExposures,
  inferenceExposures,
  LearningTraceRow,
  reconstructLearningTrace,
} from './learning-trace';

function row(
  turn: string,
  engine: 'gemini_direct' | 'nous_hermes',
  exposure: Array<{ id: string; version: number }>,
  status: string,
  partIndex = 0,
): LearningTraceRow {
  return {
    id: `${turn}-delivery-${partIndex}`,
    operationKey: `${turn}:HERMES_REPLY:${partIndex}`,
    deliveryKind: 'HERMES_REPLY',
    partIndex,
    conversationId: `conversation-${turn}`,
    sourceMessageId: turn,
    status,
    attempts: 1,
    outboundMessageId:
      status === 'CONFIRMED' ? `${turn}-out-${partIndex}` : null,
    wamid: status === 'CONFIRMED' ? `${turn}-wamid-${partIndex}` : null,
    metadata:
      partIndex === 0
        ? {
            conversationEngine: engine,
            providerModel:
              engine === 'gemini_direct' ? 'gemini-fake' : 'nous-fake',
            promptVersion: `digest-${engine}`,
            traceId: turn,
            ...(exposure.length ? { learningExposed: exposure } : {}),
          }
        : null,
  };
}

describe('historical learning trace', () => {
  it('reconstructs T1/T2/T3 after learning status, evidence and version change', () => {
    const rows = [
      [row('T1', 'gemini_direct', [{ id: 'A', version: 1 }], 'CONFIRMED')],
      [
        row(
          'T2',
          'nous_hermes',
          [
            { id: 'A', version: 2 },
            { id: 'B', version: 1 },
          ],
          'SUPPRESSED',
        ),
      ],
      [row('T3', 'gemini_direct', [], 'CONFIRMED')],
    ];
    const traces = rows.map(reconstructLearningTrace);
    const currentLearningState = {
      A: { version: 3, status: 'RETIRED' },
      B: { evidence: [] },
    };
    expect(currentLearningState.A.version).toBe(3);
    expect(traces.map((trace) => trace.learningExposed)).toEqual([
      [{ id: 'A', version: 1 }],
      [
        { id: 'A', version: 2 },
        { id: 'B', version: 1 },
      ],
      [],
    ]);
    expect(traces.map((trace) => trace.engine)).toEqual([
      'gemini_direct',
      'nous_hermes',
      'gemini_direct',
    ]);
    expect(
      confirmedExposures(traces, 'A', 1).map((trace) => trace.traceId),
    ).toEqual(['T1']);
    expect(confirmedExposures(traces, 'A', 2)).toEqual([]);
    expect(
      inferenceExposures(traces, 'A', 2).map((trace) => trace.traceId),
    ).toEqual(['T2']);
  });

  it.each(['PREPARED', 'DISPATCHING', 'REJECTED', 'AMBIGUOUS', 'SUPPRESSED'])(
    'preserves exposure without calling %s confirmed',
    (status) => {
      const trace = reconstructLearningTrace([
        row('T', 'gemini_direct', [{ id: 'A', version: 1 }], status),
      ]);
      expect(trace.deliveredConfirmed).toBe(false);
      expect(trace.exposureAnalyticsEligible).toBe(true);
      expect(confirmedExposures([trace], 'A', 1)).toEqual([]);
    },
  );

  it('counts one inference across parts and durable delivery retries', () => {
    const first = row(
      'T',
      'nous_hermes',
      [{ id: 'A', version: 1 }],
      'CONFIRMED',
    );
    const second = {
      ...row('T', 'nous_hermes', [], 'CONFIRMED', 1),
      attempts: 3,
    };
    const trace = reconstructLearningTrace([second, first]);
    expect(trace.learningExposed).toEqual([{ id: 'A', version: 1 }]);
    expect(trace.deliveries.map((part) => part.attempts)).toEqual([1, 3]);
    expect(confirmedExposures([trace], 'A', 1)).toHaveLength(1);
    expect(
      reconstructLearningTrace([first, { ...second, status: 'AMBIGUOUS' }])
        .deliveredConfirmed,
    ).toBe(false);
  });

  it('rejects malformed, duplicated or cross-turn metadata instead of inventing a trace', () => {
    const valid = row(
      'T',
      'gemini_direct',
      [{ id: 'A', version: 1 }],
      'CONFIRMED',
    );
    expect(() =>
      reconstructLearningTrace([{ ...valid, metadata: null }]),
    ).toThrow('MALFORMED_LEARNING_TRACE');
    expect(() =>
      reconstructLearningTrace([
        {
          ...valid,
          metadata: {
            ...(valid.metadata as Record<string, unknown>),
            learningExposed: [
              { id: 'A', version: 1 },
              { id: 'A', version: 1 },
            ],
          },
        },
      ]),
    ).toThrow('DUPLICATE_LEARNING_EXPOSURE');
    expect(() =>
      reconstructLearningTrace([
        valid,
        row('OTHER', 'gemini_direct', [], 'CONFIRMED', 1),
      ]),
    ).toThrow('INCONSISTENT_DELIVERY_BATCH');
  });
});
