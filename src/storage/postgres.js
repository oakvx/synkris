import pg from 'pg';
import { postgresOptions } from './postgres-options.js';

export function createPgPool(env = process.env) {
  const pool = new pg.Pool(postgresOptions(env));
  // An idle connection error must not become an unhandled EventEmitter error.
  pool.on('error', () => console.error('[postgres] Connessione inattiva interrotta; il pool si riconnetterà'));
  return pool;
}
