import { randomUUID } from 'crypto';
import {
  ConversationStatus,
  HandoffStatus,
  MarketingConsentStatus,
  MessageDirection,
  MessageSender,
  MobileReplyStatus,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { MobileReplyService } from '../src/conversations/mobile-reply.service';

// Explicit opt-in, local disposable DB ONLY. Never use DATABASE_URL or a shared DB.
const url = process.env.HERMES_MOBILE_REPLY_TEST_DATABASE_URL;
const local =
  url &&
  /^postgres(?:ql)?:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1):\d+\/hermes_mobile_reply_test(?:\?|$)/.test(
    url,
  );
const run = local ? describe : describe.skip;

run('mobile reply PostgreSQL ledger (Meta mock only)', () => {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url:
          url || 'postgresql://test:test@127.0.0.1:1/hermes_mobile_reply_test',
      },
    },
  });
  const meta = { sendTextMessage: jest.fn() };
  const email = `mobile-reply-${randomUUID()}@example.test`;
  const config = {
    get: (key: string) => (key === 'MOBILE_REPLY_ENABLED' ? 'true' : email),
  };
  const service = new MobileReplyService(
    prisma as never,
    meta as never,
    config as never,
  );
  const actor = { id: randomUUID(), sessionId: randomUUID() };
  const contactId = randomUUID();
  const conversationId = randomUUID();
  const operations: string[] = [];
  const reply = (operationId = randomUUID()) => {
    operations.push(operationId);
    return { operationId, content: 'Mensaje de prueba sin proveedor externo' };
  };

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actor.id,
        email,
        name: 'Test only',
        password: 'not-a-login',
        role: UserRole.ADMIN,
      },
    });
    await prisma.mobileSession.create({
      data: {
        id: actor.sessionId,
        userId: actor.id,
        refreshHash: 'test-only',
        expiresAt: new Date(Date.now() + 1800000),
      },
    });
    await prisma.contact.create({
      data: { id: contactId, waId: `test-${randomUUID()}` },
    });
    await prisma.conversation.create({
      data: {
        id: conversationId,
        contactId,
        status: ConversationStatus.HANDED_OFF,
      },
    });
    await prisma.humanHandoff.create({
      data: {
        conversationId,
        assignedAgentId: actor.id,
        status: HandoffStatus.IN_PROGRESS,
      },
    });
    await prisma.message.create({
      data: {
        conversationId,
        contactId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        content: 'hola',
      },
    });
  });

  afterAll(async () => {
    await prisma.mobileReplyOperation.deleteMany({
      where: { operationId: { in: operations } },
    });
    await prisma.auditLog.deleteMany({ where: { entityId: conversationId } });
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.humanHandoff.deleteMany({ where: { conversationId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.contact.deleteMany({ where: { id: contactId } });
    await prisma.mobileSession.deleteMany({ where: { userId: actor.id } });
    await prisma.user.deleteMany({ where: { id: actor.id } });
    await prisma.$disconnect();
  });

  beforeEach(() => meta.sendTextMessage.mockReset());

  it('double touch commits one dispatch, message and audit; differing payload 409', async () => {
    const dto = reply();
    meta.sendTextMessage.mockResolvedValue({
      messages: [{ id: `wamid.mock.${randomUUID()}` }],
    });
    const results = await Promise.all([
      service.reply(conversationId, dto.operationId, dto, actor),
      service.reply(conversationId, dto.operationId, dto, actor),
    ]);
    expect(results.some((r) => r.status === MobileReplyStatus.CONFIRMED)).toBe(
      true,
    );
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(
      (await service.status(conversationId, dto.operationId, actor)).status,
    ).toBe('CONFIRMED');
    expect(
      await prisma.message.count({
        where: { metadata: { path: ['operationId'], equals: dto.operationId } },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          entityId: conversationId,
          action: 'MOBILE_HUMAN_MESSAGE_SENT',
        },
      }),
    ).toBe(1);
    await expect(
      service.reply(
        conversationId,
        dto.operationId,
        { ...dto, content: 'changed' },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('timeout and restart from DISPATCHING never dispatch again', async () => {
    const dto = reply();
    meta.sendTextMessage.mockRejectedValue(new Error('timeout'));
    expect(
      (await service.reply(conversationId, dto.operationId, dto, actor)).status,
    ).toBe('AMBIGUOUS');
    expect(
      (await service.reply(conversationId, dto.operationId, dto, actor)).status,
    ).toBe('AMBIGUOUS');
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
    await prisma.mobileReplyOperation.update({
      where: { operationId: dto.operationId },
      data: { status: MobileReplyStatus.DISPATCHING },
    });
    expect(
      (await service.reply(conversationId, dto.operationId, dto, actor)).status,
    ).toBe('DISPATCHING');
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('opt-out, missing handoff, expired window and revoked session block BEFORE Meta', async () => {
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        marketingConsentStatus: MarketingConsentStatus.OPTED_OUT,
        marketingOptOutAt: new Date(),
      },
    });
    const opted = reply();
    await expect(
      service.reply(conversationId, opted.operationId, opted, actor),
    ).rejects.toMatchObject({ status: 403 });
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        marketingConsentStatus: MarketingConsentStatus.UNKNOWN,
        marketingOptOutAt: null,
      },
    });
    await prisma.humanHandoff.updateMany({
      where: { conversationId },
      data: { status: HandoffStatus.RESOLVED },
    });
    const noHandoff = reply();
    await expect(
      service.reply(conversationId, noHandoff.operationId, noHandoff, actor),
    ).rejects.toMatchObject({ status: 409 });
    await prisma.humanHandoff.updateMany({
      where: { conversationId },
      data: { status: HandoffStatus.IN_PROGRESS },
    });
    await prisma.message.updateMany({
      where: { conversationId, sender: MessageSender.CONTACT },
      data: { createdAt: new Date(Date.now() - 25 * 3600000) },
    });
    const expired = reply();
    await expect(
      service.reply(conversationId, expired.operationId, expired, actor),
    ).rejects.toMatchObject({ status: 400 });
    await prisma.message.updateMany({
      where: { conversationId, sender: MessageSender.CONTACT },
      data: { createdAt: new Date() },
    });
    await prisma.mobileSession.update({
      where: { id: actor.sessionId },
      data: { revokedAt: new Date() },
    });
    const revoked = reply();
    await expect(
      service.reply(conversationId, revoked.operationId, revoked, actor),
    ).rejects.toMatchObject({ status: 401 });
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });
});
