import { randomUUID } from 'node:crypto';
import {
  ConversationStatus,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
} from '@prisma/client';
import { MobileInboxService } from '../src/mobile-inbox/mobile-inbox.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Opt-in only. Provision a FRESH local disposable DB named hermes_g4_inbox_test_<32 hex>,
// migrate it explicitly with `prisma migrate deploy`, then set
// HERMES_G4_INBOX_TEST_DATABASE_URL for this Jest test. Never use a shared DB.
const databaseUrl = process.env.HERMES_G4_INBOX_TEST_DATABASE_URL;
function disposableLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'postgresql:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      /^\d+$/.test(url.port) &&
      url.username === 'hermes_g4_inbox_test' &&
      Boolean(url.password) &&
      /^\/hermes_g4_inbox_test_[a-f0-9]{32}$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
const run = databaseUrl ? describe : describe.skip;

run('MobileInboxService on isolated migrated PostgreSQL', () => {
  let prisma: PrismaClient;
  let service: MobileInboxService;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const conversations = [1, 2, 3, 4, 5, 6, 7].map(id);
  const contacts = [101, 102, 103, 104, 105, 106, 107].map(id);
  const messages = [201, 202, 203, 204, 205, 206, 207].map(id);
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 12, minute));
  const marker = `SYNTHETIC_PRIVATE_${randomUUID()}`;

  beforeAll(async () => {
    // Guard BEFORE construction/connect: a configured unsafe URL must fail, never skip.
    if (!databaseUrl || !disposableLocalUrl(databaseUrl))
      throw new Error('Only a fresh loopback hermes_g4_inbox_test_<32 hex> DB is allowed');
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    // Also proves explicit migrations ran (missing tables fail). Never delete pre-existing data.
    expect(await prisma.contact.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
    service = new MobileInboxService(prisma as PrismaService);
    for (let n = 0; n < conversations.length; n++) {
      await prisma.contact.create({
        data: {
          id: contacts[n],
          waId: `g4-inbox-${randomUUID()}`,
          name: `Local contact ${n + 1}`,
          phone: `local-${n + 1}`,
          email: marker,
          metadata: { private: marker },
        },
      });
      await prisma.conversation.create({
        data: {
          id: conversations[n],
          contactId: contacts[n],
          channel: n === 6 ? 'local-non-whatsapp' : 'whatsapp',
          status: n === 2 || n === 4 ? ConversationStatus.CLOSED : ConversationStatus.ACTIVE,
          updatedAt: at(59 - n), // deliberately inverse to message ordering
          metadata: { private: marker },
        },
      });
    }
    const fixture = [
      [0, 0, MessageType.TEXT, 'older'],
      [0, 10, MessageType.TEXT, 'first'],
      [1, 20, MessageType.TEXT, 'tie-low'],
      [2, 20, MessageType.TEXT, 'tie-high'],
      [3, 30, MessageType.IMAGE, marker],
      [3, 30, MessageType.TEXT, 'same-time-high-id'],
      [6, 40, MessageType.TEXT, 'not-whatsapp'],
    ] as const;
    for (let n = 0; n < fixture.length; n++) {
      const [index, minute, type, content] = fixture[n];
      await prisma.message.create({
        data: {
          id: messages[n],
          conversationId: conversations[index],
          contactId: contacts[index],
          direction: MessageDirection.INBOUND,
          sender: MessageSender.CONTACT,
          type,
          content,
          createdAt: at(minute),
          rawPayload: { private: marker },
          metadata: { private: marker },
        },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.message.deleteMany({ where: { id: { in: messages } } });
      await prisma.conversation.deleteMany({ where: { id: { in: conversations } } });
      await prisma.contact.deleteMany({ where: { id: { in: contacts } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('ranks real LATERAL SQL by latest message DESC, ID ASC on ties, NULLS LAST; pages without loss', async () => {
    const expected = [conversations[3], conversations[1], conversations[2], conversations[0], conversations[4], conversations[5]];
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await service.list({ limit: 2, cursor });
      expect(result.reconciliation).toBe('restart');
      expect(result.data.map((row) => row.id)).toEqual(expected.slice(page * 2, page * 2 + 2));
      seen.push(...result.data.map((row) => row.id));
      if (page < 2) {
        expect(result.nextCursor).toEqual(expect.any(String));
        cursor = result.nextCursor!;
      } else expect(result.nextCursor).toBeNull();
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(6);
    expect((await service.list({ limit: 2, cursor: cursor! })).data.map((row) => row.id)).toEqual(expected.slice(4));
    const emptyCursor = (await service.list({ limit: 5 })).nextCursor;
    expect(emptyCursor).toEqual(expect.any(String));
    expect(JSON.parse(Buffer.from(emptyCursor!, 'base64url').toString('utf8'))).toMatchObject({ v: 2, latestAt: null, id: conversations[4], status: null });
    expect(await service.list({ limit: 2, cursor: emptyCursor! })).toMatchObject({ data: [{ id: conversations[5], latestMessage: null }], nextCursor: null });
  });

  it('filters status before paging and binds status into cursor', async () => {
    const first = await service.list({ limit: 1, status: ConversationStatus.CLOSED });
    expect(first.data.map((row) => row.id)).toEqual([conversations[2]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(await service.list({ limit: 1, status: ConversationStatus.CLOSED, cursor: first.nextCursor! })).toMatchObject({
      data: [{ id: conversations[4], latestMessage: null }], nextCursor: null,
    });
    await expect(service.list({ limit: 1, cursor: first.nextCursor! })).rejects.toThrow();
    await expect(service.list({ limit: 1, status: ConversationStatus.ACTIVE, cursor: first.nextCursor! })).rejects.toThrow();
  });

  it('returns only allowlisted nested fields; non-text content stays null', async () => {
    const page = await service.list({ limit: 6 });
    const keys = (value: object) => Object.keys(value).sort();
    for (const row of page.data) {
      expect(keys(row)).toEqual(['contact', 'id', 'latestMessage', 'status', 'updatedAt']);
      expect(keys(row.contact)).toEqual(['id', 'name', 'phone']);
      if (row.latestMessage)
        expect(keys(row.latestMessage)).toEqual(['content', 'conversationId', 'createdAt', 'direction', 'id', 'sender', 'type']);
    }
    expect(page.data[0].latestMessage).toMatchObject({ id: messages[5], content: 'same-time-high-id' });
    const detail = await service.detail(conversations[3]);
    expect(keys(detail)).toEqual(['contact', 'id', 'status', 'updatedAt']);
    expect(keys(detail.contact)).toEqual(['id', 'name', 'phone']);
    const image = await prisma.message.findUniqueOrThrow({ where: { id: messages[4] } });
    expect(image.content).toBe(marker);
    const result = await service.messages(conversations[3], { limit: 1, cursor: Buffer.from(JSON.stringify({ at: at(30).toISOString(), id: messages[5] })).toString('base64url') });
    expect(result.data).toMatchObject([{ id: messages[4], content: null }]);
    expect(JSON.stringify([page, detail, result])).not.toContain(marker);
    expect(JSON.stringify([page, detail, result])).not.toMatch(/"(?:rawPayload|metadata|email|waId|tokensUsed|costEstimate)":/);
  });

  it('messages paginate DESC by time then ID, with terminal null cursor; detail/messages reject other channels', async () => {
    const first = await service.messages(conversations[3], { limit: 1 });
    expect(first.data.map((row) => row.id)).toEqual([messages[5]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.messages(conversations[3], { limit: 1, cursor: first.nextCursor! });
    expect(second.data).toMatchObject([{ id: messages[4], content: null }]);
    expect(second.nextCursor).toBeNull();
    expect(await service.messages(conversations[5], { limit: 1 })).toMatchObject({ data: [], nextCursor: null });
    await expect(service.detail(conversations[6])).rejects.toThrow();
    await expect(service.messages(conversations[6], { limit: 1 })).rejects.toThrow();
  });
});
