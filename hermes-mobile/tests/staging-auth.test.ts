import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetworkUnavailable, SessionExpired, stagingConfig, StagingAuth, type Storage, type Transport } from '../src/stagingAuth';

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

test('restoring validates with server; refresh and status do not send activity', async () => {
  const { store } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'saved');
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url);
    return url.endsWith('/refresh') ? result({ accessToken: 'access', refreshToken: 'rotated' }) : result({ active: true });
  };
  await new StagingAuth(config, store, transport).validate();
  assert.deepEqual(calls.map((url) => url.split('/').at(-1)), ['refresh', 'status']);
});

test('expired refresh fails closed and cannot restore a screen', async () => {
  const { store } = fakeStorage();
  await store.setItemAsync('hermes.crm.mobile.refresh.v1', 'expired');
  const auth = new StagingAuth(config, store, async () => result({}, 401));
  await assert.rejects(auth.validate(), SessionExpired);
});

test('offline and logout delete local secret even when remote request fails', async () => {
  const { store, values } = fakeStorage();
  const auth = new StagingAuth(config, store, async (url) => {
    if (url.endsWith('/crm-proof')) return result({ accessToken: 'a', refreshToken: 'r' });
    if (url.endsWith('/verify-code')) return result({ proof: 'p' });
    throw new Error('offline');
  });
  await auth.verifyCode('user@example.invalid', '12345678');
  await assert.rejects(auth.validate(), NetworkUnavailable);
  await assert.rejects(auth.logout(), NetworkUnavailable);
  assert.equal(values.size, 0);
});
