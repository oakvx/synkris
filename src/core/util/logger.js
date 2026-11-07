import { getTraceId } from '../../observability/metrics.js';
// ============== Logger ==============
const LV = ["error", "warn", "info", "debug"];
const configuredLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const CUR = LV.includes(configuredLevel) ? configuredLevel : 'info';
const okLevel = l => LV.includes(l) && LV.indexOf(l) <= LV.indexOf(CUR);
const sensitiveField = /^(?:text|body|message|preview|prompt|chatId|clientChatId|phone|clientPhone|customerName|full_name|email|token|password|private_key|credentials|license|authorization)$|(?:password|secret|token|privatekey)/i;

function redactString(value) {
  return String(value)
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"']+/gi, '[database URL]')
    .replace(/\b\d{5,20}@c\.us\b/gi, '[chat]')
    .replace(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, '[private key]');
}

export function safeJSON(o) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(o, (k, v) => {
      if (k && sensitiveField.test(k)) return '[redacted]';
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return typeof v === 'string' ? redactString(v) : v;
    });
  } catch {
    try {
      return redactString(o);
    } catch {
      return "[unserializable]";
    }
  }
}

export function log(level, msg, payload = null) {
  const lvl = String(level || '').toLowerCase();
  if (!okLevel(lvl)) return;
  const traceId = getTraceId();
  const ts = new Date().toISOString();
  const format = (process.env.LOG_FORMAT || 'json').toLowerCase();
  let line;
  if (format === 'json') {
    let safePayload = null;
    if (payload != null) {
      try { safePayload = JSON.parse(safeJSON(payload)); }
      catch { safePayload = '[unserializable]'; }
    }
    line = JSON.stringify({ timestamp: ts, level: lvl, event: redactString(msg),
      ...(traceId ? { traceId } : {}), ...(safePayload == null ? {} : { data: safePayload }) });
  } else {
    line = `[${ts}] [${lvl.toUpperCase()}] ${redactString(msg)}${payload == null ? '' : ' ' + safeJSON(payload)}`;
  }
  (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
}
