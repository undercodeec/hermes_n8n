import { LearningItemStatus, LearningRiskLevel } from '@prisma/client';
import { selectApprovedLearning } from './learning-retrieval.service';

const now = new Date('2026-10-24T12:00:00.000Z');
const candidate = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  version: 1,
  kind: 'STYLE',
  trigger: 'brújula consulta',
  guidance: 'Responder primero la consulta actual',
  hasEffectiveEvidence: true,
  status: LearningItemStatus.ACTIVE,
  riskLevel: LearningRiskLevel.LOW,
  validUntil: new Date('2026-11-24T12:00:00.000Z'),
  createdAt: new Date('2026-10-20T12:00:00.000Z'),
  serviceCode: undefined as string | undefined,
  market: undefined as string | undefined,
  ...overrides,
});

const context = (customerMessage: string) => ({
  customerMessage,
  serviceCode: 'WEB',
  market: 'EC',
  approvedKnowledge: [] as string[],
  now,
});

describe('offline F3 QA learning selector fixture', () => {
  it('shows zero without a literal match and one with the approved accented word', () => {
    const items = [candidate('synthetic-approved')];
    expect(
      selectApprovedLearning(
        items,
        context('Necesito orientación general'),
        12000,
      ),
    ).toEqual([]);
    expect(
      selectApprovedLearning(items, context('Necesito brujula'), 12000),
    ).toEqual([]);
    expect(
      selectApprovedLearning(items, context('Necesito brújula'), 12000).map(
        ({ id }) => id,
      ),
    ).toEqual(['synthetic-approved']);
  });

  it('respects eligibility, scope, ranking and the three-item cap', () => {
    const items = [
      candidate('general'),
      candidate('scoped-old', { serviceCode: 'WEB', market: 'EC' }),
      candidate('scoped-new', {
        serviceCode: 'WEB',
        market: 'EC',
        createdAt: new Date('2026-10-23T12:00:00.000Z'),
      }),
      candidate('scoped-fourth', {
        serviceCode: 'WEB',
        market: 'EC',
        createdAt: new Date('2026-10-19T12:00:00.000Z'),
      }),
      candidate('wrong-market', { market: 'PE' }),
      candidate('high-risk', { riskLevel: LearningRiskLevel.HIGH }),
      candidate('expired', { validUntil: now }),
      candidate('missing-evidence', { hasEffectiveEvidence: false }),
      candidate('short-only', {
        trigger: 'sol',
        guidance: 'Responder primero la consulta actual',
      }),
    ];
    expect(
      selectApprovedLearning(items, context('Necesito brújula sol'), 12000).map(
        ({ id }) => id,
      ),
    ).toEqual(['scoped-new', 'scoped-old', 'scoped-fourth']);
  });
});
