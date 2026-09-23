import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { MessageDirection, MessageSender, MessageType } from '@prisma/client';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { AutoReplyJobData } from '../src/auto-replies/auto-reply.constants';
import { InboundTurnService } from '../src/auto-replies/inbound-turn.service';
import { InboundTurnRecoveryService } from '../src/auto-replies/inbound-turn-recovery.service';
import { PrismaService } from '../src/prisma/prisma.service';

const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
const redisUrl = process.env.REDIS_INTEGRATION_URL;
if (!databaseUrl || !redisUrl)
  throw new Error(
    'DATABASE_INTEGRATION_URL and REDIS_INTEGRATION_URL are required',
  );

describe('inbound turn batching with PostgreSQL and BullMQ Redis', () => {
  let prisma: PrismaService;
  let turns: InboundTurnService;
  let queue: Queue<AutoReplyJobData>;
  let events: QueueEvents;
  let worker: Worker<AutoReplyJobData>;
  const contactIds: string[] = [];
  const processed: Array<{
    turnId: string;
    contents: string[];
    types: string[];
  }> = [];
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: Number(url.port) || 6379,
    maxRetriesPerRequest: null,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    turns = new InboundTurnService(prisma, {
      get: (key: string) =>
        key === 'HERMES_INBOUND_DEBOUNCE_MS'
          ? '120'
          : key === 'HERMES_INBOUND_MAX_WAIT_MS'
            ? '300'
            : undefined,
    } as ConfigService);
    const name = `inbound-turn-${randomUUID()}`;
    queue = new Queue<AutoReplyJobData>(name, { connection });
    events = new QueueEvents(name, { connection });
    worker = new Worker<AutoReplyJobData>(
      name,
      async (job) => {
        const turn = await turns.claim(job.data.inboundTurnId!);
        if (!turn) return;
        const messages = await turns.messages(turn.id);
        processed.push({
          turnId: turn.id,
          contents: messages.map((message) => message.content || ''),
          types: messages.map((message) => message.type),
        });
        await turns.complete(turn.id, turn.processingToken!);
      },
      { connection },
    );
    await Promise.all([
      queue.waitUntilReady(),
      events.waitUntilReady(),
      worker.waitUntilReady(),
    ]);
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.$disconnect();
  });

  async function conversation() {
    const contact = await prisma.contact.create({
      data: { waId: `turn-test-${randomUUID()}` },
    });
    contactIds.push(contact.id);
    const chat = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
    return { conversationId: chat.id, contactId: contact.id };
  }

  async function inbound(
    chat: { conversationId: string; contactId: string },
    content: string,
    wamid = `wamid.${randomUUID()}`,
    type: MessageType = MessageType.TEXT,
  ): Promise<{ turnId: string; job: Job<AutoReplyJobData>; dueAt: Date }> {
    const message = await prisma.message.create({
      data: {
        ...chat,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type,
        content,
        wamid,
      },
    });
    const turn = await turns.schedule({
      ...chat,
      inboundMessageId: message.id,
    });
    const job = await queue.add(
      'send-auto-reply',
      { ...chat, inboundMessageId: message.id, inboundTurnId: turn.id },
      {
        jobId: `auto-reply-${message.id}`,
        delay: Math.max(0, turn.dueAt.getTime() - Date.now() + 5),
      },
    );
    return { turnId: turn.id, job, dueAt: turn.dueAt };
  }

  it('processes M1, M2, M3 as one turn after silence', async () => {
    const chat = await conversation();
    const first = await inbound(chat, 'Quiero una página');
    await wait(30);
    const second = await inbound(chat, 'Es para una lavandería');
    await wait(30);
    const third = await inbound(chat, 'Quiero rastrear prendas');
    expect(first.turnId).toBe(second.turnId);
    expect(second.turnId).toBe(third.turnId);
    await Promise.all(
      [first.job, second.job, third.job].map((job) =>
        job.waitUntilFinished(events, 5000),
      ),
    );
    expect(processed.filter((turn) => turn.turnId === first.turnId)).toEqual([
      {
        turnId: first.turnId,
        contents: [
          'Quiero una página',
          'Es para una lavandería',
          'Quiero rastrear prendas',
        ],
        types: ['TEXT', 'TEXT', 'TEXT'],
      },
    ]);
  });

  it('caps the due time from the first inbound', async () => {
    const chat = await conversation();
    const slowerTurns = new InboundTurnService(prisma, {
      get: (key: string) =>
        key === 'HERMES_INBOUND_DEBOUNCE_MS'
          ? '500'
          : key === 'HERMES_INBOUND_MAX_WAIT_MS'
            ? '300'
            : undefined,
    } as ConfigService);
    const ids: string[] = [];
    let turnId = '';
    for (const content of ['M1', 'M2', 'M3']) {
      const message = await prisma.message.create({
        data: {
          ...chat,
          direction: MessageDirection.INBOUND,
          sender: MessageSender.CONTACT,
          type: MessageType.TEXT,
          content,
          wamid: `wamid.${randomUUID()}`,
        },
      });
      const turn = await slowerTurns.schedule({
        ...chat,
        inboundMessageId: message.id,
      });
      if (turnId) expect(turn.id).toBe(turnId);
      turnId = turn.id;
      ids.push(message.id);
      if (content !== 'M3') await wait(40);
    }
    const third = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: turnId },
    });
    expect(third.dueAt.getTime() - third.firstAt.getTime()).toBeLessThanOrEqual(
      300,
    );
    const job = await queue.add(
      'send-auto-reply',
      { ...chat, inboundMessageId: ids[2], inboundTurnId: turnId },
      { delay: Math.max(0, third.dueAt.getTime() - Date.now() + 5) },
    );
    await job.waitUntilFinished(events, 5000);
    expect(processed.filter((turn) => turn.turnId === turnId)).toHaveLength(1);
    const next = await inbound(chat, 'M4');
    expect(next.turnId).not.toBe(turnId);
    await next.job.waitUntilFinished(events, 5000);
  });

  it('processes one inbound after the normal silence window', async () => {
    const chat = await conversation();
    const only = await inbound(chat, 'Mensaje único');
    await only.job.waitUntilFinished(events, 5000);
    expect(processed.filter((turn) => turn.turnId === only.turnId)).toEqual([
      { turnId: only.turnId, contents: ['Mensaje único'], types: ['TEXT'] },
    ]);
  });

  it('keeps text, audio, text and image attachments in ordered turns', async () => {
    const chat = await conversation();
    const first = await inbound(chat, 'Texto inicial');
    const audio = await inbound(chat, '[Audio]', undefined, MessageType.AUDIO);
    const last = await inbound(chat, 'Corrección por texto');
    expect(new Set([first.turnId, audio.turnId, last.turnId]).size).toBe(1);
    await Promise.all(
      [first.job, audio.job, last.job].map((job) =>
        job.waitUntilFinished(events, 5000),
      ),
    );
    expect(processed.find((turn) => turn.turnId === first.turnId)).toEqual({
      turnId: first.turnId,
      contents: ['Texto inicial', '[Audio]', 'Corrección por texto'],
      types: ['TEXT', 'AUDIO', 'TEXT'],
    });

    const imageChat = await conversation();
    const caption = await inbound(imageChat, 'Quiero algo parecido a esto');
    const image = await inbound(
      imageChat,
      '[Imagen]',
      undefined,
      MessageType.IMAGE,
    );
    expect(caption.turnId).toBe(image.turnId);
    await Promise.all(
      [caption.job, image.job].map((job) =>
        job.waitUntilFinished(events, 5000),
      ),
    );
    expect(
      processed.find((turn) => turn.turnId === caption.turnId)?.types,
    ).toEqual(['TEXT', 'IMAGE']);
  });

  it('isolates simultaneous contacts and deduplicates the same inbound assignment', async () => {
    const firstChat = await conversation();
    const secondChat = await conversation();
    const [first, second] = await Promise.all([
      inbound(firstChat, 'Contacto A'),
      inbound(secondChat, 'Contacto B'),
    ]);
    expect(first.turnId).not.toBe(second.turnId);
    const source = await prisma.message.findFirstOrThrow({
      where: { conversationId: firstChat.conversationId },
      select: { id: true },
    });
    const same = await turns.schedule({
      ...firstChat,
      inboundMessageId: source.id,
    });
    expect(same.id).toBe(first.turnId);
    await Promise.all(
      [first.job, second.job].map((job) => job.waitUntilFinished(events, 5000)),
    );
    expect(
      processed.filter((turn) =>
        [first.turnId, second.turnId].includes(turn.turnId),
      ),
    ).toHaveLength(2);
  });

  it('recovers a stale processing claim without letting its old token complete', async () => {
    const chat = await conversation();
    const scheduled = await inbound(chat, 'Reintento tras caída del worker');
    await scheduled.job.waitUntilFinished(events, 5000);
    await prisma.inboundTurn.update({
      where: { id: scheduled.turnId },
      data: {
        status: 'PROCESSING',
        processingAt: new Date(Date.now() - 16 * 60 * 1000),
        processingToken: 'old-worker',
      },
    });
    const reclaimed = await turns.claim(scheduled.turnId);
    expect(reclaimed?.processingToken).toBeTruthy();
    expect(reclaimed?.processingToken).not.toBe('old-worker');
    await turns.complete(scheduled.turnId, 'old-worker');
    expect(
      (
        await prisma.inboundTurn.findUniqueOrThrow({
          where: { id: scheduled.turnId },
        })
      ).status,
    ).toBe('PROCESSING');
    await turns.complete(scheduled.turnId, reclaimed!.processingToken!);
    expect(
      (
        await prisma.inboundTurn.findUniqueOrThrow({
          where: { id: scheduled.turnId },
        })
      ).status,
    ).toBe('PROCESSED');
  });

  it('requeues a persisted turn when its original queue add was lost', async () => {
    const chat = await conversation();
    const message = await prisma.message.create({
      data: {
        ...chat,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'Mensaje guardado sin job',
        wamid: `wamid.${randomUUID()}`,
      },
    });
    const turn = await turns.schedule({
      ...chat,
      inboundMessageId: message.id,
    });
    await wait(150);
    const recovery = new InboundTurnRecoveryService(turns, queue);
    await recovery.scan();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (processed.some((entry) => entry.turnId === turn.id)) break;
      await wait(20);
    }
    expect(processed.filter((entry) => entry.turnId === turn.id)).toEqual([
      {
        turnId: turn.id,
        contents: ['Mensaje guardado sin job'],
        types: ['TEXT'],
      },
    ]);
  });
});
