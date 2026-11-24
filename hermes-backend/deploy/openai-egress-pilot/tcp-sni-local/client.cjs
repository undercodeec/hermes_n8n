const tls = require('node:tls');
const net = require('node:net');
const dns = require('node:dns').promises;
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const mode = process.argv[2];
assert.ok(['allow', 'wrong', 'absent', 'down', 'proxy-absent-regression'].includes(mode), 'unknown test');

async function connectProxy() {
  let address;
  try { ({ address } = await dns.lookup('proxy', { family: 4 })); }
  catch (error) { throw new Error(`PROXY_UNAVAILABLE: DNS ${error.code}`); }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port: 8443 });
    socket.setTimeout(3000);
    const fail = reason => { socket.destroy(); reject(new Error(`PROXY_UNAVAILABLE: TCP ${reason}`)); };
    socket.once('timeout', () => fail('timeout'));
    socket.once('error', error => fail(error.code));
    socket.once('connect', () => {
      socket.removeAllListeners('timeout');
      socket.removeAllListeners('error');
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

async function availabilityProbe() {
  const socket = await connectProxy();
  socket.on('error', () => {});
  socket.destroy();
}

async function attempt() {
  const raw = await connectProxy(); // A real TCP connect precedes every TLS result.
  const options = { socket: raw, rejectUnauthorized: false };
  if (mode !== 'absent') options.servername = mode === 'wrong' ? 'other.synthetic.test' : 'api.synthetic.test';
  return new Promise(resolve => {
    let secure = false, data = '', finished = false;
    const socket = tls.connect(options);
    const finish = reason => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ secure, data, reason });
    };
    socket.setTimeout(7000, () => finish('timeout'));
    socket.on('secureConnect', () => { secure = true; });
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => finish('end'));
    socket.on('error', error => finish(error.code || error.message));
    socket.on('close', () => finish('close'));
  });
}

(async () => {
  if (mode === 'proxy-absent-regression') {
    for (const test of ['wrong', 'absent', 'down']) {
      const child = spawnSync(process.execPath, [__filename, test], { encoding: 'utf8', timeout: 15000 });
      assert.notEqual(child.status, 0, `${test} incorrectly passed without proxy`);
      assert.match(child.stderr, /PROXY_UNAVAILABLE: (DNS|TCP)/, `${test}: unexpected failure ${child.stderr}`);
      console.log(`proxy absent / ${test}: correctly failed (${child.stderr.match(/PROXY_UNAVAILABLE: (DNS|TCP) \S+/)?.[0]})`);
    }
    return;
  }
  let result;
  if (mode === 'allow') {
    for (let i = 0; i < 20; i++) {
      try { result = await attempt(); } catch (error) { if (i === 19) throw error; }
      if (result?.secure && result.data === 'synthetic-upstream-ok\n') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(result.secure, true, JSON.stringify(result));
    assert.equal(result.data, 'synthetic-upstream-ok\n', JSON.stringify(result));
  } else {
    await availabilityProbe();
    result = await attempt();
    await availabilityProbe();
    assert.equal(result.secure, false, JSON.stringify(result));
    assert.equal(result.data, '', JSON.stringify(result));
    assert.ok(['end', 'close', 'ECONNRESET'].includes(result.reason), JSON.stringify(result));
  }
  console.log(`${mode}: PASS (proxy resolved, TCP connected; TLS ${result.reason})`);
})().catch(error => { console.error(error); process.exitCode = 1; });
