/** Persistent WhatsApp inbox: only keyed SHA-256 hashes, no customer text/phone.
 * Complements (not replaces) in-process per-chat ordering.
 * A timeout or crash mid-action still requires booking idempotency.
 */
import { createHash } from 'node:crypto';

export function messageIdHash(key) {
  if (typeof key !== 'string' || !key || key.length > 500) throw new Error('Invalid message key');
  return createHash('sha256').update(key).digest('hex');
}

export function createPersistentMessageInbox(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('PostgreSQL required');
  return {
    async acquire(key) {
      const hash = messageIdHash(key);
      const result = await db.query(`INSERT INTO public.whatsapp_message_inbox
        (message_hash, status, attempts, lease_until)
        VALUES ($1,'processing',1,now()+interval '5 minutes')
        ON CONFLICT (message_hash) DO UPDATE
        SET attempts=public.whatsapp_message_inbox.attempts+1,
            status='processing', lease_until=now()+interval '5 minutes'
        WHERE public.whatsapp_message_inbox.status='processing'
          AND public.whatsapp_message_inbox.lease_until < now()
        RETURNING message_hash`, [hash]);
      return result.rowCount === 1;
    },
    async complete(key) {
      const result = await db.query(`UPDATE public.whatsapp_message_inbox
        SET status='completed', lease_until=NULL, completed_at=now()
        WHERE message_hash=$1 AND status='processing'`, [messageIdHash(key)]);
      if (result.rowCount !== 1) throw new Error('Message inbox completion failed');
    },
    async release(key) {
      await db.query(`UPDATE public.whatsapp_message_inbox
        SET lease_until=now()-interval '1 second' WHERE message_hash=$1 AND status='processing'`, [messageIdHash(key)]);
    },
    async prune() {
      const result = await db.query(`DELETE FROM public.whatsapp_message_inbox
        WHERE status='completed' AND completed_at < now()-interval '30 days'`);
      return result.rowCount || 0;
    },
  };
}
