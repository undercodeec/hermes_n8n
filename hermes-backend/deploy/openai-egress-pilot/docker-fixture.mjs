// Disposable topology fixture, not the real agent or a production proxy.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const mode = process.argv[2];
if (mode === 'mock') {
  tls.createServer({ key: readFileSync('/certs/key.pem'), cert: readFileSync('/certs/cert.pem') }, socket => {
    socket.on('error', () => {});
    socket.once('data', () => socket.end('synthetic mock response'));
  }).listen(8443, '0.0.0.0');
} else if (mode === 'relay') {
  const stats = { accepted: 0, attempts: 0, connected: 0, failed: 0, lastError: null };
  net.createServer(client => {
    stats.accepted++;
    stats.attempts++;
    const upstream = net.connect(8443, 'mock');
    const abort = () => { client.destroy(); upstream.destroy(); };
    upstream.on('connect', () => { stats.connected++; });
    client.on('error', abort);
    upstream.on('error', error => { stats.failed++; stats.lastError = error.code; abort(); });
    client.pipe(upstream).pipe(client);
  }).listen(8443, '0.0.0.0');
  // Test-only telemetry also stays available when the mock is stopped.
  net.createServer(async client => {
    client.on('error', () => {});
    let ip = null;
    try { ip = (await dns.lookup('mock', { family: 4 })).address; } catch {}
    client.end(JSON.stringify({ ...stats, ip }));
  }).listen(8080, '0.0.0.0');
} else if (mode === 'test' || mode === 'closed') {
  const cert = readFileSync('/certs/cert.pem');
  assert.equal(existsSync('/certs/key.pem'), false, 'client must not receive mock private key');
  const connect = (host, port, options = {}) => new Promise((resolve, reject) => {
    const socket = options.tls ? tls.connect({ host, port, servername: options.servername || 'api.openai.test', ca: options.ca, rejectUnauthorized: true }) : net.connect(port, host);
    let data = '';
    socket.setTimeout(2500, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    if (options.tls) socket.on('secureConnect', () => socket.write('synthetic request'));
    else if (options.direct) socket.on('connect', () => { socket.destroy(); resolve('connected'); });
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => data ? resolve(data) : reject(new Error('empty response')));
    socket.on('close', () => { if (!data) reject(new Error('closed')); });
  });
  if (mode === 'test') {
    let result;
    for (let i = 0; i < 30; i++) {
      try { result = await connect('relay', 8443, { tls: true, ca: cert }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    assert.equal(result, 'synthetic mock response');
    await assert.rejects(connect('relay', 8443, { tls: true, ca: cert, servername: 'wrong.example' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    await assert.rejects(connect('relay', 8443, { tls: true }), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const { ip } = JSON.parse(await connect('relay', 8080));
    assert.ok(net.isIPv4(ip));
    await assert.rejects(connect(ip, 8443, { direct: true }), /timeout|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/);
    console.log('PASS: mock TLS, hostname, CA and direct mock IP isolation');
  } else {
    const before = JSON.parse(await connect('relay', 8080));
    assert.ok(before.connected >= 1, 'relay previously reached the mock');
    await assert.rejects(connect('relay', 8443, { tls: true, ca: cert }), error =>
      error.code === 'ECONNRESET' || error.message === 'closed' || error.message === 'empty response');
    const after = JSON.parse(await connect('relay', 8080));
    assert.equal(after.accepted, before.accepted + 1, 'live relay accepted the request');
    assert.equal(after.attempts, before.attempts + 1, 'exactly one upstream attempt');
    assert.equal(after.connected, before.connected, 'no successful upstream connection');
    assert.equal(after.failed, before.failed + 1, 'upstream failure recorded');
    assert.ok(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(after.lastError), `unexpected upstream error: ${after.lastError}`);
    console.log(`PASS: relay alive, upstream failed (${after.lastError}), one attempt, no fallback in fixture`);
  }
} else throw new Error('unknown mode');
