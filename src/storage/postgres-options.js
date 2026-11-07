import fs from 'node:fs';

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} non valido`);
  return parsed;
}

export function postgresOptions(env = process.env) {
  const options = {
    max: positiveInteger(env.PG_POOL_MAX, 10, 'PG_POOL_MAX'),
    connectionTimeoutMillis: positiveInteger(env.PG_CONNECT_TIMEOUT_MS, 5000, 'PG_CONNECT_TIMEOUT_MS'),
    idleTimeoutMillis: positiveInteger(env.PG_IDLE_TIMEOUT_MS, 30_000, 'PG_IDLE_TIMEOUT_MS'),
  };
  let mode = env.PGSSLMODE;
  let caFile = env.PGSSLROOTCERT;
  let certFile = env.PGSSLCERT;
  let keyFile = env.PGSSLKEY;
  if (env.DATABASE_URL) {
    let url;
    try { url = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL non valido'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Protocollo DATABASE_URL non valido');
    const urlSsl = url.searchParams.get('ssl');
    if (urlSsl !== null && !['true', 'false', '1', '0'].includes(urlSsl)) throw new Error('Parametro SSL DATABASE_URL non valido');
    mode = url.searchParams.get('sslmode') ||
      (['true', '1'].includes(urlSsl) ? 'require' : ['false', '0'].includes(urlSsl) ? 'disable' : mode);
    caFile = url.searchParams.get('sslrootcert') || caFile;
    certFile = url.searchParams.get('sslcert') || certFile;
    keyFile = url.searchParams.get('sslkey') || keyFile;
    // pg replaces the entire ssl object if these parameters remain in the URL.
    for (const key of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
    options.connectionString = url.toString();
  } else {
    Object.assign(options, {
      host: env.PGHOST || '127.0.0.1',
      port: positiveInteger(env.PGPORT, 5432, 'PGPORT'),
      user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE,
    });
  }
  if (mode === 'no-verify') throw new Error('PGSSLMODE=no-verify non supportato: configurare PGSSLROOTCERT');
  if (mode && !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) {
    throw new Error('PGSSLMODE non valido');
  }
  const useSsl = env.PG_SSL === '1' || (mode && mode !== 'disable') || caFile || certFile || keyFile;
  options.ssl = useSsl ? {
    rejectUnauthorized: true,
    ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}),
    ...(certFile ? { cert: fs.readFileSync(certFile, 'utf8') } : {}),
    ...(keyFile ? { key: fs.readFileSync(keyFile, 'utf8') } : {}),
  } : false;
  return options;
}
