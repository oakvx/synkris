// migrate-jsonb-bookings-to-norm.js
// Migra da tabella vecchia "bookings" (JSONB) al nuovo schema normalizzato.
// Uso:
//   node migrate-jsonb-bookings-to-norm.js
//
// Richiede DATABASE_URL (o variabili PG*) e che esistano:
// - bookings-pg.js  (vecchio storage JSONB)
// - bookings-norm-pg.js (nuovo storage normalizzato)

import { initBookingsDbPg, listBookingsPg } from "./bookings-pg.js";
import { initBookingsNormDbPg, bulkUpsertBookingsNormPg } from "./bookings-norm-pg.js";

async function main() {
  await initBookingsDbPg();
  const rows = await listBookingsPg();
  const arr = Array.isArray(rows) ? rows : [];

  if (!arr.length) {
    console.log("Nessun record trovato nella tabella bookings (JSONB).");
    return;
  }

  await initBookingsNormDbPg();
  await bulkUpsertBookingsNormPg(arr);

  console.log(`OK: migrati ${arr.length} record nel nuovo schema normalizzato.`);
}

main().catch((e) => {
  console.error("Migrazione fallita:", e?.message || e);
  process.exit(1);
});
