export async function handleMessage(client, chatId, textRaw, tools = {}) {
  // serializza i messaggi per chat con watchdog anti-stallo
  while (__busyChats.has(chatId)) {
    const since = __busySince.get(chatId) || 0;
    if (since && Date.now() - since > BUSY_TTL_MS) {
      log("warn", "[BUSY-STALL] for chat, force-release", {
        chatId,
        since,
        ttl: BUSY_TTL_MS,
      });
      __busyChats.delete(chatId);
      __busySince.delete(chatId);
      break;
    }
    await __delay(50);
  }
  __busyChats.add(chatId);
  __busySince.set(chatId, Date.now());

  // === Stato: DICHIARO E ASSEGNO SUBITO (evita ReferenceError in ESM) ===
  let state = getState(chatId);
  state.collected ||= {};
  state.context ||= {};
state.context.lastDayShown = atNoon(day).toISOString();
state.availFlow ||= {};
state.availFlow.day = atNoon(day).toISOString();  // ISO anche qui ✅

  ensureContext(state);

  // --- Normalizzazione SUBITO ---
  const text = (textRaw ?? "").toString().trim();
  const lower = text.toLowerCase();
  const isCancel = lower === "annulla" || lower === "/annulla";

  try {
    // --- Log in cronologia utente (una sola volta) ---
    try {
      await appendUserMessage(chatId, text);
    } catch (e) {
      log("warn", "appendUserMessage failed", e?.message || e);
    }

    // ============ INLINE HELPERS (solo per questa funzione) =====================
    const pureNumber = /^\s*\d+\s*[\).]?\s*$/; // accetta "2", "2)", "2."
    const t = norm(text);
    // === SHORT-CIRCUIT: numero da elenco (servizi, pro, orari, menu edit, giorno del mese) ===
    if (pureNumber.test(text)) {
      const col = state.collected || (state.collected = {});
      const awaitingDay =
        (state?.availFlow && state.availFlow.awaiting === "day") ||
        state.step === "choose_day";

     const inNumberedStep = [
  "choose_service",
  // "pick_time" gestito nel blocco dedicato più sotto
  "edit_menu",
  "edit_reschedule_time",
  "pick_professional",
  "price_select_service",
].includes(state.step);

      const hasOptions = Array.isArray(col.options) && col.options.length > 0;

      // 🔹 Nuovo: stai aspettando la scelta servizio anche se lo step è “collect”
      const waitingService =
        !col.service &&
        (state.step === "choose_service" ||
          (state.ui &&
            Array.isArray(state.ui.lastServiceList) &&
            state.ui.lastServiceList.length > 0) ||
          (Array.isArray(col.svcOptions) && col.svcOptions.length > 0));

      if (awaitingDay || inNumberedStep || hasOptions || waitingService) {
        return await handleNumericReply(client, chatId, text, tools);
      }
    }

    // --- PATCH: fuzzy "safe" per evitare default al primo servizio quando il match è debole ---
    const hasSvcToken = (q) => {
      try {
        const tokens = (cfgServices() || [])
          .flatMap((s) => s.toLowerCase().split(/\W+/))
          .filter((x) => x && x.length >= 4);
        const nq = norm(q);
        return tokens.some((tok) => nq.includes(norm(tok)));
      } catch {
        return false;
      }
    };

    const fuzzyServiceSafe = (q) => {
      const hit = fuzzyService(q);
      if (!hit) return null;
      const first =
        typeof cfgServices === "function" && (cfgServices()[0] || null);
      if (first && norm(hit) === norm(first) && !hasSvcToken(q)) return null;
      return hit;
    };

    const phone = phoneFromChatId(chatId);
    log("info", "[HANDLE]", { chatId, text });

    // --- CANCELLAZIONE GLOBALE RAPIDA ---
    if (/^(annulla|cancel|stop|fine)\b/i.test(t)) {
      const st = pending.get(chatId);
      if (st && /^edit_/.test(st.step)) {
        pending.delete(chatId);
        releaseSoftHoldByChat(chatId);
        await reply(
          client,
          chatId,
          "✅ Ho chiuso la gestione dell’appuntamento. Nessuna modifica applicata."
        );
        return "";
      }
      if (st) unlockBooking(st);
      pending.delete(chatId);
      releaseSoftHoldByChat(chatId);
      await reply(
        client,
        chatId,
        '✅ Operazione annullata. Se vuoi ricominciare, scrivi "prenota" o "appuntamento".'
      );
      return "";
    }

    // === PATCH: INFO RAPIDE (short-circuit) ===
    const _st = pending.get(chatId);
    if (!isInCriticalStep(state.step)) {
      const RE_ADDR =
        /(indirizz[oi]|dove\s+(siete|vi\s+trovate)|mappa|google\s*maps|come\s+raggiungerci|ubicazion[ei]|posizion[ei])/i;
      const RE_HOURS =
        /(orari?|apert[oi]|chius[oi]|quando\s+(siete|siamo)\s+aperti|fino\s+a\s+che\s+ora)/i;

      if (RE_ADDR.test(t)) {
        const addr = "Via Bosco, 44/a, 42019 Reggio Emilia RE".trim();
        return reply(
          client,
          chatId,
          addr
            ? `Ci trovi qui:\n${addr}\n`
            : `Siamo in Via Bosco, 44/a, 42019 Reggio Emilia RE.`
        );
      }

      if (RE_HOURS.test(t)) {
        const hours = (config?.openingHours || config?.hours || "").trim();
        return reply(
          client,
          chatId,
          hours
            ? `Orari di apertura:\n${hours}`
            : `Orari tipici: Lun–Ven 9–19, Sab 9–13 (chiuso Dom).`
        );
      }
    }
    ensureContext(state);
    // --- Guard lock: blocca solo NUOVI intenti, non gli step del flusso ---
    if (isBookingLocked(state) && !isCancel) {
      if (!isInCriticalStep(state.step) && state.step !== "collect") {
        await safeSend(
          client,
          chatId,
          '❌ Se non vuoi più prenotare, digita "annulla".',
          { noFooter: true }
        );
        return { ok: true, ignored: true };
      }
    }

    const col = state.collected || (state.collected = {});

    function setAndPersist() {
      return pending.set(chatId, state);
    }

    // --- COMANDI VELOCI DI MODIFICA ---
    if (
      /^(modifica|cambia)\s+(data|giorno)\b/i.test(t) ||
      /^\/data\b/i.test(t)
    ) {
      await startEditDate(client, chatId);
      return "";
    }
    if (
      /^(modifica|cambia)\s+(ora|orario)\b/i.test(t) ||
      /^\/orario\b/i.test(t)
    ) {
      await startEditTime(client, chatId);
      return "";
    }
    if (
      /^(modifica|cambia)\s+(professionista|operatrice|operatore)\b/i.test(t) ||
      /^\/pro(f)?\b/i.test(t)
    ) {
      await startEditProfessional(client, chatId);
      return "";
    }
    if (
      /^(modifica|cambia)\s+(nome|intestazione)\b/i.test(t) ||
      /^\/nome\b/i.test(t)
    ) {
      await startEditName(client, chatId);
      return "";
    }

    // --- MENU GENERICO /modifica ---
    if (/^\/?modifica\b/i.test(t)) {
      const booking = getUpcomingBookingByPhone(phone);
      if (booking) {
        state.step = "edit_menu";
        state.edit = { target: booking };
        setAndPersist();
        await reply(client, chatId, showEditMenu(booking));
      } else {
        await reply(
          client,
          chatId,
          "Non ho trovato prenotazioni future col tuo numero."
        );
      }
      return "";
    }

    function renderSlotsList(slots) {
      if (!Array.isArray(slots) || !slots.length) return "";
      const isObj = typeof slots[0] === "object" && slots[0] && slots[0].time;
      if (!isObj) {
        return slots.map((h, i) => `${i + 1}) ${h}`).join("\n");
      }
      return slots
        .map((it, i) => {
          const prosLbl = labelProsForSlot(it);
          return `${i + 1}) ${it.time}${prosLbl ? ` (${prosLbl})` : ""}`;
        })
        .join("\n");
    }

    // ——— PRO LABELING ———
    function proShort(name) {
      const s = String(name || "").trim();
      if (!s) return "";
      const parts = s.split(/\s+/);
      if (parts.length === 1) return parts[0]; // es. "Melissa"
      const cognome = parts[parts.length - 1];
      const iniz = cognome[0] ? cognome[0].toUpperCase() : "";
      return `${parts[0]} ${iniz}.`; // "Melissa G."
    }

    function proKey(p) {
      const email = (p?.email || "").toLowerCase().trim();
      if (email) return email;
      const nm = (p?.name || p || "").toString();
      return norm(nm);
    }

    /** Normalizza: accetta ["10:00","11:00"] o [{time,pros}] → [{time,pros:[]}] */
    function normalizeSlotsDetail(slots) {
      if (!Array.isArray(slots)) return [];
      if (slots.length && typeof slots[0] === "object" && slots[0]?.time)
        return slots;
      return slots.map((h) => ({ time: h, pros: [] }));
    }

    // ===================== Debounce duplicati =====================
    if (!global.__lastMessages) global.__lastMessages = new Map();
    const lastMsg = global.__lastMessages.get(phone);
    if (lastMsg && lastMsg.text === text && Date.now() - lastMsg.ts < 800)
      return "";
    global.__lastMessages.set(phone, { text, ts: Date.now() });
    {
      // ===== VIEW-ONLY AVAILABILITY — MINI-FLOW =====
      // Usa: state.availFlow = { mode:'month'|'week', year, monthIdx, days:[Date], awaiting:'day' }

      // 1) Se sto aspettando il giorno (dopo "dicembre?" o "settimana prossima?")
      if (state.availFlow && state.availFlow.awaiting === "day") {
        if (/\b(annulla|indietro|esci|stop)\b/i.test(t)) {
          state.availFlow = null;
          setAndPersist();
          return reply(
            client,
            chatId,
            "Ok, annullato. Dimmi pure un’altra data."
          );
        }

        // prendi un numero 1..31 o "il 21"
        const m = String(text).match(/\b([1-9]|[12]\d|3[01])\b/);
        if (!m)
          return reply(
            client,
            chatId,
            'Dimmi il *giorno* in numero (es. "21").'
          );
        const dayNum = parseInt(m[1], 10);

        let targetDay = null;

        if (state.availFlow.mode === "month") {
          const { year, monthIdx } = state.availFlow;
          const max = daysInMonth(year, monthIdx);
          if (dayNum < 1 || dayNum > max) {
            return reply(
              client,
              chatId,
              `Giorno non valido per ${monthLabelIT(
                monthIdx
              )} (${max} giorni). Riprova con 1-${max}.`
            );
          }
          targetDay = new Date(year, monthIdx, dayNum, 12, 0, 0, 0);
        } else if (state.availFlow.mode === "week") {
          const arr = state.availFlow.days || [];
          // Se l’utente ha scritto 1..7 senza "il/di", prendilo come indice; altrimenti prova match sul giorno del mese
          if (
            dayNum >= 1 &&
            dayNum <= arr.length &&
            !/\b(il|del|di)\b/i.test(t)
          ) {
            targetDay = arr[dayNum - 1];
          } else {
            targetDay = arr.find((d) => d.getDate() === dayNum) || null;
            if (!targetDay) {
              const lines = arr
                .map(
                  (d, i) =>
                    `${i + 1}) ${String(d.getDate()).padStart(
                      2,
                      "0"
                    )} ${itaWeekdayName(d)}`
                )
                .join("\n");
              return reply(
                client,
                chatId,
                `Scegli un numero (1-${arr.length}) o un giorno del mese presente nella lista:\n${lines}`
              );
            }
          }
        }

        state.availFlow = null;
        setAndPersist();
        const msgOut = await buildAvailabilityMessage({
          day: atNoon(targetDay),
          service: col.service || null,
          duration: col.service ? cfgServiceDuration(col.service) : null,
          professional: col.professionalEmail || col.professionalName || null,
        });
        return reply(client, chatId, msgOut);
      }

      // 2) Nuova richiesta di disponibilità (giorno / settimana / mese)
      {
        const req = parseAvailabilityRequest(text);
        if (req) {
          const svcCtx = col.service || fuzzyServiceSafe(text) || null;
          const durCtx = svcCtx ? cfgServiceDuration(svcCtx) : null;

         if (req.kind === "day") {
  const proCtx = col.professionalEmail || col.professionalName || null;
  return await showDayAvailability(req.date, svcCtx, col.professionalEmail || col.professionalName || null);

}


          if (req.kind === "next_week") {
            const days = listNextWeekDays();
            state.availFlow = { mode: "week", days, awaiting: "day" };
            setAndPersist();
            const lines = days
              .map(
                (d, i) =>
                  `${i + 1}) ${String(d.getDate()).padStart(
                    2,
                    "0"
                  )} ${itaWeekdayName(d)}`
              )
              .join("\n");
            return reply(
              client,
              chatId,
              `Settimana prossima è troppo ampia: scegli un giorno.\n${lines}\nRispondi con *1-${
                days.length
              }* oppure con il *giorno* (es. "${String(
                days[0].getDate()
              ).padStart(2, "0")}").`
            );
          }

          if (req.kind === "month") {
            const { year, monthIdx } = req;
            state.availFlow = {
              mode: "month",
              year,
              monthIdx,
              awaiting: "day",
            };
            setAndPersist();
            return reply(
              client,
              chatId,
              buildAskDayOfMonthPrompt(year, monthIdx)
            );
          }
        }
      }
    }
    // === MODALITÀ DISPONIBILITÀ (explorer) ===
    async function showDayAvailability(dayIn, svcCtx, proCtx) {
  const D = atNoon(dayIn);
const duration = svcCtx ? cfgServiceDuration(svcCtx) : null;
      const slotsDetail = normalizeSlotsDetail(
        await fetchSlots({
          service: svcCtx || null,
          day: D,
          duration,
          professional: proCtx || null,
          wantDetail: true,
        })
      );
      state.availFlow = {
  active: true,
  day: D.toISOString(),
  service: svcCtx || null,
  professional: proCtx || null,
  slots: slotsDetail,
};
state.context ||= {};
state.context.lastDayShown = D.toISOString();
state.availFlow ||= {};
state.availFlow.day = D.toISOString();

pending.set(chatId, state);

      pending.set(chatId, state);

      if (!slotsDetail.length) {
        return reply(
          client,
          chatId,
          `😕 Nessun orario libero per ${fmtDate(D)
}${
            svcCtx ? ` (${svcCtx})` : ""
          }.\nScrivi un’altra *data* (es. "domani" o "21/10") oppure *annulla* per uscire.`
        );
      }

      const list = slotsDetail
        .map((it, i) => {
          const prosLbl = labelProsForSlot(it);
          return `${i + 1}) ${it.time}${prosLbl ? ` (${prosLbl})` : ""}`;
        })
        .join("\n");

      return reply(
        client,
        chatId,
        `📅 Disponibilità ${fmtDate(D)
}${
          svcCtx ? ` • ${svcCtx}` : ""
        }\n${list}\n(1-${
          slotsDetail.length
        })\n\nPuoi:\n• Rispondere con *numero* o *HH:MM* per scegliere\n• Scrivere un’altra *data* per cambiare giorno\n• Scrivere *annulla* per uscire`
      );
    }

    // — gestione interazioni in modalità disponibilità —
    if (state.availFlow && state.availFlow.active) {
      if (/\b(annulla|esci|stop|indietro)\b/i.test(t)) {
        state.availFlow = null;
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          "Ok, uscita dalla ricerca di disponibilità."
        );
        // NON return: continuiamo col resto se serve
      } else {
        // 1) Numero da lista -> prenota
        if (/^\s*\d+\s*$/.test(text)) {
          const n = parseInt(text, 10);
          const opts = state.availFlow.slots || [];
          if (n >= 1 && n <= opts.length) {
            const picked = opts[n - 1];
            col.when = new Date(state.availFlow.day);
            col.time = picked.time;
            // auto-pro se un solo pro nello slot
            if (
              !col.professionalAny &&
              !col.professionalEmail &&
              !col.professionalName &&
              picked?.pros?.length === 1
            ) {
              col.professionalEmail = picked.pros[0].email;
              col.professionalName = picked.pros[0].name;
            }
            if (!col.service && state.availFlow.service)
              col.service = state.availFlow.service;
            state.step = "collect";
bumpBookingLock(state);
if (state.context) state.context.lastDayShown = null;
if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
return await advanceAppointment(false);

          }
        }

        // 2) Orario HH:MM -> prenota
        {
          const hhmm = parseTimeSmart(text);
          if (hhmm) {
            col.when = new Date(state.availFlow.day);
            col.time = hhmm;
            if (!col.service && state.availFlow.service)
              col.service = state.availFlow.service;
            state.step = "collect";
bumpBookingLock(state);
if (state.context) state.context.lastDayShown = null;
if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
return await advanceAppointment(false);

          }
        }

        // 3) Altra data -> ricarica disponibilità
        {
          const newDay = parseRelativeDay(text);
          if (newDay) {
            const svcCtx =
              state.availFlow.service ||
              col.service ||
              fuzzyServiceSafe(text) ||
              null;
            const proCtx =
              col.professionalEmail || col.professionalName || null;
            return await showDayAvailability(newDay, svcCtx, proCtx);
          }
        }
        // se non riconosco niente, spiego come fare
        return reply(
          client,
          chatId,
          "Scrivi *un numero*, un orario *HH:MM* o un’altra *data*. Per uscire scrivi *annulla*."
        );
      }
    }
    // === Conferma giorno alternativo quando il selezionato è chiuso ===
    if (state.step === "confirm_alt_day") {
      const tyes = /\b(s[iì]|si|ok|va ?bene|perfetto)\b/i.test(t);
      const tno = /\b(no|cambia|altra|diversa|non)\b/i.test(t);
      const iso = state.context?.altDaySuggest;
      const alt = iso ? new Date(iso) : null;

       if (tyes && alt) {
 col.when = atNoon(alt);
 if (state.context) state.context.lastDayShown = null;
 // gotoPickTime imposta già pick_time; qui assicuro lock+persist
 bumpBookingLock(state);
 if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
 const r = await gotoPickTime(col.when);
        if (r) return r;
        return reply(
          client,
          chatId,
          "Per quel giorno non ho orari liberi. Vuoi indicare un’altra data?"
        );
      }
      if (tno) {
    state.step = "choose_day";
    state.ui ||= {}; state.ui.lastAsk = "date";
    if (state.context) { state.context.altDaySuggest = null; state.context.lastDayShown = null; }
    if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
    return reply(client, chatId, 'Ok, dimmi un’altra data (GG/MM o "domani").');
  }
    }

    // === TIME OVERRIDE ROBUSTO: se scrivo un orario, usalo nel flow corrente ===
    {
      const hhmm = parseTimeSmart(text); // (il tuo parser: 18:30 / 18.30 / 1830 / "18 e 30")
      if (hhmm) {
        const col = state.collected || (state.collected = {});
        const inBooking =
          isBookingFlowActive(state, col) ||
          [
            "collect",
            "choose_service",
            "pick_time",
            "ask_allergies",
            "ask_name",
          ].includes(String(state.step || "")) ||
          !!col.service ||
          !!col.when ||
          !!state.availFlow?.active;

        if (inBooking) {
          // Se provengo dalla modalità disponibilità, prendo CONTEX da lì
          if (state.availFlow && state.availFlow.active) {
            // data del giorno mostrato
            if (!col.when && state.availFlow.day) {
              col.when = new Date(state.availFlow.day);
            }
            // servizio di contesto (se c'era)
            if (!col.service && state.availFlow.service) {
              col.service = state.availFlow.service;
            }
            // se lo slot scelto esiste ed ha 1 solo pro, auto-assegna
            if (
              !col.professionalAny &&
              !col.professionalEmail &&
              !col.professionalName
            ) {
              const slot = (state.availFlow.slots || []).find(
                (s) => s.time === hhmm
              );
              if (slot?.pros?.length === 1) {
                col.professionalEmail = slot.pros[0].email;
                col.professionalName = slot.pros[0].name;
              }
            }
            // esci dalla availability mode
            state.availFlow = null;
          }

          // imposta l'orario e avanza nel flow
          col.time = hhmm;
          state.step = "collect";
          bumpBookingLock(state);
          pending.set(chatId, state);

          const r = await advanceAppointment(false);
          if (r) return r;
          // se manca ancora qualcosa (es. data o nome) il flow lo chiederà qui sotto
        }
      }
    }

    // — TRIGGER MODALITÀ DISPONIBILITÀ — SOLO SE ESPRESSA E MAI DURANTE IL BOOKING
    {
      const inBooking =
        isInCriticalStep(state.step) ||
        isBookingFlowActive(state, state.collected);
      if (!inBooking) {
        // chiedono esplicitamente disponibilità / posti / orari liberi
        const explicitAvailRe =
          /\b(?:avete\s+posto|c[’'`]?\s?è\s+posto|posti?\s+liber[oi]|disponibil(?:ità|ita)|orari?\s+liber[oi]|slot|quando\s+(?:siete|siamo)\s+liber[oi])\b/i;
        // indizi “periodo” (settimana/mese) senza orario specifico
        const weekHintRe = /\b(?:questa\s+settimana|settimana\s+prossima)\b/i;
        const monthHintRe = /\b(?:questo\s+mese|prossimo\s+mese)\b/i;

        const askedAvail = explicitAvailRe.test(t);
        const askedWeek = weekHintRe.test(t);
        const askedMonth = monthHintRe.test(t);

        // Se hai un parser alto livello, usalo come extra-segnale
        const req =
          typeof parseAvailabilityRequest === "function"
            ? parseAvailabilityRequest(text)
            : null;

        if (askedAvail || askedWeek || askedMonth || req) {
          const col = state.collected || (state.collected = {});
          const svcCtx =
            col.service ||
            (typeof fuzzyServiceSafe === "function" &&
              fuzzyServiceSafe(text)) ||
            null;
          const proCtx = col.professionalEmail || col.professionalName || null;

          // — SETTIMANA (lista giorni → l’utente sceglie)
          if (askedWeek || (req && req.kind === "next_week")) {
            const days = listNextWeekDays();
            state.availFlow = { mode: "week", days, awaiting: "day" };
            pending.set(chatId, state);
            const lines = days
              .map(
                (d, i) =>
                  `${i + 1}) ${String(d.getDate()).padStart(
                    2,
                    "0"
                  )} ${itaWeekdayName(d)}`
              )
              .join("\n");
            await reply(
              client,
              chatId,
              `🔎 Modalità disponibilità (settimana prossima).\n` +
                `Scegli un giorno:\n${lines}\n` +
                `Rispondi con **1-${
                  days.length
                }** oppure scrivi il **giorno** (es. "${String(
                  days[0].getDate()
                ).padStart(2, "0")}")`
            );
            return "";
          }

          // — MESE (scegli il giorno del mese indicato)
          if (askedMonth || (req && req.kind === "month")) {
            const base = new Date();
            const next = /\bprossim/i.test(t) || (req && req.shift === 1);
            if (next) {
              base.setMonth(base.getMonth() + 1);
            }
            const year = base.getFullYear();
            const monthIdx = base.getMonth(); // 0..11
            state.availFlow = {
              mode: "month",
              year,
              monthIdx,
              awaiting: "day",
            };
            pending.set(chatId, state);
            await reply(
              client,
              chatId,
              buildAskDayOfMonthPrompt(year, monthIdx)
            );
            return "";
          }

          // — GIORNO SINGOLO (default)
          const day =
            (req && req.kind === "day" && req.date) ||
            parseRelativeDay(text) ||
            (col.when ? atNoon(col.when) : nextOpenDay(new Date()));

          await reply(
            client,
            chatId,
            "🔎 Modalità disponibilità attiva. Per uscire scrivi **annulla**."
          );
          return await showDayAvailability(day, svcCtx, proCtx);
        }
      }
    }

    // ===================== PRIORITÀ INFO (prima di qualsiasi lock) =====================
    if (looksLikeInfoQuestion(text) && !isInCriticalStep(state.step)) {
      const svcCtx =
        resolveServiceFromText(text) ||
        fuzzyServiceSafe(text) ||
        col.service ||
        getLastService(chatId);

      const topic = extractInfoTopic(text); // <<--- MANCAVA

      if (svcCtx) rememberService(chatId, svcCtx);
      if (topic) rememberInfoTopic(chatId, topic);

      const prompt = buildQAPromptWithMemory(
        chatId,
        composeInfoPrompt(svcCtx, topic)
      );
      let answer = (await askQA(prompt, tools, client)).trim();

      if (!answer) {
        if (svcCtx) {
          answer = `• ${svcCtx}: ${cfgServicePriceText(
            svcCtx
          )} (durata ${cfgServiceDuration(svcCtx)} min)`;
        } else {
          return await askInfoWhichService(client, chatId, state, col);
        }
      }
      return reply(client, chatId, answer);
    }

    // ===================== Booking lock SOLO ora (se flusso attivo o messaggio sembra prenotazione) =====================
    if (isBookingFlowActive(state, col) || looksLikeBooking(text))
      bumpBookingLock(state);

    // ===================== Menu gestione prenotazione =====================
    if (
      (typeof wantsEditMenu === "function" && wantsEditMenu(t)) ||
      /\b(modifica|cancella|annulla)\b.*\b(appunt|prenot)\b/i.test(t) ||
      /\b(appunt|prenot)\b.*\b(modifica|cancella|annulla)\b/i.test(t)
    ) {
      const booking = getUpcomingBookingByPhone(phone);
      if (booking) {
        state.step = "edit_menu";
        state.edit = { target: booking };
        setAndPersist();
        return reply(client, chatId, showEditMenu(booking));
      }
      return reply(
        client,
        chatId,
        "Non ho trovato prenotazioni future col tuo numero."
      );
    }

    // === Gestione scelte del menu di editing ===
    if (state.step === "edit_menu") {
      const booking = state.edit && state.edit.target;
      if (!booking) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
        );
      }

      if (!/^\s*[0-4]\s*$/.test(t)) {
        return reply(client, chatId, "Scegli un numero valido (0-4).");
      }
      const n = parseInt(t, 10);

      // 0) Cancella → chiedi conferma
      if (n === 0) {
        state.step = "edit_cancel_confirm";
        setAndPersist();
        const d = new Date(booking.startTime);
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        return reply(
          client,
          chatId,
          `Confermi di annullare l’appuntamento del ${dd}/${mm} alle ${hh}:${mi}? (sì/no)`
        );
      }

      // 1) Modifica data → chiedi nuova data
      if (n === 1) {
        state.step = "edit_reschedule_date";
        setAndPersist();
        return reply(
          client,
          chatId,
          "📅 Scrivi la *nuova data* (GG/MM o “domani”)."
        );
      }

      // 2) Modifica orario → mostra slot del giorno attuale della prenotazione
      if (n === 2) {
        const day = new Date(booking.startTime);
        const duration =
          Number(booking.durationMin) || cfgServiceDuration(booking.service);
        const slots = normalizeSlotsDetail(
          await fetchSlots({
            service: booking.service,
            day,
            duration,
            professional:
              booking.professionalEmail || booking.professionalName || null,
            wantDetail: true,
          })
        );
        if (!slots.length)
          return reply(
            client,
            chatId,
            `Nessun orario libero per ${fmtDate(D)
}.`
          );
        col.options = slots;
        state.edit.day = day;
        state.step = "edit_reschedule_time";
        setAndPersist();
        return reply(
          client,
          chatId,
          `Orari disponibili per ${fmtDate(D)
}:\n${renderSlotsList(
            slots
          )}\n(1-${slots.length})`
        );
      }

      // 3) Modifica professionista
      if (n === 3) {
        const pros = (cfgServiceProfessionals(booking.service) || []).map(
          (p) => p.name
        );
        if (!pros.length)
          return reply(
            client,
            chatId,
            "Non ho professionisti configurati per questo servizio."
          );
        col.proOptions = pros;
        state.step = "edit_pick_professional";
        setAndPersist();
        return reply(
          client,
          chatId,
          `Preferisci un professionista in particolare?\n0) Non mi interessa\n${pros
            .map((p, i) => `${i + 1}) ${p}`)
            .join("\n")}\n(0-${pros.length})`
        );
      }

      // 4) Modifica nome
      if (n === 4) {
        state.step = "edit_change_name";
        setAndPersist();
        return reply(
          client,
          chatId,
          "Scrivi *nome e cognome* corretti (es. “Giulia Bianchi”)."
        );
      }
      return "";
    }
    if (state.step === "edit_cancel_confirm") {
      const booking = state.edit && state.edit.target;
      if (!booking) {
        pending.delete(chatId);
        return reply(client, chatId, "Sessione scaduta.");
      }

      const yes = /\b(s[iì]|yes|y|ok|va bene|confermo|1)\b/i.test(t);
      const no = /\b(no|n|annulla|indietro|2)\b/i.test(t);

      if (yes) {
        await cancelEventSafe(booking.eventId);
        updateBookingByEventId(booking.eventId, {
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        });
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          `✅ Prenotazione del ${fmtDate(booking.startTime)} annullata.`
        );
      }
      if (no) {
        state.step = "edit_menu";
        setAndPersist();
        return reply(client, chatId, showEditMenu(booking));
      }
      return reply(client, chatId, "Rispondi *sì* o *no*.");
    }
    if (state.step === "edit_reschedule_time") {
      const booking = state.edit && state.edit.target;
      const options = col.options || [];
      if (!booking || !options.length) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
        );
      }

      // Numero da lista
      if (pureNumber.test(text)) {
        const n = parseInt(text, 10);
        if (n < 1 || n > options.length) {
          return reply(
            client,
            chatId,
            `Scegli un numero valido (1-${options.length}).`
          );
        }
        const item = options[n - 1];
        const chosen = typeof item === "string" ? item : item.time;

        const day = state.edit?.day
          ? new Date(state.edit.day)
          : new Date(booking.startTime);
        const newStart = setTime(day, chosen);
        const duration =
          Number(booking.durationMin) || cfgServiceDuration(booking.service);

        // Mantieni lo stesso pro se possibile, altrimenti il primo libero nello slot
        let newProEmail = booking.professionalEmail;
        let newProName = booking.professionalName;
        const pros = typeof item === "object" && item?.pros ? item.pros : [];
        if (pros.length) {
          const same = pros.find(
            (p) => p.email && p.email === booking.professionalEmail
          );
          const pick = same || pros[0];
          newProEmail = pick.email || newProEmail;
          newProName = pick.name || newProName;
        }

        const ok = await updateEventSafe({
          eventId: booking.eventId,
          serviceName: booking.service,
          professionalEmail: newProEmail,
          clientPhone: booking.clientPhone,
          startTime: toISOStringLocal(newStart),
          durationMin: duration,
        });

        if (ok) {
          updateBookingByEventId(booking.eventId, {
            startTime: toISOStringLocal(newStart),
            professionalEmail: newProEmail,
            professionalName: newProName || proNameByEmail(newProEmail),
          });
          pending.delete(chatId);
          return reply(
            client,
            chatId,
            `✅ Appuntamento spostato a ${fmtDate(newStart)} alle ${chosen}.`
          );
        }
        return reply(
          client,
          chatId,
          "❌ Non sono riuscito a spostare l’appuntamento. Riprova tra poco."
        );
      }

      // Orario libero HH:MM
      let hhmm = parseHHMM(text);
      if (!hhmm) hhmm = parseNaturalTime(text);
      if (hhmm) {
        const day = state.edit?.day
          ? new Date(state.edit.day)
          : new Date(booking.startTime);
        const newStart = setTime(day, hhmm);
        const duration =
          Number(booking.durationMin) || cfgServiceDuration(booking.service);

        const ok = await updateEventSafe({
          eventId: booking.eventId,
          serviceName: booking.service,
          professionalEmail: booking.professionalEmail,
          clientPhone: booking.clientPhone,
          startTime: toISOStringLocal(newStart),
          durationMin: duration,
        });
        if (ok) {
          updateBookingByEventId(booking.eventId, {
            startTime: toISOStringLocal(newStart),
          });
          pending.delete(chatId);
          return reply(
            client,
            chatId,
            `✅ Appuntamento spostato a ${fmtDate(newStart)} alle ${hhmm}.`
          );
        }
        return reply(
          client,
          chatId,
          "❌ Non sono riuscito a spostare l’appuntamento. Riprova."
        );
      }

      return reply(
        client,
        chatId,
        `Scegli un numero (1-${options.length}) o scrivi un orario *HH:MM*.`
      );
    }

    // ===================== Shortcut “edit_*” (data / pro / nome) =====================
    // Cambio data → chiedi nuova data e poi proponi orari (con pros)
    if (state.step === "edit_reschedule_date") {
      const chosenTimeEdit =
        (typeof parseTimeSmart === "function" && parseTimeSmart(text)) ||
        (typeof parseHHMM === "function" && parseHHMM(text)) ||
        null;
      if (chosenTimeEdit) {
        // memorizza nelle collected (riusiamo lo stesso campo)
        const col = state.collected || (state.collected = {});
        col.pendingTime = chosenTimeEdit;
        setAndPersist();
        await reply(
          client,
          chatId,
          `Segno *${chosenTimeEdit}*. Ora dimmi la data (es. "domani" o "23/10").`
        );
        return "";
      }

      const booking = state.edit && state.edit.target;
      if (!booking) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
        );
      }
      const day = parseRelativeDay(t);
      if (!day)
        return reply(
          client,
          chatId,
          "Formato data non riconosciuto. Scrivi GG/MM o “domani”."
        );

      state.step = "edit_reschedule_time";
      state.edit.day = day;
      setAndPersist();

      const duration =
        Number(booking.durationMin) || cfgServiceDuration(booking.service);
      const slots = normalizeSlotsDetail(
        await fetchSlots({
          service: booking.service,
          day,
          duration,
          professional:
            booking.professionalEmail || booking.professionalName || null,
          wantDetail: true,
        })
      );
      if (!slots.length) {
        return reply(
          client,
          chatId,
          `Non vedo orari liberi per ${fmtDate(D)
}. Prova un altro giorno.`
        );
      }
      col.options = slots;
      setAndPersist();
      return reply(
        client,
        chatId,
        `Orari disponibili per ${fmtDate(D)
}:\n${renderSlotsList(
          slots
        )}\n(1-${slots.length})`
      );
    }

    // Cambio professionista
    if (state.step === "edit_pick_professional") {
      const booking = state.edit && state.edit.target;
      const pros = (state.edit && state.edit.proOptions) || [];
      const n = parseInt(t, 10);
      if (isNaN(n) || n < 1 || n > pros.length) {
        return reply(
          client,
          chatId,
          `Scegli un numero valido (1-${pros.length}).`
        );
      }
      const newProName = pros[n - 1];
      const newProEmail = proEmailByName(newProName);

      const currentDate = new Date(booking.startTime);
      const duration =
        Number(booking.durationMin) || cfgServiceDuration(booking.service);
      const slots = normalizeSlotsDetail(
        await fetchSlots({
          service: booking.service,
          day: currentDate,
          duration,
          professional: newProEmail || newProName,
          wantDetail: true,
        })
      );
      const hhmm = booking.startTime.slice(11, 16);
      const times = slots.map((x) => x.time);
      if (!times.includes(hhmm)) {
        state.step = "edit_reschedule_time";
        state.edit.day = currentDate;
        col.options = slots;
        setAndPersist();
        return reply(
          client,
          chatId,
          `A quell'ora ${newProName} non è libero. Ecco gli orari disponibili per ${fmtDate(
            currentDate
          )}:\n${renderSlotsList(slots)}\n(1-${slots.length})`
        );
      }
      const startISO = toISOStringLocal(currentDate);
      const ok = await updateEventSafe({
        eventId: booking.eventId,
        serviceName: booking.service,
        professionalEmail: newProEmail || booking.professionalEmail,
        clientPhone: booking.clientPhone,
        startTime: startISO,
        durationMin: booking.durationMin,
      });
      if (ok) {
        updateBookingByEventId(booking.eventId, {
          professionalEmail: newProEmail,
          professionalName: newProName,
        });
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          `✅ Professionista aggiornato: ${newProName}.`
        );
      }
      return reply(
        client,
        chatId,
        "❌ Non sono riuscito a modificare il professionista."
      );
    }

    // Cambio nome
    if (state.step === "edit_change_name") {
      const booking = state.edit && state.edit.target;
      const name = extractCustomerName(text) || t;
      if (!booking || !name || name.split(" ").length < 2) {
        return reply(
          client,
          chatId,
          "Scrivi nome e cognome (es. “Giulia Bianchi”)."
        );
      }
      const ok = await updateEventSafe({
        eventId: booking.eventId,
        serviceName: booking.service,
        professionalEmail: booking.professionalEmail,
        clientPhone: booking.clientPhone,
        startTime: booking.startTime,
        durationMin: booking.durationMin,
        notes:
          (booking.notes || "").replace(/Nome:\s*.*$/im, "").trim() +
          `\nNome: ${name}`,
      });
      if (ok) {
        updateBookingByEventId(booking.eventId, { customerName: name });
        pending.delete(chatId);
        return reply(client, chatId, `✅ Nome aggiornato: ${name}.`);
      }
      return reply(
        client,
        chatId,
        "❌ Non sono riuscito a modificare il nome."
      );
    }

    // ===================== Reset conversazione =====================
    if (/^\s*(annulla|reset|stop|cancella|ricomincia)\s*$/i.test(t)) {
      if (state) unlockBooking(state);
      pending.delete(chatId);
      releaseSoftHoldByChat(chatId);

      return reply(
        client,
        chatId,
        "👍 Ok, procedura annullata. Dimmi pure come posso aiutarti."
      );
    }

    // ===================== Anti-loop: se "qualsiasi professionista" già scelto =====================
    if (state.step === "pick_professional" && col.professionalAny === true) {
      state.step = "collect";
      setAndPersist();
    }

    // ===================== Shortcut gestione cancellazione/spostamento =====================
    const manageCancelPattern =
      /\b(?:annull|cancell|disd)\w*.*\b(?:appunt|prenot)\w*/i;
    const manageModifyPattern =
      /\b(?:modif|spost|camb)\w*.*\b(?:appunt|prenot)\w*/i;

    if (manageCancelPattern.test(t)) {
      const booking = getUpcomingBookingByPhone(phone);
      if (!booking)
        return reply(
          client,
          chatId,
          "🤔 Non risulta alcuna prenotazione da annullare."
        );
      const startTs = new Date(booking.startTime).getTime();
      if (startTs - Date.now() < CANCEL_POLICY_HOURS * 3600 * 1000) {
        return reply(
          client,
          chatId,
          `Mancano meno di ${CANCEL_POLICY_HOURS} ore: non posso annullare automaticamente. Contatta il salone.`
        );
      }
      await cancelEventSafe(booking.eventId);
      updateBookingByEventId(booking.eventId, {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
      });
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        `✅ Prenotazione del ${fmtDate(
          booking.startTime
        )} alle ${booking.startTime.slice(11, 16)} annullata.`
      );
    }

    if (manageModifyPattern.test(t)) {
      const booking = getUpcomingBookingByPhone(phone);
      if (!booking)
        return reply(
          client,
          chatId,
          "🤔 Non risulta alcuna prenotazione da modificare."
        );
      if (state) unlockBooking(state);
      pending.delete(chatId);
      state = {
        step: "collect",
        collected: {
          service: booking.service,
          when: null,
          time: null,
          professionalAny: false,
          professionalName:
            booking.professionalName ||
            proNameByEmail(booking.professionalEmail),
          professionalEmail: booking.professionalEmail,
          customerName: booking.customerName,
          allergies: booking.allergies || null,
          options: [],
          proOptions: null,
          daypartWindow: null,
          infoOptions: null,
          pendingTime: null,
          allSlotsMode: false,
          eventId: booking.eventId,
        },
        context: { lastService: null, lastInfoTopic: null, lock: null },
      };
      ensureContext(state);
      pending.set(chatId, state);
      await reply(
        client,
        chatId,
        `Hai un appuntamento per *${booking.service}* il *${fmtDate(
          booking.startTime
        )}* alle *${booking.startTime.slice(
          11,
          16
        )}*.\n📅 Per quando vuoi spostarlo? (Indica una nuova data)`
      );
      return "";
    }

    // ===================== Helpers inline per avanzamento =====================
    async function gotoPickTime(dayIn) {
  const D = atNoon(dayIn);
      const duration = cfgServiceDuration(col.service);
      const proEmail = col.professionalAny
        ? null
        : col.professionalEmail ||
          (col.professionalName ? proEmailByName(col.professionalName) : null);

      const slotsRaw = await fetchSlots({
        service: col.service,
        D,
        duration,
        professional: proEmail || null,
        wantDetail: true, // chiedi dettaglio pros per slot
      });
      const slotsDetail = normalizeSlotsDetail(slotsRaw);
      let filtered = filterSlotsByWindow(
        slotsDetail.map((s) => s.time),
        col.daypartWindow || null
      )
        .map((h) => slotsDetail.find((s) => s.time === h))
        .filter(Boolean);

      if (!filtered.length) return null;
state.context ||= {};
state.context.lastDayShown = atNoon(day).toISOString();
state.availFlow ||= {};
state.availFlow.day = atNoon(day).toISOString();  // ISO anche qui ✅

state.context.lastDayShown = atNoon(day).toISOString(); // << ancora valido se l’utente risponde col numero/ora

      col.options = filtered;
      
      state.step = "pick_time";
      bumpBookingLock(state);
      setAndPersist();

      // Raggruppo per daypart renderizzando pros
      const grouped = groupSlotsByDaypart(filtered.map((s) => s.time));
      const mk = (title, arr) => {
        if (!arr.length) return "";
        const lines = arr
          .map((h) => {
            const item = filtered.find((x) => x.time === h) || { pros: [] };
            const prosLbl = labelProsForSlot(item);
            return `• ${h}${prosLbl ? ` (${prosLbl})` : ""}`;
          })
          .join("\n");
        return `${title}\n${lines}`;
      };
      const listText = [
        mk("Mattina:", grouped.mattina),
        mk("Pomeriggio:", grouped.pomeriggio),
        mk("Sera:", grouped.sera),
      ]
        .filter(Boolean)
        .join("\n");

      const allergBanner = getAllergens(col.service).length
        ? `\nAllergeni monitorati: ${getAllergens(col.service).join(", ")}`
        : "";

      const header = proEmail
        ? `📅 Disponibilità per il ${fmtDate(D)
} (solo ${
            col.professionalName || proNameByEmail(proEmail)
          }):`
        : `📅 Disponibilità per il ${fmtDate(D)
} (tutti i professionisti):`;

      const extra = proEmail ? `\n0) Vedi tutti gli slot disponibili` : ``;
      const range = proEmail
        ? `(0-${col.options.length})`
        : `(1-${col.options.length})`;
      return reply(
        client,
        chatId,
        `${header}${allergBanner}\n${listText}${extra}\n${range}`
      );
    }

    function askNameIfMissing() {
      if (!col.customerName) {
        state.step = "ask_name";
        bumpBookingLock(state);
        setAndPersist();
        return reply(client, chatId, "Per favore, il tuo nome e cognome? 😊");
      }
      return null;
    }

    function askProfessionalIfNeeded() {
      if (
        !col.professionalAny &&
        !col.professionalName &&
        !col.professionalEmail
      ) {
        const prosSpec = cfgServiceProfessionals(col.service);
        const names = prosSpec.length
          ? prosSpec.map((p) => p.name)
          : Object.values(config.professionals || {}).map((p) => p.name);

        // Se ci sono professionisti, chiedi SEMPRE; niente auto-assegnazione
        if (names.length >= 1) {
          col.proOptions = names; // SOLO nomi
          state.step = "pick_professional";
          bumpBookingLock(state);
          setAndPersist();
          const list = names.map((n, i) => `${i + 1}) ${n}`).join("\n");
          return reply(
            client,
            chatId,
            `Preferisci un professionista in particolare?\n0) Non mi interessa\n${list}\n(0-${names.length})`
          );
        }

        // Nessun pro noto -> chiedi testo libero
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return reply(
          client,
          chatId,
          "Preferisci un professionista in particolare? (scrivi il nome)"
        );
      }
      return null;
    }

    function gateAllergiesIfNeeded() {
      const allergyPrompt = askAllergies(col.service);
      if (
        col.service &&
        allergyPrompt &&
        (!col.allergies || typeof col.allergies.has !== "boolean")
      ) {
        state.step = "ask_allergies";
        bumpBookingLock(state);
        setAndPersist();
        return reply(client, chatId, allergyPrompt);
      }
      return null;
    }

    async function advanceAppointment(useIntakeFromText) {
      if (useIntakeFromText) {
        const intake = parseIntake(text);
        if (pureNumber.test(text)) delete intake.time; // evita 2 -> 02:00
        Object.assign(col, intake);

        // Scelta servizio numerica
        if (!col.service && pureNumber.test(text)) {
          const svcs = cfgServices();
          const idx = parseInt(text, 10);
          if (!isNaN(idx) && svcs[idx - 1]) {
            col.service = svcs[idx - 1];
            col.time = null;
          }
        }

        if (col.service) {
          rememberService(chatId, col.service);
          const allergens = getAllergens(col.service);
          if (allergens.length && !col._allergenAlertShown) {
            await reply(
              client,
              chatId,
              `⚠️ Attenzione allergeni per "${col.service}": ${allergens.join(
                ", "
              )}`
            );
            col._allergenAlertShown = true; // evita ripetizioni
            pending.set(chatId, state);
            setAndPersist();
          }
        }
      }

      // 1) Servizio
      if (!col.service) {
        // 🔹 salva che stiamo aspettando una scelta numerica 1..N
        col.svcOptions = cfgServices();
        state.step = "choose_service";
        pending.set(chatId, state);

        bumpBookingLock(state);
        setAndPersist();
        return reply(client, chatId, askService(state, chatId));
      }

      // 2) Allergie
      {
        const r = gateAllergiesIfNeeded();
        if (r) return r;
      }

      // 3) Professionista (se necessario)
      {
        const r = askProfessionalIfNeeded();
        if (r) return r;
      }
// === GUARD: utente ha scritto un orario (es. "9:00") mentre eravamo ancora sulla domanda data ===
{
  const wroteTime = /\b(\d{1,2})([:.,\s])?(\d{2})\b/.test(text);
  if (state.ui?.lastAsk === "date" && wroteTime) {
    // recupera il giorno mostrato (o da availFlow) PRIMA di leggere l'orario
    if (!col.when) {
  const iso = state.availFlow?.day || state.context?.lastDayShown;
  if (iso) col.when = new Date(iso);
}


    // parse orario con i tuoi helper "intelligenti"
    let hhmm = null;
    if (typeof parseTimeSmart === "function") hhmm = parseTimeSmart(text);
    if (!hhmm && typeof parseHHMM === "function") hhmm = parseHHMM(text);

    if (col.when && hhmm) {
      col.time = hhmm;
      // siamo completi, possiamo avanzare senza tornare a chiedere la data
      state.step = "collect";
      if (state.context) state.context.lastDayShown = null;
      bumpBookingLock(state);
      if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
      return await advanceAppointment(false);
    }
    // Se non ho capito l'orario, lascia che prosegua la logica standard sotto.
  }
}

     // 4) Data — SMART
if (!col.when) {
  // Se ho già un "giorno mostrato" (es. appena ho mandato la lista), usalo come default
  if (state.context?.lastDayShown) {
    col.when = new Date(state.context.lastDayShown);
    if (state.context) state.context.lastDayShown = null;
    if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
  }

  // 4.a) Prova a capire la data dal testo corrente
  let parsedDay = null;
  if (!parsedDay && typeof parseRelativeDay === "function") parsedDay = parseRelativeDay(text);
  if (!parsedDay && typeof parseNaturalDate === "function") parsedDay = parseNaturalDate(text);
  if (!parsedDay && typeof parseDayMonthSmart === "function") parsedDay = parseDayMonthSmart(text);
  if (!parsedDay && typeof parseDayMonth === "function") parsedDay = parseDayMonth(text);

  if (parsedDay) {
    col.when = atNoon(parsedDay);
    if (col.pendingTime) { col.time = col.pendingTime; col.pendingTime = null; }
    // prosegui
  } else {
    // 🔒 Anti-loop: se ho già una data (es. presa da lastDayShown), NON rientro a chiedere la data
    if (col.when) {
      if (col.pendingTime) { col.time = col.pendingTime; col.pendingTime = null; }
      // prosegui senza entrare in choose_day
    } else {
      // 4.b) Non ho capito la data: entro nello step di scelta data
      state.step = "choose_day";
      state.ui ||= {}; state.ui.lastAsk = "date";
      pending.set(chatId, state); bumpBookingLock(state); setAndPersist();
      return reply(client, chatId, '📅 Per quale data vuoi prenotare? (es. "23/10", "domani", "lunedì prossimo", "tra 2 settimane")');
    }
  }
}


// 4.c) Se la data risultasse nel passato, spostala al prossimo giorno utile
if (col.when && isPast(setTime(col.when, col.time || "23:59"))) {
  col.when = nextOpenDay(new Date());
}

// 4.d) Se il giorno è chiuso, proponi il primo giorno utile e chiedi conferma (sì/no)
if (cfgClosedDay(col.when)) {
  const altDay = nextOpenDay(col.when);
  state.step = "confirm_alt_day";
  state.context ||= {};
state.context.lastDayShown = atNoon(altDay).toISOString();
state.availFlow ||= {};
state.availFlow.day = atNoon(altDay).toISOString();  // ISO anche qui ✅

  state.context.altDaySuggest = atNoon(altDay).toISOString();

  pending.set(chatId, state);
  bumpBookingLock(state);
  setAndPersist();

  return reply(
    client,
    chatId,
    `Il giorno ${fmtDate(col.when)} siamo chiusi. Ti va bene ${fmtDate(altDay)}? (sì/no)`
  );
}


      // 5) Orario
if (!col.time) {
  const day = atNoon(col.when);

  // harden: metti subito pick_time e persisti
  state.step = "pick_time";
  state.ui ||= {};
  state.ui.lastAsk = "time";
  pending.set(chatId, state);
  bumpBookingLock(state);
  setAndPersist();

  const resp = await gotoPickTime(day);
  if (resp) return resp;

  const altDay = nextOpenDay(day);
  const altResp = await gotoPickTime(altDay);
  if (altResp) { col.when = altDay; return altResp; }

  bumpBookingLock(state);
  setAndPersist();
  return reply(client, chatId, "😕 Non ho trovato disponibilità. Prova con un’altra data o un orario diverso.");
}


      // 6) Nome
      {
        const r = askNameIfMissing();
        if (r) return r;
      }

      // 7) Verifica slot e conferma
      const duration = cfgServiceDuration(col.service);
      const start = setTime(col.when, col.time);

      if (cfgClosedDay(start)) {
        const altDay = nextOpenDay(start);
        const altSlots = normalizeSlotsDetail(
          await fetchSlots({
            service: col.service,
            day: altDay,
            duration,
            professional: col.professionalAny
              ? null
              : col.professionalEmail || col.professionalName || null,
            wantDetail: true,
          })
        );
        if (altSlots.length) {
          col.when = altDay;
          col.options = altSlots;
          state.step = "pick_time";
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            `Il giorno dopo (${fmtDate(
              altDay
            )}) ho questi orari disponibili:\n${renderSlotsList(
              altSlots
            )}\n(1-${altSlots.length})`
          );
        }
        bumpBookingLock(state);
        setAndPersist();
        return reply(
          client,
          chatId,
          "🤔 Non ho trovato slot vicini. Vuoi cambiare data o fascia oraria?"
        );
      }

      const daySlots = normalizeSlotsDetail(
        await fetchSlots({
          service: col.service,
          day: atNoon(start),
          duration,
          professional: col.professionalAny
            ? null
            : col.professionalEmail || col.professionalName || null,
          wantDetail: true,
        })
      );
      const dayTimes = daySlots.map((x) => x.time);

      if (dayTimes.includes(col.time)) {
        // Se NON hai un pro e l’API GCAL lo richiede, scegli automaticamente il primo libero per quell’orario
        if (
          !col.professionalAny &&
          !col.professionalEmail &&
          !col.professionalName
        ) {
          const slotItem = daySlots.find((x) => x.time === col.time);
          if (slotItem && slotItem.pros && slotItem.pros.length) {
            col.professionalEmail = slotItem.pros[0].email;
            col.professionalName = slotItem.pros[0].name;
          }
        }
        try {
          // === Risolvi pro per lo slot scelto (robusto) ===
          const slot = daySlots.find((s) => s.time === col.time);

          const pe = col.professionalAny
            ? slot && slot.pros && slot.pros[0]
              ? slot.pros[0].email
              : null
            : col.professionalEmail ||
              (col.professionalName
                ? proEmailByName(col.professionalName)
                : null);

          const pn = col.professionalAny
            ? slot && slot.pros && slot.pros[0]
              ? slot.pros[0].name
              : null
            : col.professionalName ||
              proNameByEmail(col.professionalEmail) ||
              null;

          // Se manca l'email del pro, non chiamare GCal: chiedi di scegliere altro orario
          if (!pe) {
            state.step = "pick_time";
            col.options = daySlots; // ripropone gli slot del giorno
            bumpBookingLock(state);
            setAndPersist();
            return reply(
              client,
              chatId,
              "⚠️ Nessun professionista libero per quell’orario. Scegli un altro orario o invia 0 per vedere tutti gli slot."
            );
          }

          // === Titolo + note con marcatura allergie ===
          const allergFlag =
            col.allergies && col.allergies.has ? "⚠️ ALLERGENI " : "";
          const baseTitle = `${allergFlag}${col.service}`;

          const listed =
            col.allergies && Array.isArray(col.allergies.list)
              ? col.allergies.list.filter(Boolean)
              : [];

          const monitored = getAllergens(col.service);
          const monitoredStr = monitored.length ? monitored.join(", ") : "—";

          const notes =
            col.allergies && col.allergies.has
              ? `Cliente: ${col.customerName}. Allergie dichiarate${
                  listed.length ? `: ${listed.join(", ")}` : ""
                }. Allergeni (config): ${monitoredStr}. Contattare prima del trattamento.`
              : `Cliente: ${col.customerName}. Allergeni (config): ${monitoredStr}.`;

          // === Anti-doppio invio ===
          const fingerprint = `${col.service}|${pe}|${new Date(
            start
          ).toISOString()}`;
          if (state.txId && state.eventFingerprint === fingerprint) return "";
          state.txId = Date.now();
          state.eventFingerprint = fingerprint;

          // === Soft-hold (5') per evitare race tra più utenti su stesso slot/pro
          const holdOk = acquireSoftHold({
            chatId,
            professionalEmail: pe,
            startTime: start,
            durationMin: duration,
          });
          if (!holdOk) {
            // lo slot è stato appena preso: proponi alternative
            const freshSlots = normalizeSlotsDetail(
              await fetchSlots({
                service: col.service,
                day: atNoon(start),
                duration,
                professional: col.professionalAny
                  ? null
                  : col.professionalEmail || col.professionalName || null,
                wantDetail: true,
              })
            );
            if (!freshSlots.length) {
              return reply(
                client,
                chatId,
                "Quel posto è appena stato occupato 😕. Non ho più disponibilità per quel giorno."
              );
            }
            col.options = freshSlots;
            state.step = "pick_time";
            setAndPersist();
            return reply(
              client,
              chatId,
              `Quel posto è appena stato occupato 😕. Disponibili invece:\n${renderSlotsList(
                freshSlots
              )}\n(1-${freshSlots.length})`
            );
          }
          // --- Guard locale: dati minimi prima di creare l'evento ---
          if (!col.service) {
            return reply(
              client,
              chatId,
              "Mi dici il trattamento? Non riesco a creare la prenotazione senza il servizio."
            );
          }
          // Non uso 'duration' del blocco sottostante per evitare conflitti di nome
          const _dur = cfgServiceDuration(col.service);
          if (!_dur) {
            return reply(
              client,
              chatId,
              "Durata non trovata per il servizio scelto: non riesco a creare l’appuntamento."
            );
          }
          if (!col.when) {
            state.step = "choose_day";
            bumpBookingLock(state);
            setAndPersist();
            return reply(
              client,
              chatId,
              'Che giorno preferisci? (es. "23/10", "mercoledì", "lunedì prossimo", "tra 2 settimane")'
            );
          }
          // Se manca l’orario, rimettiamo l’utente in pick_time: i tuoi parser smart lo capiranno
          if (!col.time) {
            state.step = "pick_time";
            bumpBookingLock(state);
            setAndPersist();
            return reply(
              client,
              chatId,
              'Dimmi l’ora (es. "9:30", "9 e 30", "9.30", "9,30"), oppure scegli un numero dalla lista.'
            );
          }
          // Se il servizio ha allergeni monitorati e non abbiamo ancora la risposta, chiedili ora
          if (
            askAllergies(col.service) &&
            (!col.allergies || typeof col.allergies.has !== "boolean")
          ) {
            state.step = "ask_allergies";
            bumpBookingLock(state);
            setAndPersist();
            return reply(client, chatId, askAllergies(col.service));
          }
          // Se manca il professionista per quello slot, torna alla scelta orario (ri-proponi gli slot del giorno)
          if (!pe) {
            state.step = "pick_time";
            col.options = daySlots;
            bumpBookingLock(state);
            setAndPersist();
            return reply(
              client,
              chatId,
              "⚠️ Nessun professionista libero per quell’orario. Scegli un altro orario o invia 0 per vedere tutti gli slot."
            );
          }

          // === Crea evento (passando anche i campi “umani”) ===

          // === Crea evento (passando anche i campi “umani”) ===
          let eventData;
          try {
            eventData = await makeEvent({
              serviceName: baseTitle,
              professionalEmail: pe,
              professionalName: pn,
              customerName: col.customerName,
              clientPhone: chatId,
              startTime: start,
              durationMin: duration,
              notes,
              allergic: !!(col.allergies && col.allergies.has),
              allergies: listed.length
                ? listed
                : col.allergies && col.allergies.has
                ? "sì (non specificate)"
                : null,
            });
          } finally {
            // rilascia sempre l'hold (successo o errore)
            releaseSoftHoldByChat(chatId);
          }

          // === Persist booking con i dati risolti ===
          persistBooking({
            eventId: eventData.id || null,
            service: col.service,
            professionalEmail: pe,
            professionalName: pn,
            clientPhone: chatId,
            customerName: col.customerName,
            startTime: new Date(start).toISOString(),
            durationMin: duration,
            allergies: col.allergies || null,
            status: "confirmed",
            createdAt: new Date().toISOString(),
          });

          // === Chiudi flow ===
          if (state.context) state.context.lastDayShown = null;
          unlockBooking(state);
          pending.delete(chatId);

          const promos = (
            Array.isArray(config.promotions) ? config.promotions : []
          )
            .filter((p) => norm(p.service || "") === norm(col.service))
            .map((p) => p.text)
            .filter(Boolean);

          const allergyNote = (() => {
            if (!askAllergies(col.service)) return "";
            const allMonitored = getAllergens(col.service);
            const monitoredText = allMonitored.length
              ? `\nAllergeni (attenzione): ${allMonitored.join(", ")}`
              : "";
            if (col.allergies?.has) {
              const listed2 =
                col.allergies.list && col.allergies.list.length
                  ? ` (${col.allergies.list.join(", ")})`
                  : "";
              return `\n⚠️ Allergie dichiarate${listed2}.${monitoredText}\nTi consigliamo di contattare il salone prima del trattamento.`;
            }
            return `\nAllergie: nessuna dichiarata.${monitoredText}`;
          })();

          const proLabel = pn || "operatore";

          return reply(
            client,
            chatId,
            `✅ Prenotazione confermata: ${
              col.service
            } con ${proLabel} il ${fmtDate(start)} alle ${col.time} a nome ${
              col.customerName
            }. Prezzo: ${cfgServicePriceText(col.service)}${
              promos.length ? `\nPromo attive: ${promos.join(" • ")}` : ""
            }${allergyNote}\nGrazie e a presto! 🎉
    \n
    Nota bene: per annullare o modificare l'appuntamento basta scrivere "modifica" o "annulla"!`
          );
        } catch (e) {
          log("error", "createCalendarEvent", e?.message || e);
          state.txId = null;
          state.eventFingerprint = null;
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            "❌ Errore durante la conferma. Riproviamo tra poco, per favore."
          );
        }
      } else {
        const nearTimes = nearestTimes(dayTimes, col.time, 3);
        if (nearTimes.length) {
          const nearDetail = daySlots.filter((x) => nearTimes.includes(x.time));
          col.options = nearDetail;
          state.step = "pick_time";
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            `A quell'ora non c'è posto. Ti posso proporre questi orari vicini:\n${renderSlotsList(
              nearDetail
            )}\n(1-${nearDetail.length})`
          );
        }
        const altDay = nextOpenDay(new Date(col.when.getTime() + 86400000));
        const altSlots = normalizeSlotsDetail(
          await fetchSlots({
            service: col.service,
            day: altDay,
            duration,
            professional: col.professionalAny
              ? null
              : col.professionalEmail || col.professionalName || null,
            wantDetail: true,
          })
        );
        if (altSlots.length) {
          col.when = altDay;
          col.options = altSlots;
          state.step = "pick_time";
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            `Il giorno dopo (${fmtDate(
              altDay
            )}) ho questi orari disponibili:\n${renderSlotsList(
              altSlots
            )}\n(1-${altSlots.length})`
          );
        }
        bumpBookingLock(state);
        setAndPersist();
        return reply(
          client,
          chatId,
          "🤔 Non ho trovato slot vicini. Cambiamo data o orario?"
        );
      }
    }
    // === FASTLANE: frase unica con servizio+data+ora ===
    {
      const intake = parseIntake(text);
      const hasBookingWords =
        /\b(prenot|appunt|riserv|posto|liber[oi])\w*/i.test(t);
      if (hasBookingWords && (intake.service || intake.when || intake.time)) {
        Object.assign(col, intake);
        state.step = "collect";
        bumpBookingLock(state);
        pending.set(chatId, state);
        const r = await advanceAppointment(false);
        if (r) return r;
      }
    }

    // ===================== FASTLANE: professionista dal testo =====================
    if (
      col.service &&
      !col.professionalAny &&
      !col.professionalName &&
      !col.professionalEmail
    ) {
      const proHit = findProfessionalCandidatesByText(text, col.service);
      if (proHit?.resolved) {
        col.professionalAny = false;
        col.professionalName = proHit.resolved;
        col.professionalEmail = proEmailByName(proHit.resolved);
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(true);
      }
      if (proHit?.ambiguous?.length) {
        col.proOptions = proHit.ambiguous; // SOLO nomi
        state.step = "pick_professional";
        bumpBookingLock(state);
        setAndPersist();
        const list = proHit.ambiguous
          .map((n, i) => `${i + 1}) ${n}`)
          .join("\n");
        return reply(
          client,
          chatId,
          `Preferisci un professionista in particolare?\n0) Non mi interessa\n${list}\n(0-${proHit.ambiguous.length})`
        );
      }
    }

    // ===================== Step aperti =====================
    if (state.step === "ask_name") {
      const name = extractCustomerName(text);
      if (name) {
        col.customerName = name;
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(false);
      }
      return reply(
        client,
        chatId,
        "Scrivi nome e cognome completi (es. “Giulia Bianchi”)."
      );
    }

    if (state.step === "price_select_service") {
      if (pureNumber.test(text)) {
        const list = col.infoOptions || [];
        const idx = parseInt(text, 10) - 1;
        const svc = list[idx];
        if (!svc)
          return reply(
            client,
            chatId,
            `Scegli un numero valido (1-${list.length}).`
          );
        state.step = "collect";
        col.infoOptions = null;
        rememberService(chatId, svc);
        setAndPersist();
        return reply(
          client,
          chatId,
          `• ${svc}: ${cfgServicePriceText(svc)} (durata ${cfgServiceDuration(
            svc
          )} min)`
        );
      }
      const svcByText = fuzzyServiceSafe(text);

      if (svcByText) {
        state.step = "collect";
        col.infoOptions = null;
        rememberService(chatId, svcByText);
        setAndPersist();
        return reply(
          client,
          chatId,
          `• ${svcByText}: ${cfgServicePriceText(
            svcByText
          )} (durata ${cfgServiceDuration(svcByText)} min)`
        );
      }
    }

    if (state.step === "info_select_service") {
      if (pureNumber.test(text)) {
        const list = col.infoOptions || [];
        const idx = parseInt(text, 10) - 1;
        const svc = list[idx];
        if (!svc)
          return reply(
            client,
            chatId,
            `Scegli un numero valido (1-${list.length}).`
          );
        state.step = "collect";
        col.infoOptions = null;
        rememberService(chatId, svc);
        setAndPersist();
        const topic = getLastInfoTopic(chatId);
        let a = (
          await askQA(
            buildQAPromptWithMemory(chatId, composeInfoPrompt(svc, topic)),
            tools,
            client
          )
        ).trim();
        if (!a)
          a = `• ${svc}: ${cfgServicePriceText(
            svc
          )} (durata ${cfgServiceDuration(svc)} min)`;
        return reply(client, chatId, a);
      }
      const svcByText = fuzzyServiceSafe(text);

      if (svcByText) {
        state.step = "collect";
        col.infoOptions = null;
        rememberService(chatId, svcByText);
        setAndPersist();
        const topic = getLastInfoTopic(chatId);
        let a = (
          await askQA(
            buildQAPromptWithMemory(
              chatId,
              composeInfoPrompt(svcByText, topic)
            ),
            tools,
            client
          )
        ).trim();
        if (!a)
          a = `• ${svcByText}: ${cfgServicePriceText(
            svcByText
          )} (durata ${cfgServiceDuration(svcByText)} min)`;
        return reply(client, chatId, a);
      }
    }
    if (state.step === "choose_service") {
      const list =
        state.collected?.svcOptions ||
        state.ui?.lastServiceList ||
        cfgServices();

      const n = parseListIndex(text, list.length);
      if (Number.isFinite(n)) {
        const svc = list[n - 1];
        state.step = "collect";
        state.collected.service = svc;
        rememberService(chatId, svc);
        bumpBookingLock(state);
        pending.set(chatId, state);
        setAndPersist();
        return advanceAppointment(false);
      }

      // oppure hanno scritto il nome del servizio
      const svcByText = fuzzyServiceSafe(text);
      if (svcByText) {
        state.step = "collect";
        state.collected.service = svcByText;
        rememberService(chatId, svcByText);
        bumpBookingLock(state);
        pending.set(chatId, state);
        setAndPersist();
        return advanceAppointment(false);
      }

      return reply(
        client,
        chatId,
        `Scegli un numero valido (1-${list.length}).`
      );
    }

    // ==== Orari (prenotazione standard) ====
if (state.step === "pick_time") {
  const col = state.collected || (state.collected = {});
  const opts = Array.isArray(col.options) ? col.options : [];

  // Porta dentro la data dal contesto (availability/pick_time) PRIMA di leggere l'orario
  if (!col.when && state.availFlow?.day) {
    col.when = new Date(state.availFlow.day);
  }
  if (!col.when && state.context?.lastDayShown) {
    col.when = new Date(state.context.lastDayShown);
    if (state.context) state.context.lastDayShown = null;
    if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
  }

  // Se abbiamo già day+time, non restare qui
  if (col.when && col.time) {
    state.step = "collect";
    bumpBookingLock(state);
    if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
    return await advanceAppointment(false);
  }

  // ... (poi continua con il parsing dell’HH:MM, come già fai)


  // --- 1) PROVA PRIMA ORARIO LIBERO (testo) CON I TUOI PARSER ---
  // NOTE: uso *text* (quello normalizzato in handleMessage), NON "msg"
  const normText = String(text)
    .toLowerCase()
    .replace(/[.,]/g, ":")                 // 9,30 / 9.30 -> 9:30
    .replace(/\b(\d{1,2})\s+e\s+(\d{1,2})\b/g, "$1:$2") // 9 e 30 -> 9:30
    .trim();

  const parsedHHMM =
      (typeof parseTimeSmart === "function" && parseTimeSmart(normText)) ||
      (typeof parseHHMM === "function" && parseHHMM(normText)) ||
      (typeof parseNaturalTime === "function" && parseNaturalTime(normText)) ||
      null;

  // helper per confronto minuti
  const toMin = (s) => {
    const [H, M] = String(s).trim().split(":").map(Number);
    return (Number.isFinite(H) ? H : 0) * 60 + (Number.isFinite(M) ? M : 0);
  };

  if (parsedHHMM) {
    // match ESATTO sugli slot del giorno mostrato; se non c'è, prendi il più vicino
    let idx = opts.findIndex(o => o && typeof o.time === "string" && o.time.startsWith(parsedHHMM));
    if (idx < 0 && opts.length) {
      const want = toMin(parsedHHMM);
      let bestIdx = -1, best = Infinity;
      for (let i = 0; i < opts.length; i++) {
        const cur = toMin(opts[i].time || "00:00");
        const d = Math.abs(cur - want);
        if (d < best) { best = d; bestIdx = i; }
      }
      if (bestIdx >= 0) idx = bestIdx;
    }

    if (idx >= 0) {
      const choice = opts[idx];
      col.time = choice.time;

      // se nello slot c'è un solo pro e non è stato scelto, auto-assegna
      if (!col.professionalEmail && !col.professionalName && choice.pros && choice.pros.length === 1) {
        col.professionalAny  = false;
        col.professionalName = choice.pros[0].name || null;
        col.professionalEmail= choice.pros[0].email || null;
      }

      state.step = "collect";
      bumpBookingLock(state);
      if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
      return await advanceAppointment(false);
    }

    await reply(client, chatId, `❌ ${parsedHHMM} non è disponibile quel giorno. Scrivi un altro orario (es. "9:30") oppure scegli un numero dalla lista.`);
    return "";
  }

  // --- 2) ALTERNATIVA: INDICE DELL'ELENCO (0 = mostra TUTTI) ---
  const n = (typeof parseListIndex === "function") ? parseListIndex(text, opts.length) : parseInt(text, 10);

  if (Number.isFinite(n)) {
    if (n === 0) {
      const duration = cfgServiceDuration(col.service);
      const allSlots = await fetchSlots({
        service: col.service,
        day: atNoon(col.when),
        duration,
        professional: null,
        wantDetail: true,
      });
      if (!allSlots.length) {
        await reply(client, chatId, "Nessuno slot disponibile in quel giorno.");
        return "";
      }
      col.options = allSlots;
      col.allSlotsMode = true;
      if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);

      const linesAll = allSlots.map(
        (it, i) => `${i + 1}) ${it.time} (${(it.pros || []).map(p => p.name).join(", ")})`
      ).join("\n");

      await reply(client, chatId, `Tutti gli slot disponibili (${fmtDate(col.when)}):\n${linesAll}\n(1-${allSlots.length})`);
      return "";
    }

    const choice = opts[n - 1];
    if (!choice) {
      await reply(client, chatId, `Numero non valido. Scrivi un orario (es. "9:30") o un numero 1-${opts.length}.`);
      return "";
    }

    col.time = choice.time || choice;

    // se nello slot ci sono più pro e non hai scelto il pro, passa a pick_professional
    if (!col.professionalEmail && !col.professionalName && choice.pros && choice.pros.length > 1) {
      col.proOptions = choice.pros.map(p => p.name);
      state.step = "pick_professional";
      pending.set(chatId, state);
      const list = choice.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
      return reply(client, chatId, `Chi preferisci alle ${col.time}?\n${list}\n(1-${choice.pros.length})`);
    }

    // se un solo pro, auto-assegna
    if (!col.professionalEmail && !col.professionalName && choice.pros && choice.pros.length === 1) {
      col.professionalAny   = false;
      col.professionalName  = choice.pros[0].name;
      col.professionalEmail = choice.pros[0].email || null;
    }

    state.step = "collect";
    bumpBookingLock(state);
    if (typeof setAndPersist === "function") setAndPersist(); else pending.set(chatId, state);
    return await advanceAppointment(false);
  }

  // --- 3) Fallback help ---
  await reply(
    client,
    chatId,
    `Dimmi l’ora (es. "9:30", "9 e 30", "9.30", "9,30") oppure scegli un numero 1-${opts.length}. Scrivi 0 per vedere tutti gli slot.`
  );
  return "";
}


    // ====== STEP: scelta professionista ======
    if (state.step === "pick_professional") {
      // assicurati che col esista
      const col = state.collected || (state.collected = {});
      if (!col.service) {
        state.step = "choose_service";
        await reply(
          client,
          chatId,
          "Devo prima sapere il trattamento. Scegli un numero dall’elenco dei servizi."
        );
        return "";
      }

      const list = proCatalog(col.service);
      if (!list.length) {
        await reply(
          client,
          chatId,
          '⚠️ Per questo servizio non sono configurati professionisti. Scrivi "annulla".'
        );
        return "";
      }
      // se l’utente ha scritto qualcosa, prova a risolvere
      const chosen = resolveProReply(text, list);
      if (!chosen) {
        await reply(
          client,
          chatId,
          "❌ Quel professionista non risulta nel nostro centro.\n" +
            renderProPrompt(list)
        );
        return ""; // resta nello stesso step
      }

      if (chosen.any) {
        col.professionalAny = true;
        col.professionalName = null;
        col.professionalEmail = null;
      } else {
        col.professionalAny = false;
        col.professionalName = chosen.name;
        col.professionalEmail = chosen.email;
      }

      // prima di avanzare, doppio check di coerenza
      if (!ensureProfessionalValidForService(col)) {
        await reply(
          client,
          chatId,
          "❌ Il professionista indicato non è abilitato per questo servizio.\n" +
            renderProPrompt(list)
        );
        return "";
      }

      state.step = "choose_day"; // tuo step successivo
      await reply(
        client,
        chatId,
        'Perfetto! Dimmi il giorno che preferisci (es. "mercoledì" o "23/10").'
      );
      return "";
    }

    // Parsing testo libero
    const proHit = findProfessionalCandidatesByText(text, col.service);
    if (proHit?.resolved) {
      col.professionalAny = false;
      col.professionalName = proHit.resolved;
      col.professionalEmail = proEmailByName(col.professionalName);
      state.step = "collect";
      bumpBookingLock(state);
      setAndPersist();
      return advanceAppointment(false);
    }
    if (proHit?.ambiguous?.length) {
      col.proOptions = proHit.ambiguous; // SOLO nomi
      state.step = "pick_professional";

      bumpBookingLock(state);
      setAndPersist();
      return reply(client, chatId, askProfessional(col.service));
    }
    // ====== STEP: scelta giorno ======
    if (state.step === "choose_day") {
      // 🔹 NEW: se l’utente scrive un orario qui, lo segniamo e poi chiediamo il giorno
      const chosenTime =
        (typeof parseTimeSmart === "function" && parseTimeSmart(text)) ||
        (typeof parseHHMM === "function" && parseHHMM(text)) ||
        null;

      if (chosenTime) {
        if (col.when) {
          // Giorno già scelto → usa subito l’orario e avanza
          col.time = chosenTime;
          col.pendingTime = null;
          state.step = "collect";
          bumpBookingLock(state);
          setAndPersist();
          return await advanceAppointment(false);
        }
        // Giorno non ancora scelto → comportamento precedente
        col.pendingTime = chosenTime;
        setAndPersist();
        await reply(
          client,
          chatId,
          `Perfetto, segno *${chosenTime}*. Ora dimmi il giorno (es. "domani" o "23/10").`
        );
        return "";
      }

      // 1) pattern estesi: "lunedì prossimo", "tra 2 settimane lunedì", ecc.
      const out = resolveDayishText(text, new Date());

      if (out && out.askDow) {
        await reply(
          client,
          chatId,
          "Perfetto! Dimmi il giorno della settimana: lunedì, martedì, mercoledì, giovedì, venerdì o sabato."
        );
        return "";
      }
      if (out && out.date) {
        col.when = atNoon(out.date);
        if (state.context) state.context.lastDayShown = null;

        // 🔹 NEW: se avevamo un orario “parcheggiato”, applicalo ora
        if (col.pendingTime) {
          col.time = col.pendingTime;
          col.pendingTime = null;
        }
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(false);
      }

      // 2) fallback: tuoi parser esistenti
      let day =
        typeof parseRelativeDay === "function" ? parseRelativeDay(text) : null;

      if (!day && typeof parseAvailabilityRequest === "function") {
        try {
          const req = parseAvailabilityRequest(text);
          if (
            req &&
            (req.kind === "day" || req.kind === "calendar-day") &&
            req.date
          ) {
            day = req.date;
          }
        } catch {}
      }

      if (day && !isNaN(new Date(day).getTime())) {
        col.when = atNoon(day);
        // 🔹 NEW: porta avanti l’eventuale orario scelto prima
        if (col.pendingTime) {
          col.time = col.pendingTime;
          col.pendingTime = null;
        }
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(false);
      }

      await reply(
        client,
        chatId,
        'Formato non riconosciuto. Esempi: "lunedì prossimo", "tra 2 settimane lunedì", "settimana prossima martedì", oppure GG/MM (es. "23/10").'
      );
      return "";
    }

    if (state.step === "pick_professional_for_slot") {
      const names = Array.isArray(col.proOptions) ? col.proOptions : [];
      const nums = /^\s*\d+\s*$/;

      if (nums.test(text)) {
        const n = parseInt(text.trim(), 10);
        if (n >= 1 && n <= names.length) {
          col.professionalAny = false;
          col.professionalName = names[n - 1];
          col.professionalEmail = proEmailByName(col.professionalName);
          col.time = col.pendingTime || col.time || null;
          col.pendingTime = null;

          state.step = "collect";
          bumpBookingLock(state);
          setAndPersist();
          return await advanceAppointment(false);
        }
        return reply(
          client,
          chatId,
          `Scegli un numero valido (1-${names.length}).`
        );
      }

      const proHit =
        typeof findProfessionalCandidatesByText === "function"
          ? findProfessionalCandidatesByText(text, col.service)
          : null;

      if (proHit?.resolved && names.includes(proHit.resolved)) {
        col.professionalAny = false;
        col.professionalName = proHit.resolved;
        col.professionalEmail = proEmailByName(col.professionalName);
        col.time = col.pendingTime || col.time || null;
        col.pendingTime = null;

        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return await advanceAppointment(false);
      }

      const list = names.map((p, i) => `${i + 1}) ${p}`).join("\n");
      return reply(
        client,
        chatId,
        `Per ${
          col.pendingTime || col.time || "quell'orario"
        } chi preferisci?\n${list}\n(1-${names.length})`
      );
    }

    if (state.step === "ask_allergies") {
      const info = parseAllergyInfo(text, col.service);
      if (info) {
        col.allergies = {
          has: !!info.has,
          list: Array.isArray(info.list) ? info.list : [],
        };
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        if (col.allergies.has) {
          await reply(
            client,
            chatId,
            "⚠️ Ho segnato le allergie. Procedo a fissare la prenotazione, ma chiama il negozio per avvisare e concordare meglio il tuo appuntamento."
          );
        }
        return advanceAppointment(false);
      }
      return reply(
        client,
        chatId,
        askAllergies(col.service) || "Sei allergico a qualcosa? (sì/no)"
      );
    }
    // === TRIGGER BOOKING LEGGERO (anche in collect, senza intake completo) ===
    // === TRIGGER BOOKING LEGGERO — NON durante step critici e non per orari "puri" ===
{
  const stepNow = String(state.step || "");
  const notEditing = !/^edit_/.test(stepNow);
  const pureTime = /^\s*\d{1,2}([:.,]\d{2})?\s*$/.test(text); // es. 19, 19.30, 19:30
if (notEditing && !isInCriticalStep(state.step) && !/^\s*\d{1,2}([:.,]\d{2})?\s*$/.test(text) && looksLikeBooking(text)) {

    state.step = "collect";
    bumpBookingLock(state);
    pending.set(chatId, state);
    return await advanceAppointment(true);
  }
}


    // ===================== ROUTER IBRIDO (regex + fuzzy) =====================
    if (!isInCriticalStep(state.step)) {
      const quick = intentByHybrid(text);
      function hasFutureBookingsForPhone(phone) {
        try {
          const all = readJSON("bookings.json", []);
          const now = Date.now();
          return all.some((b) => {
            const p = (
              b.phone ||
              b.clientPhone ||
              b.client_phone ||
              ""
            ).replace(/\D+/g, "");
            const when = new Date(
              b.start || b.startTime || b.start_date || b.when || 0
            ).getTime();
            return p.endsWith(phone.replace(/\D+/g, "")) && when && when >= now;
          });
        } catch {
          return false;
        }
      }

      // --- CANCEL ---
      if (quick.label === "cancel") {
        const booking = getUpcomingBookingByPhone(phoneFromChatId(chatId));
        if (!booking) {
          await reply(client, chatId, MESSAGES.it.NO_FUTURE_BOOKINGS);
          return "";
        }
        const startTs = new Date(booking.startTime).getTime();
        if (startTs - Date.now() < CANCEL_POLICY_HOURS * 3600 * 1000) {
          await reply(
            client,
            chatId,
            `Mancano meno di ${CANCEL_POLICY_HOURS} ore: non posso annullare automaticamente. Contatta il salone.`
          );
          return "";
        }
        await cancelEventSafe(booking.eventId);
        updateBookingByEventId(booking.eventId, {
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        });
        await reply(
          client,
          chatId,
          `✅ Prenotazione del ${fmtDate(booking.startTime)} annullata.`
        );
        return "";
      }

      // --- EDIT ---
      if (quick.label === "edit") {
        const booking = getUpcomingBookingByPhone(phoneFromChatId(chatId));
        if (!booking) {
          await reply(client, chatId, MESSAGES.it.NO_FUTURE_BOOKINGS);
          return "";
        }
        state.step = "edit_menu";
        state.edit = { target: booking };
        pending.set(chatId, state);
        await reply(client, chatId, showEditMenu(booking));
        return "";
      }

      // --- BOOKING (prenota/disponibilità) ---
      if (quick.label === "booking" || looksLikeBooking(text)) {
        bumpBookingLock(state);
        pending.set(chatId, state);
        return advanceAppointment(true); // riusa il tuo intake + flow
      }

      // --- PRICE ---
      if (quick.label === "price") {
        const svc =
          fuzzyServiceSafe(text) || col.service || getLastService(chatId);
        if (svc) {
          await reply(
            client,
            chatId,
            `• ${svc}: ${cfgServicePriceText(svc)} (durata ${cfgServiceDuration(
              svc
            )} min)`
          );
          return "";
        }
        const svcs = cfgServices();
        col.infoOptions = svcs;
        state.step = "price_select_service";
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          `Di quale trattamento vuoi conoscere il prezzo?\n${svcs
            .map((s, i) => `${i + 1}) ${s}`)
            .join("\n")}\n(1-${svcs.length})`
        );
        return "";
      }

      // --- INFO (manda a askQA con contesto se possibile) ---
      if (quick.label === "info") {
        const svcCtx =
          fuzzyServiceSafe(text) || col.service || getLastService(chatId);
        const topic = extractInfoTopic(text) || getLastInfoTopic(chatId);
        if (svcCtx) rememberService(chatId, svcCtx);
        if (topic) rememberInfoTopic(chatId, topic);
        const prompt = buildQAPromptWithMemory(
          chatId,
          composeInfoPrompt(svcCtx, topic)
        );
        let answer = (await askQA(prompt, tools, client)).trim();
        if (!answer && svcCtx)
          answer = `• ${svcCtx}: ${cfgServicePriceText(
            svcCtx
          )} (durata ${cfgServiceDuration(svcCtx)} min)`;
        await reply(client, chatId, answer || "Dimmi pure cosa vuoi sapere 😉");
        return "";
      }

      // --- GREETING / OTHER → fallback askQA ---
      if (quick.label === "greeting" || quick.label === "other") {
        const answer =
          (
            await askQA(buildQAPromptWithMemory(chatId, text), tools, client)
          ).trim() ||
          "Posso aiutarti a prenotare un trattamento o rispondere a domande sui nostri servizi. 😊";
        await reply(client, chatId, answer);
        return "";
      }
    }
    // (se siamo in step critico, mantiene il tuo flusso esistente)

    // ===================== Fallback generativo =====================
    const answer =
      (
        await askQA(buildQAPromptWithMemory(chatId, text), tools, client)
      ).trim() ||
      "Posso aiutarti a prenotare un trattamento o rispondere a domande sui nostri servizi. 😊 Fammi sapere come posso aiutarti.";
    return reply(client, chatId, answer);
  } catch (err) {
    log("error", "onMessage error", err?.stack || err?.message || String(err));
    try {
      await reply(
        client,
        chatId,
        "😓 C’è stato un errore temporaneo. Puoi ripetermi l’ultimo messaggio?"
      );
    } catch {}
  } finally {
    __busyChats.delete(chatId);
    __busySince.delete(chatId);
  }
}