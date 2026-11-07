/** Errori PostgreSQL per cui un tentativo successivo può riuscire. */
export function isRetryableBookingDbError(error) {
  const code = String(error?.code || '');
  return code.startsWith('08') || ['40001', '40P01', '53300', '57P01', '57P02',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code);
}
