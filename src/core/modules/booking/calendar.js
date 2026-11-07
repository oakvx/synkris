/**
 * booking/calendar: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const { GCAL, _createCalendarEvent, _digitsPhone, cfgServiceDuration, cfgServiceItem, config, log, proEmailByName, simpleNorm } = dependencies;

async function makeEvent({
  eventId = null,
  serviceName,
  professionalEmail,
  professionalName = null,
  clientPhone,
  customerName = null, // <- arriva dal flow come "customerName"
  startTime,
  durationMin,
  notes = null, // <- verrà rimappato a serviceDetails
  price = null,
  reminders = [{
    method: "popup",
    minutes: 1440
  }],
}) {
  let allergies = null;
  const payload = {
    eventId,
    serviceName,
    professionalEmail,
    professionalName, // opzionale ma utile per il titolo in gcal
    clientPhone: _digitsPhone(clientPhone),
    clientName: customerName, // <- mapping richiesto da gcal.js
    startTime, // Date o ISO, gcal fa new Date(...)
    durationMin,
    price,
    serviceDetails: notes,
    allergies,
    reminders,
  };
  try {
    // Guard: serve sempre un professionalEmail per creare l'evento
    if (!payload.professionalEmail) {
      throw new Error("professionalEmail mancante (impossibile creare evento)");
    }

    // NOTE: Il blocco FIX Bug #5 è stato commentato perché fa riferimento a 'col' che non è definito
    // in questo contesto. La logica di risoluzione professionalAny dovrebbe essere gestita
    // prima di chiamare makeEvent, passando professionalEmail già risolto.

    /* BLOCCO COMMENTATO - col is not defined
    // FIX Bug #5: Forzare risoluzione professionalAny prima di creare evento
    if (col.professionalAny && (!col.professionalEmail || !col.professionalName)) {
      // Tentativo di assegnazione automatica da slot o servizio
      if (col.time && Array.isArray(col.options)) {
        const matchingSlot = col.options.find(s => s.time === col.time);
        if (matchingSlot && matchingSlot.pros && matchingSlot.pros.length) {
          const firstPro = matchingSlot.pros[0];
          col.professionalEmail = firstPro.email || null;
          col.professionalName = firstPro.name || firstPro.email || null;
          col.professionalAny = false;
          log('info', '[FIX Bug #5] professionalAny risolto da slot', {
            email: col.professionalEmail,
            name: col.professionalName
          });
        }
      }

      // Fallback: prendi primo professionista disponibile per il servizio
      if (col.professionalAny && !col.professionalEmail && col.service) {
        try {
          const servicePros = (typeof cfgServiceProfessionals === 'function')
            ? cfgServiceProfessionals(col.service)
            : [];

          if (servicePros && servicePros.length) {
            const firstPro = servicePros[0];
            const proEmail = typeof firstPro === 'string' ? firstPro : (firstPro.email || null);
            const proName = typeof firstPro === 'string'
              ? (typeof proNameByEmail === 'function' ? proNameByEmail(firstPro) : firstPro)
              : (firstPro.name || proEmail);

            if (proEmail) {
              col.professionalEmail = proEmail;
              col.professionalName = proName;
              col.professionalAny = false;
              log('info', '[FIX Bug #5] professionalAny risolto da servizio', {
                email: col.professionalEmail,
                name: col.professionalName
              });
            }
          }
        } catch (err) {
          log('error', '[FIX Bug #5] Errore risoluzione professionalAny', { error: String(err) });
        }
      }

      // Se ancora non risolto, errore critico
      if (col.professionalAny && !col.professionalEmail) {
        log('error', '[FIX Bug #5] professionalAny non risolto, impossibile creare evento', {
          service: col.service,
          time: col.time,
          when: col.when
        });
        await reply(client, chatId,
          " Errore nella scelta del professionista. Riprova specificando chi preferisci.");
        return "";
      }
    }
    */

    return await _createCalendarEvent(payload);
  } catch (e) {
    log("error", "createCalendarEvent", e?.message || e);
    throw e;
  }
}

async function updateEventSafe(args) {
  try {
    if (typeof GCAL.updateCalendarEvent === "function") {
      await GCAL.updateCalendarEvent(args);
      return true;
    }
    if (typeof GCAL.updateEvent === "function") {
      await GCAL.updateEvent(args);
      return true;
    }
  } catch (e) {
    log("warn", "updateEventSafe", e?.message || e);
  }
  return false;
}

async function cancelEventSafe(eventId) {
  try {
    if (!eventId) return false;

    // nuova API "pulita"
    if (typeof GCAL.cancelCalendarEvent === "function") {
      await GCAL.cancelCalendarEvent(eventId); // <- QUI: passa la stringa, NON l’oggetto
      return true;
    }

    // compat vecchie API object-based
    if (typeof GCAL.deleteEvent === "function") {
      await GCAL.deleteEvent({
        eventId
      });
      return true;
    }
    if (typeof GCAL.cancelEvent === "function") {
      await GCAL.cancelEvent({
        eventId
      });
      return true;
    }
  } catch (e) {
    // Deletion is idempotent: a missing event is already cancelled.
    if (e?.code === 'EVENT_NOT_FOUND' || Number(e?.response?.status) === 404) return true;
    log("warn", "cancelEventSafe", { code: e?.code || 'unknown' });
  }
  return false;
}

function getServiceDurationForPro(serviceName, proId) {
  try {
    const buffer = Math.max(0, Number(config?.services?.[serviceName]?.bufferAfterMin) || 0);
    const withBuffer = n => Number(n) + buffer;
    // fallback rapido
    const DEFAULT = 30;
    if (!serviceName) {
      if (typeof cfgServiceDuration === "function") {
        const d = cfgServiceDuration();
        return Number.isFinite(+d) && +d > 0 ? +d : DEFAULT;
      }
      return DEFAULT;
    }

    // Ottieni item servizio (supporta helper esistenti)
    const svcItem =
      (typeof cfgServiceItem === "function" ? cfgServiceItem(serviceName) : null) ||
      (config && config.services && config.services[serviceName]) || {};

    // mappa professionalDurations (se esiste)
    const pd = svcItem.professionalDurations || svcItem.professionalDuration || {};

    // Normalizza proId: se è un nome cerca email con proEmailByName se disponibile
    let proEmail = proId || null;
    if (proEmail && typeof proEmailByName === "function" && !/@/.test(String(proEmail))) {
      try {
        const mapped = proEmailByName(proEmail);
        if (mapped) proEmail = mapped;
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }
    }

    // 1) Cerca corrispondenza chiave diretta (case-insensitive) su professionalDurations
    if (proEmail && pd && typeof pd === "object") {
      const lookup = String(proEmail).toLowerCase();
      for (const k of Object.keys(pd)) {
        if (!k) continue;
        if (k.toLowerCase() === lookup) {
          const val = +pd[k];
          if (Number.isFinite(val) && val > 0) return withBuffer(val);
        }
      }
    }

    // 2) Potrebbe esserci una chiave in pd usata come "nome" invece che email - confronto fuzzy semplice
    if (proId && pd && typeof pd === "object") {
      const tryNorm = (v) =>
        typeof simpleNorm === "function" ? simpleNorm(String(v || "")) : String(v || "").toLowerCase().trim();
      const tgt = tryNorm(proId);
      for (const k of Object.keys(pd)) {
        if (!k) continue;
        // confronto sulla chiave (nome) o, se la chiave è un'email presente in config.professionals, confronto il nome associato
        if (tryNorm(k) === tgt) {
          const val = +pd[k];
          if (Number.isFinite(val) && val > 0) return withBuffer(val);
        }
        const maybeName = config?.professionals?.[k]?.name;
        if (maybeName && tryNorm(maybeName) === tgt) {
          const val = +pd[k];
          if (Number.isFinite(val) && val > 0) return withBuffer(val);
        }
      }
    }

    // 3) Fallback al campo generico duration del servizio (config.services[svc].duration)
    if (Number.isFinite(+svcItem.duration) && +svcItem.duration > 0) return withBuffer(+svcItem.duration);

    // 4) Fallback all'helper cfgServiceDuration se presente
    if (typeof cfgServiceDuration === "function") {
      try {
        const d = cfgServiceDuration(serviceName);
        if (Number.isFinite(+d) && +d > 0) return withBuffer(+d);
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }
    }

    // default ultimo
    return DEFAULT;
  } catch (err) {
    // sicurezza: non rompere il flusso di prenotazione
    try {
      log && typeof log === "function" && log("warn", "getServiceDurationForPro error", err?.message || err);
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", {
        error: String(err)
      }); //  FIX Bug #17
    }
    return 30;
  }
}

  return { makeEvent, updateEventSafe, cancelEventSafe, getServiceDurationForPro };
}
