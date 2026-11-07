/**
 * conversation/state: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const { BOOKING_LOCK_MS, __pgQuery, fmtDateWithWeekdayIT, formatDateWithWeekdayIT, log, pending, renderSlotsList, reply } = dependencies;

function now() {
  return Date.now();
}

function lockBooking(state) {
  if (!state) return;
  ensureContext(state);
  const now = Date.now();
  state.context.lock = {
    active: true,
    ts: now,
    ttl: BOOKING_LOCK_MS,
    type: "appointment"
  };
}

async function validateProfessionalForService(serviceName, professionalEmail) {
  try {
    if (!serviceName) {
      return {
        ok: false,
        reason: "Servizio non specificato."
      };
    }

    // Lookup servizio dal DB (fonte di verità)
    const svcRows = await __pgQuery(
      `SELECT service_id
       FROM public.services
       WHERE is_active = true AND lower(service_name) = lower($1)
       LIMIT 1`,
      [serviceName]
    );
    const svc = svcRows && svcRows[0] ? svcRows[0] : null;
    if (!svc) {
      return {
        ok: false,
        reason: "Servizio non configurato."
        // service_id deliberatamente assente: il servizio non esiste nel DB
      };
    }

    // Se non è stato scelto un professionista, è valido comunque
    if (!professionalEmail) {
      return {
        ok: true,
        service_id: svc.service_id
      };
    }

    // Lookup professionista
    const proRows = await __pgQuery(
      `SELECT p.professional_id
       FROM public.professionals p
       LEFT JOIN public.professional_emails pe
         ON pe.professional_id = p.professional_id
       WHERE p.is_active = true
         AND (
           (p.email IS NOT NULL AND lower(p.email::text) = lower($1))
           OR (pe.email IS NOT NULL AND lower(pe.email) = lower($1))
         )
       LIMIT 1`,
      [professionalEmail]
    );
    const pro = proRows && proRows[0] ? proRows[0] : null;
    if (!pro) {
      // FIX (service_id always present): il servizio È stato trovato; restituiamo
      // sempre service_id così il caller non rimane con null. Il professional_id sarà
      // null (campo nullable in appointments) e verrà loggato chiaramente.
      log("warn", "[validateProfessionalForService] professional email non trovata in DB — " +
        "la prenotazione procede senza professional_id (campo nullable)", {
        email: professionalEmail,
        service: serviceName,
        service_id: svc.service_id,
        hint: "Aggiungere l'email del professionista in public.professional_emails o public.professionals.email",
      });
      return {
        ok: true, // permissivo: non bloccare il flusso per un professionista non configurato
        service_id: svc.service_id,
        professional_id: null,
        _warn: "professional_not_in_db",
      };
    }

    // Verifica mapping professionista -> servizio (se la tabella è vuota, consideriamo tutto abilitato)
    const mapCountRows = await __pgQuery(
      `SELECT EXISTS (SELECT 1 FROM public.professional_services LIMIT 1) AS has_map`
    );
    const hasMap = !!(mapCountRows && mapCountRows[0] && mapCountRows[0].has_map);

    if (hasMap) {
      const mapRows = await __pgQuery(
        `SELECT 1
         FROM public.professional_services
         WHERE professional_id = $1 AND service_id = $2
         LIMIT 1`,
        [pro.professional_id, svc.service_id]
      );
      if (!mapRows || mapRows.length === 0) {
        // FIX: restituiamo service_id anche qui — il problema è il mapping, non il servizio
        return {
          ok: false,
          service_id: svc.service_id,
          reason: "Questo servizio non è disponibile con il professionista selezionato."
        };
      }
    }

    return {
      ok: true,
      service_id: svc.service_id,
      professional_id: pro.professional_id
    };
  } catch (e) {
    console.error("[validateProfessionalForService] error:", e);
    // Fallback permissivo: non bloccare il flusso per errori DB momentanei.
    // Prova a restituire service_id dalla mappa in RAM per non lasciarlo null.
    const fallbackSvcId = serviceName ? (shared.__svcNameToId.get(String(serviceName)) || null) : null;
    return {
      ok: true,
      ...(fallbackSvcId != null ? {
        service_id: fallbackSvcId
      } : {}),
    };
  }
}

function ensureContext(st) {
  if (!st) return;
  st.context = st.context || {};
  st.context.lock = st.context.lock || {
    active: false,
    ts: 0,
    ttl: null
  };
  if (!st.context.lock.ttl) {
    const envTtl = Number(process.env.BOOKING_LOCK_TTL_MS || 300000); // 5 min
    st.context.lock.ttl = Number.isFinite(envTtl) ? envTtl : 300000;
  }
}

function isBookingLocked(st, nowTs) {
  if (!st || !st.context || !st.context.lock) return false;
  let lock = st.context.lock;
  // Se il lock è nel vecchio formato {type, until}, lo converto
  if (lock.type && typeof lock.until === "number") {
    const nowConv = typeof nowTs === "number" ? nowTs : Date.now();
    if (nowConv < lock.until) {
      // Lock ancora valido: imposto un nuovo lock con campo active/ts/ttl
      const remaining = lock.until - nowConv;
      st.context.lock = {
        active: true,
        ts: nowConv,
        ttl: remaining,
        type: lock.type
      };
      lock = st.context.lock;
    } else {
      // Lock scaduto: resetto lo stato
      st.context.lock = {
        active: false,
        ts: 0,
        ttl: 0
      };
      return false;
    }
  }
  if (!lock.active) return false;
  const now = typeof nowTs === "number" ? nowTs : Date.now();
  // (resto del codice invariato...)
}

function bumpBookingLock(st, ttlMs = 2 * 60 * 1000, meta) {
  if (!st) return;
  ensureContext(st);

  const rawTtl = Number(ttlMs);
  const ttl = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 2 * 60 * 1000;
  const now = Date.now();

  const prev = st.context.lock || {};
  // Filtra dal meta eventuali chiavi riservate (active, ts, ttl)
  const {
    active: _,
    ts: __,
    ttl: ___,
    ...metaFiltered
  } = meta || {};
  st.context.lock = {
    ...prev, // mantengo vecchi metadati
    active: true,
    ts: now,
    ttl: ttl,
    ...metaFiltered // aggiungo nuovi metadati filtrati
  };

}

function unlockBooking(st, reason) {
  if (!st || !st.context) return;

  const now = Date.now();
  const prev = st.context.lock || {};
  const {
    active: _,
    ts: __,
    ttl: ___,
    ...prevFiltered
  } = prev;
  st.context.lock = {
    ...prevFiltered, // mantengo vecchi metadati (owner, reason, ecc.)
    active: false,
    ts: 0,
    ttl: 0,
    releasedAt: now,
    releaseReason: reason || "manual",
  };

}

function isBookingFlowActive(state, col) {
  return !!(state && state.step && state.step !== "collect");
}

function isInCriticalStep(step) {
  return [
    // booking
    "choose_service",
    "choose_day",
    "confirm_day_month",
    "pick_time",
    "pick_professional",
    "pick_professional_for_time",
    "collect_name",
    "finalize_booking",
    "confirm_final",

    // legacy (se rimane in giro codice vecchio)
    "ask_name",
    "confirm_booking",

    // info/price flows
    "price_select_service",
    "info_select_service",

    // resume mid-flow
    "resume_confirm",

    // edit flow
    "edit_pick_booking",
    "edit_menu",
    "edit_pick_professional",
    "edit_reschedule_date",
    "edit_reschedule_time",
    "edit_cancel_confirm",
    "edit_change_name",
    "edit_cancel_confirm",
  ].includes(step);
}

function ensureValidState(state) {
  try {
    if (!state || typeof state !== "object") return {
      ok: false,
      step: "",
      missing: ["state"]
    };

    const step = String(state.step || "collect");
    const col = state.collected || {};
    const missing = [];

    const hasValidWhen = () => {
      if (!col.when) return false;
      const d = new Date(col.when);
      return Number.isFinite(d.getTime());
    };

    // Booking flow
    if (step === "choose_day") {
      // Permettiamo "giorno prima del trattamento": il servizio può mancare qui
    } else if (step === "pick_time") {
      if (!col.service) missing.push("col.service");
      if (!hasValidWhen()) missing.push("col.when");
      if (!Array.isArray(col.options) || !col.options.length) missing.push("col.options");
    } else if (step === "pick_professional_for_time") {
      if (!col.time) missing.push("col.time");
      if (!Array.isArray(col.proOptions) || !col.proOptions.length) missing.push("col.proOptions");
    } else if (step === "confirm_final" || step === "finalize_booking") {
      if (!col.service) missing.push("col.service");
      if (!hasValidWhen()) missing.push("col.when");
      if (!col.time) missing.push("col.time");
      if (!col.customerName) missing.push("col.customerName");
    } else if (step === "pick_professional") {
      // non troppo aggressivo: si può arrivare qui anche da "prenota" senza servizio
      // ma se manca la lista pros, il flow è rotto.
      // (non aggiungiamo check perché è gestito dal blocco dedicato di pick_professional)
    }

    // Edit flow
    if (step.startsWith("edit_")) {
      const ed = state.edit || {};
      if (step !== "edit_pick_booking" && !ed.target) missing.push("edit.target");
      if (step === "edit_pick_booking" && (!Array.isArray(ed.list) || !ed.list.length)) missing.push("edit.list");
      if (step === "edit_pick_professional" && (!Array.isArray(ed.proOptions) || !ed.proOptions.length)) missing.push("edit.proOptions");
      if (step === "edit_reschedule_time" && (!Array.isArray(col.options) || !col.options.length)) missing.push("col.options");
    }

    return {
      ok: missing.length === 0,
      step,
      missing
    };
  } catch (e) {
    return {
      ok: false,
      step: String(state?.step || ""),
      missing: ["exception"]
    };
  }
}

function firstMissingField(col) {
  const c = col || {};
  if (!c.service) return "service";
  if (!c.when) return "when";
  if (!c.time) return "time";
  // professional "se richiesto": gestito solo nei casi dove serve davvero
  if (!c.professionalAny && !c.professionalEmail && Array.isArray(c.proOptions) && c.proOptions.length) return "professional";
  if (!c.customerName) return "customerName";
  return null;
}

async function promptResumeStep(client, chatId, state) {
  try {
    const step = String(state?.step || "collect");
    const col = state?.collected || {};

    if (step === "choose_service") {
      await reply(client, chatId, "Ok  Che trattamento vuoi prenotare?");
      return;
    }

    if (step === "collect_name") {
      await reply(client, chatId, 'Perfetto. Scrivi *nome e cognome* (es. "Maria Rossi").', {
        noFooter: true
      });
      return;
    }

    if (step === "choose_day") {
      await reply(client, chatId, `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "23 ottobre")`);
      return;
    }

    if (step === "pick_time") {
      if (col.when && Array.isArray(col.options) && col.options.length) {
        const dayStr =
          typeof formatDateWithWeekdayIT === "function" ?
            formatDateWithWeekdayIT(col.when) :
            (typeof fmtDateWithWeekdayIT === "function" ? fmtDateWithWeekdayIT(col.when) : String(col.when));
        const list = typeof renderSlotsList === "function" ? renderSlotsList(col.options) : "";
        const base = list ?
          `Disponibilità per *${dayStr}*:\n${list}` :
          `Perfetto. Per *${dayStr}* che ora preferisci? (es. 14:30)`;
        await reply(client, chatId, `${base}\n\nScrivi l’orario desiderato (es. "14:30").`);
        return;
      }
      await reply(client, chatId, `Ok  Per che giorno? (es. "domani", "23 ottobre")`);
      return;
    }

    if (step === "pick_professional_for_time") {
      const pros = Array.isArray(col.proOptions) ? col.proOptions : [];
      if (pros.length) {
        const list = pros.map((p, i) => `${i + 1}) ${p?.name || p?.email || String(p)}`).join("\n");
        await reply(client, chatId, `Chi preferisci? Puoi rispondere con il *numero* o il *nome*:\n${list}`);
        return;
      }
      await reply(client, chatId, "Ok  Dimmi il nome del professionista che preferisci.");
      return;
    }
  } catch (e) {
    // no-op
  }
}

function ensureUI(state) {
  if (!state) return;
  state.ui = state.ui || {};
}

function getState(chatId) {
  if (!pending.has(chatId)) {
    pending.set(chatId, {
      step: "collect",
      collected: {
        service: null,
        when: null,
        time: null,
        professionalAny: true,
        professionalName: null,
        professionalEmail: null,
        customerName: null,
        options: [],
        proOptions: null,
        daypartWindow: null,
        infoOptions: null,
      },
      context: {
        lastService: null,
        lastInfoTopic: null,
        lock: null
      },
    });
  }
  return pending.get(chatId);
}

function resetState(chatId) {
  pending.delete(chatId);
}

function setState(chatId, st) {
  if (!st || typeof st !== "object") return;
  pending.set(chatId, st);
}

  return { now, lockBooking, validateProfessionalForService, ensureContext, isBookingLocked, bumpBookingLock, unlockBooking, isBookingFlowActive, isInCriticalStep, ensureValidState, firstMissingField, promptResumeStep, ensureUI, getState, resetState, setState };
}
