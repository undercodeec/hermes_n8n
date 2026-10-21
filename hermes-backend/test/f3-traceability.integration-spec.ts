import { randomUUID } from 'node:crypto';
import {
  LearningItemStatus,
  LearningRiskLevel,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
} from '@prisma/client';
import {
  confirmedExposures,
  inferenceExposures,
  loadLearningTrace,
} from '../src/automated-deliveries/learning-trace';
import { PrismaService } from '../src/prisma/prisma.service';

describe('F3 historical trace on isolated PostgreSQL', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const url = process.env.DATABASE_INTEGRATION_URL;
    if (!url || !url.includes('127.0.0.1:55432/hermes_learning_test'))
      throw new Error('Isolated local PostgreSQL URL required');
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => prisma?.$disconnect());

  it('reconstructs T1/T2/T3 after retirement, a successor and evidence invalidation', async () => {
    const token = randomUUID();
    const contact = await prisma.contact.create({
      data: { waId: `trace-${token}` },
    });
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
    const fingerprint = `synthetic-${token}`;
    const expires = new Date(Date.now() + 86400_000);
    const item = async (
      label: string,
      version: number,
      sameFingerprint: boolean,
    ) =>
      prisma.learningItem.create({
        data: {
          fingerprint: sameFingerprint ? fingerprint : `${label}-${token}`,
          version,
          status: LearningItemStatus.ACTIVE,
          kind: 'STYLE',
          trigger: 'consulta actual',
          guidance: 'Responder primero la pregunta',
          riskLevel: LearningRiskLevel.LOW,
          validUntil: expires,
        },
      });
    const a1 = await item('A', 1, true);
    const a2 = await item('A', 2, true);
    const b1 = await item('B', 1, false);
    const sourceIds: string[] = [];
    try {
      const turns = [
        {
          engine: 'gemini_direct',
          exposure: [{ id: a1.id, version: 1 }],
          status: 'CONFIRMED',
        },
        {
          engine: 'nous_hermes',
          exposure: [
            { id: a2.id, version: 2 },
            { id: b1.id, version: 1 },
          ],
          status: 'SUPPRESSED',
        },
        { engine: 'gemini_direct', exposure: [], status: 'CONFIRMED' },
      ] as const;
      for (const [index, turn] of turns.entries()) {
        const source = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            contactId: contact.id,
            direction: MessageDirection.INBOUND,
            sender: MessageSender.CONTACT,
            type: MessageType.TEXT,
            content: `synthetic turn ${index + 1}`,
          },
        });
        sourceIds.push(source.id);
        const outbound =
          turn.status === 'CONFIRMED'
            ? await prisma.message.create({
                data: {
                  conversationId: conversation.id,
                  contactId: contact.id,
                  direction: MessageDirection.OUTBOUND,
                  sender: MessageSender.HERMES,
                  type: MessageType.TEXT,
                  content: `synthetic reply ${index + 1}`,
                  wamid: `wamid.synthetic.${token}.${index}`,
                },
              })
            : null;
        await prisma.automatedDelivery.create({
          data: {
            operationKey: `${source.id}:HERMES_REPLY:0`,
            deliveryKind: 'HERMES_REPLY',
            partIndex: 0,
            conversationId: conversation.id,
            contactId: contact.id,
            sourceMessageId: source.id,
            outboundMessageId: outbound?.id,
            sender: MessageSender.HERMES,
            content: `synthetic reply ${index + 1}`,
            status: turn.status,
            wamid: outbound?.wamid,
            metadata: {
              conversationEngine: turn.engine,
              providerModel: `${turn.engine}-fake`,
              promptVersion: `digest-${turn.engine}`,
              traceId: source.id,
              ...(turn.exposure.length
                ? { learningExposed: turn.exposure }
                : {}),
            },
          },
        });
      }
      await prisma.learningEvidence.create({
        data: {
          learningItemId: b1.id,
          conversationId: conversation.id,
          messageId: sourceIds[1],
        },
      });
      await prisma.learningItem.update({
        where: { id: a1.id },
        data: { status: LearningItemStatus.RETIRED },
      });
      await prisma.learningEvidence.deleteMany({
        where: { learningItemId: b1.id },
      });
      const a3 = await item('A', 3, true);
      expect(a3.version).toBe(3);
      const traces = await Promise.all(
        sourceIds.map((id) => loadLearningTrace(prisma as PrismaService, id)),
      );
      expect(traces.map((trace) => trace.learningExposed)).toEqual([
        [{ id: a1.id, version: 1 }],
        [
          { id: a2.id, version: 2 },
          { id: b1.id, version: 1 },
        ],
        [],
      ]);
      expect(traces.map((trace) => trace.deliveredConfirmed)).toEqual([
        true,
        false,
        true,
      ]);
      expect(confirmedExposures(traces, a1.id, 1)).toHaveLength(1);
      expect(confirmedExposures(traces, a2.id, 2)).toHaveLength(0);
      expect(inferenceExposures(traces, a2.id, 2)).toHaveLength(1);
      expect(JSON.stringify(traces)).not.toMatch(
        /Responder primero|synthetic turn/,
      );
    } finally {
      await prisma.automatedDelivery.deleteMany({
        where: { contactId: contact.id },
      });
      await prisma.learningEvidence.deleteMany({
        where: { learningItemId: { in: [a1.id, a2.id, b1.id] } },
      });
      await prisma.learningItem.deleteMany({
        where: { fingerprint: { in: [fingerprint, `B-${token}`] } },
      });
      await prisma.contact.delete({ where: { id: contact.id } });
    }
  });
});
