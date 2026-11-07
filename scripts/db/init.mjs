import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPgPool } from '../../src/storage/postgres.js';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL obbligatorio per inizializzare il database');
  }

  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const pool = createPgPool();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Schema PostgreSQL inizializzato. Nessun dato locale importato.');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error) => {
  // Non stampare URL di connessione, credenziali o contenuti delle query.
  console.error('Inizializzazione database fallita:', error.code || error.message);
  process.exitCode = 1;
});
