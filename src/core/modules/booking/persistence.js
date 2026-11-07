/**
 * booking/persistence: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const {
    __MAX_RETRY_ITEMS,
    __initBookingsCacheFromPg,
    __loadIdMaps,
    __pgPool,
    __pgQuery,
    __pgWriteQueue,
    bulkUpsertBookingsNormPg,
    getBusyIntervalsForDay,
    isRetryableBookingDbError,
    log,
    now,
  } = dependencies;

function _asBookingsArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.bookings)) return data.bookings;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.items)) return data.items;

  // Supporta formato "mappa" (es. {id: booking, ...} o {phone: [booking,...], ...})
  if (data && typeof data === "object") {
    const vals = Object.values(data);
    const flat = [];
    for (const v of vals) {
      if (!v) continue;
      if (Array.isArray(v)) flat.push(...v);
      else if (typeof v === "object") flat.push(v);
    }

    const isBookingLike = (o) =>
      o &&
      typeof o === "object" &&
      (o.eventId || o.startTime || o.start || o.datetime || o.date) &&
      (o.service || o.serviceName || o.professionalEmail || o.professionalName);

    const out = flat.filter(isBookingLike);
    if (out.length) return out;
  }

  return [];
}

function loadBookings() {
  // Sync: usiamo cache in RAM (riempita da PostgreSQL all’avvio).
  if (!Array.isArray(shared.__bookingsCache)) shared.__bookingsCache = [];
  return shared.__bookingsCache;
}

async function saveBookings(arr) {
  if (!Array.isArray(arr)) {
    log("error", "[bookings] saveBookings expected an array", {
      type: typeof arr
    });
    return false;
  }

  const clean = arr.filter((x) => x && typeof x === "object");

  // Se il DB non è ok, prova un re-init una volta.
  if (!shared.__bookingsDBOk) {
    await __initBookingsCacheFromPg();
    if (!shared.__bookingsDBOk) {
      log("error", "[bookings] PostgreSQL non disponibile: impossibile salvare", {
        error: String(shared.__bookingsDBInitErr?.message || shared.__bookingsDBInitErr || "unknown"),
      });
      // Do not queue an unconfirmed booking: the caller may cancel its Google
      // event, and a delayed retry would create a ghost booking in PostgreSQL.
      return false;
    }
  }

  try {
    // Un'unica transazione per l'intero batch. In caso di errore non pubblichiamo
    // nella cache record che non sono stati confermati da PostgreSQL.
    await bulkUpsertBookingsNormPg(clean);
    shared.__bookingsCache.length = 0;
    shared.__bookingsCache.push(...clean);
    return true;
  } catch (e) {
    log('error', '[bookings] Salvataggio fallito', { code: e?.code || 'unknown' });
    if (!isRetryableBookingDbError(e)) {
      // Vincoli 23P01 (overlap), 23505 (unique), FK: errore definitivo.
      // Non avviare retry che potrebbero occupare uno slot gia' assegnato.
      return false;
    }
    shared.__bookingsDBOk = false;
    shared.__bookingsDBInitErr = e;
    // Permanent and transient failures both leave the booking unconfirmed.
    // A user retry must create a new journalled operation, not replay stale data.
    return false;
  }
}

function enqueueBookingsForRetry(records) {
  if (__pgWriteQueue.length + records.length > __MAX_RETRY_ITEMS) {
    log('error', '[bookings] Coda retry piena: intervento richiesto', {
      queued: __pgWriteQueue.length, rejected: records.length
    });
    return false;
  }
  __pgWriteQueue.push(...records);
  return true;
}

async function __drainPgWriteQueue() {
  if (shared.__retryBusy || !__pgWriteQueue.length) return;
  shared.__retryBusy = true;
  try {
    const batch = __pgWriteQueue.splice(0, __pgWriteQueue.length);
    try {
      await bulkUpsertBookingsNormPg(batch);
      // Ricaricare invece di sovrascrivere altri salvataggi concurrenti.
      await __initBookingsCacheFromPg();
      log('info', '[bookings] Retry PostgreSQL completato', { count: batch.length });
    } catch (e) {
      if (isRetryableBookingDbError(e)) {
        __pgWriteQueue.unshift(...batch);
      } else {
        log('error', '[bookings] Retry bloccato da errore permanente', { code: e?.code || 'unknown' });
      }
    }
  } finally {
    shared.__retryBusy = false;
  }
}

function _bkDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function _bkPhoneKey(v) {
  let d = _bkDigits(v);
  // normalizza Italia: +39 / 0039 / 39
  d = d.replace(/^00?39/, "").replace(/^39/, "");
  return d;
}

function _bkToISO(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? v.toISOString() : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function _bkEnsureTimes(b) {
  if (!b || typeof b !== "object") return b;

  // duration
  const durMin = Number(b.durationMin ?? b.duration ?? b.minutes ?? 0) || 0;
  if (durMin > 0) b.durationMin = durMin;

  // start
  const startISO = _bkToISO(
    b.startTime ?? b.start ?? b.datetime ?? b.date ?? b.when ?? b.day ?? null
  );
  if (startISO) b.startTime = startISO;

  const startMs = Number(b.startMs);
  const sMs = Number.isFinite(startMs) ? startMs : startISO ? Date.parse(startISO) : NaN;
  if (Number.isFinite(sMs)) b.startMs = sMs;

  // end (se manca o è incoerente, ricostruiscilo da duration)
  const endISO = _bkToISO(b.endTime ?? b.end ?? null);
  let eMs = Number(b.endMs);
  if (!Number.isFinite(eMs)) {
    if (endISO) eMs = Date.parse(endISO);
    else if (Number.isFinite(sMs) && durMin > 0) eMs = sMs + durMin * 60_000;
  }
  if (Number.isFinite(eMs) && Number.isFinite(sMs) && eMs > sMs) {
    b.endMs = eMs;
    b.endTime = new Date(eMs).toISOString();
  }

  // phone
  if (b.clientPhone) b.clientPhone = _bkDigits(b.clientPhone);
  if (!b.clientPhone && b.phone) b.clientPhone = _bkDigits(b.phone);

  // service
  if (!b.service && b.serviceName) b.service = b.serviceName;

  return b;
}

async function persistBooking(rec) {
  try {
    if (!rec || typeof rec !== "object") return false;

    if (!shared.__bookingsDBOk) await __initBookingsCacheFromPg();
    if (!shared.__bookingsDBOk) return false;
    const arr = loadBookings();
    const nowIso = new Date().toISOString();

    const incoming = _bkEnsureTimes({
      ...rec,
      updatedAt: nowIso,
      createdAt: rec.createdAt || nowIso,
    });

    // Normalizza service_id/serviceId per compatibilità con bulkUpsertBookingsNormPg -> appointments
    if ((incoming.service_id == null && incoming.serviceId == null) && incoming.service) {
      try {
        // Passo 1: mappa in RAM
        if (shared.__svcNameToId.size === 0) await __loadIdMaps();
        let sid = shared.__svcNameToId.get(String(incoming.service || "")) || null;

        // Passo 2: query diretta al DB se la mappa non ha il servizio
        // (es. il servizio è stato aggiunto dopo l'avvio e il refresh non è ancora avvenuto)
        if (!sid && __pgPool) {
          const rows = await __pgQuery(
            `SELECT service_id FROM public.services
                         WHERE is_active = true AND lower(service_name) = lower($1) LIMIT 1`,
            [String(incoming.service || "")]
          );
          if (rows && rows[0]) sid = Number(rows[0].service_id) || null;
        }

        if (sid) {
          incoming.serviceId = sid;
          incoming.service_id = sid;
        } else {
          log("warn", "[persistBooking] service_id non trovato né in mappa né in DB", {
            service: incoming.service,
            mapSize: shared.__svcNameToId.size,
          });
        }
      } catch (e) {
        log("warn", "[persistBooking] errore risoluzione service_id", {
          error: String(e?.message || e)
        });
      }
    }

    // opzionale: normalizza professional_id
    if ((incoming.professional_id == null && incoming.professionalId == null) && incoming.professionalEmail) {
      try {
        if (shared.__proEmailToId.size === 0) await __loadIdMaps();
        const pid = shared.__proEmailToId.get(String(incoming.professionalEmail || "").toLowerCase()) || null;
        if (pid) {
          incoming.professionalId = pid;
          incoming.professional_id = pid;
        } else {
          log("warn", "[persistBooking] professionalEmail non trovata in __proEmailToId", {
            email: incoming.professionalEmail,
            mapSize: shared.__proEmailToId.size,
          });
        }
      } catch (e) {
        log("warn", "[persistBooking] errore risoluzione professional_id", {
          error: String(e?.message || e)
        });
      }
    }

    const inPhoneKey = _bkPhoneKey(incoming.clientPhone || incoming.phone || "");
    const inStartISO = _bkToISO(
      incoming.startTime ||
      incoming.startMs ||
      incoming.start ||
      incoming.datetime ||
      incoming.date ||
      incoming.day
    );

    const mergeAt = async (idx) => {
      if (idx < 0) return false;
      const updated = arr.slice();
      updated[idx] = _bkEnsureTimes({
        ...arr[idx],
        ...incoming,
        createdAt: arr[idx]?.createdAt || incoming.createdAt || nowIso,
        updatedAt: nowIso,
      });
      try {
        await bulkUpsertBookingsNormPg([updated[idx]]);
        // Refresh only the affected record; concurrent requests must not replay
        // the whole stale in-memory appointment list into PostgreSQL.
        arr[idx] = updated[idx];
        return true;
      } catch (error) {
        log('error', '[persistBooking] Failed to merge', { code: error?.code || 'unknown' });
        return false;
      }
    };

    // 1) Dedup: eventId vince
    if (incoming.eventId) {
      const idx = arr.findIndex((b) => b && b.eventId === incoming.eventId);
      if (idx >= 0) return await mergeAt(idx);
    }

    // 2) Dedup: composite (phone + startTime)
    if (inPhoneKey && inStartISO) {
      const idx = arr.findIndex((b) => {
        const pKey = _bkPhoneKey(b?.clientPhone || b?.phone || "");
        const sISO = _bkToISO(
          b?.startTime || b?.startMs || b?.start || b?.datetime || b?.date || b?.day || null
        );
        return !!pKey && !!sISO && pKey === inPhoneKey && sISO === inStartISO;
      });
      if (idx >= 0) return await mergeAt(idx);
    }

    await bulkUpsertBookingsNormPg([incoming]);
    arr.push(incoming);
    return true;
  } catch (e) {
    // FIX (silent catch): logga l'eccezione invece di inghiottirla silenziosamente
    log("error", "[persistBooking] eccezione non gestita", {
      error: String(e?.message || e)
    });
    return false;
  }
}

async function updateBookingByEventId(eventId, patch) {
  try {
    if (!eventId) return false;
    const arr = loadBookings();
    const nowIso = new Date().toISOString();

    const index = arr.findIndex(b => b?.eventId === eventId);
    if (index < 0) return false;
    const updated = arr.slice();
    updated[index] = _bkEnsureTimes({ ...arr[index], ...patch, updatedAt: nowIso });
    return !!(await saveBookings(updated));
  } catch {
    return false;
  }
}

async function updateBookingByComposite(match, patch) {
  try {
    if (!match) return false;
    const arr = loadBookings();
    const nowIso = new Date().toISOString();

    const targetISO = _bkToISO(
      match.startTime ?? match.startMs ?? match.start ?? match.datetime ?? match.date ?? match.day ?? null
    );
    const phoneKey = _bkPhoneKey(match.clientPhone || match.phone || "");
    if (!targetISO || !phoneKey) return false;

    const index = arr.findIndex(b => {
      const bISO = _bkToISO(
        b?.startTime ?? b?.startMs ?? b?.start ?? b?.datetime ?? b?.date ?? b?.day ?? null
      );
      return bISO === targetISO && _bkPhoneKey(b?.clientPhone || b?.phone || '') === phoneKey;
    });
    if (index < 0) return false;
    const updated = arr.slice();
    updated[index] = _bkEnsureTimes({ ...arr[index], ...patch, updatedAt: nowIso });
    return !!(await saveBookings(updated));
  } catch {
    return false;
  }
}

function getUpcomingBookingByPhone(phone) {
  // === corpo di getUpcomingBookingByPhone ===
  try {
    const digits = (s) => String(s || "").replace(/\D/g, "");
    const normPhone = (s) => {
      let d = digits(s);
      // normalizza +39 / 0039 / 039
      d = d.replace(/^00?39/, "").replace(/^39/, "");
      return d;
    };
    const phoneMatch = (a, b) => {
      const A = normPhone(a);
      const B = normPhone(b);
      if (!A || !B) return false;
      if (A === B) return true;
      const min = 7;
      return A.endsWith(B.slice(-min)) || B.endsWith(A.slice(-min));
    };

    const rows = loadBookings();
    if (!Array.isArray(rows) || !rows.length) return null;

    const now = Date.now();
    const toTs = (b) =>
      Date.parse(b.startTime || b.start || b.date || b.datetime || "");

    const matches = rows
      .filter((b) => {
        if (!b) return false;
        const ts = toTs(b);
        if (!Number.isFinite(ts) || ts < now) return false; // solo future
        const status = String(b.status || b.state || "").toLowerCase();
        if (/(cancel|annull|deleted)/.test(status)) return false;
        const p =
          b.clientPhone ||
          b.phone ||
          b.customerPhone ||
          b.whatsapp ||
          b.contact ||
          "";
        return phoneMatch(p, phone);
      })
      .sort((a, b) => toTs(a) - toTs(b));

    const first = matches[0] || null;
    if (first && !first.service && first.serviceName)
      first.service = first.serviceName;
    return first;
  } catch (e) {
    log("warn", "getUpcomingBookingByPhone failed", e?.message || e);
    return null;
  }
}

function getUserActiveBookingsAll(phoneOrChatId) {
  try {
    const rows = loadBookings();
    if (!Array.isArray(rows) || !rows.length) return [];

    const now = Date.now();
    const want = _bkPhoneKey(phoneOrChatId);

    const phoneMatch = (x) => {
      const got = _bkPhoneKey(x);
      if (!want || !got) return false;
      if (want === got) return true;
      const min = 7;
      return want.endsWith(got.slice(-min)) || got.endsWith(want.slice(-min));
    };

    const toTs = (b) => {
      const ms = Number(b?.startMs);
      if (Number.isFinite(ms)) return ms;
      const iso = _bkToISO(b?.startTime || b?.start || b?.datetime || b?.date || b?.day || null);
      const t = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(t) ? t : NaN;
    };

    const out = rows
      .filter((b) => {
        const ts = toTs(b);
        if (!Number.isFinite(ts) || ts < now) return false;

        const st = String(b.status || b.state || "").toLowerCase();
        if (/(cancel|annull|deleted)/.test(st)) return false;

        const candidates = [
          b.clientPhone,
          b.customerPhone,
          b.phone,
          b.whatsapp,
          b.clientChatId,
          b.chatId,
        ];
        return candidates.some((c) => phoneMatch(c));
      })
      .sort((x, y) => toTs(x) - toTs(y));

    for (const x of out) _bkEnsureTimes(x);
    return out;
  } catch {
    return [];
  }
}

async function markBookingCancelled(eventId) {
  const ok = await updateBookingByEventId(eventId, {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
  });
  if (!ok) {
    try {
      log("warn", "[bookings] markBookingCancelled: eventId non trovato", {
        eventId
      });
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", {
        error: String(err)
      }); //  FIX Bug #17
    }
  }
}

function slotOverlapsExistingBookings(proEmail, s, e, opts = {}) {
  const day = new Date(s);
  const ignoreChatId = opts && opts.ignoreChatId ? String(opts.ignoreChatId) : null;

  // include anche hold altrui (ma possiamo ignorare il nostro hold quando serve)
  const booked = getBusyIntervalsForDay(day, proEmail, {
    ignoreChatId
  }) || [];
  for (const [bs, be] of booked)
    if (s < be && bs < e) return true;
  return false;
}

function hasFutureBookingsForPhone(phone) {
  try {
    const all = loadBookings();
    const now = Date.now();
    return all.some((b) => {
      const p = (b.phone || b.clientPhone || b.client_phone || "").replace(
        /\D+/g,
        ""
      );
      const when = new Date(
        b.start || b.startTime || b.start_date || b.when || 0
      ).getTime();
      return p.endsWith(phone.replace(/\D+/g, "")) && when && when >= now;
    });
  } catch {
    return false;
  }
}

  return { _asBookingsArray, loadBookings, saveBookings, enqueueBookingsForRetry, __drainPgWriteQueue, _bkDigits, _bkPhoneKey, _bkToISO, _bkEnsureTimes, persistBooking, updateBookingByEventId, updateBookingByComposite, getUpcomingBookingByPhone, getUserActiveBookingsAll, markBookingCancelled, slotOverlapsExistingBookings, hasFutureBookingsForPhone };
}
