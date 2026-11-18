import assert from 'node:assert/strict';
import test from 'node:test';
import { canCompose, demoReducer, initialState, visibleChats } from '../src/demo';

test('login is simulated and opens a synthetic inbox', () => {
  const state = demoReducer(initialState, { type: 'LOGIN' });
  assert.equal(state.signedIn, true);
  assert.equal(state.chats.length, 3);
  assert.ok(state.chats.every((chat) => chat.name.includes('ejemplo')));
});

test('offline clears draft and prevents composing or sending', () => {
  let state = demoReducer(initialState, { type: 'LOGIN' });
  state = demoReducer(state, { type: 'OPEN', id: 'demo-a' });
  state = demoReducer(state, { type: 'TAKE_CONTROL' });
  state = demoReducer(state, { type: 'DRAFT', text: 'Solo prueba' });
  assert.equal(state.draft, 'Solo prueba');
  state = demoReducer(state, { type: 'NETWORK', online: false });
  assert.equal(state.draft, '');
  assert.equal(demoReducer(state, { type: 'DRAFT', text: 'Otro' }), state);
  assert.equal(demoReducer(state, { type: 'SEND_DEMO' }), state);
});

test('a simulated reply changes only in-memory data; double tap with cleared draft is inert', () => {
  let state = demoReducer(initialState, { type: 'LOGIN' });
  state = demoReducer(state, { type: 'OPEN', id: 'demo-a' });
  state = demoReducer(state, { type: 'TAKE_CONTROL' });
  const length = state.chats[0].messages.length;
  state = demoReducer(state, { type: 'DRAFT', text: '  Respuesta ficticia  ' });
  state = demoReducer(state, { type: 'SEND_DEMO' });
  assert.equal(state.chats[0].messages.length, length + 1);
  assert.equal(state.chats[0].messages.at(-1)?.text, 'Respuesta ficticia');
  assert.match(state.notice, /no se envió/);
  assert.equal(demoReducer(state, { type: 'SEND_DEMO' }), state);
});

test('foreground reconciliation is a local indicator, not a remote refresh', () => {
  const signed = demoReducer(initialState, { type: 'LOGIN' });
  const offline = demoReducer(signed, { type: 'NETWORK', online: false });
  assert.equal(demoReducer(offline, { type: 'FOREGROUND' }), offline);
  const resumed = demoReducer(demoReducer(offline, { type: 'NETWORK', online: true }), { type: 'FOREGROUND' });
  assert.equal(resumed.chats.length, signed.chats.length);
  assert.match(resumed.notice, /datos ficticios/);
});

test('logout clears synthetic reply, selection, draft and local session', () => {
  let state = demoReducer(initialState, { type: 'LOGIN' });
  state = demoReducer(state, { type: 'OPEN', id: 'demo-b' });
  state = demoReducer(state, { type: 'TAKE_CONTROL' });
  state = demoReducer(state, { type: 'DRAFT', text: 'Borrador' });
  state = demoReducer(state, { type: 'SEND_DEMO' });
  state = demoReducer(state, { type: 'LOGOUT' });
  assert.equal(state.signedIn, false);
  assert.equal(state.selectedId, null);
  assert.equal(state.draft, '');
  assert.deepEqual(state.chats, initialState.chats);
});

test('invalid conversation and sending without session have no effect', () => {
  assert.equal(demoReducer(initialState, { type: 'OPEN', id: 'unknown' }), initialState);
  assert.equal(demoReducer(initialState, { type: 'SEND_DEMO' }), initialState);
});

test('search and combined control and priority filters are local and accent insensitive', () => {
  let state = demoReducer(initialState, { type: 'SEARCH', text: ' INFORMACION ' });
  assert.deepEqual(visibleChats(state).map((chat) => chat.id), ['demo-c']);
  state = demoReducer(state, { type: 'SEARCH', text: '' });
  state = demoReducer(state, { type: 'CONTROL_FILTER', value: 'hermes' });
  state = demoReducer(state, { type: 'PRIORITY_FILTER', value: 'alta' });
  assert.deepEqual(visibleChats(state).map((chat) => chat.id), ['demo-a']);
  state = demoReducer(state, { type: 'CONTROL_FILTER', value: 'humano' });
  assert.deepEqual(visibleChats(state).map((chat) => chat.id), ['demo-c']);
  state = demoReducer(state, { type: 'PRIORITY_FILTER', value: 'normal' });
  assert.deepEqual(visibleChats(state), []);
  assert.equal(state.chats.length, 3);
});

test('control gates composing and sending and is tracked independently per conversation', () => {
  let state = demoReducer(initialState, { type: 'LOGIN' });
  assert.deepEqual(state.chats.map((chat) => chat.control), ['hermes', 'hermes', 'humano']);
  state = demoReducer(state, { type: 'OPEN', id: 'demo-a' });
  assert.equal(canCompose(state), false);
  assert.equal(demoReducer(state, { type: 'DRAFT', text: 'No' }), state);
  assert.equal(demoReducer({ ...state, draft: 'No' }, { type: 'SEND_DEMO' }).chats, state.chats);
  state = demoReducer(state, { type: 'TAKE_CONTROL' });
  assert.equal(canCompose(state), true);
  assert.match(state.notice, /demostración/);
  state = demoReducer(state, { type: 'DRAFT', text: 'Borrador' });
  state = demoReducer(state, { type: 'RETURN_CONTROL' });
  assert.equal(state.draft, '');
  assert.equal(canCompose(state), false);
  assert.equal(state.chats[2].control, 'humano');
  state = demoReducer(state, { type: 'OPEN', id: 'demo-c' });
  assert.equal(canCompose(state), true);
  assert.equal(demoReducer(state, { type: 'TAKE_CONTROL' }), state);
  state = demoReducer(state, { type: 'NETWORK', online: false });
  assert.equal(canCompose(state), false);
  assert.equal(demoReducer(state, { type: 'RETURN_CONTROL' }), state);
});

test('logout resets filters and local control changes', () => {
  let state = demoReducer(initialState, { type: 'LOGIN' });
  state = demoReducer(state, { type: 'SEARCH', text: 'app' });
  state = demoReducer(state, { type: 'CONTROL_FILTER', value: 'humano' });
  state = demoReducer(state, { type: 'PRIORITY_FILTER', value: 'alta' });
  state = demoReducer(state, { type: 'OPEN', id: 'demo-b' });
  state = demoReducer(state, { type: 'TAKE_CONTROL' });
  state = demoReducer(state, { type: 'LOGOUT' });
  assert.deepEqual(state, initialState);
});
