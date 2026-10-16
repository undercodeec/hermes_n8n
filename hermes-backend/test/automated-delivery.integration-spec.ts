import { randomUUID } from 'node:crypto';
import {
  AutomatedDeliveryKind,
  AutomatedDeliveryStatus,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
} from '@prisma/client';
import { AutomatedDeliveryService } from '../src/automated-deliveries/automated-delivery.service';
import { loadLearningTrace } from '../src/automated-deliveries/learning-trace';
import { MetaService } from '../src/meta/meta.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('AutomatedDelivery PostgreSQL claims (integration)', () => {
  const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
  let prisma: PrismaClient | undefined;
  let contactId: string | undefined;
  let deliveryId: string;
  let operationKey: string;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('DATABASE_INTEGRATION_URL is required');
    }
    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    await prisma.$connect();
  });

  beforeEach(async () => {
    if (!prisma) throw new Error('Integration Prisma client is unavailable');

    const suffix = randomUUID();
    const contact = await prisma.contact.create({
      data: { waId: `integration-${suffix}` },
    });
    contactId = contact.id;
    const conversation = await prisma.conversation.create({
      data: { contactId },
    });
    const inbound = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        contactId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'integration inbound',
        wamid: `wamid.in.${suffix}`,
      },
    });
    operationKey = `${inbound.id}:HERMES_REPLY:0`;
    const delivery = await prisma.automatedDelivery.create({
      data: {
        operationKey,
        deliveryKind: AutomatedDeliveryKind.HERMES_REPLY,
        partIndex: 0,
        conversationId: conversation.id,
        contactId,
        sourceMessageId: inbound.id,
        sender: MessageSender.HERMES,
        content: 'integration outbound',
      },
    });
    deliveryId = delivery.id;
  });

  afterEach(async () => {
    if (!prisma || !contactId) return;
    await prisma.automatedDelivery.deleteMany({ where: { contactId } });
    await prisma.contact.delete({ where: { id: contactId } });
    contactId = undefined;
  });

  afterAll(async () => prisma?.$disconnect());

  it('allows one atomic PREPARED claim and one operation key', async () => {
    if (!prisma || !contactId) {
      throw new Error('Integration fixture is unavailable');
    }

    const [first, second] = await Promise.all([
      prisma.automatedDelivery.updateMany({
        where: {
          id: deliveryId,
          status: AutomatedDeliveryStatus.PREPARED,
          claimToken: null,
        },
        data: {
          status: AutomatedDeliveryStatus.DISPATCHING,
          claimToken: 'worker-a',
        },
      }),
      prisma.automatedDelivery.updateMany({
        where: {
          id: deliveryId,
          status: AutomatedDeliveryStatus.PREPARED,
          claimToken: null,
        },
        data: {
          status: AutomatedDeliveryStatus.DISPATCHING,
          claimToken: 'worker-b',
        },
      }),
    ]);
    expect(first.count + second.count).toBe(1);
    expect(
      await prisma.automatedDelivery.count({ where: { operationKey } }),
    ).toBe(1);

    const existing = await prisma.automatedDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    await expect(
      prisma.automatedDelivery.create({
        data: {
          operationKey,
          deliveryKind: AutomatedDeliveryKind.HERMES_REPLY,
          partIndex: 1,
          conversationId: existing.conversationId,
          contactId,
          sourceMessageId: existing.sourceMessageId,
          sender: MessageSender.HERMES,
          content: 'duplicate key',
        },
      }),
    ).rejects.toBeDefined();
  });

  it('suppresses a prepared reply when a newer inbound arrives during the output delay', async () => {
    if (!prisma || !contactId)
      throw new Error('Integration fixture unavailable');
    const delivery = await prisma.automatedDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const meta = { sendTextMessage: jest.fn() };
    const service = new AutomatedDeliveryService(
      prisma as PrismaService,
      meta as unknown as MetaService,
    );
    await prisma.message.create({
      data: {
        conversationId: delivery.conversationId,
        contactId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'Un detalle más',
        wamid: `wamid.later.${randomUUID()}`,
        rawPayload: { timestamp: String(Math.floor(Date.now() / 1000) + 2) },
      },
    });
    const result = await service.deliverPreparedBatch(delivery.sourceMessageId);
    expect(result.reasonCode).toBe('NEWER_INBOUND');
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
    expect(
      (
        await prisma.automatedDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
        })
      ).status,
    ).toBe(AutomatedDeliveryStatus.SUPPRESSED);
  });

  it('suppresses a prepared voice note when a newer inbound arrives before dispatch', async () => {
    if (!prisma || !contactId)
      throw new Error('Integration fixture unavailable');
    const delivery = await prisma.automatedDelivery.update({
      where: { id: deliveryId },
      data: { metadata: { voiceMediaId: 'prepared-voice-media' } },
    });
    const sendVoiceNote = jest.fn();
    const service = new AutomatedDeliveryService(
      prisma as PrismaService,
      { sendVoiceNote } as unknown as MetaService,
    );
    await prisma.message.create({
      data: {
        conversationId: delivery.conversationId,
        contactId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'Corrijo mi pedido',
        wamid: `wamid.later.${randomUUID()}`,
        rawPayload: { timestamp: String(Math.floor(Date.now() / 1000) + 2) },
      },
    });
    const result = await service.deliverPreparedBatch(delivery.sourceMessageId);
    expect(result.reasonCode).toBe('NEWER_INBOUND');
    expect(sendVoiceNote).not.toHaveBeenCalled();
    expect(
      (
        await prisma.automatedDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
        })
      ).status,
    ).toBe(AutomatedDeliveryStatus.SUPPRESSED);
  });

  it('rechecks NEWER_INBOUND before each reply part', async () => {
    if (!prisma || !contactId)
      throw new Error('Integration fixture unavailable');
    const delivery = await prisma.automatedDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    await prisma.automatedDelivery.create({
      data: {
        operationKey: `${delivery.sourceMessageId}:HERMES_REPLY:1`,
        deliveryKind: AutomatedDeliveryKind.HERMES_REPLY,
        partIndex: 1,
        conversationId: delivery.conversationId,
        contactId,
        sourceMessageId: delivery.sourceMessageId,
        sender: MessageSender.HERMES,
        content: 'Pregunta de seguimiento',
      },
    });
    const sendTextMessage = jest.fn().mockImplementation(async () => {
      await prisma!.message.create({
        data: {
          conversationId: delivery.conversationId,
          contactId,
          direction: MessageDirection.INBOUND,
          sender: MessageSender.CONTACT,
          type: MessageType.TEXT,
          content: 'Otra corrección',
          wamid: `wamid.later.${randomUUID()}`,
          rawPayload: { timestamp: String(Math.floor(Date.now() / 1000) + 2) },
        },
      });
      return { messages: [{ id: `wamid.out.${randomUUID()}` }] };
    });
    const service = new AutomatedDeliveryService(
      prisma as PrismaService,
      { sendTextMessage } as unknown as MetaService,
    );
    const result = await service.deliverPreparedBatch(delivery.sourceMessageId);
    expect(result.confirmed).toBe(1);
    expect(result.reasonCode).toBe('NEWER_INBOUND');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('reconstructs confirmed exposure from the persisted ledger without guidance', async () => {
    if (!prisma) throw new Error('Integration fixture unavailable');
    const delivery = await prisma.automatedDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    await prisma.automatedDelivery.update({
      where: { id: deliveryId },
      data: {
        metadata: {
          conversationEngine: 'gemini_direct',
          providerModel: 'gemini-fake',
          promptVersion: 'synthetic-digest',
          traceId: delivery.sourceMessageId,
          learningExposed: [{ id: 'synthetic-learning-a', version: 1 }],
        },
      },
    });
    const service = new AutomatedDeliveryService(
      prisma as PrismaService,
      {
        sendTextMessage: jest.fn().mockResolvedValue({
          messages: [{ id: `wamid.out.${randomUUID()}` }],
        }),
      } as unknown as MetaService,
    );
    expect(
      (await service.deliverPreparedBatch(delivery.sourceMessageId)).confirmed,
    ).toBe(1);
    const trace = await loadLearningTrace(
      prisma as PrismaService,
      delivery.sourceMessageId,
    );
    expect(trace.deliveredConfirmed).toBe(true);
    expect(trace.learningExposed).toEqual([
      { id: 'synthetic-learning-a', version: 1 },
    ]);
    expect(trace.traceId).toBe(delivery.sourceMessageId);
    expect(trace.deliveries[0].wamid).toMatch(/^wamid\.out\./);
    expect(JSON.stringify(trace)).not.toContain('guidance');
    expect(
      (
        await loadLearningTrace(
          prisma as PrismaService,
          delivery.sourceMessageId,
        )
      ).learningExposed,
    ).toEqual(trace.learningExposed);
  });

  it('rolls back every prepared part when later trace metadata cannot persist', async () => {
    if (!prisma || !contactId)
      throw new Error('Integration fixture unavailable');
    const delivery = await prisma.automatedDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const source = await prisma.message.create({
      data: {
        conversationId: delivery.conversationId,
        contactId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'synthetic second inbound',
      },
    });
    const service = new AutomatedDeliveryService(
      prisma as PrismaService,
      { sendTextMessage: jest.fn() } as unknown as MetaService,
    );
    const invalidMetadata: Record<string, unknown> = {};
    invalidMetadata.self = invalidMetadata;
    const batch = {
      deliveryKind: 'HERMES_REPLY' as const,
      conversationId: delivery.conversationId,
      contactId,
      sourceMessageId: source.id,
      sender: 'HERMES' as const,
      allowHandedOff: false,
      parts: [
        {
          partIndex: 0,
          content: 'Part 0',
          metadata: {
            conversationEngine: 'nous_hermes',
            providerModel: 'nous-fake',
            traceId: source.id,
            learningExposed: [{ id: 'synthetic-learning', version: 2 }],
          },
        },
        { partIndex: 1, content: 'Part 1', metadata: invalidMetadata },
      ],
    };
    await expect(service.prepareBatch(batch)).rejects.toBeDefined();
    expect(
      await prisma.automatedDelivery.count({
        where: { sourceMessageId: source.id },
      }),
    ).toBe(0);
    await service.prepareBatch({
      ...batch,
      parts: [batch.parts[0], { partIndex: 1, content: 'Part 1' }],
    });
    expect(
      await prisma.automatedDelivery.count({
        where: { sourceMessageId: source.id },
      }),
    ).toBe(2);
  });

  it('keeps a post-inference suppression terminal with exposure and no Meta send', async () => {
    if (!prisma || !contactId)
      throw new Error('Integration fixture unavailable');
    const delivery = await prisma.automatedDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const source = await prisma.message.create({
      data: {
        conversationId: delivery.conversationId,
        contactId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'synthetic suppressed inbound',
      },
    });
    const sendTextMessage = jest.fn();
    const service = new AutomatedDeliveryService(
      prisma as PrismaService,
      { sendTextMessage } as unknown as MetaService,
    );
    await service.recordSuppressedInference({
      conversationId: delivery.conversationId,
      contactId,
      sourceMessageId: source.id,
      reasonCode: 'REPLY_PART_BLOCKED',
      metadata: {
        conversationEngine: 'nous_hermes',
        providerModel: 'nous-fake',
        promptVersion: 'synthetic-digest',
        traceId: source.id,
        learningExposed: [{ id: 'synthetic-learning', version: 1 }],
      },
    });
    const trace = await loadLearningTrace(prisma as PrismaService, source.id);
    expect(trace.deliveredConfirmed).toBe(false);
    expect(trace.exposureAnalyticsEligible).toBe(true);
    expect(trace.deliveries[0].status).toBe('SUPPRESSED');
    expect((await service.recoverBatch(source.id))?.terminal).toBe(true);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});
