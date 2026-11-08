/** whatsapp-web.js boundary. The booking core keeps its small sendText/onMessage API.
 * QR material stays in RAM; LocalAuth/profile and web cache stay in the private runtime.
 * Native message objects never reach persistence or the conversation orchestrator.
 */
import fs from 'node:fs';
import whatsappWeb from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { whatsappOptions, isWhatsAppConnectedState } from './whatsapp-options.js';
import { validChatId } from './salon-operations.js';

const TEXT_TYPES = new Set(['chat', 'image', 'video', 'document', 'buttons_response', 'list_response', 'template_button_reply']);
function providerError(code, outcome) {
  const error = new Error(code);
  error.code = code;
  if (outcome) error.outcome = outcome;
  return error;
}

async function withDeadline(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(providerError(code)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Resolve LIDs using the provider's explicit PN mapping, never treating LID digits as a phone. */
export async function normalizeWhatsAppMessage(message, client, { lookupTimeoutMs = 5000 } = {}) {
  if (!message || message.fromMe || message.id?.fromMe || message.isGroupMsg || message.isStatus || message.broadcast) return null;
  const from = message.from;
  if (typeof from !== 'string' || (!validChatId(from) && !/^\d{1,30}@lid$/.test(from))) return null;
  if (!TEXT_TYPES.has(message.type)) return null;
  const body = (typeof message.body === 'string' ? message.body : typeof message.caption === 'string' ? message.caption : '').trim();
  const id = message.id?._serialized ?? message.id;
  if (!body || body.length > 4000 || typeof id !== 'string' || !id || id.length > 240) return null;
  let chatId = from;
  if (from.endsWith('@lid')) {
    if (typeof client?.getContactLidAndPhone !== 'function') return null;
    const mappings = await withDeadline(client.getContactLidAndPhone([from]), lookupTimeoutMs, 'WHATSAPP_CONTACT_TIMEOUT');
    const match = Array.isArray(mappings) ? mappings.find(item => item?.lid === from && validChatId(item?.pn)) : null;
    if (!match) return null;
    chatId = match.pn;
  }
  return { id, from: chatId.toLowerCase(), body, fromMe: false, isGroupMsg: false };
}

/** Factories/encoder are injectable for offline contract tests, not runtime bypass flags. */
export function createWhatsAppClient({ env = process.env, status = {}, logger = () => {}, onFatal = null,
  clientFactory = options => new whatsappWeb.Client(options), qrToDataURL = QRCode.toDataURL,
  now = () => Date.now(), maxPendingMessages = 250, lookupTimeoutMs = 5000, sendTimeoutMs = 15_000 } = {}) {
  if (!Number.isInteger(maxPendingMessages) || maxPendingMessages < 1 ||
      !Number.isInteger(lookupTimeoutMs) || lookupTimeoutMs < 1 || lookupTimeoutMs > 60_000 ||
      !Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 60_000) throw new TypeError('Invalid provider queue/timeout limits');
  const { clientId, dataPath, qrTimeoutMs, ...clientOptions } = whatsappOptions(env);
  const authStrategy = new whatsappWeb.LocalAuth({ clientId, dataPath });
  let native;
  try { native = clientFactory({ ...clientOptions, authStrategy }); }
  catch { throw providerError('WHATSAPP_CLIENT_INIT_FAILED'); }

  let started = false, initialized = false, readySeen = false, connected = false;
  let draining = false, destroyed = false, everReady = false;
  let terminalError = null, initialization = null, destruction = null;
  let resolveReady, rejectReady, qrTimer;
  let qrGeneration = 0, connectionGeneration = 0, pendingMessages = 0;
  let incoming = Promise.resolve();
  const handlers = new Set();
  const canSend = () => initialized && readySeen && connected && !terminalError && !destroyed;
  const canReceive = () => canSend() && !draining;
  const publishOnline = () => {
    status.online = canReceive();
    if (status.online) everReady = true;
  };
  const clearQR = () => {
    qrGeneration++;
    clearTimeout(qrTimer);
    qrTimer = undefined;
    status.qrDataUrl = null;
    status.qrUpdatedAt = 0;
  };
  const report = code => logger('warn', 'whatsapp_provider_event', { code });
  const fail = code => {
    if (destroyed || terminalError) return;
    terminalError = providerError(code);
    connectionGeneration++;
    connected = false;
    clearQR();
    publishOnline();
    status.lastError = code;
    rejectReady?.(terminalError);
    // Startup failures reject initialize(). Post-ready failures must restart the bot,
    // otherwise /health would stay green around a permanently closed native client.
    if (everReady && !draining) {
      if (onFatal) {
        try { Promise.resolve(onFatal(terminalError)).catch(() => { report('WHATSAPP_FATAL_HANDLER_FAILED'); void adapter.destroy(); }); }
        catch { report('WHATSAPP_FATAL_HANDLER_FAILED'); void adapter.destroy(); }
      } else { void adapter.destroy(); }
    }
  };
  const listeners = {
    qr(value) {
      if (!started || destroyed || draining || terminalError || typeof value !== 'string' || !value || value.length > 4096) return;
      readySeen = false;
      connected = false;
      connectionGeneration++;
      // Keep a configured QR deadline across rotations, but invalidate older encodes.
      const deadline = qrTimer;
      qrGeneration++;
      status.qrDataUrl = null;
      status.qrUpdatedAt = 0;
      if (!deadline && qrTimeoutMs) qrTimer = setTimeout(() => fail('WHATSAPP_QR_TIMEOUT'), qrTimeoutMs);
      publishOnline();
      const generation = qrGeneration, issuedAt = now();
      void Promise.resolve().then(() => qrToDataURL(value, { type: 'image/png', errorCorrectionLevel: 'M', margin: 2, width: 320 }))
        .then(data => {
          if (generation !== qrGeneration || destroyed || draining || terminalError || readySeen) return;
          if (typeof data !== 'string' || data.length >= 200000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data)) {
            report('WHATSAPP_QR_ENCODING_FAILED'); return;
          }
          status.qrDataUrl = data;
          status.qrUpdatedAt = issuedAt;
        }).catch(() => { if (generation === qrGeneration && !destroyed) report('WHATSAPP_QR_ENCODING_FAILED'); });
    },
    authenticated() {
      readySeen = false;
      connected = false;
      connectionGeneration++;
      clearQR();
      publishOnline();
    },
    ready() {
      if (!started || destroyed || draining || terminalError) return;
      readySeen = true;
      connected = true;
      connectionGeneration++;
      clearQR();
      publishOnline();
      resolveReady?.();
    },
    change_state(state) {
      if (destroyed || terminalError) return;
      connectionGeneration++;
      connected = isWhatsAppConnectedState(state);
      publishOnline();
    },
    auth_failure() { fail('WHATSAPP_AUTH_FAILED'); },
    disconnected() { fail('WHATSAPP_DISCONNECTED'); },
    error() { fail('WHATSAPP_CLIENT_ERROR'); },
    message(message) {
      if (!canReceive()) return;
      if (pendingMessages >= maxPendingMessages) { report('WHATSAPP_INBOUND_CAPACITY'); return; }
      const generation = connectionGeneration;
      pendingMessages++;
      // Serialize only normalization/submission (not the booking work). This keeps
      // order even when a LID lookup is slower than the following PN message.
      incoming = incoming.then(async () => {
        if (!canReceive() || generation !== connectionGeneration) return;
        const normalized = await normalizeWhatsAppMessage(message, native, { lookupTimeoutMs });
        if (!normalized || !canReceive() || generation !== connectionGeneration) return;
        for (const handler of handlers) {
          try { Promise.resolve(handler(normalized)).catch(() => report('WHATSAPP_MESSAGE_HANDLER_FAILED')); }
          catch { report('WHATSAPP_MESSAGE_HANDLER_FAILED'); }
        }
      }).catch(() => report('WHATSAPP_MESSAGE_NORMALIZATION_FAILED')).finally(() => { pendingMessages--; });
    },
  };
  for (const [event, listener] of Object.entries(listeners)) native.on(event, listener);
  status.online = false;
  clearQR();
  const closeNative = async () => {
    try { await native.destroy(); }
    catch { report('WHATSAPP_DESTROY_FAILED'); }
  };

  const adapter = {
    initialize() {
      if (initialization) return initialization;
      if (destroyed || draining || terminalError) return Promise.reject(terminalError || providerError('WHATSAPP_STOPPED'));
      started = true;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const launch = Promise.resolve().then(async () => {
        if (destroyed) throw providerError('WHATSAPP_STOPPED');
        fs.mkdirSync(dataPath, { recursive: true, mode: 0o700 });
        const executablePath = clientOptions.puppeteer.executablePath;
        if (executablePath && !fs.statSync(executablePath).isFile()) throw providerError('WHATSAPP_CHROME_MISSING');
        await native.initialize();
        initialized = true;
        publishOnline();
      }).catch(() => {
        fail('WHATSAPP_INITIALIZE_FAILED');
        throw terminalError || providerError('WHATSAPP_STOPPED');
      }).finally(async () => {
        // SIGTERM may precede completion of puppeteer.launch(). Close a late browser too.
        if (destroyed) { await destruction; await closeNative(); }
      });
      initialization = Promise.all([launch, ready]).then(() => {
        if (destroyed || draining || terminalError) throw terminalError || providerError('WHATSAPP_STOPPED');
        return adapter;
      }).catch(async error => { await adapter.destroy(); throw error; });
      return initialization;
    },
    onMessage(handler) {
      if (typeof handler !== 'function') throw new TypeError('Message handler required');
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async sendText(to, text) {
      if (!validChatId(to)) throw providerError('WHATSAPP_INVALID_RECIPIENT');
      if (typeof text !== 'string' || !text.trim() || text.length > 65536) throw providerError('WHATSAPP_INVALID_TEXT');
      if (!canSend()) throw providerError('WHATSAPP_NOT_READY');
      try {
        const result = await withDeadline(
          native.sendMessage(to.toLowerCase(), text, { sendSeen: false, waitUntilMsgSent: true }),
          sendTimeoutMs, 'WHATSAPP_SEND_UNCONFIRMED');
        const id = result?.id?._serialized;
        if (typeof id !== 'string' || !id) throw providerError('WHATSAPP_SEND_UNCONFIRMED');
        return id;
      } catch {
        // After handing a send to WhatsApp an exception/null result may follow
        // submission. Never automatically replay an ambiguous send.
        throw providerError('WHATSAPP_SEND_UNCONFIRMED', 'unknown');
      }
    },
    async getState() {
      if (!initialized || !readySeen || destroyed || terminalError || draining) return null;
      const generation = connectionGeneration;
      let state;
      try { state = await native.getState(); }
      catch {
        if (generation === connectionGeneration) { connected = false; publishOnline(); }
        throw providerError('WHATSAPP_STATE_UNAVAILABLE');
      }
      if (generation !== connectionGeneration || destroyed || terminalError || draining) return null;
      connected = isWhatsAppConnectedState(state);
      publishOnline();
      return status.online ? state : null;
    },
    beginShutdown() {
      draining = true;
      connectionGeneration++;
      clearQR();
      publishOnline();
    },
    destroy() {
      if (destruction) return destruction;
      adapter.beginShutdown();
      destroyed = true;
      rejectReady?.(terminalError || providerError('WHATSAPP_STOPPED'));
      handlers.clear();
      // Keep a redacting error listener for late native errors while launch unwinds.
      for (const [event, listener] of Object.entries(listeners)) if (event !== 'error') native.off(event, listener);
      destruction = closeNative();
      return destruction;
    },
  };
  return adapter;
}
