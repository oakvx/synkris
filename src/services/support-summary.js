const bool = value => typeof value === 'boolean' ? value : null;
const allowed = (value, values) => values.includes(value) ? value : 'unknown';

// Allowlist rather than regex-redacting arbitrary logs: never copy contacts,
// error messages, queue contents, tokens, model prompts or provider payloads.
export function filterRuntimeDiagnostics(data = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  return {schema:1,scope:'runtime-status',
    whatsappReady:bool(data.whatsappReady),databaseReady:bool(data.databaseReady),
    calendarMaintenance:bool(data.calendarMaintenance),aiConfigured:bool(data.aiConfigured),
    calendarStatus:allowed(data.lastInboundSyncStatus,['ok','error','partial','disabled','suspended_for_reconciliation','unknown'])};
}

export async function collectRuntimeSummary({env = process.env, fetchImpl = globalThis.fetch} = {}) {
  const port = Number(env.ADMIN_PORT || 3000);
  if (typeof env.ADMIN_TOKEN !== 'string' || env.ADMIN_TOKEN.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('runtime_unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),4000);timeout.unref?.();
  try {
    // Executed INSIDE the existing bot container, never against a host port
    // that could belong to another application. No redirect can forward auth.
    const response = await fetchImpl('http://127.0.0.1:'+port+'/diagnostics',{
      headers:{'X-Admin-Token':env.ADMIN_TOKEN},redirect:'error',signal:controller.signal});
    if (response.status !== 200 || !response.body) throw new Error('runtime_unavailable');
    const reader = response.body.getReader();const chunks = [];let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 32768) { controller.abort();throw new Error('runtime_unavailable'); }
        chunks.push(Buffer.from(item.value));
      }
    } finally { reader.releaseLock(); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('runtime_unavailable');
    return filterRuntimeDiagnostics(data);
  } catch { throw new Error('runtime_unavailable'); }
  finally { clearTimeout(timeout);controller.abort(); }
}
