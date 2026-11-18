import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chronologicalMessages, MobileInboxClient, type AuthorizedGet } from '../src/mobileInboxClient';

const contact = { id: 'contact-1', name: 'Cliente real', phone: '0990000000', email: 'must-not-leak' };
const row = (id: string) => ({ id, status: 'OPEN', updatedAt: '2026-11-17T12:00:00.000Z', contact, latestMessage: msg(`${id}-msg`, id), unread: 30 });
const msg = (id: string, conversationId: string, type = 'TEXT') => ({ id, conversationId, direction: 'INBOUND', sender: 'CUSTOMER', type, content: 'Texto de prueba', createdAt: '2026-11-17T12:00:00.000Z', rawPayload: 'secret' });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const page = (data: unknown[], nextCursor: string | null) => ({ data, nextCursor, reconciliation: 'restart' });

test('list and messages follow opaque cursors, dedupe rows, and drop forbidden payloads', async () => {
  const paths: string[] = [];
  const get: AuthorizedGet = async (path) => {
    paths.push(path);
    if (path.includes('/messages')) return reply(path.includes('cursor=old%2Bmsg') ? page([msg('m1', 'a'), msg('m2', 'a', 'IMAGE')], null) : page([msg('m1', 'a')], 'old+msg'));
    if (path.endsWith('/a')) return reply(row('a'));
    return reply(path.includes('cursor=opaque%2Bcursor') ? page([row('a'), row('b')], null) : page([row('a')], 'opaque+cursor'));
  };
  const client = new MobileInboxClient(get);
  await client.refresh();
  assert.equal(client.snapshot.locked, false);
  assert.equal(JSON.stringify(client.snapshot).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(client.snapshot).includes('rawPayload'), false);
  assert.equal(JSON.stringify(client.snapshot).includes('unread'), false);
  await client.moreConversations();
  assert.deepEqual(client.snapshot.conversations.map((item) => item.id), ['a', 'b']);
  await client.open('a');
  await client.moreMessages();
  assert.deepEqual(client.snapshot.messages.map((item) => item.id), ['m1', 'm2']);
  assert.equal(client.snapshot.messages[1].content, null);
  assert.ok(paths.includes('/api/mobile/inbox?limit=20&cursor=opaque%2Bcursor'));
  assert.ok(paths.includes('/api/mobile/inbox/a/messages?limit=50&cursor=old%2Bmsg'));
  assert.ok(paths.every((path) => path.startsWith('/api/mobile/inbox') && !/reply|send|events/.test(path)));
});

test('chronological display reverses newest-first pages without changing cursor traversal or tie order', async () => {
  const at = (id: string, createdAt: string, direction: string) => ({ ...msg(id, 'a'), createdAt, direction });
  const newest = at('d', '2026-11-17T12:02:00.000Z', 'OUTBOUND');
  const question = at('c', '2026-11-17T12:01:00.000Z', 'INBOUND');
  const tied = at('b', '2026-11-17T12:01:00.000Z', 'OUTBOUND');
  const oldest = at('a', '2026-11-17T12:00:00.000Z', 'INBOUND');
  const client = new MobileInboxClient(async (path) => {
    if (path.endsWith('/a')) return reply(row('a'));
    if (path.includes('/messages')) return reply(path.includes('cursor=') ? page([tied, oldest], null) : page([newest, question], 'older'));
    return reply(page([row('a')], null));
  });
  await client.refresh();
  await client.open('a');
  assert.deepEqual(chronologicalMessages(client.snapshot.messages).map((m) => m.id), ['c', 'd']);
  await client.moreMessages();
  const before = client.snapshot.messages.map((m) => m.id);
  assert.deepEqual(before, ['d', 'c', 'b', 'a']);
  assert.deepEqual(chronologicalMessages(client.snapshot.messages).map((m) => m.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(client.snapshot.messages.map((m) => m.id), before);
  assert.equal(client.snapshot.messagesCursor, null);
});

test('foreground/manual reconciliation discards old cursors and stale detail; restart after invalid cursor', async () => {
  const paths: string[] = [];
  let invalid = false;
  const client = new MobileInboxClient(async (path) => {
    paths.push(path);
    if (path.endsWith('/a')) return reply(row('a'));
    if (path.includes('/messages')) return reply(page([msg('m1', 'a')], 'older'));
    if (path.includes('cursor=')) return invalid ? reply({ error: 'invalid' }, 400) : reply(page([row('b')], null));
    return reply(page([row('a')], 'next'));
  });
  await client.refresh();
  await client.open('a');
  await client.refresh();
  assert.equal(client.snapshot.selected, null);
  assert.deepEqual(client.snapshot.messages, []);
  assert.deepEqual(paths.filter((path) => path === '/api/mobile/inbox?limit=20').length, 2);
  invalid = true;
  await client.moreConversations();
  assert.equal(client.snapshot.locked, false);
  assert.deepEqual(client.snapshot.conversations.map((item) => item.id), ['a']);
  assert.equal(paths.filter((path) => path === '/api/mobile/inbox?limit=20').length, 3);
});

test('network error and revocation hide sensitive data; late replies cannot repopulate after lock', async () => {
  let revoked = false;
  let lost = 0;
  const client = new MobileInboxClient(async (path) => {
    if (revoked) return reply({ debug: 'private' }, 403);
    return reply(path.endsWith('/a') ? row('a') : page([row('a')], 'next'));
  }, () => { lost++; });
  await client.refresh();
  revoked = true;
  await client.moreConversations();
  assert.equal(client.snapshot.locked, true);
  assert.deepEqual(client.snapshot.conversations, []);
  assert.equal(JSON.stringify(client.snapshot).includes('private'), false);
  assert.equal(lost, 1);

  let release!: (response: Response) => void;
  const pending = new MobileInboxClient(async () => new Promise<Response>((resolve) => { release = resolve; }));
  const request = pending.refresh();
  pending.lock();
  release(reply(page([row('a')], null)));
  await request;
  assert.equal(pending.snapshot.locked, true);
  assert.deepEqual(pending.snapshot.conversations, []);
});

test('offline detail and malformed reconciliation fail closed without exposing cached chats', async () => {
  let offline = false;
  const client = new MobileInboxClient(async (path) => {
    if (offline) throw new Error('private network diagnostic');
    return reply(path.endsWith('/a') ? row('a') : page([row('a')], null));
  });
  await client.refresh();
  offline = true;
  await client.open('a');
  assert.equal(client.snapshot.locked, true);
  assert.deepEqual(client.snapshot.conversations, []);
  assert.equal(JSON.stringify(client.snapshot).includes('diagnostic'), false);
  const malformed = new MobileInboxClient(async () => reply({ data: [row('a')], nextCursor: null, reconciliation: 'append' }));
  await malformed.refresh();
  assert.equal(malformed.snapshot.locked, true);
});

test('invalid message cursor restarts list reconciliation, discarding old selected history', async () => {
  const paths: string[] = [];
  const client = new MobileInboxClient(async (path) => {
    paths.push(path);
    if (path.includes('/messages?limit=50&cursor=')) return reply({ error: 'invalid' }, 400);
    if (path.includes('/messages')) return reply(page([msg('m1', 'a')], 'stale'));
    if (path.endsWith('/a')) return reply(row('a'));
    return reply(page([row('a')], null));
  });
  await client.refresh();
  await client.open('a');
  await client.moreMessages();
  assert.equal(client.snapshot.locked, false);
  assert.equal(client.snapshot.selected, null);
  assert.deepEqual(client.snapshot.messages, []);
  assert.equal(paths.filter((path) => path === '/api/mobile/inbox?limit=20').length, 2);
});
