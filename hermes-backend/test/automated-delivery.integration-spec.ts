import { randomUUID } from 'node:crypto';
import {
  AutomatedDeliveryKind,
  AutomatedDeliveryStatus,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
} from '@prisma/client';

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
});
