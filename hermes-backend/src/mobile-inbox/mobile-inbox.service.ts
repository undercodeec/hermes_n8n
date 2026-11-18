import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MobileInboxQuery, MobileMessageQuery } from './mobile-inbox.dto';

type Cursor = { at: string; id: string };
type InboxCursor = { latestAt: Date | null; id: string };
const contactSelect = { id: true, name: true, phone: true } as const;
const messageSelect = {
  id: true,
  conversationId: true,
  direction: true,
  sender: true,
  type: true,
  content: true,
  createdAt: true,
} as const;
const conversationSelect = {
  id: true,
  status: true,
  updatedAt: true,
  contact: { select: contactSelect },
  messages: {
    select: messageSelect,
    take: 1,
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
  },
} satisfies Prisma.ConversationSelect;

function readCursor(raw?: string): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (!value || typeof value !== 'object') throw new Error('cursor');
    const cursor = value as Record<string, unknown>;
    if (
      typeof cursor.at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT/.test(cursor.at) ||
      !Number.isFinite(Date.parse(cursor.at)) ||
      typeof cursor.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(cursor.id)
    )
      throw new Error('cursor');
    return { at: cursor.at, id: cursor.id };
  } catch {
    throw new BadRequestException(
      'Cursor inválido; reinicie la reconciliación',
    );
  }
}

function nextCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString(
    'base64url',
  );
}

function readInboxCursor(
  raw: string | undefined,
  status: string | undefined,
): InboxCursor | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (!value || typeof value !== 'object') throw new Error('cursor');
    const cursor = value as Record<string, unknown>;
    if (
      cursor.v !== 2 ||
      cursor.status !== (status ?? null) ||
      typeof cursor.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(cursor.id) ||
      (cursor.latestAt !== null &&
        (typeof cursor.latestAt !== 'string' ||
          !/^\d{4}-\d\d-\d\dT/.test(cursor.latestAt) ||
          !Number.isFinite(Date.parse(cursor.latestAt))))
    )
      throw new Error('cursor');
    return {
      latestAt: cursor.latestAt === null ? null : new Date(cursor.latestAt),
      id: cursor.id,
    };
  } catch {
    throw new BadRequestException(
      'Cursor de Inbox inválido; reinicie la reconciliación',
    );
  }
}

function nextInboxCursor(
  latestAt: Date | null,
  id: string,
  status?: string,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      latestAt: latestAt?.toISOString() ?? null,
      id,
      status: status ?? null,
    }),
  ).toString('base64url');
}

function safeMessage(message: {
  id: string;
  conversationId: string;
  direction: string;
  sender: string;
  type: MessageType;
  content: string | null;
  createdAt: Date;
}) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    sender: message.sender,
    type: message.type,
    content: message.type === MessageType.TEXT ? message.content : null,
    createdAt: message.createdAt,
  };
}

@Injectable()
export class MobileInboxService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MobileInboxQuery) {
    const cursor = readInboxCursor(query.cursor, query.status);
    const statusFilter = query.status
      ? Prisma.sql`AND c.status = ${query.status}::"ConversationStatus"`
      : Prisma.empty;
    // DESC NULLS LAST, then deterministic C-collated ID ASC, including empty conversations.
    const after = !cursor
      ? Prisma.empty
      : cursor.latestAt === null
        ? Prisma.sql`AND latest."createdAt" IS NULL AND c.id COLLATE "C" > ${cursor.id}`
        : Prisma.sql`AND (
          latest."createdAt" < ${cursor.latestAt}
          OR (latest."createdAt" = ${cursor.latestAt} AND c.id COLLATE "C" > ${cursor.id})
          OR latest."createdAt" IS NULL
        )`;
    return this.prisma.$transaction(
      async (tx) => {
        // Only <= limit+1 IDs cross the wire. The existing
        // messages(conversationId, createdAt) index backs each LATERAL LIMIT 1.
        const ranked = await tx.$queryRaw<
          Array<{ id: string; latestAt: Date | null }>
        >(Prisma.sql`
          SELECT c.id, latest."createdAt" AS "latestAt"
          FROM conversations c
          LEFT JOIN LATERAL (
            SELECT m."createdAt" FROM messages m
            WHERE m."conversationId" = c.id
            ORDER BY m."createdAt" DESC LIMIT 1
          ) latest ON true
          WHERE c.channel = 'whatsapp' ${statusFilter} ${after}
          ORDER BY latest."createdAt" DESC NULLS LAST, c.id COLLATE "C" ASC
          LIMIT ${query.limit + 1}
        `);
        const page = ranked.slice(0, query.limit);
        const rows = page.length
          ? await tx.conversation.findMany({
              where: {
                id: { in: page.map((entry) => entry.id) },
                channel: 'whatsapp',
                ...(query.status ? { status: query.status } : {}),
              },
              select: conversationSelect,
            })
          : [];
        const byId = new Map(rows.map((row) => [row.id, row]));
        return {
          data: page
            .map((rank) => byId.get(rank.id)!)
            .map((row) => ({
              id: row.id,
              status: row.status,
              updatedAt: row.updatedAt,
              contact: row.contact,
              latestMessage: row.messages[0]
                ? safeMessage(row.messages[0])
                : null,
            })),
          nextCursor:
            ranked.length > query.limit && page.length
              ? nextInboxCursor(
                  page[page.length - 1].latestAt,
                  page[page.length - 1].id,
                  query.status,
                )
              : null,
          // A cursor is a traversal hint, not a snapshot: refresh page 1 after invalidation.
          reconciliation: 'restart',
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async detail(id: string) {
    const row = await this.prisma.conversation.findFirst({
      where: { id, channel: 'whatsapp' },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        contact: { select: contactSelect },
      },
    });
    if (!row) throw new NotFoundException('Conversación no encontrada');
    return row;
  }

  async messages(id: string, query: MobileMessageQuery) {
    const cursor = readCursor(query.cursor);
    return this.prisma.$transaction(
      async (tx) => {
        const exists = await tx.conversation.findFirst({
          where: { id, channel: 'whatsapp' },
          select: { id: true },
        });
        if (!exists) throw new NotFoundException('Conversación no encontrada');
        const rows = await tx.message.findMany({
          where: {
            conversationId: id,
            conversation: { is: { channel: 'whatsapp' } },
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: new Date(cursor.at) } },
                    { createdAt: new Date(cursor.at), id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          select: messageSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        return {
          data: page.map(safeMessage),
          nextCursor:
            rows.length > query.limit && page.length
              ? nextCursor(
                  page[page.length - 1].createdAt,
                  page[page.length - 1].id,
                )
              : null,
          reconciliation: 'restart',
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
