import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import whatsappWeb from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { whatsappOptions, isWhatsAppConnectedState, stopWhatsAppClient } from '../src/services/whatsapp-options.js';
import { createWhatsAppClient, normalizeWhatsAppMessage } from '../src/services/whatsapp-provider.js';
import { createMessageDispatcher } from '../src/services/message-dispatcher.js';
import { createPersistentMessageInbox } from '../src/services/message-inbox.js';
import { createModule as createTransport } from '../src/core/modules/conversation/transport.js';

const PN = '393331234567@c.us', LID = '991234567890@lid';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const message = (id = 'incoming-1', extra = {}) => ({ from: PN, id: { _serialized: id, fromMe: false }, type: 'chat', body: 'prenota', ...extra });
const png = value => 'data:image/png;base64,' + Buffer.from(value).toString('base64');

class NativeClient extends EventEmitter {
  initializeCalls = 0; destroyCalls = 0; logoutCalls = 0; stateCalls = 0;
  sends = []; lookups = []; state = 'CONNECTED'; browserOpen = false;
  async initialize() { this.initializeCalls++; await this.onInitialize?.(); this.browserOpen = true; }
  async destroy() { this.destroyCalls++; this.browserOpen = false; }
  async logout() { this.logoutCalls++; throw Error('logout must never be used for shutdown'); }
  async getState() { this.stateCalls++; return this.getStateImpl ? this.getStateImpl() : this.state; }
  async sendMessage(to, text, options) {
    this.sends.push({ to, text, options });
    return this.sendImpl ? this.sendImpl() : { id: { _serialized: 'synthetic-outgoing-id' } };
  }
  async getContactLidAndPhone(ids) { this.lookups.push(ids); return this.lookupImpl ? this.lookupImpl(ids) : []; }
}

function fixture(t, { env = {}, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synk-wwebjs-'));
  const native = new NativeClient(), status = {}, logs = [];
  const client = createWhatsAppClient({ env: { SESSION_PATH: path.join(root, 'session'), ...env }, status,
    logger: (...args) => logs.push(args), ...options,
    clientFactory: config => { native.options = config; config.authStrategy.setup(native); return native; } });
  t.after(async () => { await client.destroy(); fs.rmSync(root, { recursive: true, force: true }); });
  const start = async () => { const init = client.initialize(); await tick(); native.emit('ready'); await init; };
  return { root, native, status, logs, client, start };
}

test('whatsapp-web.js options keep sandbox/TLS protections and put LocalAuth/cache below SESSION_PATH', () => {
  const options = whatsappOptions({ SESSION_PATH: path.resolve('synthetic session'), PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium' });
  assert.equal(options.dataPath, path.resolve('synthetic session/whatsapp-web.js'));
  assert.equal(options.webVersionCache.path, path.join(options.dataPath, 'web-cache'));
  assert.equal(options.puppeteer.executablePath, '/usr/bin/chromium');
  assert.equal(options.puppeteer.headless, true);
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--disable-web-security', '--disable-site-isolation-trials']) assert.equal(options.puppeteer.args.includes(flag), false);
  for (const key of ['handleSIGINT', 'handleSIGTERM', 'handleSIGHUP']) assert.equal(options.puppeteer[key], false);
  assert.equal(options.bypassCSP, false); assert.equal(options.takeoverOnConflict, false);
  assert.equal(options.puppeteer.userDataDir, undefined);
});

test('only explicit host opt-in enables sandbox bypass; TLS is never bypassed', () => {
  for (const value of [undefined, '0', 'true', 'yes']) assert.equal(whatsappOptions({ CHROME_NO_SANDBOX: value }).puppeteer.args.includes('--no-sandbox'), false);
  const options = whatsappOptions({ CHROME_NO_SANDBOX: '1', CHROME_HEADLESS: '0', CHROME_PATH: '/synthetic/chrome' });
  assert.ok(options.puppeteer.args.includes('--no-sandbox'));
  assert.ok(options.puppeteer.args.includes('--disable-setuid-sandbox'));
  assert.equal(options.puppeteer.args.includes('--ignore-certificate-errors'), false);
  assert.equal(options.puppeteer.headless, false);
  assert.equal(options.puppeteer.executablePath, '/synthetic/chrome');
});

test('timeouts stay in milliseconds and malformed/overflow values are refused', () => {
  const options = whatsappOptions({ QR_TIMEOUT_MS: '45000', AUTH_TIMEOUT_MS: '60000' });
  assert.equal(options.qrTimeoutMs, 45000); assert.equal(options.authTimeoutMs, 60000);
  assert.equal(whatsappOptions({}).authTimeoutMs, 30000);
  for (const name of ['QR_TIMEOUT_MS', 'AUTH_TIMEOUT_MS']) for (const value of ['-1', 'NaN', 'Infinity', '0.5', '2147483648']) assert.throws(() => whatsappOptions({ [name]: value }), new RegExp(name));
});

test('session IDs cannot traverse paths and default storage does not touch session-v5', () => {
  for (const id of ['../other', 'a/b', 'a\\b', 'a b', 'x'.repeat(65)]) assert.throws(() => whatsappOptions({ WHATSAPP_SESSION_ID: id }), /WHATSAPP_SESSION_ID/);
  const options = whatsappOptions({ APP_DATA_DIR: path.resolve('synthetic salon/config'), WHATSAPP_SESSION_ID: 'salon_2-main' });
  assert.equal(options.clientId, 'salon_2-main');
  assert.equal(options.dataPath, path.resolve('synthetic salon/config/session/whatsapp-web.js'));
  assert.ok(!options.dataPath.includes('session-v5'));
});

test('the native CONNECTED sentinel is necessary but not itself application readiness', () => {
  assert.equal(isWhatsAppConnectedState(whatsappWeb.WAState.CONNECTED), true);
  for (const state of ['READY', 'PAIRING', 'OPENING', 'DISCONNECTED', null, undefined, {}]) assert.equal(isWhatsAppConnectedState(state), false);
});

test('real LocalAuth reuses the same isolated profile and destroy preserves it and legacy files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synk-local-auth-'));
  const old = path.join(root, 'legacy-session.data.json'); fs.writeFileSync(old, 'synthetic legacy marker');
  const config = whatsappOptions({ SESSION_PATH: root });
  try {
    let profile;
    for (let index = 0; index < 2; index++) {
      const native = new whatsappWeb.Client({ authStrategy: new whatsappWeb.LocalAuth({ clientId: config.clientId, dataPath: config.dataPath }), puppeteer: { ...config.puppeteer } });
      // Exercise the real strategy without initialize(), Chromium or WhatsApp.
      await native.authStrategy.beforeBrowserInitialized();
      if (index === 0) { profile = native.options.puppeteer.userDataDir; fs.writeFileSync(path.join(profile, 'synthetic-marker'), 'preserve'); }
      assert.equal(native.options.puppeteer.userDataDir, profile);
      await stopWhatsAppClient(native);
      assert.equal(fs.readFileSync(path.join(profile, 'synthetic-marker'), 'utf8'), 'preserve');
      assert.equal(fs.readFileSync(old, 'utf8'), 'synthetic legacy marker');
    }
    assert.equal(profile, path.join(config.dataPath, 'session-whatsapp-ai'));
    await stopWhatsAppClient(null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('construction is offline and passes a real LocalAuth strategy, never a userDataDir', async t => {
  const f = fixture(t);
  assert.equal(f.native.options.authStrategy instanceof whatsappWeb.LocalAuth, true);
  assert.equal(f.native.initializeCalls, 0); assert.equal(f.native.browserOpen, false);
  assert.equal(fs.existsSync(path.join(f.root, 'session')), false);
  assert.equal(f.native.options.puppeteer.userDataDir, undefined);
  assert.equal(f.native.options.qrTimeoutMs, undefined);
});

test('initialize/authenticated/CONNECTED cannot enable sending before native ready', async t => {
  const f = fixture(t); const init = f.client.initialize();
  let resolved = false; void init.then(() => { resolved = true; }, () => {});
  await tick(); f.native.emit('authenticated', 'SYNTHETIC_PRIVATE_AUTH'); f.native.emit('change_state', 'CONNECTED');
  assert.equal(f.status.online, false); assert.equal(resolved, false);
  assert.equal(await f.client.getState(), null); assert.equal(f.native.stateCalls, 0);
  await assert.rejects(f.client.sendText(PN, 'test'), { code: 'WHATSAPP_NOT_READY' });
  assert.equal(f.native.sends.length, 0);
  f.native.emit('ready'); await init; assert.equal(f.status.online, true);
});

test('ready before launch completion still waits for initialization; initialize is idempotent', async t => {
  const f = fixture(t), launch = deferred(); f.native.onInitialize = () => launch.promise;
  const init = f.client.initialize(); assert.equal(f.client.initialize(), init);
  await tick(); f.native.emit('ready'); assert.equal(f.status.online, false);
  launch.resolve(); assert.equal(await init, f.client);
  assert.equal(f.status.online, true); assert.equal(f.native.initializeCalls, 1);
});

test('a restored native session reaches ready without requiring a fresh QR', async t => {
  const f = fixture(t); f.native.onInitialize = () => { f.native.emit('ready'); };
  await f.client.initialize(); assert.equal(f.status.online, true); assert.equal(f.status.qrDataUrl, null);
});

test('text normalization exposes only canonical core fields and preserves serialized dedupe ID', async () => {
  const normalized = await normalizeWhatsAppMessage(message('false_private_SERIAL', { body: '  prenota domani  ', _data: { secret: 'not forwarded' }, author: 'not forwarded' }));
  assert.deepEqual(normalized, { id: 'false_private_SERIAL', from: PN, body: 'prenota domani', fromMe: false, isGroupMsg: false });
});

test('real whatsapp-web.js Message text and media captions match the normalization contract', async () => {
  for (const type of ['chat', 'image']) {
    const native = new whatsappWeb.Message(null, { id: { _serialized: 'synthetic-native-id', id: 'synthetic', fromMe: false }, from: { _serialized: PN }, to: PN,
      type, body: 'prenota', directPath: type === 'image' ? '/synthetic-no-download' : undefined, caption: 'prenota', t: 1700000000 });
    assert.equal((await normalizeWhatsAppMessage(native)).body, 'prenota');
  }
});

test('groups, own messages, status, broadcast, channels and malformed payloads never reach the core', async () => {
  const lookup = { getContactLidAndPhone() { throw Error('must not lookup unsupported messages'); } };
  for (const payload of [null, {}, message('x', { from: '123456@g.us' }), message('x', { isGroupMsg: true }),
    message('x', { fromMe: true }), message('x', { id: { _serialized: 'x', fromMe: true } }), message('x', { from: 'status@broadcast' }),
    message('x', { isStatus: true }), message('x', { broadcast: true }), message('x', { from: '123456@newsletter' }),
    message('x', { from: 'outside@web' }), message('x', { type: 'poll_creation' }), message('x', { type: 'vcard' }),
    message('x', { body: '' }), message('x', { body: 'x'.repeat(4001) }), message('x', { id: {} }), message('x', { id: 'x'.repeat(241) })]) {
    assert.equal(await normalizeWhatsAppMessage(payload, lookup), null);
  }
});

test('LID senders use the provider PN mapping, not contact.number or LID digits', async () => {
  const calls = []; const normalized = await normalizeWhatsAppMessage(message('lid-id', { from: LID }), {
    getContactLidAndPhone: async ids => { calls.push(ids); return [{ lid: LID, pn: PN }]; },
    getContactById() { throw Error('contact.number is not a verified phone mapping'); },
  });
  assert.deepEqual(calls, [[LID]]); assert.equal(normalized.from, PN); assert.equal(normalized.id, 'lid-id');
});

test('missing/mismatched LID mappings fail closed instead of inventing phone numbers', async () => {
  for (const mappings of [null, [], {}, [{ lid: 'other@lid', pn: PN }], [{ lid: LID, pn: '123456@g.us' }], [{ lid: LID }]]) {
    assert.equal(await normalizeWhatsAppMessage(message('id', { from: LID }), { getContactLidAndPhone: async () => mappings }), null);
  }
  assert.equal(await normalizeWhatsAppMessage(message('id', { from: LID }), {}), null);
});

test('provider contact lookup has a bounded wait', async () => {
  await assert.rejects(normalizeWhatsAppMessage(message('id', { from: LID }), { getContactLidAndPhone: () => new Promise(() => {}) }, { lookupTimeoutMs: 10 }), { code: 'WHATSAPP_CONTACT_TIMEOUT' });
});

test('listeners registered before initialize deliver direct messages but not pre-ready input', async t => {
  const f = fixture(t), received = []; f.client.onMessage(value => received.push(value));
  const init = f.client.initialize(); await tick(); f.native.emit('message', message('before-ready'));
  f.native.emit('ready'); await init; f.native.emit('message', message('after-ready')); await tick();
  assert.deepEqual(received.map(value => value.id), ['after-ready']);
});

test('async LID normalization preserves order when the next message uses the PN alias', async t => {
  const f = fixture(t), lookup = deferred(), received = [];
  f.native.lookupImpl = () => lookup.promise; f.client.onMessage(value => received.push(value)); await f.start();
  f.native.emit('message', message('first', { from: LID })); f.native.emit('message', message('second'));
  await tick(); assert.equal(received.length, 0);
  lookup.resolve([{ lid: LID, pn: PN }]); await tick();
  assert.deepEqual(received.map(value => value.id), ['first', 'second']);
  assert.deepEqual(received.map(value => value.from), [PN, PN]);
});

test('adapter submission plus real dispatcher preserves per-chat order and rejects duplicates', async t => {
  const f = fixture(t), first = deferred(), handled = [], tasks = [];
  const dispatcher = createMessageDispatcher({ handle: async value => { handled.push(value.id); if (value.id === 'first') await first.promise; } });
  f.client.onMessage(value => { tasks.push(dispatcher.submit(value)); }); await f.start();
  f.native.emit('message', message('first')); f.native.emit('message', message('second')); f.native.emit('message', message('first'));
  await tick(); assert.deepEqual(handled, ['first']);
  first.resolve(); const result = await Promise.all(tasks);
  assert.deepEqual(handled, ['first', 'second']); assert.equal(result[2].reason, 'duplicate');
});

test('one slow booking does not block normalized messages for another chat', async t => {
  const f = fixture(t), first = deferred(), handled = [], tasks = [];
  const dispatcher = createMessageDispatcher({ handle: async value => { handled.push(value.id); if (value.id === 'slow') await first.promise; } });
  f.client.onMessage(value => { tasks.push(dispatcher.submit(value)); }); await f.start();
  f.native.emit('message', message('slow')); f.native.emit('message', message('other', { from: '393331234568@c.us' }));
  await tick(); assert.deepEqual(handled, ['slow', 'other']); first.resolve(); await Promise.all(tasks);
});

test('normalized IDs are hashed by the persistent inbox and stay deduplicated across dispatchers', async () => {
  const rows = new Map(), keys = []; let handled = 0;
  const db = { async query(sql, args) {
    keys.push(args[0]);
    if (sql.includes('INSERT INTO')) { if (rows.has(args[0])) return { rowCount: 0 }; rows.set(args[0], 'processing'); }
    else if (sql.includes("SET status='completed'")) rows.set(args[0], 'completed');
    return { rowCount: 1 };
  } };
  const normalized = await normalizeWhatsAppMessage(message('persistent-serialized-id'));
  const create = () => createMessageDispatcher({ inbox: createPersistentMessageInbox(db), handle: async () => { handled++; } });
  assert.equal((await create().submit(normalized)).processed, true);
  assert.equal((await create().submit(normalized)).reason, 'duplicate');
  assert.equal(handled, 1); assert.ok(keys.every(value => /^[a-f0-9]{64}$/.test(value)));
});

test('normalization queue is bounded and does not retain unbounded pending LID lookups', async t => {
  const f = fixture(t, { maxPendingMessages: 1 }), lookup = deferred(), received = [];
  f.native.lookupImpl = () => lookup.promise; f.client.onMessage(value => received.push(value)); await f.start();
  f.native.emit('message', message('first', { from: LID })); f.native.emit('message', message('dropped'));
  await tick(); assert.equal(f.native.lookups.length, 1);
  lookup.resolve([{ lid: LID, pn: PN }]); await tick();
  assert.deepEqual(received.map(value => value.id), ['first']);
  assert.ok(f.logs.some(entry => entry[2].code === 'WHATSAPP_INBOUND_CAPACITY'));
});

test('normalization and handler failures are redacted and do not poison later input', async t => {
  const f = fixture(t), received = [];
  f.native.lookupImpl = async () => { throw Error('SYNTHETIC_PRIVATE_PHONE_AND_BODY'); };
  f.client.onMessage(value => { received.push(value.id); if (value.id === 'handler-fails') return Promise.reject(Error('SYNTHETIC_PRIVATE_TEXT')); });
  await f.start(); f.native.emit('message', message('bad-lid', { from: LID })); f.native.emit('message', message('handler-fails')); f.native.emit('message', message('good'));
  await tick(); assert.deepEqual(received, ['handler-fails', 'good']);
  assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_PRIVATE'), false);
  assert.ok(f.logs.some(entry => entry[2].code === 'WHATSAPP_MESSAGE_NORMALIZATION_FAILED'));
  assert.ok(f.logs.some(entry => entry[2].code === 'WHATSAPP_MESSAGE_HANDLER_FAILED'));
});

test('messages awaiting LID normalization cannot arrive after disconnection', async t => {
  const f = fixture(t), lookup = deferred(), received = [];
  f.native.lookupImpl = () => lookup.promise; f.client.onMessage(value => received.push(value)); await f.start();
  f.native.emit('message', message('pending', { from: LID })); await tick(); f.native.emit('disconnected', 'SYNTHETIC_PRIVATE_REASON');
  lookup.resolve([{ lid: LID, pn: PN }]); await tick();
  assert.deepEqual(received, []); assert.equal(f.status.online, false);
});

test('message subscriptions can be removed', async t => {
  const f = fixture(t), received = []; const remove = f.client.onMessage(value => received.push(value));
  await f.start(); remove(); f.native.emit('message', message()); await tick(); assert.deepEqual(received, []);
  assert.throws(() => f.client.onMessage(null), TypeError);
});

test('raw QR is encoded as PNG only in RAM, never written/logged, then cleared at ready', async t => {
  const done = deferred();
  const f = fixture(t, { now: () => 123456, qrToDataURL: async (...args) => { const data = await QRCode.toDataURL(...args); done.resolve(); return data; } });
  const init = f.client.initialize(); await tick(); f.native.emit('qr', 'SYNTHETIC_NOT_A_REAL_WHATSAPP_QR'); await done.promise; await tick();
  assert.ok(f.status.qrDataUrl.startsWith('data:image/png;base64,'));
  assert.deepEqual([...Buffer.from(f.status.qrDataUrl.split(',')[1], 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(f.status.qrUpdatedAt, 123456); assert.equal(f.status.online, false);
  assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_NOT_A_REAL'), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'session/whatsapp-web.js')), []);
  f.native.emit('ready'); await init; assert.equal(f.status.qrDataUrl, null); assert.equal(f.status.qrUpdatedAt, 0);
});

test('older async QR encodes cannot overwrite a newer QR or resurrect one after ready', async t => {
  const encodes = new Map(); const f = fixture(t, { qrToDataURL: value => { const pending = deferred(); encodes.set(value, pending); return pending.promise; } });
  const init = f.client.initialize(); await tick(); f.native.emit('qr', 'old'); f.native.emit('qr', 'new'); await tick();
  encodes.get('new').resolve(png('new')); await tick(); assert.equal(f.status.qrDataUrl, png('new'));
  encodes.get('old').resolve(png('old')); await tick(); assert.equal(f.status.qrDataUrl, png('new'));
  f.native.emit('qr', 'late'); await tick(); f.native.emit('ready'); await init;
  encodes.get('late').resolve(png('late')); await tick(); assert.equal(f.status.qrDataUrl, null);
});

test('authenticated invalidates pending QR without declaring the client ready', async t => {
  const encode = deferred(); const f = fixture(t, { qrToDataURL: () => encode.promise });
  const init = f.client.initialize(); await tick(); f.native.emit('qr', 'synthetic'); await tick(); f.native.emit('authenticated');
  encode.resolve(png('synthetic')); await tick(); assert.equal(f.status.qrDataUrl, null); assert.equal(f.status.online, false);
  f.native.emit('ready'); await init;
});

test('invalid/failed QR encoding cannot expose arbitrary URLs or leak encoder errors', async t => {
  const f = fixture(t, { qrToDataURL: async value => { if (value === 'reject') throw Error('SYNTHETIC_QR_SECRET'); return value; } });
  const init = f.client.initialize(); await tick();
  for (const value of ['https://untrusted.example/qr', '<svg/>', 'data:image/png;base64,' + 'a'.repeat(200000), 'reject']) {
    f.native.emit('qr', value); await tick(); assert.equal(f.status.qrDataUrl, null);
  }
  assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_QR_SECRET'), false);
  f.native.emit('ready'); await init;
});

test('QR timeout applies across rotations and rejects startup without lingering timers', { timeout: 2000 }, async t => {
  const f = fixture(t, { env: { QR_TIMEOUT_MS: '30' }, qrToDataURL: async value => png(value) });
  const init = f.client.initialize(); const rejected = assert.rejects(init, { code: 'WHATSAPP_QR_TIMEOUT' });
  await tick(); f.native.emit('qr', 'first');
  const rotations = setInterval(() => f.native.emit('qr', 'rotated'), 5); t.after(() => clearInterval(rotations));
  await rejected; assert.equal(f.status.online, false); assert.equal(f.status.qrDataUrl, null); assert.ok(f.native.destroyCalls > 0);
});

test('auth_failure before ready rejects startup with a redacted error and closes the browser', async t => {
  const f = fixture(t); const init = f.client.initialize(); const rejected = assert.rejects(init, { code: 'WHATSAPP_AUTH_FAILED' });
  await tick(); f.native.emit('auth_failure', 'SYNTHETIC_PRIVATE_AUTH'); await rejected;
  assert.equal(f.status.online, false); assert.equal(f.status.qrDataUrl, null); assert.ok(f.native.destroyCalls > 0);
  assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_PRIVATE'), false);
});

test('native initialization failures are redacted and cleaned up', async t => {
  const f = fixture(t); f.native.onInitialize = async () => { throw Error('SYNTHETIC_PRIVATE_BROWSER_DATA'); };
  await assert.rejects(f.client.initialize(), { code: 'WHATSAPP_INITIALIZE_FAILED', message: 'WHATSAPP_INITIALIZE_FAILED' });
  assert.equal(f.status.online, false); assert.ok(f.native.destroyCalls > 0);
});

test('a terminal post-ready disconnect requests one restart and immediately blocks sends', async t => {
  const fatal = []; const f = fixture(t, { onFatal: error => fatal.push(error) }); await f.start();
  f.native.emit('disconnected', 'SYNTHETIC_PRIVATE_REASON'); f.native.emit('auth_failure', 'SYNTHETIC_PRIVATE_AUTH');
  assert.equal(fatal.length, 1); assert.equal(fatal[0].code, 'WHATSAPP_DISCONNECTED');
  assert.equal(f.status.online, false); assert.equal(f.status.qrDataUrl, null);
  await assert.rejects(f.client.sendText(PN, 'test'), { code: 'WHATSAPP_NOT_READY' });
  assert.equal(f.native.sends.length, 0); assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_PRIVATE'), false);
});

test('transient state changes suspend readiness; a fresh CONNECTED poll can recover only after ready', async t => {
  const f = fixture(t); await f.start(); f.native.emit('change_state', 'OPENING');
  assert.equal(f.status.online, false); assert.equal(await f.client.getState(), 'CONNECTED'); assert.equal(f.status.online, true);
  f.native.state = 'PAIRING'; assert.equal(await f.client.getState(), null); assert.equal(f.status.online, false);
  f.native.emit('authenticated'); assert.equal(await f.client.getState(), null); assert.equal(f.status.online, false);
  f.native.emit('change_state', 'CONNECTED'); assert.equal(f.status.online, false);
  f.native.emit('ready'); assert.equal(f.status.online, true);
});

test('a stale CONNECTED poll cannot resurrect readiness after terminal disconnect', async t => {
  const f = fixture(t, { onFatal: () => {} }), poll = deferred(); await f.start(); f.native.getStateImpl = () => poll.promise;
  const state = f.client.getState(); f.native.emit('disconnected'); poll.resolve('CONNECTED');
  assert.equal(await state, null); assert.equal(f.status.online, false);
});

test('poll failure marks offline and redacts upstream errors', async t => {
  const f = fixture(t); await f.start(); f.native.getStateImpl = async () => { throw Error('SYNTHETIC_PRIVATE_STATE'); };
  await assert.rejects(f.client.getState(), { code: 'WHATSAPP_STATE_UNAVAILABLE', message: 'WHATSAPP_STATE_UNAVAILABLE' });
  assert.equal(f.status.online, false);
});

test('sendText delegates once to sendMessage with no automatic seen receipt and returns the provider ID', async t => {
  const f = fixture(t); await f.start(); assert.equal(await f.client.sendText(PN, 'test message'), 'synthetic-outgoing-id');
  assert.deepEqual(f.native.sends, [{ to: PN, text: 'test message', options: { sendSeen: false, waitUntilMsgSent: true } }]);
});

test('invalid recipients/text are refused before calling the provider', async t => {
  const f = fixture(t); await f.start();
  for (const to of [LID, '12345@g.us', 'status@broadcast', '12345@newsletter', '', null]) await assert.rejects(f.client.sendText(to, 'test'), { code: 'WHATSAPP_INVALID_RECIPIENT' });
  for (const text of ['', ' ', null, {}, 'x'.repeat(65537)]) await assert.rejects(f.client.sendText(PN, text), { code: 'WHATSAPP_INVALID_TEXT' });
  assert.equal(f.native.sends.length, 0);
});

test('an exception, timeout or missing ID after provider submission has unknown outcome and is never retried', async t => {
  const f = fixture(t, { sendTimeoutMs: 10 }); await f.start();
  for (const result of [undefined, null, {}, { id: {} }, Error('SYNTHETIC_PRIVATE_SEND'), new Promise(() => {})]) {
    f.native.sendImpl = async () => { if (result instanceof Error) throw result; return result; };
    await assert.rejects(f.client.sendText(PN, 'test'), { code: 'WHATSAPP_SEND_UNCONFIRMED', outcome: 'unknown', message: 'WHATSAPP_SEND_UNCONFIRMED' });
  }
  assert.equal(f.native.sends.length, 6);
});

test('the booking transport suppresses retries and duplicate text after an unknown provider send', async t => {
  const f = fixture(t); await f.start(); f.native.sendImpl = async () => { throw Error('synthetic network interruption'); };
  const transport = createTransport({ __SEND_DEDUP: new Map(), log: () => {} }, {});
  assert.equal(await transport.safeSend(f.client, PN, 'prenotazione da verificare'), 'prenotazione da verificare');
  assert.equal(await transport.safeSend(f.client, PN, 'prenotazione da verificare'), '');
  assert.equal(f.native.sends.length, 1);
});

test('shutdown destroys once without logout and late events cannot restore QR/readiness', async t => {
  const f = fixture(t); await f.start();
  await Promise.all([stopWhatsAppClient(f.client), stopWhatsAppClient(f.client)]);
  assert.equal(f.native.destroyCalls, 1); assert.equal(f.native.logoutCalls, 0);
  f.native.emit('ready'); f.native.emit('qr', 'late'); f.native.emit('change_state', 'CONNECTED'); await tick();
  assert.equal(f.status.online, false); assert.equal(f.status.qrDataUrl, null); assert.equal(await f.client.getState(), null);
});

test('bounded drain rejects new input but lets already-running booking work send before destroy', async t => {
  const f = fixture(t), received = []; f.client.onMessage(value => received.push(value)); await f.start();
  f.client.beginShutdown(); f.native.emit('message', message()); f.native.emit('ready'); f.native.emit('change_state', 'CONNECTED'); await tick();
  assert.equal(f.status.online, false); assert.deepEqual(received, []);
  assert.equal(await f.client.sendText(PN, 'transaction finished'), 'synthetic-outgoing-id');
  await f.client.destroy(); await assert.rejects(f.client.sendText(PN, 'too late'), { code: 'WHATSAPP_NOT_READY' });
});

test('SIGTERM while awaiting QR cancels readiness and destroys without logging out', async t => {
  const f = fixture(t); const init = f.client.initialize(); const rejected = assert.rejects(init, { code: 'WHATSAPP_STOPPED' });
  await tick(); await f.client.destroy(); await rejected;
  assert.equal(f.status.qrDataUrl, null); assert.equal(f.native.logoutCalls, 0); assert.equal(f.native.listenerCount('qr'), 0);
});

test('a browser whose launch finishes after shutdown is closed again and never becomes ready', async t => {
  const f = fixture(t), launch = deferred(); f.native.onInitialize = () => launch.promise;
  const init = f.client.initialize(); const rejected = assert.rejects(init, { code: 'WHATSAPP_STOPPED' });
  await tick(); await f.client.destroy(); await rejected; launch.resolve(); await tick();
  assert.equal(f.native.browserOpen, false); assert.ok(f.native.destroyCalls >= 2); assert.equal(f.status.online, false);
});
