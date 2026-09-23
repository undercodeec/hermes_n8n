import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  InboundTurn,
  InboundTurnStatus,
  MessageDirection,
  MessageSender,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InboundTurnService {
  private static readonly PROCESSING_LEASE_MS = 15 * 60 * 1000;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async schedule(input: {
    conversationId: string;
    contactId: string;
    inboundMessageId: string;
  }): Promise<InboundTurn> {
    const now = new Date();
    const debounceMs = this.milliseconds('HERMES_INBOUND_DEBOUNCE_MS', 4000);
    const maxWaitMs = this.milliseconds('HERMES_INBOUND_MAX_WAIT_MS', 12000);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))`;
      const inbound = await tx.message.findUniqueOrThrow({
        where: { id: input.inboundMessageId },
        select: {
          id: true,
          conversationId: true,
          contactId: true,
          inboundTurnId: true,
        },
      });
      if (
        inbound.conversationId !== input.conversationId ||
        inbound.contactId !== input.contactId
      )
        throw new Error('Inbound no pertenece a la conversación');
      if (inbound.inboundTurnId) {
        return tx.inboundTurn.findUniqueOrThrow({
          where: { id: inbound.inboundTurnId },
        });
      }
      const open = await tx.inboundTurn.findFirst({
        where: {
          conversationId: input.conversationId,
          status: InboundTurnStatus.OPEN,
          dueAt: { gt: now },
        },
        orderBy: { firstAt: 'desc' },
      });
      const dueAt = new Date(
        Math.min(
          now.getTime() + debounceMs,
          (open?.firstAt.getTime() ?? now.getTime()) + maxWaitMs,
        ),
      );
      const turn = open
        ? await tx.inboundTurn.update({
            where: { id: open.id },
            data: { lastAt: now, dueAt, lastMessageId: inbound.id },
          })
        : await tx.inboundTurn.create({
            data: {
              conversationId: input.conversationId,
              contactId: input.contactId,
              firstAt: now,
              lastAt: now,
              dueAt: new Date(now.getTime() + Math.min(debounceMs, maxWaitMs)),
              lastMessageId: inbound.id,
            },
          });
      await tx.message.update({
        where: { id: inbound.id },
        data: {
          inboundTurnId: turn.id,
          inboundTurnPosition: await tx.message.count({
            where: { inboundTurnId: turn.id },
          }),
        },
      });
      return turn;
    });
  }

  async claim(turnId: string): Promise<InboundTurn | null> {
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - InboundTurnService.PROCESSING_LEASE_MS,
    );
    const token = randomUUID();
    const claimed = await this.prisma.inboundTurn.updateMany({
      where: {
        id: turnId,
        dueAt: { lte: now },
        OR: [
          { status: InboundTurnStatus.OPEN },
          {
            status: InboundTurnStatus.PROCESSING,
            processingAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        status: InboundTurnStatus.PROCESSING,
        processingAt: now,
        processingToken: token,
      },
    });
    return claimed.count === 1
      ? this.prisma.inboundTurn.findUnique({ where: { id: turnId } })
      : null;
  }

  async findPending(turnId: string): Promise<InboundTurn | null> {
    return this.prisma.inboundTurn.findFirst({
      where: {
        id: turnId,
        status: { in: [InboundTurnStatus.OPEN, InboundTurnStatus.PROCESSING] },
      },
    });
  }

  async recoverable(now = new Date()): Promise<InboundTurn[]> {
    const staleBefore = new Date(
      now.getTime() - InboundTurnService.PROCESSING_LEASE_MS,
    );
    return this.prisma.inboundTurn.findMany({
      where: {
        OR: [
          { status: InboundTurnStatus.OPEN, dueAt: { lte: now } },
          {
            status: InboundTurnStatus.PROCESSING,
            processingAt: { lt: staleBefore },
          },
        ],
      },
      orderBy: { dueAt: 'asc' },
      take: 100,
    });
  }

  nextClaimAt(turn: InboundTurn): number {
    return turn.status === InboundTurnStatus.PROCESSING && turn.processingAt
      ? turn.processingAt.getTime() + InboundTurnService.PROCESSING_LEASE_MS
      : turn.dueAt.getTime();
  }

  async messages(turnId: string) {
    return this.prisma.message.findMany({
      where: {
        inboundTurnId: turnId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
      },
      orderBy: [{ inboundTurnPosition: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        wamid: true,
        type: true,
        content: true,
        createdAt: true,
        rawPayload: true,
      },
    });
  }

  async complete(turnId: string, token: string): Promise<void> {
    await this.prisma.inboundTurn.updateMany({
      where: {
        id: turnId,
        status: InboundTurnStatus.PROCESSING,
        processingToken: token,
      },
      data: {
        status: InboundTurnStatus.PROCESSED,
        processingAt: null,
        processingToken: null,
      },
    });
  }

  async release(turnId: string, token: string): Promise<void> {
    await this.prisma.inboundTurn.updateMany({
      where: {
        id: turnId,
        status: InboundTurnStatus.PROCESSING,
        processingToken: token,
      },
      data: {
        status: InboundTurnStatus.OPEN,
        processingAt: null,
        processingToken: null,
      },
    });
  }

  private milliseconds(key: string, fallback: number): number {
    const configured = Number(this.config.get(key));
    return Number.isSafeInteger(configured) && configured > 0
      ? configured
      : fallback;
  }
}
