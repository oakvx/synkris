/** In-process serialization and replay suppression for OpenWA message callbacks.
 * The provider is not an exactly-once source. This protects live conversations;
 * persistence across restarts requires a provider-id inbox table in PostgreSQL.
 */
export function createMessageDispatcher({ handle, inbox = null, now = () => Date.now(),
  dedupeTtlMs = 10 * 60_000, maxChats = 10_000, maxQueuedPerChat = 25 } = {}) {
  if (typeof handle !== 'function') throw new TypeError('handle must be a function');
  const queues = new Map();
  const seen = new Map();
  let submitted = 0;
  const prune = () => {
    const cutoff = now() - dedupeTtlMs;
    for (const [key, expiry] of seen) if (expiry <= cutoff) seen.delete(key);
  };
  async function submit(message) {
    const chatId = String(message?.from || '');
    if (!chatId || chatId.length > 180) return { processed: false, reason: 'invalid_sender' };
    const rawId = message?.id?._serialized ?? message?.id;
    const messageId = typeof rawId === 'string' && rawId.length <= 240 ? rawId : null;
    if (++submitted % 100 === 0) prune();
    const dedupeKey = messageId ? `${chatId}:${messageId}` : null;
    if (dedupeKey && seen.get(dedupeKey) > now()) return { processed: false, reason: 'duplicate' };
    const existing = queues.get(chatId);
    if (existing && existing.depth >= maxQueuedPerChat) return { processed: false, reason: 'queue_full' };
    if (!existing && queues.size >= maxChats) return { processed: false, reason: 'at_capacity' };
    if (dedupeKey) {
      if (seen.size >= maxChats * maxQueuedPerChat) prune();
      seen.set(dedupeKey, now() + dedupeTtlMs);
    }
    const previous = existing?.tail || Promise.resolve();
    const record = existing || { tail: previous, depth: 0 };
    record.depth += 1;
    queues.set(chatId, record);
    const task = previous.catch(() => {}).then(async () => {
      if (dedupeKey && inbox && !(await inbox.acquire(dedupeKey))) {
        return { processed: false, reason: 'duplicate' };
      }
      try {
        const result = await handle(message);
        if (dedupeKey && inbox) await inbox.complete(dedupeKey);
        return { processed: true, result };
      } catch (error) {
        if (dedupeKey) {
          seen.delete(dedupeKey);
          if (inbox) await inbox.release(dedupeKey).catch(() => {});
        }
        throw error;
      }
    });
    record.tail = task;
    try {
      return await task;
    } finally {
      record.depth -= 1;
      if (record.depth === 0 && queues.get(chatId) === record) queues.delete(chatId);
    }
  }
  return { submit, snapshot: () => ({ activeChats: queues.size, dedupeEntries: seen.size }) };
}
