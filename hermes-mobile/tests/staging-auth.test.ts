import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalClearFailed, NetworkUnavailable, RefreshUncertain, SessionExpired, stagingConfig, StagingAuth, type Storage, type Transport } from '../src/stagingAuth';

function fakeStorage() {
  const values = new Map<string, string>();
  const store: Storage = {
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
  };
  return { store, values };
}
const config = stagingConfig('https://otp.example.invalid', 'https://hermes.example.invalid')!;
function result(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }

test('staging mode requires explicit endpoints and HTTPS outside loopback', () => {
  assert.equal(stagingConfig(undefined, 'https://hermes.example.invalid'), null);
  assert.throws(() => stagingConfig('http://otp.example.invalid', 'https://hermes.example.invalid'), /HTTPS/);
  assert.ok(stagingConfig('http://127.0.0.1:3000', 'https://hermes.example.invalid'));
  assert.throws(() => stagingConfig('https://user:pass@otp.example.invalid', 'https://hermes.example.invalid'), /válida/);
});

test('OTP proof goes only to Hermes; no admin token is stored', async () => {
  const { store, values } = fakeStorage();
  const calls: { url: string; body: Record<string, string> }[] = [];
  const transport: Transport = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    calls.push({ url, body });
    if (url.endsWith('/request-code')) return result({ success: true });
    if (url.endsWith('/verify-code')) return result({ success: true, proof: 'one-use-proof' });
    return result({ accessToken: 'short-access', refreshToken: 'private-refresh' });
  };
  const auth = new StagingAuth(config, store, transport);
  await auth.requestCode(' user@example.invalid ');
  await assert.rejects(auth.verifyCode('user@example.invalid', '123'), /ocho dígitos/);
  await auth.verifyCode('user@example.invalid', '00000001');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.email, 'user@example.invalid');
  assert.equal(calls[1].body.code, '00000001');
  assert.deepEqual(calls[2].body, { proof: 'one-use-proof' });
  assert.equal([...values.values()][0], 'private-refresh');
  assert.equal(values.size, 1);
});

test('restoring validates with server; refresh and session check do not send activity', async () => {
  const { store } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'saved');
  const calls: string[] = [];
  const transport: Transport = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return url.endsWith('/refresh') ? result({ accessToken: 'access', refreshToken: 'rotated' }) : result({ active: true });
  };
  await new StagingAuth(config, store, transport).validate();
  assert.deepEqual(calls.map((url) => `${url.split(' ')[0]} ${url.split('/').at(-1)}`), ['POST refresh', 'GET session']);
});

test('expired refresh fails closed and cannot restore a screen', async () => {
  const { store } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'expired');
  const auth = new StagingAuth(config, store, async () => result({}, 401));
  await assert.rejects(auth.validate(), SessionExpired);
});

test('offline session check never refreshes; 401 may refresh once but never accepts grace', async () => {
  const { store } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'old');
  let refreshes = 0;
  let offline = false;
  const auth = new StagingAuth(config, store, async (url) => {
    if (url.endsWith('/refresh')) { refreshes++; return result({ accessToken: 'access', refreshToken: `r${refreshes}` }); }
    if (offline) throw new Error('offline');
    return result({}, 401);
  });
  await assert.rejects(auth.validate(), SessionExpired);
  assert.equal(refreshes, 1); // restored token rejected; do not rotate again
  offline = true;
  await assert.rejects(auth.validate(), NetworkUnavailable);
  assert.equal(refreshes, 1);
});

test('401 on an existing access JWT tries refresh once; rejected refresh has no grace period', async () => {
  const { store, values } = fakeStorage();
  let refreshes = 0;
  const auth = new StagingAuth(config, store, async (url) => {
    if (url.endsWith('/verify-code')) return result({ proof: 'p' });
    if (url.endsWith('/crm-proof')) return result({ accessToken: 'a', refreshToken: 'old' });
    if (url.endsWith('/refresh')) { refreshes++; return result({}, 401); }
    return result({}, 401);
  });
  await auth.verifyCode('user@example.invalid', '12345678');
  await assert.rejects(auth.validate(), SessionExpired);
  assert.equal(refreshes, 1);
  assert.equal(values.size, 0);
  await assert.rejects(auth.validate(), SessionExpired);
  assert.equal(refreshes, 1);
});

test('OTP error and throttling never expose server payload or grant access', async () => {
  const { store, values } = fakeStorage();
  const invalid = new StagingAuth(config, store, async () => result({ debug: 'do-not-show' }, 400));
  await assert.rejects(invalid.verifyCode('user@example.invalid', '00000042'), /Código inválido o vencido/);
  const limited = new StagingAuth(config, store, async () => result({ debug: 'do-not-show' }, 429));
  await assert.rejects(limited.requestCode('user@example.invalid'), /Demasiados intentos/);
  assert.equal(values.size, 0);
});

test('offline logout confirms local deletion but not remote revocation', async () => {
  const { store, values } = fakeStorage();
  const auth = new StagingAuth(config, store, async (url) => {
    if (url.endsWith('/crm-proof')) return result({ accessToken: 'a', refreshToken: 'r' });
    if (url.endsWith('/verify-code')) return result({ proof: 'p' });
    throw new Error('offline');
  });
  await auth.verifyCode('user@example.invalid', '12345678');
  await assert.rejects(auth.validate(), NetworkUnavailable);
  assert.equal(await auth.logout(), 'unconfirmed');
  assert.equal(values.size, 0);
  await assert.rejects(auth.validate(), SessionExpired);
});

test('logout blocks immediately and removes protected secret while remote request is pending', async () => {
  const { store, values } = fakeStorage();
  let release!: (response: Response) => void;
  let started!: () => void;
  const sent = new Promise<void>((resolve) => { started = resolve; });
  const auth = new StagingAuth(config, store, async (url) => {
    if (url.endsWith('/verify-code')) return result({ proof: 'p' });
    if (url.endsWith('/crm-proof')) return result({ accessToken: 'a', refreshToken: 'r' });
    started();
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  await auth.verifyCode('user@example.invalid', '12345678');
  const logout = auth.logout();
  await assert.rejects(auth.validate(), SessionExpired);
  await sent;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(values.size, 0);
  release(result({ success: true }));
  assert.equal(await logout, 'revoked');
});

test('200 with inactive or missing status cannot unlock', async () => {
  const { store } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'saved');
  const auth = new StagingAuth(config, store, async (url) => url.endsWith('/refresh')
    ? result({ accessToken: 'a', refreshToken: 'r' }) : result({ active: false }));
  await assert.rejects(auth.validate(), SessionExpired);
});

test('a late refresh cannot rewrite a secret after local revocation', async () => {
  const { store, values } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'old');
  let release!: (value: Response) => void;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  const transport: Transport = async (url) => url.endsWith('/refresh') ? new Promise((resolve) => { release = resolve; requested(); }) : result({ active: true });
  const auth = new StagingAuth(config, store, transport);
  const ongoing = auth.validate();
  await started;
  await auth.clear();
  release(result({ accessToken: 'late-access', refreshToken: 'late-secret' }));
  await assert.rejects(ongoing, SessionExpired);
  assert.equal(values.size, 0);
});

test('logout fails closed if protected storage cannot delete the secret', async () => {
  const { store, values } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'saved');
  const auth = new StagingAuth(config, store, async (url) => url.endsWith('/refresh')
    ? result({ accessToken: 'a', refreshToken: 'r' }) : result({ active: true }));
  await auth.validate();
  store.deleteItemAsync = async () => { throw new Error('storage failure'); };
  await assert.rejects(auth.logout(), LocalClearFailed);
  assert.equal(values.size, 1);
  await assert.rejects(auth.validate(), SessionExpired);
});

test('expired access JWT on logout never rotates refresh or falsely confirms revocation', async () => {
  const { store, values } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'old');
  const paths: string[] = [];
  const auth = new StagingAuth(config, store, async (url) => {
    paths.push(url.split('/').at(-1)!);
    if (url.endsWith('/refresh')) return result({ accessToken: 'short', refreshToken: 'rotated' });
    if (url.endsWith('/session')) return result({ active: true });
    return result({}, 401);
  });
  await auth.validate();
  assert.equal(await auth.logout(), 'unconfirmed');
  assert.deepEqual(paths, ['refresh', 'session', 'logout']);
  assert.equal(values.size, 0);
});

test('lost refresh response clears old token, never retries and requires new OTP', async () => {
  const { store, values } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'old');
  let calls = 0;
  const auth = new StagingAuth(config, store, async () => { calls++; throw new Error('lost response'); });
  await assert.rejects(auth.validate(), RefreshUncertain);
  await assert.rejects(auth.validate(), SessionExpired);
  assert.equal(calls, 1);
  assert.equal(values.size, 0);
});

test('interrupted refresh persists pending marker and new process never resends old token', async () => {
  const { store, values } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'old');
  let started!: () => void;
  const sent = new Promise<void>((resolve) => { started = resolve; });
  const first = new StagingAuth(config, store, async () => { started(); return new Promise<Response>(() => {}); });
  void first.validate();
  await sent;
  assert.equal(values.size, 2);
  let calls = 0;
  const restarted = new StagingAuth(config, store, async () => { calls++; return result({}); });
  await assert.rejects(restarted.validate(), RefreshUncertain);
  assert.equal(calls, 0);
  assert.equal(values.size, 0);
});

test('refresh storage write failure cannot expose access or replay old refresh', async () => {
  const { store, values } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'old');
  let calls = 0;
  const original = store.setItemAsync;
  store.setItemAsync = async (key, value) => {
    if (value === 'rotated') throw new Error('storage failure');
    await original(key, value);
  };
  const auth = new StagingAuth(config, store, async () => { calls++; return result({ accessToken: 'new', refreshToken: 'rotated' }); });
  await assert.rejects(auth.validate(), RefreshUncertain);
  await assert.rejects(auth.validate(), SessionExpired);
  assert.equal(calls, 1);
  assert.equal(values.size, 0);
});

test('unconfirmed local deletion keeps session blocked even after app tries validation', async () => {
  const { store, values } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'old');
  store.deleteItemAsync = async () => {};
  let calls = 0;
  const auth = new StagingAuth(config, store, async () => { calls++; return result({}); });
  await assert.rejects(auth.logout(), LocalClearFailed);
  await assert.rejects(auth.validate(), SessionExpired);
  await assert.rejects(auth.verifyCode('user@example.invalid', '12345678'), LocalClearFailed);
  assert.equal(calls, 0);
  assert.equal(values.size, 1);
});

test('late mobile proof exchange cannot recreate session after clear', async () => {
  const { store, values } = fakeStorage();
  let release!: (value: Response) => void;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  const auth = new StagingAuth(config, store, async (url) => {
    if (url.endsWith('/verify-code')) return result({ proof: 'one-use' });
    return new Promise<Response>((resolve) => { release = resolve; requested(); });
  });
  const ongoing = auth.verifyCode('user@example.invalid', '00000042');
  await started;
  await auth.clear();
  release(result({ accessToken: 'late-access', refreshToken: 'stale-refresh' }));
  await assert.rejects(ongoing, SessionExpired);
  assert.equal(values.size, 0);
});

test('a late session status cannot validate a cleared session', async () => {
  const { store } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'old');
  let release!: (value: Response) => void;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  const auth = new StagingAuth(config, store, async (url) => url.endsWith('/refresh')
    ? result({ accessToken: 'access', refreshToken: 'rotated' })
    : new Promise<Response>((resolve) => { release = resolve; requested(); }));
  const ongoing = auth.validate();
  await started;
  await auth.clear();
  release(result({ active: true }));
  await assert.rejects(ongoing, SessionExpired);
});
