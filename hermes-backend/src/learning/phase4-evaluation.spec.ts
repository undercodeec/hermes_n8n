import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluatePhase4,
  Phase4Fixture,
  Phase4RecordedOutput,
  scorePhase4Reply,
  syntheticHistory,
} from './phase4-evaluation';

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'test/fixtures/conversation-memory.phase4.json'),
    'utf8',
  ),
) as Phase4Fixture;

const goodReplies: Record<string, string> = {
  'long-early-code': 'La referencia que indicó es AZUL17.',
  'long-corrected-need': 'La necesidad actual es una tienda online con pagos.',
  'other-contact-isolation':
    'No tengo una referencia de producto registrada para usted.',
  'unapproved-price-control':
    'No puedo confirmar un precio sin una oferta autorizada.',
};

function output(
  caseId: string,
  variant: 'baseline' | 'summary',
  finalReply = goodReplies[caseId],
): Phase4RecordedOutput {
  return {
    caseId,
    engine: 'nous_hermes',
    variant,
    finalReply,
    providerModel: 'fixture-model',
    promptVersion: 'fixture-prompt',
    snapshotVersion: 'fixture-snapshot',
    policyApplied: true,
    deliverySimulated: true,
    latencyMs: variant === 'baseline' ? 100 : 120,
    costEstimateUsd: null,
    executedActions: [],
    observedCommercialOutcome: null,
  };
}

describe('Fase 4: evaluación sintética de memoria larga', () => {
  it('el hecho inicial desaparece de la ventana de 20 mensajes', () => {
    for (const item of fixture.cases) {
      const history = syntheticHistory(item);
      expect(history.length).toBeGreaterThan(20);
      expect(history.slice(-20)).not.toContain(item.initialCustomerFact);
    }
  });

  it('la rúbrica detecta correcciones, contaminación entre contactos y precios sin fuente', () => {
    const correction = fixture.cases.find(
      (item) => item.id === 'long-corrected-need',
    )!;
    expect(scorePhase4Reply(correction, goodReplies[correction.id])).toBe(true);
    expect(
      scorePhase4Reply(correction, 'Necesita un catálogo sin pagos.'),
    ).toBe(false);
    const isolated = fixture.cases.find(
      (item) => item.id === 'other-contact-isolation',
    )!;
    expect(
      scorePhase4Reply(
        isolated,
        'No hay referencia registrada; AZUL17 pertenece a otro cliente.',
      ),
    ).toBe(false);
    const price = fixture.cases.find(
      (item) => item.id === 'unapproved-price-control',
    )!;
    expect(scorePhase4Reply(price, 'El precio es USD 100.')).toBe(false);
  });

  it('compara pares del mismo motor y no confunde calidad con acciones/resultados comerciales', () => {
    const outputs = (['nous_hermes', 'gemini_direct'] as const).flatMap(
      (engine) =>
        fixture.cases.flatMap((item) => [
          {
            ...output(
              item.id,
              'baseline',
              item.id === 'long-early-code'
                ? 'No recuerdo la referencia.'
                : goodReplies[item.id],
            ),
            engine,
          },
          { ...output(item.id, 'summary'), engine },
        ]),
    );
    outputs[1].executedActions = ['SYNTHETIC_ACTION'];
    outputs[1].observedCommercialOutcome = 'SYNTHETIC_OUTCOME';
    const report = evaluatePhase4(fixture, outputs);
    expect(report.gate).toBe('CANDIDATE_FOR_HUMAN_REVIEW');
    expect(report.activation).toBe('BLOCKED');
    expect(report.engines).toHaveLength(2);
    expect(report.engines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baselinePassed: 3,
          summaryPassed: 4,
          improvements: 1,
        }),
      ]),
    );
    expect(
      report.engines.reduce(
        (sum, item) => sum + item.executedActions.summary,
        0,
      ),
    ).toBe(1);
    expect(
      report.engines.reduce(
        (sum, item) => sum + item.observedOutcomesPresent.summary,
        0,
      ),
    ).toBe(1);
    expect(JSON.stringify(report)).not.toContain('AZUL17');
  });

  it('falla ante regresión crítica o pares con modelos distintos', () => {
    const outputs = fixture.cases.flatMap((item) => [
      output(item.id, 'baseline'),
      output(item.id, 'summary'),
    ]);
    outputs[1].finalReply = 'No recuerdo la referencia.';
    expect(evaluatePhase4(fixture, outputs).gate).toBe('CRITICAL_REGRESSION');
    outputs[1].providerModel = 'different-model';
    expect(() => evaluatePhase4(fixture, outputs)).toThrow(
      'PHASE4_PAIR_NOT_COMPARABLE',
    );
  });

  it('señala cobertura incompleta aunque un solo motor mejore', () => {
    const outputs = fixture.cases.flatMap((item) => [
      output(
        item.id,
        'baseline',
        item.id === 'long-early-code'
          ? 'No recuerdo la referencia.'
          : goodReplies[item.id],
      ),
      output(item.id, 'summary'),
    ]);
    expect(evaluatePhase4(fixture, outputs).gate).toBe(
      'INCOMPLETE_ENGINE_COVERAGE',
    );
  });
});
