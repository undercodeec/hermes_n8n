import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { startProxy } from './proxy.mjs';

const openssl = process.env.PILOT_OPENSSL || (process.platform === 'win32'
  ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-egress-mock-'));
  try {
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1',
      '-subj', '/CN=api.openai.test', '-addext', 'subjectAltName=DNS:api.openai.test'],
    { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }

// A synthetic HTTP-like exchange, not the real hermes-agent or OpenAI contract.
function request(port, ca, servername = 'api.openai.test') {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, ca, rejectUnauthorized: true });
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.once('secureConnect', () => socket.write('POST /mock-openai HTTP/1.0\r\n\r\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
    socket.once('close', () => { if (!response) reject(new Error('connection closed')); });
  });
}

test('local TCP tunnel preserves verified TLS to synthetic upstream and fails closed', async (t) => {
  const { key, cert } = fixture();
  let requests = 0;
  const upstream = tls.createServer({ key, cert }, socket => {
    socket.once('data', data => {
      requests++;
      assert.equal(data.toString(), 'POST /mock-openai HTTP/1.0\r\n\r\n');
      socket.end('HTTP/1.0 200 OK\r\n\r\nmock');
    });
    socket.on('error', () => {});
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await startProxy({ upstreamPort: port });
  t.after(() => proxy.close());
  assert.match(await request(proxy.port, cert), /200 OK\r\n\r\nmock$/);
  await assert.rejects(request(proxy.port, cert, 'wrong.example'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  await assert.rejects(request(proxy.port, undefined), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  assert.equal(requests, 1, 'invalid TLS peers must not send application data');
  assert.throws(() => startProxy({ upstreamPort: port, listenPort: port }), /looping/);
  assert.throws(() => startProxy({ upstreamPort: 0 }), /invalid/);
});

test('unavailable upstream never falls back to another destination', async (t) => {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const proxy = await startProxy({ upstreamPort: port });
  t.after(() => proxy.close());
  await assert.rejects(request(proxy.port, undefined));
});

test('client half-close still receives the response after upstream sees EOF', async (t) => {
  const upstream = net.createServer({ allowHalfOpen: true }, socket => {
    let received = '';
    socket.on('data', chunk => { received += chunk; });
    socket.on('end', () => socket.end(`response:${received}`));
    socket.on('error', () => {});
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await startProxy({ upstreamPort: port });
  t.after(() => proxy.close());
  const result = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxy.port, allowHalfOpen: true });
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('connect', () => socket.end('request'));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
    socket.on('close', () => resolve(response));
  });
  assert.equal(result, 'response:request');
});

test('upstream half-close still receives data sent by client after EOF', async (t) => {
  let receive;
  const received = new Promise(resolve => { receive = resolve; });
  const upstream = net.createServer({ allowHalfOpen: true }, socket => {
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => receive(data));
    socket.on('error', () => receive('socket error'));
    socket.end('greeting');
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await startProxy({ upstreamPort: port });
  t.after(() => proxy.close());
  const greeting = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxy.port, allowHalfOpen: true });
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => socket.end('late request'));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
  assert.equal(greeting, 'greeting');
  assert.equal(await received, 'late request');
});
