/**
 * booking/edit: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const {
    __dbAllPros,
    cancelEventSafe,
    cfgServiceDuration,
    cfgServicePriceText,
    cfgServiceProfessionals,
    compareHHMM,
    fetchSlots,
    fmtDate,
    fmtWeekdayDateShortIT,
    formatDateWithWeekdayIT,
    getServiceDurationForPro,
    getState,
    getUserActiveBookingsAll,
    isValidDate,
    log,
    makeEvent,
    normalizeSlotsDetail,
    parseDaySmart,
    pending,
    phoneFromChatId,
    proNameByEmail,
    releaseSoftHoldByChat,
    reply,
    toISOStringLocal,
    updateBookingByComposite,
    updateBookingByEventId,
    updateEventSafe,
  } = dependencies;

function _editParseNewDate(raw) {
  const original = String(raw ?? "");
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  const stripDiacritics = (s) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const normalize = (s) => {
    let t = stripDiacritics(String(s ?? "").toLowerCase().trim());
    t = t.replace(/[“”"']/g, "");
    t = t.replace(/\s+/g, " ").trim();
    // toglie punteggiatura ai bordi (così "domani?" funziona)
    t = t.replace(/^[?!.,;:()\[\]{}<>]+/g, "").replace(/[?!.,;:()\[\]{}<>]+$/g, "").trim();
    return t;
  };

  // Evita falsi positivi: un orario tipo "12.30" non è una data
  const __n0 = normalize(original);
  if (/^(?:alle\s*)?(?:[01]?\d|2[0-3])\s*[:.]\s*[0-5]\d\s*\??\s*$/i.test(__n0)) return null;

  let txt = normalize(original);

  // Evita falsi positivi: un orario tipo "alle 12.30" / "dalle 15:30" non è una data durante le modifiche
  txt = txt.replace(/\b(?:alle|ore|h|dalle)\s*([01]?\d|2[0-3])\s*[.:,]\s*([0-5]\d)\b/gi, " ");

  const isValidDate = (d, y, m, day) =>
    d instanceof Date &&
    !Number.isNaN(d.getTime()) &&
    d.getFullYear() === y &&
    d.getMonth() === m &&
    d.getDate() === day;

  const makeDate = (y, m, day) => {
    const d = new Date(y, m, day, 0, 0, 0, 0);
    return isValidDate(d, y, m, day) ? d : null;
  };

  const normalizeYear = (yy) => {
    if (yy == null) return null;
    const n = parseInt(String(yy), 10);
    if (Number.isNaN(n)) return null;
    if (n < 100) return 2000 + n; // 25 -> 2025
    return n;
  };

  const rollFutureIfMissingYear = (d) => {
    if (d && d < base) d.setFullYear(d.getFullYear() + 1);
    return d;
  };

  const addDays = (n) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const wordToNumber = (w) => {
    const map = {
      un: 1,
      uno: 1,
      una: 1,
      due: 2,
      tre: 3,
      quattro: 4,
      cinque: 5,
      sei: 6,
      sette: 7,
      otto: 8,
      nove: 9,
      dieci: 10,
      undici: 11,
      dodici: 12,
      tredici: 13,
      quattordici: 14,
      quindici: 15,
      sedici: 16,
      diciassette: 17,
      diciotto: 18,
      diciannove: 19,
      venti: 20,
      ventuno: 21,
      ventidue: 22,
      ventitre: 23,
      ventiquattro: 24,
      venticinque: 25,
      ventisei: 26,
      ventisette: 27,
      ventotto: 28,
      ventinove: 29,
      trenta: 30,
      trentuno: 31
    };
    if (w == null) return null;
    const s = String(w).toLowerCase().trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return map[s] ?? null;
  };

  const monthMap = {
    gennaio: 0,
    gen: 0,
    febbraio: 1,
    feb: 1,
    marzo: 2,
    mar: 2,
    aprile: 3,
    apr: 3,
    maggio: 4,
    mag: 4,
    giugno: 5,
    giu: 5,
    luglio: 6,
    lug: 6,
    agosto: 7,
    ago: 7,
    settembre: 8,
    set: 8,
    sett: 8,
    ottobre: 9,
    ott: 9,
    novembre: 10,
    nov: 10,
    dicembre: 11,
    dic: 11
  };

  const weekdayMap = {
    lunedi: 1,
    lun: 1,
    martedi: 2,
    mar: 2,
    mercoledi: 3,
    mer: 3,
    giovedi: 4,
    gio: 4,
    venerdi: 5,
    ven: 5,
    sabato: 6,
    sab: 6,
    domenica: 0,
    dom: 0
  };

  const nextWeekday = (targetDow, addNextWeek) => {
    const d = new Date(base);
    const current = d.getDay();
    let diff = (targetDow - current + 7) % 7;
    if (diff === 0) diff = 7; // prossima occorrenza, non "oggi"
    if (addNextWeek) diff += 7; // "<giorno> prossimo" => settimana successiva
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  // --- Relativi (anche dentro frasi tipo "domani?" / "domani pomeriggio") ---
  if (/\boggi\b/.test(txt)) return new Date(base);

  if (/\bdopodomani\b/.test(txt)) return addDays(2);

  if (/\bdomani\b/.test(txt)) return addDays(1);

  // "tra/fra X giorni|settimane|mesi|anni" (X numero o parola)
  {
    const rel = txt.match(/\b(tra|fra)\s+([a-z0-9]+)\s*(giorno|giorni|g|gg|settimana|settimane|sett|mese|mesi|anno|anni)\b/);
    if (rel) {
      const n = wordToNumber(rel[2]);
      const unit = rel[3];
      if (n != null && n >= 0) {
        const d = new Date(base);
        if (unit === "giorno" || unit === "giorni" || unit === "g" || unit === "gg") {
          d.setDate(d.getDate() + n);
          d.setHours(0, 0, 0, 0);
          return d;
        }
        if (unit === "settimana" || unit === "settimane" || unit === "sett") {
          d.setDate(d.getDate() + n * 7);
          d.setHours(0, 0, 0, 0);
          return d;
        }
        if (unit === "mese" || unit === "mesi") {
          d.setMonth(d.getMonth() + n);
          d.setHours(0, 0, 0, 0);
          return d;
        }
        if (unit === "anno" || unit === "anni") {
          d.setFullYear(d.getFullYear() + n);
          d.setHours(0, 0, 0, 0);
          return d;
        }
      }
    }
  }

  // --- Giorni della settimana: "lunedi", "lunedi prossimo", "venerdi settimana prossima" ---
  {
    const w = txt.match(/\b(lunedi|lun|martedi|mar|mercoledi|mer|giovedi|gio|venerdi|ven|sabato|sab|domenica|dom)\b/);
    if (w) {
      const key = w[1];

      const keyRe = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const isWeekdayProssimo =
        new RegExp(`\\b${keyRe}\\s+prossim[oa]\\b|\\bprossim[oa]\\s+${keyRe}\\b`).test(txt);

      const hasWeekQualifier = /\b(settimana prossima|della prossima settimana)\b/.test(txt);

      // Regola: calcola il prossimo <giorno> e poi +7 giorni
      return nextWeekday(weekdayMap[key], hasWeekQualifier || isWeekdayProssimo);
    }
  }

  // --- Date numeriche: ISO (YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD) dentro la frase ---
  {
    const iso = txt.match(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
    if (iso) {
      const y = parseInt(iso[1], 10);
      const m = parseInt(iso[2], 10) - 1;
      const day = parseInt(iso[3], 10);
      const d = makeDate(y, m, day);
      if (d) return d;
    }
  }

  // --- Date numeriche: D/M(/Y) con / - . anche dentro la frase (gestisce swap se mese>12) ---
  {
    const dmy = txt.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
    if (dmy) {
      let a = parseInt(dmy[1], 10);
      let b = parseInt(dmy[2], 10);
      const yOpt = normalizeYear(dmy[3]) ?? base.getFullYear();

      // Italia: preferenza D/M. Se mese invalido ma l'altro senso è valido, swappa.
      let dd = a,
        mm = b - 1;
      let d = makeDate(yOpt, mm, dd);

      if (!d) {
        // prova swap (M/D) se sembra plausibile
        dd = b;
        mm = a - 1;
        d = makeDate(yOpt, mm, dd);
      }

      if (d) {
        if (dmy[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }
  }

  // --- Date con spazi: "15 12 2025" / "15 12" ---
  {
    const spaced = txt.match(/\b(\d{1,2})\s+(\d{1,2})(?:\s+(\d{2,4}))?\b/);
    if (spaced) {
      const a = parseInt(spaced[1], 10);
      const b = parseInt(spaced[2], 10);
      const yOpt = normalizeYear(spaced[3]) ?? base.getFullYear();

      // evita collisioni con orari tipo "alle 15 30" (non perfetto ma riduce falsi positivi)
      if (!/\balle\b|\bdalle\b|\bore\b/.test(txt)) {
        let d = makeDate(yOpt, b - 1, a);
        if (!d) d = makeDate(yOpt, a - 1, b); // swap se necessario
        if (d) {
          if (spaced[3] == null) d = rollFutureIfMissingYear(d);
          return d;
        }
      }
    }
  }

  // --- "15 dicembre" / "15 dic 2025" / "dicembre 15" ---
  {
    const monthKeys = Object.keys(monthMap).sort((a, b) => b.length - a.length).join("|");

    // giorno + mese (+ anno)
    const dm = txt.match(new RegExp(`\\b(\\d{1,2})(?:\\s*(?:°|º))?\\s*(?:di\\s*)?(${monthKeys})\\b(?:\\s+(\\d{2,4}))?`, "i"));
    if (dm) {
      const day = parseInt(dm[1], 10);
      const mKey = dm[2].toLowerCase();
      const mm = monthMap[mKey];
      const yOpt = normalizeYear(dm[3]) ?? base.getFullYear();
      let d = makeDate(yOpt, mm, day);
      if (d) {
        if (dm[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }

    // mese + giorno (+ anno)
    const md = txt.match(new RegExp(`\\b(${monthKeys})\\s+(\\d{1,2})(?:\\s*(?:°|º))?\\b(?:\\s+(\\d{2,4}))?`, "i"));
    if (md) {
      const mKey = md[1].toLowerCase();
      const day = parseInt(md[2], 10);
      const mm = monthMap[mKey];
      const yOpt = normalizeYear(md[3]) ?? base.getFullYear();
      let d = makeDate(yOpt, mm, day);
      if (d) {
        if (md[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }
  }

  // --- Solo giorno: "15" / "il 15" (mese corrente se futuro, altrimenti mese prossimo) ---
  {
    const onlyDay = txt.match(/^(?:il\s+)?(\d{1,2})(?:\s*(?:°|º))?$/);
    if (onlyDay) {
      const day = parseInt(onlyDay[1], 10);
      let y = base.getFullYear();
      let m = base.getMonth();

      let d = makeDate(y, m, day);
      if (!d) return null;

      if (d < base) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        d = makeDate(y, m, day);
        if (!d) return null;
      }
      return d;
    }
  }

  // --- Fallback: parser esterno se presente ---
  if (typeof parseDaySmart === "function") {
    const d = parseDaySmart(original, {
      baseDate: base
    });
    if (d && !Number.isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }

  return null;
}

async function startEditDate(client, chatId) {
  const phone = phoneFromChatId(chatId);
  const bookings = getUserActiveBookingsAll(phone);

  if (!bookings.length) {
    return reply(
      client,
      chatId,
      " Non ho trovato prenotazioni future col tuo numero."
    );
  }

  const openDateForBooking = async (booking) => {
    const s = pending.get(chatId) || getState(chatId);
    _editSnapshotStateFromBooking(s, booking);
    s.step = "edit_reschedule_date";
    s.edit = {
      target: booking
    };
    s.collected = s.collected || {};
    pending.set(chatId, s);

    const line = _fmtBookingLine ?
      _fmtBookingLine(booking) :
      `${fmtDate(booking.startTime || booking.day || new Date())} - ${booking.service || ""
      }`;

    return reply(
      client,
      chatId,
      `Vuoi cambiare la data di:\n${line}\n\nDimmi la nuova data (GG/MM, "oggi" o "domani").`
    );
  };

  if (bookings.length === 1) {
    return openDateForBooking(bookings[0]);
  }

  // Più prenotazioni: scelgo quale, poi passo a edit_reschedule_date
  return startEditChooseBooking(
    client,
    chatId,
    bookings,
    "edit_reschedule_date"
  );
}

function _editDuration(booking) {
  if (!booking) return 30;

  const svc = booking.service || booking.serviceName;
  const proEmail = booking.professionalEmail;

  // Se abbiamo servizio e professionista, usa durata specifica
  if (svc && proEmail) {
    return getServiceDurationForPro(svc, proEmail);
  }

  // Fallback: durata dal booking o da config
  return (
    Number(booking.durationMin) ||
    cfgServiceDuration(svc) ||
    30
  );
}

function _editListProNamesForService(serviceName) {
  const prosSpec = cfgServiceProfessionals(serviceName) || [];
  const names = prosSpec.map((p) => p.name).filter(Boolean);
  if (names.length) return names;
  // Tutti i pro dal DB, non da config.professionals
  return __dbAllPros().map((p) => p.name).filter(Boolean);
}

function _editDayFromBooking(booking) {
  const d = new Date(booking.startTime);
  d.setHours(12, 0, 0, 0);
  return d;
}

function _editSnapshotStateFromBooking(state, booking) {
  if (!state || !booking) return;
  const col = state.collected || (state.collected = {});

  // servizio
  if (!col.service) {
    col.service = booking.service || col.service || null;
  }

  // nome cliente
  if (booking.customerName && !col.customerName) {
    col.customerName = booking.customerName;
  }

  // professionista
  const proEmail = booking.professionalEmail || null;
  const proName =
    booking.professionalName ||
    (proEmail && typeof proNameByEmail === "function" ?
      proNameByEmail(proEmail) :
      null);

  if (proEmail) col.professionalEmail = proEmail;
  if (proName) col.professionalName = proName;

  if (!proEmail && !proName) {
    // nessuna preferenza esplicita: se non è già impostato, considero "qualunque"
    if (typeof col.professionalAny !== "boolean") {
      col.professionalAny = true;
    }
  } else {
    col.professionalAny = false;
  }

  // data + orario
  if (booking.startTime && !col.when) {
    const d = new Date(booking.startTime);
    if (!Number.isNaN(d.getTime())) {
      const day = new Date(d);
      day.setHours(12, 0, 0, 0);
      col.when = day;
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      col.time = `${hh}:${mm}`;
    }
  }
}

function _editFormatTimeList(times) {
  return (times || []).map((t) => `- ${t}`).join("\n");
}

function renderSlotsList(slots = []) {
  const safeProName = (p) => {
    const nm = String(p?.name || "").trim();
    const em = String(p?.email || "").trim();

    // se ho email, uso proNameByEmail (che ora non restituisce mai email come display)
    if (em) return proNameByEmail(em);

    // se il "name" è in realtà una mail, derivane un nome
    if (nm && nm.includes("@")) return proNameByEmail(nm);

    return nm || "";
  };

  return (slots || [])
    .map((slot) => {
      if (typeof slot === "string") return `${slot}`;
      const time = slot?.time || slot?.hhmm || "";

      const prosArr = Array.isArray(slot?.pros) ? slot.pros : [];
      const names = prosArr.map(safeProName).filter(Boolean);

      const fallbackOne =
        slot?.professionalName ? safeProName({
          name: slot.professionalName
        }) : "";

      const prosNames = names.length ?
        ` (${names.join(", ")})` :
        (fallbackOne ? ` (${fallbackOne})` : "");

      return `${time}${prosNames}`.trim();
    })
    .join("\n");
}

function _toISO(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  return typeof toISOStringLocal === "function" ?
    toISOStringLocal(d) :
    d.toISOString();
}

async function _editFetchTimes({
  service,
  day,
  duration,
  professionalEmail
}) {
  const list = await fetchSlots({
    service,
    day,
    duration,
    professional: professionalEmail || null,
  });
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.sort(compareHHMM);
}

function _editComputeNewNotes(oldNotes, newName) {
  const base = String(oldNotes || "").trim();
  if (!newName) return base || "";
  const line = `Nome: ${newName}`;
  if (!base) return line;
  if (/^Nome:\s*.*$/im.test(base)) {
    return base.replace(/^Nome:\s*.*$/im, line).trim();
  }
  return (base + "\n" + line).trim();
}

async function _editApplyUpdate({
  booking,
  newStartISO = null,
  newProEmail = null,
  newName = null,
  forceRecreate = false, // true = cancella vecchio evento e ne crea uno nuovo
}) {
  if (!booking?.eventId) return false;

  const prev = {
    startTime: booking.startTime,
    professionalEmail: booking.professionalEmail || null,
    professionalName: booking.professionalName || null,
    customerName: booking.customerName || null,
  };

  const nextStartISO = newStartISO || booking.startTime;
  const nextProEmail = newProEmail ?? booking.professionalEmail;

  const nextNotes =
    typeof booking.notes !== "undefined" || newName ?
      _editComputeNewNotes(booking.notes, newName) :
      booking.notes;

  const nextDuration = _editDuration(booking);
  const nextProName =
    (nextProEmail &&
      typeof proNameByEmail === "function" &&
      proNameByEmail(nextProEmail)) ||
    booking.professionalName ||
    null;
  const nextClientName = newName || booking.customerName || null;

  const patch = {};
  if (newStartISO) patch.startTime = nextStartISO;
  if (newProEmail) {
    patch.professionalEmail = newProEmail;
    patch.professionalName = nextProName;
  }
  if (newName) patch.customerName = newName;
  if (typeof nextNotes !== "undefined") patch.notes = nextNotes;

  // Sempre: tracciamo aggiornamento e manteniamo coerenza dei campi orari
  patch.updatedAt = new Date().toISOString();
  if (newStartISO) {
    const sMs = Date.parse(nextStartISO);
    if (Number.isFinite(sMs)) {
      patch.startMs = sMs;
      const eMs = sMs + (Number(nextDuration) || 0) * 60_000;
      if (Number.isFinite(eMs) && eMs > sMs) {
        patch.endMs = eMs;
        patch.endTime = new Date(eMs).toISOString();
      }
    }
  }

  // Never delete the old Calendar event before the replacement and database
  // commit have succeeded: that ordering could silently lose an appointment.
  // Google Calendar supports updating start, operator and customer name in place.
  // Preserve the existing ID even for legacy forceRecreate callers.
  if (forceRecreate) {
    log('info', 'calendar_in_place_edit', { requestedRecreate: true });
  }

  // --- CASO 2: cambio pro/nome (e/o start se updateEventSafe lo supporta) -> patch sullo stesso eventId ---
  const ok = await updateEventSafe({
    eventId: booking.eventId,
    serviceName: booking.service,
    professionalEmail: nextProEmail,
    professionalName: nextProName,
    clientPhone: booking.clientPhone,
    clientName: nextClientName,
    startTime: nextStartISO,
    durationMin: nextDuration,
    price: booking.price || null,
    serviceDetails: nextNotes,
    allergic: booking.allergic ?? null,
    reminders: booking.reminders || [{
      method: "popup",
      minutes: 1440
    }],
  });

  if (!ok) {
    try {
      log("warn", "[EDIT] updateEventSafe failed", {
        eventId: booking.eventId,
        startTime: nextStartISO,
        professionalEmail: nextProEmail || booking.professionalEmail,
      });
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", {
        error: String(err)
      }); //  FIX Bug #17
    }
    return false;
  }

  const saved =
    (await updateBookingByEventId(booking.eventId, patch)) ||
    (await updateBookingByComposite({
      clientPhone: booking.clientPhone,
      startTime: prev.startTime
    },
      patch
    ));

  if (!saved) {
    // Provider accepted an update but DB did not. Attempt to restore Calendar
    // to the last persisted booking. A failed compensation needs manual review.
    const reverted = await updateEventSafe({
      eventId: booking.eventId,
      serviceName: booking.service,
      professionalEmail: booking.professionalEmail,
      professionalName: booking.professionalName,
      clientPhone: booking.clientPhone,
      clientName: booking.customerName,
      startTime: booking.startTime,
      durationMin: nextDuration,
      price: booking.price || null,
      serviceDetails: booking.notes || null,
      allergic: booking.allergic ?? null,
      reminders: booking.reminders || [{ method: 'popup', minutes: 1440 }],
    });
    log(reverted ? 'warn' : 'error', reverted ? 'booking_edit_compensated' : 'booking_edit_needs_attention',
      { code: reverted ? 'database_write_failed' : 'calendar_rollback_failed' });
    return false;
  }

  try {
    const after = {
      startTime: patch.startTime || prev.startTime,
      professionalEmail: patch.professionalEmail || prev.professionalEmail,
      professionalName: patch.professionalName || prev.professionalName,
      customerName: patch.customerName || prev.customerName,
    };
    log("info", "[EDIT] booking updated", {
      eventId: booking.eventId,
      before: prev,
      after,
    });
  } catch (err) {
    log("warn", "[CATCH] Errore ignorato", {
      error: String(err)
    }); //  FIX Bug #17
  }

  return true;
}

async function startEditTime(client, chatId) {
  const phone = phoneFromChatId(chatId);
  const bookings = getUserActiveBookingsAll(phone);
  if (!bookings.length) {
    return reply(
      client,
      chatId,
      " Non ho trovato prenotazioni future col tuo numero."
    );
  }

  const openTimeForBooking = async (booking) => {
    const s = pending.get(chatId) || getState(chatId);
    _editSnapshotStateFromBooking(s, booking); // << mente locale
    const day = _editDayFromBooking(booking);
    const duration = _editDuration(booking);
    const pro = booking.professionalEmail || null;

    try {
      releaseSoftHoldByChat(chatId);
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", {
        error: String(err)
      }); //  FIX Bug #17
    }

    const slots = normalizeSlotsDetail(
      await fetchSlots({
        service: booking.service,
        day,
        duration,
        professional: pro,
        wantDetail: true,
      })
    );

    if (!slots.length) {
      const dateStr = typeof formatDateWithWeekdayIT === "function" ?
        formatDateWithWeekdayIT(day) :
        (typeof fmtDate === "function" ? fmtDate(day) : day.toLocaleDateString());
      return reply(
        client,
        chatId,
        `Non vedo orari liberi per ${dateStr} con il professionista attuale. Puoi cambiare data o professionista dal menu di modifica.`
      );
    }

    s.step = "edit_reschedule_time";
    s.edit = {
      target: booking,
      day
    };
    s.collected = s.collected || {};
    s.collected.options = slots;
    pending.set(chatId, s);

    // PATCH: rimosso elenco numerato degli orari, l'utente sceglie l'orario direttamente
    const dateStr = typeof formatDateWithWeekdayIT === "function" ?
      formatDateWithWeekdayIT(day) :
      (typeof fmtDate === "function" ? fmtDate(day) : day.toLocaleDateString());
    const lines = renderSlotsList(slots);
    return reply(
      client,
      chatId,
      `Orari disponibili per ${dateStr}:\n${lines}\n\nScrivi l'orario desiderato (es. "14:30") o tocca l'orario mostrato.`
    );
  };

  if (bookings.length === 1) {
    return openTimeForBooking(bookings[0]);
  }

  // Più prenotazioni: scelgo quale, poi passo a edit_reschedule_time con quel booking
  return startEditChooseBooking(
    client,
    chatId,
    bookings,
    "edit_reschedule_time"
  );
}

async function startEditProfessional(client, chatId) {
  const phone = phoneFromChatId(chatId);
  const bookings = getUserActiveBookingsAll(phone);
  if (!bookings.length)
    return reply(
      client,
      chatId,
      " Non ho trovato prenotazioni future col tuo numero."
    );

  if (bookings.length === 1) {
    const booking = bookings[0];
    const pros = (cfgServiceProfessionals(booking.service) || []).filter(
      (x) => x && x.name
    );
    if (!pros.length)
      return reply(
        client,
        chatId,
        "Non ho professionisti associati a questo servizio."
      );
    const s = pending.get(chatId) || getState(chatId);
    _editSnapshotStateFromBooking(s, booking); // << mente locale
    s.step = "edit_pick_professional";
    s.edit = {
      target: booking,
      proOptions: pros
    };
    pending.set(chatId, s);

    const list =
      "0) Indietro (tieni quello attuale)\n" +
      pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
    return reply(
      client,
      chatId,
      `Scegli il professionista:\n${list}\n(0-${pros.length})`
    );
  }

  return startEditChooseBooking(
    client,
    chatId,
    bookings,
    "edit_pick_professional"
  );
}

async function startEditName(client, chatId) {
  const phone = phoneFromChatId(chatId);
  const bookings = getUserActiveBookingsAll(phone);
  if (!bookings.length)
    return reply(
      client,
      chatId,
      " Non ho trovato prenotazioni future col tuo numero."
    );

  if (bookings.length === 1) {
    const booking = bookings[0];
    const s = pending.get(chatId) || getState(chatId);
    _editSnapshotStateFromBooking(s, booking); // << mente locale
    s.step = "edit_change_name";
    s.edit = {
      target: booking
    };
    pending.set(chatId, s);

    return reply(
      client,
      chatId,
      "Scrivi il nuovo nome e cognome per la prenotazione."
    );
  }

  return startEditChooseBooking(client, chatId, bookings, "edit_change_name");
}

function _fmtBookingLine(booking) {
  if (!booking) return "";

  const whenRaw =
    booking.startTime || booking.start || booking.date || booking.datetime || booking.day || null;

  const when = whenRaw ? new Date(whenRaw) : new Date();
  const ok = Number.isFinite(when.getTime());

  const dayLabel = ok ? fmtWeekdayDateShortIT(when) : "data da definire";
  const hh = ok ? String(when.getHours()).padStart(2, "0") : "--";
  const mi = ok ? String(when.getMinutes()).padStart(2, "0") : "--";

  const service = booking.service || booking.serviceName || "Trattamento";
  const pro = booking.professionalName || proNameByEmail(booking.professionalEmail) || "";
  const proTxt = pro ? ` con ${pro}` : "";

  const customer =
    (booking.customerName || booking.clientName || "").toString().trim();
  const customerTxt = customer ? `.\n*Prenotato per : ${customer}` : "";

  return `${dayLabel} alle ${hh}:${mi} - ${service}${proTxt}${customerTxt}`.trim();
}

function showEditMenu(booking) {
  const line = _fmtBookingLine(booking);

  return ` Prenotazione selezionata:
 *${line}*

 Cosa vuoi fare?
1)  Cambia data
2)  Cambia orario
3)  Cambia professionista
4)  Cambia nome
5)  Modifica un'altra prenotazione
0)  Cancella prenotazione
6)  Esci

Scegli un numero dall'elenco tra 0 e 6
(0-6)`;
}

function renderEditBookingList(bookings) {
  const arr = Array.isArray(bookings) ? bookings : [];
  return arr
    .map((b, i) => {
      const line =
        typeof _fmtBookingLine === "function" ?
          _fmtBookingLine(b) :
          String(b?.service || b?.serviceName || "Prenotazione");
      return `*${i + 1})* ${line}`;
    })
    .join("\n");
}

async function startEditChooseBooking(
  client,
  chatId,
  bookings,
  nextStep = null
) {
  const s = pending.get(chatId) || getState(chatId);
  s.step = "edit_pick_booking";
  s.edit = {
    list: bookings,
    nextStep: nextStep || null
  };
  pending.set(chatId, s);

  const list = renderEditBookingList(bookings);
  const len = Array.isArray(bookings) ? bookings.length : 0;

  if (!len) {
    pending.delete(chatId);
    return reply(client, chatId, "Non ho trovato prenotazioni da modificare.");
  }

  return reply(
    client,
    chatId,
    `Quale prenotazione vuoi modificare?\n\n${list}\n\n(1-${len})\nTip: puoi anche scrivere il trattamento (es. "ceretta") o la data (es. "30 dicembre").\nComandi: annulla`
  );
}

  return { _editParseNewDate, startEditDate, _editDuration, _editListProNamesForService, _editDayFromBooking, _editSnapshotStateFromBooking, _editFormatTimeList, renderSlotsList, _toISO, _editFetchTimes, _editComputeNewNotes, _editApplyUpdate, startEditTime, startEditProfessional, startEditName, _fmtBookingLine, showEditMenu, renderEditBookingList, startEditChooseBooking };
}
