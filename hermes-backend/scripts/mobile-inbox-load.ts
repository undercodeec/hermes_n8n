// Explicitly opt-in, freshly migrated disposable localhost PostgreSQL ONLY.
// No production data, external I/O, Meta calls or destructive shared-DB cleanup.
import { performance } from 'node:perf_hooks';
import { ConversationStatus, PrismaClient } from '@prisma/client';
import { MobileInboxService } from '../src/mobile-inbox/mobile-inbox.service';
import { PrismaService } from '../src/prisma/prisma.service';

const value = process.env.HERMES_G4_LOAD_TEST_DATABASE_URL;
function verifyDestination(): string {
  if (!value) throw new Error('Explicit disposable load-test URL required');
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !/^\d+$/.test(url.port) ||
    url.username !== 'hermes_g4_load_test' ||
    !url.password ||
    !/^\/hermes_g4_load_test_[a-f0-9]{32}$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('Refusing non-disposable or non-loopback database');
  return value;
}

function percentile(sorted: number[], fraction: number): number {
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2));
}

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: verifyDestination() } },
  });
  try {
    if (
      (await prisma.contact.count()) ||
      (await prisma.conversation.count()) ||
      (await prisma.message.count()) ||
      (await prisma.user.count())
    ) {
      throw new Error('Refusing to seed a database that is not empty');
    }
    // 10k conversations, 200k messages, 100 empty; timestamps deliberately tie.
    // Only synthetic text, contacts and deterministic UUIDs. No PII.
    await prisma.$executeRaw`
      INSERT INTO contacts (id, "waId", "createdAt", "updatedAt")
      SELECT md5('g4-contact-' || i)::uuid, 'synthetic-' || i, now(), now()
      FROM generate_series(1, 10000) AS i
    `;
    await prisma.$executeRaw`
      INSERT INTO conversations (id, "contactId", status, channel, "createdAt", "updatedAt")
      SELECT md5('g4-conversation-' || i)::uuid, md5('g4-contact-' || i)::uuid,
        CASE WHEN i % 10 = 0 THEN 'CLOSED'::"ConversationStatus" ELSE 'ACTIVE'::"ConversationStatus" END,
        'whatsapp', now(), now()
      FROM generate_series(1, 10000) AS i
    `;
    await prisma.$executeRaw`
      INSERT INTO messages (id, "conversationId", "contactId", direction, sender, type, content, "createdAt")
      SELECT md5('g4-message-' || i)::uuid,
        md5('g4-conversation-' || ((i-1) % 9900 + 1))::uuid,
        md5('g4-contact-' || ((i-1) % 9900 + 1))::uuid,
        'INBOUND'::"MessageDirection", 'CONTACT'::"MessageSender", 'TEXT'::"MessageType",
        'synthetic', now() - (floor((200001-i)/2)::text || ' seconds')::interval
      FROM generate_series(1, 200000) AS i
    `;
    await prisma.$executeRaw`ANALYZE contacts`;
    await prisma.$executeRaw`ANALYZE conversations`;
    await prisma.$executeRaw`ANALYZE messages`;

    const inbox = new MobileInboxService(prisma as unknown as PrismaService);
    const walk = async (status?: ConversationStatus) => {
      const seen = new Set<string>();
      let cursor: string | undefined;
      let empty = 0;
      let pages = 0;
      do {
        const result = await inbox.list({ limit: 50, status, cursor });
        for (const item of result.data) {
          if (seen.has(item.id))
            throw new Error('Duplicate conversation on a static cursor walk');
          seen.add(item.id);
          if (!item.latestMessage) empty++;
        }
        cursor = result.nextCursor ?? undefined;
        if (++pages > 210) throw new Error('Unbounded cursor traversal');
      } while (cursor);
      const expected = status === ConversationStatus.CLOSED ? 1000 : 10000;
      if (seen.size !== expected || empty !== (status ? 10 : 100)) {
        throw new Error(
          `Unexpected cursor totals: ${seen.size} conversations, ${empty} empty`,
        );
      }
      return pages;
    };
    const pages = await walk();
    const filteredPages = await walk(ConversationStatus.CLOSED);

    const first = await inbox.list({ limit: 50 });
    const targetId = await prisma.conversation.findFirstOrThrow({
      where: { contact: { waId: 'synthetic-10000' } },
      select: { id: true, contactId: true },
    });
    await prisma.message.create({
      data: {
        conversationId: targetId.id,
        contactId: targetId.contactId,
        direction: 'INBOUND',
        sender: 'CONTACT',
        type: 'TEXT',
        content: 'synthetic',
        createdAt: new Date(Date.now() + 2000),
      },
    });
    const refreshed = await inbox.list({ limit: 50 });
    if (
      refreshed.data[0]?.id !== targetId.id ||
      first.data[0]?.id === targetId.id
    ) {
      throw new Error(
        'Page-one reconciliation did not reflect the new message',
      );
    }

    const results: Record<string, object> = {};
    for (const parallel of [1, 10, 25]) {
      const durations: number[] = [];
      let errors = 0;
      for (let round = 0; round < 5; round++) {
        await Promise.all(
          Array.from({ length: parallel }, async () => {
            const start = performance.now();
            try {
              await inbox.list({ limit: 50 });
            } catch {
              errors++;
            }
            durations.push(performance.now() - start);
          }),
        );
      }
      durations.sort((a, b) => a - b);
      results[parallel] = {
        samples: durations.length,
        errors,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
      };
      if (errors)
        throw new Error(
          `Inbox query errors under ${parallel} concurrent readers`,
        );
    }
    console.log(
      JSON.stringify({
        fixture: 'synthetic-10k-conversations-200k-messages',
        pages,
        filteredPages,
        staticCursorWalk: 'passed',
        mutationReconciliation: 'passed',
        readers: results,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Avoid printing a Prisma error that could embed a disposable connection string.
  console.error(
    'Isolated load test failed:',
    error instanceof Error ? error.name : 'unknown error',
  );
  process.exitCode = 1;
});
