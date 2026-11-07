/**
 * Signed-license monitor: only transient read failures are tolerated.
 * Signature, HWID and expiration failures immediately fail closed.
 * This DOES NOT provide online revocation of previously signed offline licenses.
 */
export function createLicenseMonitor({ readLicense, verify, now = () => Date.now(),
  outageGraceMs = 10 * 60_000 } = {}) {
  if (typeof readLicense !== 'function' || typeof verify !== 'function') throw new Error('Missing license handlers');
  if (!Number.isFinite(outageGraceMs) || outageGraceMs < 0 || outageGraceMs > 3600_000) throw new Error('Invalid read grace');
  let lastVerifiedAt = null;
  let signedDeadline = null;
  let status = 'unverified';
  const snapshot = () => ({ status, lastVerifiedAt });
  async function check() {
    // A large clock rollback could artificially extend an offline license.
    // Minor NTP corrections are tolerated. This is process-local protection,
    // not an anti-tamper guarantee for machines controlled by the user.
    if (lastVerifiedAt != null && now() < lastVerifiedAt - 5 * 60_000) {
      status = 'invalid';
      throw new Error('System clock rollback detected');
    }
    let text;
    try { text = await readLicense(); }
    catch (err) {
      const code = String(err?.code || '');
      const isIoError = ['EACCES', 'ENOENT', 'EIO', 'ETIMEDOUT', 'EBUSY'].includes(code);
      if (isIoError && lastVerifiedAt != null && now() <= lastVerifiedAt + outageGraceMs && now() <= signedDeadline) {
        status = 'temporary_read_failure';
        return { ok: true, degraded: true };
      }
      status = 'invalid';
      throw err;
    }
    try {
      const result = await verify(text);
      const payload = result?.payload;
      const raw = payload?.expiry ?? payload?.expiryAt ?? payload?.exp;
      const expiryMs = Number.isFinite(+raw) ? Number(raw) : Date.parse(raw);
      const graceDays = Number.isFinite(+payload?.graceDays) ? Number(payload.graceDays) : 7;
      const deadline = expiryMs + Math.max(0, graceDays) * 86400_000;
      if (!Number.isFinite(deadline) || now() > deadline) throw new Error('Signed license expired');
      signedDeadline = deadline;
      lastVerifiedAt = now();
      status = 'valid';
      return { ok: true, degraded: false };
    } catch (err) { status = 'invalid'; throw err; }
  }
  return { check, snapshot };
}
