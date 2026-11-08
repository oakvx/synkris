import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminApp } from '../src/services/admin-server.js';

const token = 'synthetic-admin-token-for-offline-tests-only';
const recipient = '393331234567@c.us';
async function api(t, state, actions = {}) {
  const server = createAdminApp(state, actions, { token }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (route, { method = 'GET', body, authenticated = true, headers = {} } = {}) => fetch('http://127.0.0.1:' + server.address().port + route, {
    method, headers: { ...(authenticated ? { 'X-Admin-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('QR remains token-protected, no-store and fresh-only; pairing is not readiness', async t => {
  const state = { online: false, dbOnline: true, qrDataUrl: 'data:image/png;base64,c3ludGhldGlj', qrUpdatedAt: Date.now() };
  const request = await api(t, state);
  assert.equal((await request('/health', { authenticated: false })).status, 200);
  assert.equal((await request('/ready', { authenticated: false })).status, 503);
  const anonymous = await request('/api/session/qr', { authenticated: false });
  assert.equal(anonymous.status, 401); assert.ok(!(await anonymous.text()).includes('c3ludGhldGlj'));
  assert.equal((await request('/api/session/qr', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const authorized = await request('/api/session/qr');
  assert.equal(authorized.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await authorized.json(), { connected: false, qr: state.qrDataUrl });
  for (const age of [21000, -60000]) {
    state.qrUpdatedAt = Date.now() - age;
    assert.equal((await (await request('/api/session/qr')).json()).qr, null);
  }
  state.online = true; state.qrUpdatedAt = Date.now();
  assert.equal((await request('/ready', { authenticated: false })).status, 200);
  assert.deepEqual(await (await request('/api/session/qr')).json(), { connected: true, qr: null });
  state.dbOnline = false;
  assert.equal((await request('/ready', { authenticated: false })).status, 503);
});

test('an ambiguous operator send is reported as delivery_unknown, never retried or recorded as delivered', async t => {
  let sends = 0, writes = 0;
  const request = await api(t, { online: true, dbPool: { query: async () => { writes++; } } }, {
    sendText: async () => { sends++; throw Object.assign(Error('SYNTHETIC_PRIVATE_SEND_PAYLOAD'), { outcome: 'unknown' }); },
  });
  const response = await request('/api/send', { method: 'POST', body: { to: recipient, message: 'synthetic message' } });
  assert.equal(response.status, 502); assert.deepEqual(await response.json(), { ok: false, error: 'delivery_unknown' });
  assert.equal(sends, 1); assert.equal(writes, 0);
});

test('a provider that has not reached ready returns 503 before handoff, send or history', async t => {
  let sends = 0;
  const request = await api(t, { online: false, dbPool: { query: async () => { throw Error('must not write'); } } }, {
    sendText: async () => { sends++; },
  });
  const response = await request('/api/send', { method: 'POST', body: { to: recipient, message: 'test', handoff: true } });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false, error: 'client_not_ready' });
  assert.equal(sends, 0);
});

test('a provider-confirmed send stays successful if writing local history fails', async t => {
  let sends = 0;
  const request = await api(t, { online: true, dbPool: { query: async () => { throw Error('synthetic disk unavailable'); } } }, {
    sendText: async () => { sends++; return 'synthetic-provider-id'; },
  });
  const response = await request('/api/send', { method: 'POST', body: { to: recipient, message: 'test' } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, recorded: false });
  assert.equal(sends, 1);
});
