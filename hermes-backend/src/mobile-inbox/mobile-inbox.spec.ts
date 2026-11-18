/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest's expect.any matcher is typed as any. */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConversationStatus, MessageType } from '@prisma/client';
import { MobileInboxService } from './mobile-inbox.service';
import { MobileInboxGuard } from './mobile-inbox.guard';
import { MobileInboxController } from './mobile-inbox.controller';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

describe('mobile inbox read boundary', () => {
  const findMany = jest.fn();
  const findFirst = jest.fn();
  const messages = jest.fn();
  const tx = {
    conversation: { findMany, findFirst },
    message: { findMany: messages },
  };
  const prisma = {
    ...tx,
    mobileSession: { findFirst: jest.fn() },
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const service = new MobileInboxService(prisma as never);
  beforeEach(() => jest.clearAllMocks());

  it('rejects non-operator/inactive accounts and checks the session against the current DB user', async () => {
    const guard = new MobileInboxGuard(
      prisma as never,
      { get: () => 'operator@example.test' } as never,
    );
    const actor = { id: 'u', email: 'other@example.test', sessionId: 's' };
    expect(await guard.active(actor)).toBe(false);
    expect(prisma.mobileSession.findFirst).not.toHaveBeenCalled();
    prisma.mobileSession.findFirst.mockResolvedValue(null);
    expect(
      await guard.active({ ...actor, email: 'OPERATOR@example.test' }),
    ).toBe(false);
    expect(prisma.mobileSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u',
          id: 's',
          revokedAt: null,
          user: {
            is: {
              isActive: true,
              role: 'ADMIN',
              email: { equals: 'operator@example.test', mode: 'insensitive' },
            },
          },
        }),
        select: { id: true },
      }),
    );
  });

  it('scopes list and keyset in SQL, projects allowlist, ties latest message order and excludes raw payload', async () => {
    const at = new Date('2026-01-02T12:00:00Z');
    const id = '11111111-1111-4111-8111-111111111111';
    findMany.mockResolvedValue([
      {
        id,
        status: ConversationStatus.ACTIVE,
        updatedAt: at,
        contact: { id: 'c', name: 'a', phone: null },
        messages: [
          {
            id: 'm',
            conversationId: id,
            direction: 'INBOUND',
            sender: 'CONTACT',
            type: MessageType.IMAGE,
            content: 'private media caption',
            createdAt: at,
            rawPayload: 'secret',
          },
        ],
        metadata: 'secret',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        updatedAt: at,
        messages: [],
      },
    ]);
    const first = await service.list({
      limit: 1,
      status: ConversationStatus.ACTIVE,
    });
    expect(first.data[0]).toEqual({
      id,
      status: 'ACTIVE',
      updatedAt: at,
      contact: { id: 'c', name: 'a', phone: null },
      latestMessage: {
        id: 'm',
        conversationId: id,
        direction: 'INBOUND',
        sender: 'CONTACT',
        type: 'IMAGE',
        content: null,
        createdAt: at,
      },
    });
    expect(first.nextCursor).toBeTruthy();
    await service.list({
      limit: 1,
      cursor: first.nextCursor!,
      status: ConversationStatus.ACTIVE,
    });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          channel: 'whatsapp',
          status: 'ACTIVE',
          OR: expect.any(Array),
        }),
        select: expect.objectContaining({
          messages: expect.objectContaining({ take: 1 }),
        }),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );
    await expect(service.list({ limit: 1, cursor: 'bad' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('filters detail and all message reads by conversation resource, including later pagination', async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c' });
    await expect(service.detail('c')).rejects.toThrow(NotFoundException);
    await expect(service.messages('c', { limit: 1 })).rejects.toThrow(
      NotFoundException,
    );
    messages.mockResolvedValue([]);
    expect(await service.messages('c', { limit: 1 })).toEqual({
      data: [],
      nextCursor: null,
      reconciliation: 'restart',
    });
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { id: 'c', channel: 'whatsapp' },
      select: { id: true },
    });
    expect(messages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId: 'c',
          conversation: { is: { channel: 'whatsapp' } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );
  });

  it('SSE never emits private events or replay and completes after revocation', async () => {
    jest.useFakeTimers();
    const guard = { active: jest.fn().mockResolvedValue(false) };
    const controller = new MobileInboxController(
      service,
      guard as never,
      { decode: () => ({ exp: Math.floor(Date.now() / 1000) + 300 }) } as never,
    );
    const received: unknown[] = [];
    const done = jest.fn();
    const subscription = controller
      .events({ id: 'u', sessionId: 's', email: 'e' }, {
        headers: { authorization: 'Bearer fake', 'last-event-id': '999' },
      } as never)
      .subscribe({ next: (event) => received.push(event), complete: done });
    await jest.advanceTimersByTimeAsync(15000);
    expect(received).toEqual([
      { type: 'connected', data: { reconciliation: 'restart' }, retry: 3000 },
    ]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    subscription.unsubscribe();
    jest.useRealTimers();
  });

  it('SSE sends only generic heartbeat and reconciliation, clears timer on client disconnect', async () => {
    jest.useFakeTimers();
    const guard = { active: jest.fn().mockResolvedValue(true) };
    const controller = new MobileInboxController(
      service,
      guard as never,
      { decode: () => ({ exp: Math.floor(Date.now() / 1000) + 300 }) } as never,
    );
    const events: unknown[] = [];
    const subscription = controller
      .events({ id: 'u', sessionId: 's', email: 'e' }, {
        headers: { authorization: 'Bearer fake', 'last-event-id': 'stale' },
      } as never)
      .subscribe((event) => events.push(event));
    await jest.advanceTimersByTimeAsync(15000);
    expect(events).toEqual([
      { type: 'connected', data: { reconciliation: 'restart' }, retry: 3000 },
      { type: 'heartbeat', data: {} },
      { type: 'reconcile', data: { reconciliation: 'restart' } },
    ]);
    subscription.unsubscribe();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('exposes only GET methods under a dedicated mobile guard (no reply or legacy route)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MobileInboxController)).toBe(
      'api/mobile/inbox',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MobileInboxController),
    ).toContain(MobileInboxGuard);
    const methods = Object.getOwnPropertyNames(
      MobileInboxController.prototype,
    ).filter((method) => method !== 'constructor');
    expect(methods).toEqual(['list', 'events', 'messages', 'detail']);
    for (const method of methods) {
      const handler: unknown = Reflect.get(
        MobileInboxController.prototype,
        method,
      );
      expect(Reflect.getMetadata(METHOD_METADATA, handler as object)).toBe(
        RequestMethod.GET,
      );
    }
  });
});
