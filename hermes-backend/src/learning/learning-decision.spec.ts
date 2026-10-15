import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LearningItemStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationReviewService } from './conversation-review.service';
import { LearningDecisionAction } from './dto/learning-decision.dto';
import { ReviewJobData } from './learning.constants';
import { ReviewModelService } from './review-model.service';
import { ReviewCanaryPolicy } from './review-canary.policy';
import { LearningRetrievalService } from './learning-retrieval.service';

describe('Fase 3: decisión auditada y recuperación en sombra', () => {
  const tx = {
    $queryRaw: jest.fn(() => Promise.resolve([{ one: 1 }])),
    learningItem: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    learningEvidence: { count: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
    learningItem: { findMany: jest.fn() },
  };
  const config = { get: jest.fn((_key: string, fallback: string) => fallback) };
  const service = new ConversationReviewService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    {} as ReviewModelService,
    {} as Queue<ReviewJobData>,
    {} as ReviewCanaryPolicy,
    new LearningRetrievalService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    ),
  );
  const validUntil = new Date(Date.now() + 30 * 86400_000).toISOString();

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((_key: string, fallback: string) => fallback);
    tx.learningItem.findUnique.mockResolvedValue({
      id: 'item-1',
      status: LearningItemStatus.PROPOSED,
      version: 1,
      kind: 'STYLE',
      trigger: 'Cuando el cliente corrige un dato',
      guidance: 'Usar el dato más reciente',
      serviceCode: null,
      market: null,
      sourceReview: {
        issueCode: 'REPETITION',
        summary: 'Pauta general',
        counterexample: null,
      },
      _count: { evidence: 1 },
    });
    tx.learningItem.updateMany.mockResolvedValue({ count: 1 });
    tx.learningEvidence.count.mockResolvedValue(1);
    tx.learningItem.findUniqueOrThrow.mockResolvedValue({
      id: 'item-1',
      status: LearningItemStatus.ACTIVE,
    });
  });

  it('aprueba sólo con evidencia, vencimiento, operador y auditoría', async () => {
    await service.decide(
      'item-1',
      {
        action: LearningDecisionAction.APPROVE,
        reason: 'Pauta revisada con evidencia suficiente',
        validUntil,
      },
      'admin-1',
    );
    const updateCalls = tx.learningItem.updateMany.mock.calls as Array<
      [unknown]
    >;
    const auditCalls = tx.auditLog.create.mock.calls as Array<[unknown]>;
    const updateArgs = updateCalls[0][0];
    const auditArgs = auditCalls[0][0];
    expect(updateArgs).toMatchObject({
      where: { id: 'item-1', status: LearningItemStatus.PROPOSED },
      data: { status: LearningItemStatus.ACTIVE, approvedById: 'admin-1' },
    });
    expect(auditArgs).toMatchObject({
      data: {
        action: 'LEARNING_APPROVE',
        userId: 'admin-1',
        entityId: 'item-1',
      },
    });
  });

  it('bloquea aprobación sin evidencia y carreras entre operadores', async () => {
    tx.learningItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      status: LearningItemStatus.PROPOSED,
      version: 1,
      _count: { evidence: 0 },
    });
    tx.learningEvidence.count.mockResolvedValueOnce(0);
    const dto = {
      action: LearningDecisionAction.APPROVE,
      reason: 'Pauta revisada con evidencia',
      validUntil,
    };
    await expect(
      service.decide('item-1', dto, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    tx.learningItem.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.decide('item-1', dto, 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('bloquea la activación de candidatos históricos inseguros', async () => {
    const dto = {
      action: LearningDecisionAction.APPROVE,
      reason: 'Pauta revisada con evidencia suficiente',
      validUntil,
    };
    for (const guidance of [
      'Recordar que Juan Pérez necesita 15 usuarios.',
      'Ofrecer 20% de descuento si paga por transferencia.',
    ]) {
      tx.learningItem.findUnique.mockResolvedValueOnce({
        id: 'item-1',
        status: LearningItemStatus.PROPOSED,
        version: 1,
        kind: 'STYLE',
        trigger: 'Cuando el cliente consulta',
        guidance,
        serviceCode: null,
        market: null,
        sourceReview: null,
        _count: { evidence: 1 },
      });
      await expect(
        service.decide('item-1', dto, 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(tx.learningItem.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('retira una pauta activa con motivo y sin modificar su contenido', async () => {
    tx.learningItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      status: LearningItemStatus.ACTIVE,
      version: 1,
      _count: { evidence: 1 },
    });
    await service.decide(
      'item-1',
      {
        action: LearningDecisionAction.RETIRE,
        reason: 'El alcance comercial ya no es aplicable',
      },
      'admin-1',
    );
    expect(tx.learningItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'item-1', status: LearningItemStatus.ACTIVE },
      data: { status: LearningItemStatus.RETIRED },
    });
  });

  it('rechaza un candidato sin habilitarlo y exige un motivo sin contacto', async () => {
    await service.decide(
      'item-1',
      {
        action: LearningDecisionAction.REJECT,
        reason: 'La evidencia no respalda esta pauta',
      },
      'admin-1',
    );
    expect(tx.learningItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'item-1', status: LearningItemStatus.PROPOSED },
      data: { status: LearningItemStatus.REJECTED },
    });
    await expect(
      service.decide(
        'item-1',
        {
          action: LearningDecisionAction.REJECT,
          reason: 'Contactar a test@example.com',
        },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('la sombra apagada no consulta la base', async () => {
    await service.recordShadowMatches({
      conversationId: 'conversation-1',
      inboundMessageId: 'inbound-1',
      customerMessage: 'precio',
      engine: 'nous_hermes',
    });
    expect(prisma.learningItem.findMany).not.toHaveBeenCalled();
  });

  it('la sombra consulta sólo activos vigentes y registra IDs sin texto', async () => {
    config.get.mockImplementation((key: string, fallback: string) =>
      key === 'LEARNING_SHADOW_ENABLED' ? 'true' : fallback,
    );
    prisma.learningItem.findMany.mockResolvedValue([
      {
        id: 'item-1',
        version: 1,
        kind: 'STYLE',
        trigger: 'cliente pregunta precio',
        guidance: 'Consultar el catálogo vigente',
        status: LearningItemStatus.ACTIVE,
        riskLevel: 'LOW',
        validUntil: new Date(Date.now() + 86400_000),
        createdAt: new Date(),
        evidence: [{ id: 'evidence-1' }],
        serviceCode: null,
        market: null,
      },
      {
        id: 'item-2',
        version: 1,
        kind: 'STYLE',
        trigger: 'cliente solicita llamada',
        guidance: 'Pedir confirmación al equipo',
        status: LearningItemStatus.ACTIVE,
        riskLevel: 'LOW',
        validUntil: new Date(Date.now() + 86400_000),
        createdAt: new Date(),
        evidence: [{ id: 'evidence-2' }],
        serviceCode: null,
        market: null,
      },
    ]);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      await service.recordShadowMatches({
        conversationId: 'conversation-1',
        inboundMessageId: 'inbound-1',
        customerMessage: '¿Cuál es el precio?',
        serviceCode: 'WEBSITE',
        market: 'EC',
        engine: 'nous_hermes',
      });
      const calls = prisma.learningItem.findMany.mock.calls as Array<
        [
          {
            where: { status: string; validUntil: { gt: Date } };
          },
        ]
      >;
      const query = calls[0][0];
      expect(query.where.status).toBe(LearningItemStatus.ACTIVE);
      expect(query.where.validUntil.gt).toBeInstanceOf(Date);
      const event = log.mock.calls
        .map(
          ([message]) =>
            JSON.parse(message as string) as {
              matches: Array<{ id: string }>;
              customerMessage?: string;
              event: string;
            },
        )
        .find((entry) => entry.event === 'learning_shadow_retrieval')!;
      expect(event.matches.map((item) => item.id)).toEqual(['item-1']);
      expect(event.customerMessage).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});
