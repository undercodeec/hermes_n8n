/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- In-memory Prisma transaction stub; DB concurrency is covered separately. */
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { MobileReplyStatus } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { MobileReplyService } from './mobile-reply.service';

describe('mobile reply ledger (Meta is always mocked)', () => {
  const actor = { id: randomUUID(), sessionId: randomUUID() };
  const conversationId = randomUUID();
  const operationId = randomUUID();
  const dto = { operationId, content: 'Prueba móvil sin envío real' };
  let state: any;
  let service: MobileReplyService;
  let meta: { sendTextMessage: jest.Mock };
  let failConfirmation: boolean;
  let config: { get: jest.Mock };

  beforeEach(() => {
    state = null;
    failConfirmation = false;
    meta = {
      sendTextMessage: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.mock' }] }),
    };
    const tx: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mobileReplyOperation: {
        findUnique: jest.fn(async () => state && { ...state }),
        findUniqueOrThrow: jest.fn(async () => ({ ...state })),
        create: jest.fn(async ({ data }) => {
          state = {
            ...data,
            status: MobileReplyStatus.PREPARED,
            messageId: null,
            wamid: null,
            createdAt: new Date(),
            dispatchStartedAt: null,
            confirmedAt: null,
            ambiguousAt: null,
          };
          return { ...state };
        }),
        updateMany: jest.fn(async ({ where, data }) => {
          if (state?.status !== where.status) return { count: 0 };
          state = { ...state, ...data };
          return { count: 1 };
        }),
        update: jest.fn(async ({ data }) => {
          state = { ...state, ...data };
          return { ...state };
        }),
      },
      conversation: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ contactId: 'contact-test' }),
        update: jest.fn(),
      },
      message: {
        create: jest.fn(async () => {
          if (failConfirmation)
            throw new Error('DB unavailable after Meta confirmation');
          return { id: 'message-test' };
        }),
      },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      mobileReplyOperation: {
        findUnique: jest.fn(async () => state && { ...state }),
        updateMany: jest.fn(async ({ where, data }) => {
          if (state?.status !== where.status) return { count: 0 };
          state = { ...state, ...data };
          return { count: 1 };
        }),
      },
      $transaction: jest.fn(async (fn) => fn(tx)),
    };
    config = {
      get: jest.fn((key: string) =>
        key === 'MOBILE_REPLY_ENABLED' ? 'true' : 'operator@example.test',
      ),
    };
    service = new MobileReplyService(prisma, meta as never, config as never);
    jest
      .spyOn(service as any, 'authorize')
      .mockResolvedValue({ waId: 'recipient-test' });
  });

  it('one intent, repeated body cannot call Meta twice; differing body is 409', async () => {
    expect(
      await service.reply(conversationId, operationId, dto, actor),
    ).toMatchObject({
      status: MobileReplyStatus.CONFIRMED,
      wamid: 'wamid.mock',
      messageId: 'message-test',
      retryable: false,
    });
    expect(
      await service.reply(conversationId, operationId, dto, actor),
    ).toMatchObject({ status: 'CONFIRMED' });
    await expect(
      service.reply(
        conversationId,
        operationId,
        { ...dto, content: 'otro' },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('a timeout or absent wamid is ambiguous and is never retried', async () => {
    meta.sendTextMessage.mockRejectedValueOnce(
      new Error('timeout with unknown outcome'),
    );
    expect(
      await service.reply(conversationId, operationId, dto, actor),
    ).toMatchObject({ status: 'AMBIGUOUS', retryable: false });
    expect(
      await service.reply(conversationId, operationId, dto, actor),
    ).toMatchObject({ status: 'AMBIGUOUS' });
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('a crash after DISPATCHING commit does not send upon replay', async () => {
    state = {
      operationId,
      userId: actor.id,
      conversationId,
      contentHash: 'unused',
      status: MobileReplyStatus.DISPATCHING,
      messageId: null,
      wamid: null,
      createdAt: new Date(),
      dispatchStartedAt: new Date(),
      confirmedAt: null,
      ambiguousAt: null,
    };
    // Reproduce contentHash of the original request.
    state.contentHash = createHash('sha256')
      .update(JSON.stringify([conversationId, actor.id, dto.content]))
      .digest('hex');
    expect(
      await service.reply(conversationId, operationId, dto, actor),
    ).toMatchObject({ status: 'DISPATCHING', retryable: false });
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('DB failure after Meta confirmation leaves only an unknown outcome, never resends', async () => {
    failConfirmation = true;
    expect(
      await service.reply(conversationId, operationId, dto, actor),
    ).toMatchObject({ status: 'AMBIGUOUS' });
    await service.reply(conversationId, operationId, dto, actor);
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('default-off switch blocks before any Meta attempt', async () => {
    config.get.mockReturnValue(undefined);
    await expect(
      service.reply(conversationId, operationId, dto, actor),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });
});
