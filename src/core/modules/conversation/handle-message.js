import { createModule as createrouteQuickReplies } from "./quick-replies.js";
import { createModule as createrouteInformation } from "./information-route.js";
import { beginCalendarSaga, completeCalendarSaga } from "../../../services/calendar-saga.js";
import { createModule as createLifecycleModule } from "./message-lifecycle.js";
/**
 * conversation/handle-message: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const {
    nearestTimes,
    AVAIL_PAGE_SIZE,
    BUSY_TTL_MS,
    COURTESY_PATTERNS,
    COURTESY_RESPONSES,
    SALON_PHONE,
    __buildDayMonthConfirmFromText,
    __busyChats,
    __busySince,
    __dateParsingLocks,
    __delay,
    __loadIdMaps,
    __pgPool,
    __pgQuery,
    _editApplyUpdate,
    _editDuration,
    _editParseNewDate,
    _editSnapshotStateFromBooking,
    _fmtBookingLine,
    _svcNormText,
    _svcTokensFromText,
    acquireSoftHold,
    appendUserMessage,
    atNoon,
    bestServiceBySynonyms,
    buildAvailabilityCompactMessage,
    buildReviewIntakePrompt,
    buildServicesMessageForPro,
    cancelEventSafe,
    cfgClosedDay,
    cfgServiceDuration,
    cfgServiceItem,
    cfgServicePriceText,
    cfgServiceProfessionals,
    cfgServiceSynonyms,
    cfgServices,
    chatdbDeleteEntry,
    classifyIntent,
    compareHHMM,
    config,
    dlDist,
    ensureContext,
    ensureUI,
    ensureValidState,
    extractCustomerName,
    fetchSlots,
    filterOutPastTimesForToday,
    filterSlotsByDaypart,
    firstMissingField,
    fmtDate,
    fmtDateWithWeekdayIT,
    fmtWeekdayDateLongIT,
    fmtWeekdayDateShortIT,
    formatBusinessHours,
    formatDateWithWeekdayIT,
    formatDurationMin,
    fuzzyCmd,
    fuzzyService,
    fuzzyServiceSafe,
    getAllProsList,
    getDurForPro,
    getLang,
    getPrivacyText,
    getServiceDurationForPro,
    getState,
    getUserActiveBookingsAll,
    greetIfReturningUser,
    groupServicesByCategory,
    groupServicesByType,
    handleNumericReply,
    hasBookingVerb,
    hasDateOrTime,
    isBookingFlowActive,
    isBookingLocked,
    isInCriticalStep,
    isPast,
    isServiceAvailableForPro,
    isTypoClose,
    isUrgencyMessage,
    levenshtein,
    loadChatDB,
    log,
    looksLikeBooking,
    makeEvent,
    markPrivacySent,
    matchProFromFreeText,
    maybeHandleReviewReply,
    maybeSendPrivacyNotice,
    nextOpenDay,
    norm,
    normalizeSlotsDetail,
    now,
    parseHHMM,
    parseListIndex,
    parseNaturalDate,
    parseNaturalTime,
    parseTimeSmart,
    parseUnifiedDate,
    pending,
    persistBooking,
    phoneFromChatId,
    primaryIntent,
    privacyCommandKind,
    proCatalog,
    proEmailByName,
    proNameByEmail,
    proNameByEmailSafe,
    promptResumeStep,
    releaseSoftHoldByChat,
    renderSlotsList,
    reply,
    resolveEmailByName,
    resolveProReply,
    resolveServiceFromText,
    safeParseDateWithLock,
    safeSend,
    scheduleReenter,
    scoreService,
    serviceProsEmails,
    setTime,
    shouldDropIncoming,
    showEditMenu,
    simpleNorm,
    slotOverlapsExistingBookings,
    startEditChooseBooking,
    startEditDate,
    startEditName,
    startEditProfessional,
    startEditTime,
    tokens,
    typoMaxDist,
    uniqueTimesFromSlots,
    unlockBooking,
    validateDateInRange,
    validateProfessionalForService,
    wantsEditMenu,
  } = dependencies;
  const routeQuickReplies = createrouteQuickReplies(dependencies);
  const routeInformation = createrouteInformation(dependencies);
  const prepareMessageLifecycle = createLifecycleModule(dependencies);

async function handleMessage(client, chatId, textRaw, tools = {}) {
  const __isReenter = !!tools?.__reenter;

  // Inizializzazione stato
  let state = getState(chatId);

  const lifecycle = await prepareMessageLifecycle({client, chatId, textRaw, state, __isReenter});
  state = lifecycle.state;
  if (lifecycle.stopped) return "";

  // Only classify at the initial, noncritical step. Deterministic flow state
  // and explicit privacy/cancel commands always take precedence over a model.
  let initialIntentHint = null;
  if (!__isReenter && state.step === 'collect' && typeof textRaw === 'string' &&
      textRaw.trim() && !/^\s*(?:\/|annulla|stop|esci|fine|privacy|cancella dati|menu)\b/i.test(textRaw)) {
    try { initialIntentHint = await classifyIntent(textRaw); }
    catch { initialIntentHint = null; }
  }

  if (await routeInformation({client, chatId, textRaw, state, __isReenter, intentHint: initialIntentHint})) return "";

  const quick = await routeQuickReplies({client, chatId, textRaw, state, __isReenter, intentHint: initialIntentHint});
  state = quick.state;
  textRaw = quick.textRaw;
  if (quick.handled) return "";

  // ============================================================================
  // SEZIONE 3: LOCK GESTIONE CONCORRENZA
  // ============================================================================
  while (__busyChats.has(chatId)) {
    const since = __busySince.get(chatId) || 0;
    if (since && Date.now() - since > BUSY_TTL_MS) {
      log("warn", "[BUSY-STALL] Force release", {
        chatId,
        since,
        ttl: BUSY_TTL_MS
      });
      __busyChats.delete(chatId);
      __busySince.delete(chatId);
      break;
    }
    await __delay(50);
  }

  __busyChats.add(chatId);
  __busySince.set(chatId, Date.now());

  try {
    // Inizializzazione client inactivity
    if (shared.inactivityClient === null) {
      shared.inactivityClient = client;
    }

    const text = String(textRaw ?? "").trim();
    const msg = text;
    const lower = text.toLowerCase();
    const t = norm(text);

    // Dedupe in ingresso (anti doppio invio WhatsApp)
    if (!__isReenter && shouldDropIncoming(chatId, text)) {
      log("warn", "[INPUT-DEDUP] Drop duplicate incoming message", {
        chatId
      });
      return "";
    }

    // Recupera e inizializza stato
    state = getState(chatId);
    state.collected ||= {};
    state.context ||= {};
    ensureContext(state);

    // Watchdog coerenza: se lo stato è rotto, riparti soft
    const __valid = ensureValidState(state);
    if (!__valid.ok) {
      log("warn", "[STATE-WATCHDOG] Stato incoerente → reset soft", {
        chatId,
        step: __valid.step,
        missing: __valid.missing
      });

      try {
        pending.delete(chatId);
      } catch { }
      try {
        __dateParsingLocks.delete(chatId);
      } catch { }
      try {
        releaseSoftHoldByChat?.(chatId);
      } catch { }

      state = getState(chatId);
      ensureContext(state);
      state.step = "collect";
      pending.set(chatId, state);

      await reply(
        client,
        chatId,
        "Non riesco a riprendere da dove eravamo rimasti  Ripartiamo: vuoi *prenotare* o *modificare*?", {
        noFooter: true
      }
      );
      return "";
    }

    // AI decision cached at message ingress; fallback to legacy matching.
    const __intentHint = initialIntentHint;

    // Step: resume dopo una risposta "info" nel mezzo del flow
    if (state.step === "resume_confirm") {
      const yes = /\b(sì|si|ok|certo|vai|continua|riprendi|prosegui)\b/i.test(text);
      const no = /\b(no|non\s+ora|ferma|stop|basta|annulla|esci)\b/i.test(text);

      if (yes && !no) {
        const prev = String(state?.context?._resumeStep || "collect");
        state.context._resumeStep = null;
        state.step = prev || "collect";
        pending.set(chatId, state);

        await reply(client, chatId, "Perfetto  continuiamo!", {
          noFooter: true
        });
        await promptResumeStep(client, chatId, state);
        return "";
      }

      if (no) {
        try {
          pending.delete(chatId);
        } catch { }
        try {
          __dateParsingLocks.delete(chatId);
        } catch { }
        try {
          releaseSoftHoldByChat?.(chatId);
        } catch { }

        state = getState(chatId);
        ensureContext(state);
        state.step = "collect";
        pending.set(chatId, state);

        await reply(
          client,
          chatId,
          'Ok  Quando vuoi: scrivi *prenota* per fissare un appuntamento oppure *modifica* per gestirne uno esistente.', {
          noFooter: true
        }
        );
        return "";
      }

      await reply(client, chatId, "Dimmi solo *si* oppure *no* ", {
        noFooter: true
      });
      return "";
    }

    // Comando "stato" / "che manca?"
    if (/\b(stato|dove\s+siamo|a\s+che\s+punto|che\s+manca|manca\s+qualcosa)\b/i.test(t)) {
      const col = state.collected || {};
      const parts = [];

      if (col.service) parts.push(`• Trattamento: *${col.service}*`);
      if (col.professionalAny) parts.push(`• Professionista: *chiunque*`);
      else if (col.professionalName) parts.push(`• Professionista: *${col.professionalName}*`);

      if (col.when) {
        const d =
          typeof formatDateWithWeekdayIT === "function" ?
            formatDateWithWeekdayIT(col.when) :
            (typeof fmtDateWithWeekdayIT === "function" ? fmtDateWithWeekdayIT(col.when) : String(col.when));
        parts.push(`• Giorno: *${d}*`);
      }

      if (col.time) parts.push(`• Ora: *${col.time}*`);
      if (col.customerName) parts.push(`• Nome: *${col.customerName}*`);

      const missing = firstMissingField(col);
      const next =
        missing === "service" ?
          "Mi manca solo il *trattamento*: cosa vuoi fare? " :
          missing === "when" ?
            "Mi manca solo il *giorno*: per quando? " :
            missing === "time" ?
              "Mi manca solo l’*orario*: a che ora preferisci? " :
              missing === "professional" ?
                "Mi manca solo il *professionista*: dimmi il numero o il nome in lista " :
                missing === "customerName" ?
                  'Mi manca solo *nome e cognome* (es. "Maria Rossi") ' :
                  "Siamo pronti  Se vuoi confermare, dimmi pure *ok*.";

      const head = parts.length ? `Siamo a questo punto \n${parts.join("\n")}\n\n${next}` : `Non ho ancora dati della prenotazione.\n\n${next}`;
      await reply(client, chatId, head, {
        noFooter: true
      });
      return "";
    }

    // Salva messaggio utente nella cronologia
    if (!__isReenter) try {
      await appendUserMessage(chatId, text);
    } catch (e) {
      log("warn", "[APPEND] Failed to save user message", e?.message || e);
    }

    const pureNumber = /^\s*\d+\s*[\).]?\s*$/;
    const phone = typeof phoneFromChatId === "function" ? phoneFromChatId(chatId) : chatId;

    log("debug", "[HANDLE] Message received", { step: state.step });
    const BOOKING_INTENT_PATTERNS = [
      // Comandi/keyword dirette
      /^\/?(?:prenota|prenotazione|booking|appuntamento)\b/i,

      // Verbi tipici: "voglio prenotare", "vorrei fissare un appuntamento", ecc.
      /\b(?:voglio|vorrei|volevo|mi\s+serve|devo|posso)\s+(?:prenot\w*|fiss\w*|prendere|fare)\b/i,
      /\b(?:prenot\w*|fiss\w*)\s+(?:un'?\s*)?(?:appunt\w*|prenotazion\w*)\b/i,

      // Disponibilità / slot / posto (più “booking-like”, evita “orari” generici)
      /\b(?:disponibilit[àa]|orari?\s+(?:liber\w*|disponibil\w*)|posti?\s+liber\w*|slot|buco)\b/i
    ];

    // Pattern per riconoscere intent di edit durante booking
    const EDIT_INTENT_PATTERNS = [
      // Comandi secchi
      /^\/?(?:modifica|sposta|spostare|cambia|cambiare|annulla|annullare|cancella|cancellare|disdici|disdire|edit)\b/i,

      // Frasi naturali: "puoi/possiamo/potete ... spostare/cambiare/modificare ..."
      /\b(?:voglio|vorrei|volevo|devo|posso|possiamo|puoi|può|potete|mi\s+serve|mi\s+puoi|riesci\s+a)\s+(?:modific\w*|spost\w*|cambi\w*|annull\w*|cancell\w*|disdic\w*|rimand\w*|rinvi\w*|posticip\w*|anticip\w*|riprogramm\w*|slitt\w*|rischedul\w*|reschedul\w*)\b/i,

      // Anche senza "voglio/posso": se nel testo ci sono verbi di modifica + contesto appuntamento
      /\b(?:modific\w*|spost\w*|cambi\w*|annull\w*|cancell\w*|disdic\w*|rimand\w*|rinvi\w*|posticip\w*|anticip\w*|riprogramm\w*|slitt\w*|rischedul\w*|reschedul\w*)\b.*\b(?:prenotazion\w*|appunt\w*|data|giorno|orario|ora)\b/i,

      // "gestisci prenotazione/appuntamento"
      /\b(?:gestire|gestisci)\s+(?:la\s+)?(?:prenotazion\w*|appunt\w*)\b/i,

      // Imprevisti tipici
      /\b(?:non\s+posso\s+(?:venire|arrivare)|non\s+riesco\s+(?:a\s+)?venire|ho\s+un\s+imprevist\w*|devo\s+lavorare|sono\s+al\s+lavoro|ho\s+un\s+turno)\b/i
    ];

    // Switch da EDIT → BOOKING
    if (state.step && state.step.startsWith("edit_")) {
      const hasBookingIntent = BOOKING_INTENT_PATTERNS.some(pattern => pattern.test(text));

      if (hasBookingIntent && !wantsEditMenu(text)) {
        log("info", "[SWITCH] Edit → Booking rapido", {
          chatId
        });

        // Reset completo
        try {
          pending.delete(chatId);
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }
        try {
          releaseSoftHoldByChat(chatId);
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }

        // Nuovo stato booking (riparto da scelta trattamento)
        state = getState(chatId);
        state.edit = null;
        ensureContext(state);

        // UX: chiedi il nome prima di entrare nel booking (riduce confusione su orari/date)
        if (!state.collected?.customerName && !state.context?.nameConfirmed) {
          state.step = "collect_name";
          pending.set(chatId, state);
          await reply(client, chatId, "Come ti chiami? (nome e cognome)\nSe vuoi, scrivi anche trattamento + giorno + ora.");
          return "";
        }

        state.step = "choose_service";
        col.options = null; //  FIX Bug #8;
        pending.set(chatId, state);

        // Passaggio diretto senza messaggi di annullamento
        await reply(client, chatId, "Ok! Che trattamento vuoi fare? ");
        return "";
      }
    }

    // Switch da BOOKING → EDIT (solo se sei in collect/start, non durante il flow booking)
    if (!state.step || !state.step.startsWith("edit_")) {
      const col = state.collected || {};

      const __isInitialForEditSwitch = (!state.step || state.step === "collect" || state.step === "start");

      // Se c'è un booking in corso (anche se step si resetta), NON switcho su EDIT
      const __bookingInProgress = !!(
        col?.service || col?.serviceId ||
        col?.when || col?.day || col?.date ||
        col?.time || col?.timePref ||
        col?.slot || col?.slotStart || col?.slotEnd ||
        col?.professionalName || col?.professionalEmail || typeof col?.professionalAny === 'boolean'
      );

      // Override: solo se l'utente è esplicito su appuntamento/prenotazione esistente
      const __explicitEditIntent =
        /\b(?:modific\w*|cancell\w*|annull\w*|spost\w*|rimand\w*|rinvi\w*|posticip\w*|anticip\w*|disdic\w*)\b.*\b(?:prenotazion\w*|appunt\w*)\b/i.test(text) ||
        (
          /\b(?:non\s+posso\s+(?:venire|arrivare)|non\s+riesco\s+(?:a\s+)?venire|ho\s+un\s+imprevist\w*|devo\s+lavorare|sono\s+al\s+lavoro|ho\s+un\s+turno)\b/i.test(text) &&
          /\b(?:prenotazion\w*|appunt\w*)\b/i.test(text)
        );

      const hasEditIntent =
        (__explicitEditIntent || (!__bookingInProgress && __isInitialForEditSwitch)) &&
        EDIT_INTENT_PATTERNS.some(pattern => pattern.test(text));

      if (hasEditIntent) {
        log("info", "[SWITCH] Booking → Edit rapido", {
          chatId
        });

        // Reset rapido: esco dal booking corrente (evita step incoerenti)
        try {
          releaseSoftHoldByChat(chatId);
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }
        try {
          pending.delete(chatId);
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }
        state = getState(chatId);

        const phone = phoneFromChatId(chatId);

        const bookings = getUserActiveBookingsAll(phone);

        if (!bookings.length) {
          await reply(client, chatId, " Non risulta alcuna prenotazione futura da modificare.");
          return "";
        }

        // Passaggio diretto al menu edit
        if (bookings.length === 1) {
          const booking = bookings[0];
          _editSnapshotStateFromBooking(state, booking);
          state.step = "edit_menu";
          state.edit = {
            target: booking
          };
          pending.set(chatId, state);
          await reply(client, chatId, showEditMenu(booking), {
            noFooter: true
          });
          return "";
        }

        // Più prenotazioni: chiedi quale
        await startEditChooseBooking(client, chatId, bookings, null);
        return "";
      }
    }

    // ============================================================================
    // SEZIONE 4: ROUTING EDIT FLOW
    // ============================================================================
    if (typeof state.step === "string" && state.step.startsWith("edit_")) {
      const isCancelMsg =
        /^(annulla|annula|cancel|stop|fine)\b/i.test(text) ||
        (typeof fuzzyCmd === "function" && fuzzyCmd((String(text || "").trim().split(/\s+/)[0] || ""), ["annulla", "annula", "cancel", "stop", "fine"]));
      const isTextStep = state.step === "edit_reschedule_date" || state.step === "edit_change_name";
      const _menuN = pureNumber.test(t) ? Number(t) : NaN;
      const isMenuNumberInTextStep =
        state.step === "edit_reschedule_date" &&
        Number.isInteger(_menuN) &&
        _menuN >= 0 &&
        _menuN <= 4;

      if (!isCancelMsg && (!isTextStep || isMenuNumberInTextStep)) {
        return await handleNumericReply(client, chatId, textRaw);
      }

    }

    // ============================================================================
    // SEZIONE 5: HELPER FUNCTIONS
    // ============================================================================

    /**
     * Trova il servizio migliore basandosi su sinonimi configurati
     */
    function bestServiceBySynonyms(raw) {
      try {
        const svcs = (typeof cfgServices === "function" ? cfgServices() : []) || [];
        if (!svcs.length) return null;

        const N = (s) =>
          (typeof norm === "function" ? norm(String(s || "")) : String(s || "").toLowerCase())
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();

        const rawClean = String(raw || "")
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .replace(/\b(prenot\w*|appunt\w*|booking|trattament\w*|servizi?|cambia|modifica|sposta|annulla|conferma|continua|avanti|procedi|scegli|preferisc\w*|riassunto|riepilogo|menu|stato)\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (!rawClean) return null;

        const msg = " " + N(rawClean) + " ";
        const msgWords = N(rawClean).split(" ").filter(Boolean);
        const longHint = /\b(lung|lungh|lunghe|lungo)\w*\b/i.test(raw);
        const shortHint = /\b(cort|corte|corto)\w*\b/i.test(raw);
        let best = null,
          bestScore = 0;

        for (const svc of svcs) {
          const syns = (
            typeof cfgServiceSynonyms === "function" ?
              cfgServiceSynonyms(svc) || [] :
              (config?.services?.[svc]?.synonyms || [])
          ).slice();
          syns.unshift(svc);

          let svcBest = 0;
          for (const s of syns) {
            const cand = N(s);
            if (!cand || cand.length < 3) continue;

            const wrapped = " " + cand + " ";
            let score = 0;

            if (msg.includes(wrapped)) {
              score = 1.0 + Math.min(cand.length / 40, 0.25);
            } else {
              const toks = cand.split(" ").filter(Boolean);

              // token matching: exact + tolleranza piccoli refusi (es. "reffil" ~ "refill")
              let hit = 0;
              for (const tk of toks) {
                if (tk.length < 3) continue;

                if (msg.includes(" " + tk + " ")) {
                  hit++;
                  continue;
                }

                if (tk.length >= 4) {
                  const ok = msgWords.some((w) => {
                    if (w === tk) return true;

                    // tolleranza refusi/trasposizioni su token medi-lunghi (es. "reffil" ~ "refill")
                    const L = Math.max(w.length, tk.length) || 1;
                    const md = (typeof typoMaxDist === "function") ? typoMaxDist(L) : (L >= 6 ? 2 : 1);

                    if (md <= 0) return false;
                    if (Math.abs(w.length - tk.length) > md) return false;

                    try {
                      if (typeof isTypoClose === "function") return isTypoClose(w, tk, md);
                      if (typeof dlDist === "function") return dlDist(String(w).toLowerCase(), String(tk).toLowerCase()) <= md;
                      if (typeof levenshtein === "function") return levenshtein(w, tk) <= md;
                    } catch { }
                    return false;
                  });
                  if (ok) hit++;
                }

              }

              const cover = hit / Math.max(1, toks.length);
              const twoGram = toks.some((_, i) =>
                i < toks.length - 1 && msg.includes(" " + toks[i] + " " + toks[i + 1] + " ")
              );
              const contBonus = twoGram ? 0.1 : 0;
              const lenBonus = Math.min(cand.length / 50, 0.15);

              // bonus generici (non hard-coded): "lunghe/corte" se presenti nella richiesta
              const sizeBonus =
                (longHint && /\blungh/i.test(cand) ? 0.12 : 0) +
                (shortHint && /\bcort/i.test(cand) ? 0.12 : 0);

              score = Math.max(score, 0.65 * cover + contBonus + lenBonus + sizeBonus);
            }

            svcBest = Math.max(svcBest, score);
          }

          if (svcBest > bestScore) {
            bestScore = svcBest;
            best = svc;
          }
        }

        return bestScore >= 0.45 ? best : null;
      } catch {
        return null;
      }
    }

    /**
     * Parsing intake: estrae servizio, data, orario, professionista da un singolo messaggio
     */
    function parseIntake(raw) {
      if (!raw) return null;
      const out = {};
      const text = String(raw);

      // Preferenza settimana (es. "settimana prossima", "tra 2 settimane")
      try {
        const lower = text.toLowerCase();
        let w = null;
        if (/\b(la\s+prossima\s+settimana|settimana\s+prossima)\b/i.test(lower)) w = 1;
        else if (/\b(settimana\s+dopo|quella\s+dopo)\b/i.test(lower)) w = 2;
        else {
          const m = lower.match(/\btra\s+(\d{1,2})\s+settimane?\b/);
          if (m) w = Math.max(0, Math.min(12, parseInt(m[1], 10)));
        }
        if (w != null) out.weekOffset = w;
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      // STEP 0: Riconosci keyword INFO prima di tutto (solo richieste esplicite)
      const INFO_KEYWORDS = [
        // prezzo/listino/durata/costi (espliciti)
        /\b(quanto\s+(?:dura|costa|costano)|quanto\s+tempo|quanti?\s+minut[io]|durata|prezzo|prezzi|costo|costi|tariff[ae]|listino)\b/i,
        // “prima volta” (valgono solo se c'è anche una richiesta info vera e propria)
        /\b(prima\s+volta|nuovo\s+client[ea]|sono\s+nuov[oa])\b/i,
      ];

      const looksLikeInfoAsk =
        /[?]/.test(text) ||
        /\b(quanto\s+(?:dura|costa|costano)|prezzo|costo|durata|info|informazioni|listino|dettagli|spieg[ah]|dimmi|mi\s+dici)\b/i.test(text);

      const isInfoQuery = looksLikeInfoAsk && INFO_KEYWORDS.some((pattern) => pattern.test(text));

      if (isInfoQuery) {
        // Marca come query info
        out.isInfoQuery = true;

        // Estrai comunque il servizio (per sapere DI COSA chiedono info)
        let svc = null;
        try {
          svc = (typeof resolveServiceFromText === "function" ? resolveServiceFromText(text) : null) || null;
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }

        if (!svc) {
          try {
            svc = (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(text) : null) || null;
          } catch (err) {
            log("warn", "[CATCH] Errore ignorato", {
              error: String(err)
            }); //  FIX Bug #17
          }
        }

        if (svc) out.service = svc;

        // NON estrarre data/ora per query info
        return out;
      }

      // STEP 1: Nome
      // Per evitare falsi positivi (es. "per le 18:30") e perché nel flow chiediamo SEMPRE il nome,
      // non estraiamo automaticamente il nome dall'intake.

      // STEP 2: Servizio (scoring + low confidence)
      let svc = null;
      let svcScore = 0;

      const AUTO_ACCEPT = Number(process.env.SVC_AUTO_ACCEPT || 0.92); // >= auto-pick top1
      const AUTO_GAP = Number(process.env.SVC_AUTO_GAP || 0.08); // gap minimo sul secondo per auto-pick
      const ACCEPT = Number(process.env.SVC_SCORE_ACCEPT || 0.70); // >= accetta (senza lista)
      const HINT = Number(process.env.SVC_SCORE_HINT || 0.50); // >= mostra lista/suggerisci
      const AMBIG_DELTA = Number(process.env.SVC_SCORE_AMBIG_DELTA || 0.06);
      try {
        const names = (typeof cfgServices === "function" ? (cfgServices() || []) : []);
        if (names.length && typeof scoreService === "function") {
          const ranked = [];

          for (const name of names) {
            const syns = (typeof cfgServiceSynonyms === "function" ? (cfgServiceSynonyms(name) || []) : []);
            const sc = scoreService(text, {
              name,
              synonyms: syns
            });
            ranked.push({
              name,
              sc
            });
          }

          ranked.sort((a, b) => (Number(b.sc || 0) - Number(a.sc || 0)));

          const best = (ranked[0] && ranked[0].name) ? ranked[0].name : null;
          const bestScore = Number((ranked[0] && ranked[0].sc) || 0);
          const second = (ranked[1] && ranked[1].name) ? ranked[1].name : null;
          const secondScore = Number((ranked[1] && ranked[1].sc) || 0);

          // debug solo su log
          try {
            log("debug", "[SVC_SCORE]", {
              q: String(text || "").slice(0, 140),
              best,
              bestScore,
              second,
              secondScore,
              ACCEPT,
              HINT
            });
          } catch { }

          const gap = bestScore - secondScore;

          // candidati "vicini" al best (utile per omonimie: gel/ricostruzione/refill ecc.)
          const CLOSE_DELTA = Math.max(0.10, AMBIG_DELTA * 2);
          const candidatesNear = ranked
            .filter((x) => Number(x.sc || 0) >= HINT && (bestScore - Number(x.sc || 0)) <= CLOSE_DELTA)
            .slice(0, 8)
            .map((x) => x.name);

          // Auto-pick aggressivo (best alto + gap)
          if (best && bestScore >= AUTO_ACCEPT && gap >= AUTO_GAP) {
            svc = best;
            svcScore = bestScore;
            out.serviceAutoPicked = true;
          }
          // Ambiguo: più trattamenti vicini -> lista scelta (TUTTI i candidati vicini)
          else if (candidatesNear.length >= 2 && bestScore >= HINT && secondScore >= HINT && gap < AMBIG_DELTA) {
            out.serviceCandidates = candidatesNear;
          }
          // Accetta best se abbastanza alto (e non troppo ambiguo)
          else if (best && bestScore >= ACCEPT) {
            svc = best;
            svcScore = bestScore;
          }
          // Score medio: suggerisci (lista se >=2, altrimenti 1 candidato da confermare)
          else if (best && bestScore >= HINT) {
            const sug = ranked
              .filter((x) => Number(x.sc || 0) >= HINT && (bestScore - Number(x.sc || 0)) <= 0.18)
              .slice(0, 5)
              .map((x) => x.name);

            if (sug.length >= 2) {
              out.serviceCandidates = sug;
            } else {
              out.serviceCandidate = best;
              out.serviceCandidateScore = bestScore;
              out.serviceCandidateSecond = second;
              out.serviceCandidateSecondScore = secondScore;
            }
          }
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      // fallback vecchio SOLO se scoring non ha dato nulla
      if (!svc && !out.serviceCandidates && !out.serviceCandidate) {
        try {
          const tentative =
            (typeof resolveServiceFromText === "function" ? resolveServiceFromText(text) : null) || null;

          if (tentative && typeof scoreService === "function") {
            const syns = (typeof cfgServiceSynonyms === "function" ? (cfgServiceSynonyms(tentative) || []) : []);
            const sc = scoreService(text, {
              name: tentative,
              synonyms: syns
            });

            if (sc >= ACCEPT) {
              svc = tentative;
              svcScore = sc;
            } else if (sc >= HINT) {
              out.serviceCandidate = tentative;
              out.serviceCandidateScore = sc;
            }
          }
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          });
        }
      }

      if (svc) {
        out.service = svc;
        out.serviceScore = svcScore;
      }

      // FALLBACK token-based: se l'utente scrive parole generiche (es. "gel", "ricostruzione")
      // e lo scoring non decide, proponi una lista filtrata invece di "non capire".
      if (!out.service && !out.serviceCandidates && !out.serviceCandidate) {
        try {
          const tokens = (typeof _svcTokensFromText === "function") ? _svcTokensFromText(text) : [];
          if (Array.isArray(tokens) && tokens.length) {
            const services = (typeof cfgServices === "function" ? (cfgServices() || []) : []) || [];
            const matches = [];

            for (const svcName of services) {
              const it = (typeof cfgServiceItem === "function") ? cfgServiceItem(svcName) : null;
              const baseLabel = (it && (it.label || it.name)) ? (it.label || it.name) : svcName;

              const label = (typeof _svcNormText === "function") ? _svcNormText(baseLabel) : String(baseLabel || "").toLowerCase();
              const labelWords = String(label).split(" ").filter(Boolean);

              const syns = (typeof cfgServiceSynonyms === "function") ? (cfgServiceSynonyms(svcName) || []) : [];
              const synNorms = syns
                .map((x) => (typeof _svcNormText === "function") ? _svcNormText(x) : String(x || "").toLowerCase())
                .filter(Boolean);

              const hay = [label, ...synNorms].filter(Boolean);

              const ok = tokens.some((tok) => {
                if (!tok) return false;
                if (hay.some((h) => String(h).includes(tok))) return true;

                // typo-close su parole (solo token >= 4)
                if (tok.length >= 4 && typeof isTypoClose === "function") {
                  if (labelWords.some((w) => isTypoClose(tok, w))) return true;
                  for (const h of hay) {
                    const ws = String(h).split(" ").filter(Boolean);
                    if (ws.some((w) => isTypoClose(tok, w))) return true;
                  }
                }

                return false;
              });

              if (ok) matches.push(svcName);
            }

            if (matches.length >= 2) {
              out.serviceCandidates = matches.slice(0, 10);
            } else if (matches.length === 1) {
              out.serviceCandidate = matches[0];
              out.serviceCandidateScore = 0.49; // borderline: chiedi conferma
            }
          }
        } catch { }
      }

      // STEP 3: Data (solo se NON è info)
      try {
        const baseForWeek =
          (out.weekOffset != null &&
            Number.isInteger(out.weekOffset) &&
            out.weekOffset > 0 &&
            !/\b(oggi|domani|dopodomani|dopo\s+domani)\b/i.test(text) &&
            // Se è "tra/fra N settimane" è un relativo puro: NON shiftare al lunedì
            !/\b(?:tra|fra)\s+\d{1,2}\s+settimane?\b/i.test(text)) ?
            (() => {
              const d0 = new Date();
              d0.setHours(12, 0, 0, 0);
              const day = d0.getDay(); // 0=dom, 1=lun...
              const diff = (day === 0 ? -6 : 1) - day; // lunedì corrente
              d0.setDate(d0.getDate() + diff + out.weekOffset * 7);
              d0.setHours(12, 0, 0, 0);
              return d0;
            })() :
            null;

        const d = (typeof safeParseDateWithLock === "function" ?
          safeParseDateWithLock(chatId, text, baseForWeek) :
          null) || null;
        if (d) {
          const at12 = typeof atNoon === "function" ? atNoon(d) : d;
          if (!(typeof isPast === "function" && isPast(at12))) out.when = at12;
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      // STEP 4: Orario (solo se NON è info)
      try {
        let hhmm =
          (typeof parseTimeSmart === "function" ? parseTimeSmart(text) : null) ||
          (typeof parseHHMM === "function" ? parseHHMM(text) : null);

        if (!hhmm && typeof parseNaturalTime === "function") hhmm = parseNaturalTime(text);
        if (hhmm) out.time = hhmm;
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      // STEP 5: Professionista (come prima)
      try {
        const anyRe = /\b(chiunque|qualsiasi|va\s*bene\s*chiunque|non\s*mi\s*interessa)\b/i;
        if (anyRe.test(text)) {
          out.professionalAny = true;
        } else {
          const list =
            (out.service && typeof proCatalog === "function" ? proCatalog(out.service) : null) ||
            Object.entries((config?.professionals || {})).map(([email, p]) => ({
              email,
              name: (p?.name) || email,
            }));

          const hit = typeof matchProFromFreeText === "function" ? matchProFromFreeText(text, list) : null;
          if (hit) {
            out.professionalName = hit.name;
            out.professionalEmail = hit.email || null;
            out.professionalAny = false;
          }
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      return Object.keys(out).length ? out : null;
    }

    /**
     * Fuzzy service matching sicuro (evita falsi positivi)
     */
    const fuzzyServiceSafe = (q) => {
      const hit = typeof fuzzyService === "function" ? fuzzyService(q) : null;
      if (!hit) return null;

      const tokens = (cfgServices() || [])
        .flatMap((s) => s.toLowerCase().split(/\W+/))
        .filter((x) => x && x.length >= 4);
      const nq = norm(q);
      const hasSvcToken = tokens.some((tok) => nq.includes(norm(tok)));

      const first = typeof cfgServices === "function" ? cfgServices()[0] || null : null;
      if (first && norm(hit) === norm(first) && !hasSvcToken) return null;

      return hit;
    };

    /**
     * Ottiene lista completa professionisti
     */
    const getAllProsList = () =>
      Object.entries(config?.professionals || {}).map(([email, p]) => ({
        email,
        name: (p?.name) || email,
      }));

    /**
     * Nome professionista da email
     */
    const proNameByEmailSafe = (email) =>
      (config?.professionals?.[email]?.name) ||
      (typeof proNameByEmail === "function" ? proNameByEmail(email) : null) ||
      email;

    /**
     * Email professionisti per un servizio
     */
    const serviceProsEmails = (svc) => {
      try {
        const item = (typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null) ||
          (config?.services?.[svc] || {});
        const arr = item.professionals || item.pros || [];
        return Array.isArray(arr) ? arr.filter(Boolean) : [];
      } catch {
        return [];
      }
    };

    /**
     * Verifica se un servizio è disponibile per un professionista
     */
    const isServiceAvailableForPro = (svc, proEmail) => {
      if (!proEmail) return true;

      let pros = (typeof cfgServiceProfessionals === "function" ? (cfgServiceProfessionals(svc) || []) : null) || null;
      if (!pros) pros = serviceProsEmails(svc);

      const emails = (Array.isArray(pros) ? pros : [])
        .map((x) => (typeof x === "string" ? x : (x?.email || x?.name || "")))
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());

      return emails.includes(String(proEmail).toLowerCase());
    };

    /**
     * Durata servizio per professionista specifico
     */
    const getDurForPro = (svc, proEmail) => {
      try {
        if (typeof getServiceDurationForPro === "function" && proEmail) {
          const d = getServiceDurationForPro(svc, proEmail);
          if (Number.isFinite(+d) && +d > 0) return +d;
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      try {
        const item = config?.services?.[svc] || {};
        const pd = item.professionalDurations || {};
        const d2 = proEmail && pd[proEmail];
        if (Number.isFinite(+d2) && +d2 > 0) return +d2;
        const d = item.duration;
        if (Number.isFinite(+d) && +d > 0) return +d;
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      return (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(svc) || 30) : 30);
    };

    /**
     * Costruisce messaggio servizi disponibili per un professionista
     */
    const buildServicesMessageForPro = (proEmail) => {
      const allSvcs = (typeof cfgServices === "function" ? (cfgServices() || []) : []) ||
        Object.keys(config?.services || {});

      const availableRaw = allSvcs.filter((svc) => isServiceAvailableForPro(svc, proEmail));
      const unavailable = allSvcs.filter((svc) => !isServiceAvailableForPro(svc, proEmail));

      const labelOfSvc = (svc) => {
        const item = (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {}) ||
          (config?.services?.[svc] || {});
        return item.label || item.name || svc;
      };

      const groups = (typeof groupServicesByCategory === "function") ?
        groupServicesByCategory(availableRaw, labelOfSvc) : (typeof groupServicesByType === "function") ?
          groupServicesByType(availableRaw, labelOfSvc) : [{
            title: "Trattamenti",
            services: availableRaw
          }];

      const lines = [];
      const available = []; // ORDER IMPORTANTE: deve combaciare coi numeri mostrati
      let idx = 0;

      for (const g of groups) {
        if (lines.length) lines.push("");
        lines.push(`*${g.title || "Trattamenti"}*`);

        for (const svc of (g.services || [])) {
          idx++;
          available.push(svc);

          const item = (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {}) ||
            (config?.services?.[svc] || {});
          const label = item.label || item.name || svc;
          const price = (typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "") ||
            (Number.isFinite(+item.price) ? `${item.price}€` : "");
          const dur = getDurForPro(svc, proEmail);
          const durTxt = (typeof formatDurationMin === "function" ?
            (formatDurationMin(dur) || `${dur} min`) :
            `${dur} min`);
          const pricePart = price ? ` (_${price}_, _*${durTxt}*_)` : ` (_*${durTxt}*_)`;

          lines.push(`${idx}) ${label}${pricePart}`);
        }
      }

      const unavailableLines = unavailable.map((svc) => {
        const emails = serviceProsEmails(svc);
        const names = emails.map(proNameByEmailSafe).filter(Boolean);
        const who = names.length ? names.join(", ") : "-";
        return `* ${svc} (disponibile con: ${who})`;
      });

      const proHeader = proEmail ? ` con *${proNameByEmailSafe(proEmail)}*` : "";

      let msg = ` Trattamenti disponibili${proHeader}:\n` +
        (lines.length ? lines.join("\n") : " Nessun trattamento disponibile.");

      if (available.length) msg += `\n(1-${available.length})`;

      if (unavailableLines.length) {
        msg += `\n\n Non disponibili ${proHeader}:\n${unavailableLines.join("\n")}\n\n` +
          ` Se vuoi uno dei trattamenti non disponibili: digita "annulla" e prenota di nuovo scegliendo un professionista che lo esegue.`;
      }

      return {
        available,
        msg
      };
    };

    // ============================================================================
    // SEZIONE 6: SHORT-CIRCUIT ROUTING
    // ============================================================================

    // Comandi universali: "menu" / "riepilogo" / "indietro"
    {
      const __rawCmd = String(msg || "").trim();
      const __isEdit = typeof state.step === "string" && state.step.startsWith("edit_");

      const __colCmd = state.collected || (state.collected = {});
      const __activeCmd = !__isEdit && (typeof isBookingFlowActive === "function" ?
        isBookingFlowActive(state, __colCmd) :
        (!!(state.step && state.step !== "collect") || !!(__colCmd.service || __colCmd.when || __colCmd.time)));

      const __wantsMenu = /^\s*(menu|riepilogo|riassunto|stato)\s*$/i.test(__rawCmd);
      const __wantsBack = /^\s*(indietro|back)\s*$/i.test(__rawCmd);

      if (__activeCmd && (__wantsMenu || __wantsBack)) {
        // indietro: se stai scegliendo orario, torna alla scelta giorno; altrimenti mostra menu
        if (__wantsBack) {
          if (state.step === "pick_time" || state.step === "edit_reschedule_time") {
            __colCmd.time = null;
            __colCmd.options = null;
            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(
              client,
              chatId,
              'Ok  Torniamo al giorno. Che giorno preferisci? (es. "domani", "venerdì", "23 ottobre")', {
              noFooter: true
            }
            );
            return "";
          }
        }

        try {
          ensureContext(state);
          const built = buildReviewIntakePrompt(__colCmd);
          state.context.reviewIntakeMap = built.map;
          state.context.reviewIntakeMsg = built.msg;
          state.step = "review_intake";
          pending.set(chatId, state);
          await reply(client, chatId, built.msg, {
            noFooter: true
          });
          return "";
        } catch (err) {
          log("warn", "[MENU] buildReviewIntakePrompt failed", err?.message || err);
        }
      }
    }

    // Step: conferma mese/giorno quando il mese non è specificato (es. "giovedì 18")
    if (state.step === "confirm_day_month") {
      try {
        ensureContext(state);
      } catch { }
      const col = state.collected || (state.collected = {});
      const ctx = state?.context?.dayMonthConfirm || null;
      const rawIn = String(msg || "").trim();
      const low = rawIn.toLowerCase();

      const cancel = /^\s*0\s*[\).]?\s*$/.test(rawIn) || /^(annulla|annula|cancel|stop|fine|esci)\b/i.test(low);
      if (cancel) {
        try {
          state.context.dayMonthConfirm = null;
        } catch { }
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Ok  Dimmi che giorno preferisci (es. "domani", "23 ottobre", "lunedì").', {
          noFooter: true
        });
        return "";
      }

      if (!ctx || !ctx.awaiting) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Dimmi che giorno preferisci (es. "domani", "23 ottobre", "lunedì").', {
          noFooter: true
        });
        return "";
      }

      let chosen = null;
      const num = rawIn.match(/^\s*(\d+)\s*[\).]?\s*$/);
      if (num) {
        const n = parseInt(num[1], 10);
        if (n === 1 && ctx.cand1ISO) chosen = new Date(ctx.cand1ISO);
        else if (n === 2 && ctx.cand2ISO) chosen = new Date(ctx.cand2ISO);
        else if (n === 3 && ctx.show3 && ctx.cand3ISO) chosen = new Date(ctx.cand3ISO);
      } else {
        // data scritta a mano
        try {
          chosen = (typeof safeParseDateWithLock === "function") ? safeParseDateWithLock(chatId, rawIn) : null;
        } catch { }
      }

      if (!(chosen instanceof Date) || Number.isNaN(chosen.getTime())) {
        await reply(client, chatId, ctx.prompt, {
          noFooter: true
        });
        return "";
      }

      // valida futuro
      const d0 = new Date(chosen);
      d0.setHours(0, 0, 0, 0);
      const today0 = new Date();
      today0.setHours(0, 0, 0, 0);
      if (d0 < today0) {
        await reply(client, chatId, ' Quella data è già passata. Scegli una data futura.', {
          noFooter: true
        });
        await reply(client, chatId, ctx.prompt, {
          noFooter: true
        });
        return "";
      }

      col.when = (typeof atNoon === "function") ? atNoon(chosen) : chosen;

      // se avevamo già un orario, preservalo come preferenza
      if (ctx.preferredTime && !col._preferredTime) {
        col._preferredTime = ctx.preferredTime;
        try {
          ensureContext(state);
          state.context.preferredTime = ctx.preferredTime;
        } catch { }
      }

      // cleanup + vai a review
      try {
        ensureContext(state);
        state.context.dayMonthConfirm = null;
      } catch { }
      try {
        const built = buildReviewIntakePrompt(col);
        ensureContext(state);
        state.context.reviewIntakeMap = built.map;
        state.context.reviewIntakeMsg = built.msg;
        state.step = "review_intake";
        pending.set(chatId, state);
        await reply(client, chatId, built.msg, {
          noFooter: true
        });
        return "";
      } catch {
        state.step = "review_intake";
        pending.set(chatId, state);
        await reply(client, chatId, 'Ok! Continuiamo ', {
          noFooter: true
        });
        return "";
      }
    }

    // Routing per numeri puri (elenchi numerati)
    // e anche testo in step numerati che supportano nome (es. scelta pro dopo orario)
    if (pureNumber.test(msg) || state.step === "pick_professional_for_time" || state.step === "review_intake") {
      const col = state.collected || (state.collected = {});
      const hasOptions = Array.isArray(col.options) && col.options.length > 0;
      const waitingService = ["info_select_service", "price_select_service", "confirm_service"].includes(state.step);
      const isChoosingService = !col.service && state.step === "choose_service";
      const awaitingDay = (state.availFlow && state.availFlow.awaiting === "day") || state.step === "choose_day";
      const isEditFlow = typeof state.step === "string" && state.step.startsWith("edit_");
      const isReviewIntake = state.step === "review_intake";
      const inNumberedStep = ["pick_professional_for_time", "price_select_service", "review_intake"].includes(state.step);
      const isPickProfessional = state.step === "pick_professional";

      const isPickingTime = state.step === "pick_time" || state.step === "edit_reschedule_time";

      const forceListHandler = ((state.step === "pick_professional_for_time" || state.step === "review_intake") && !pureNumber.test(msg));
      const shouldUseNumericHandler =
        isReviewIntake ||
        forceListHandler ||
        (
          !isChoosingService &&
          !isPickProfessional &&
          !isPickingTime &&
          (awaitingDay || hasOptions || waitingService || inNumberedStep || isEditFlow)
        );

      const __dmPendingChooseDay = (state.step === "choose_day" && !!(state?.context?.dayMonthConfirm && state.context.dayMonthConfirm.awaiting));
      if (shouldUseNumericHandler && !__dmPendingChooseDay) {
        return await handleNumericReply(client, chatId, text, tools);
      }
    }

    // Fast-path intake: parsing diretto da messaggio libero
    if (!pureNumber.test(text)) {
      const col = state.collected || (state.collected = {});

      // NEW BOOKING: se l'utente riparte con "prenota/appuntamento/..." mentre siamo in collect/start,
      // azzera i campi del booking per non riusare un servizio vecchio.
      const __initialBookingKick = (!state.step || state.step === "collect" || state.step === "start");
      const __tNormKick = (typeof norm === "function") ? norm(t || "") : String(t || "").toLowerCase();
      const __isNewBookingKick =
        __initialBookingKick &&
        /\b(prenot|appunt|fiss|riserv|posto|disponibil|quando\s+(?:avete|hai|c'e))\w*/i.test(__tNormKick) &&
        !/\b(modific|cancell|annull|spost|disdici)\w*/i.test(__tNormKick);

      if (__isNewBookingKick) {
        try {
          releaseSoftHoldByChat(chatId);
        } catch (err) { }
        const keepName = col.customerName || null;

        col.service = null;
        col.when = null;
        col.time = null;
        col.options = null;
        col.optionIds = null;
        col.slotId = null;
        col.proOptions = null;
        col.svcOptions = null;
        col.serviceOptions = null;
        col.professionalAny = null;
        col.professionalName = null;
        col.professionalEmail = null;

        try {
          ensureContext(state);
          state.context.preferredService = null;
        } catch (err) { }
        if (keepName) col.customerName = keepName;
      }

      if (!/^edit_/.test(state.step || "")) {
        const intake = __isReenter ? null : parseIntake(t);
        if (intake) {
          // Se è una query info, gestiscila subito SOLO in "collect" (mai durante step del flow)
          const __critical = (typeof isInCriticalStep === "function") ? isInCriticalStep(state.step) : false;
          const __allowInfoNow = (!state.step || state.step === "collect") && !__critical;
          if (intake.isInfoQuery && __allowInfoNow) {
            const svc = intake.service;

            if (svc) {
              // Info su servizio specifico
              const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;

              const label = (it && (it.label || it.name)) || svc;
              const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "";
              const price = (priceRaw && String(priceRaw).trim()) || "su richiesta";
              const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
              const durTxt = typeof formatDurationMin === "function" ?
                (formatDurationMin(dur) || `${dur} min`) :
                `${dur} min`;

              const msg = `*${label}*\n Prezzo: ${price}\n Durata: ${durTxt}\n\n _Vuoi prenotare? Dimmi giorno e ora!_ `;
              await reply(client, chatId, msg, {
                noFooter: true
              });
            } else {
              // Info generica - mostra tutti i trattamenti
              const svcs = cfgServices() || [];
              const lines = svcs.map((s) => {
                const it = typeof cfgServiceItem === "function" ? cfgServiceItem(s) : null;

                const label = (it && (it.label || it.name)) || s;
                const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(s) : "";
                const price = (priceRaw && String(priceRaw).trim()) || "su richiesta";
                const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(s) : 0;
                const durTxt = typeof formatDurationMin === "function" ?
                  (formatDurationMin(dur) || `${dur} min`) :
                  `${dur} min`;

                return `*${label}* • ${price} • ${durTxt}`;
              });

              const msg = ` *I nostri trattamenti:*\n\n` + lines.join("\n\n") + "\n\n _Se vuoi prenotare dimmi giorno e ora!_ ";
              await reply(client, chatId, msg, {
                noFooter: true
              });
            }
            return "";
          }

          // Resto del flow normale per booking...
          if (
            !col.service &&
            Array.isArray(intake.serviceCandidates) &&
            intake.serviceCandidates.length > 1 &&
            (!state.step || state.step === "collect")
          ) {
            col.serviceCandidates = intake.serviceCandidates.slice();
            state.step = "confirm_service";
            pending.set(chatId, state);

            // Omonimia: se l'utente scrive un termine generico (es. "ricostruzione"),
            // espandi la lista con TUTTI i trattamenti che matchano quel termine (nome o sinonimi).
            let homToken = null;
            let opts = Array.isArray(col.serviceCandidates) ? col.serviceCandidates.slice() : [];

            try {
              const STOP = new Set([
                "voglio", "vorrei", "volevo", "prenotare", "prenota", "appuntamento",
                "un", "una", "il", "lo", "la", "i", "gli", "le",
                "per", "di", "da", "del", "della", "dei", "delle",
                "a", "al", "allo", "alla", "alle", "all",
                "nel", "nello", "nella", "nei", "negli", "nelle",
                "con", "senza", "mi", "serve", "che", "come", "fare", "farmi", "fatta", "fatto",
                "questo", "questa", "quello", "quella", "coso",
                "oggi", "domani", "dopodomani", "ieri", "tra", "dopo", "settimana", "prossima", "prossimo",
                "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato", "domenica",
                "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"
              ]);

              const q = norm(t || "");
              const tokens = q
                .split(/\s+/)
                .map((x) => String(x || "").trim())
                .filter((x) => x && x.length >= 3 && !STOP.has(x) && !/^\d+$/.test(x));

              const services = (typeof cfgServices === "function" ? (cfgServices() || []) : []);

              for (const tok of tokens) {
                const matches = [];

                for (const svc of services) {
                  const it = (typeof cfgServiceItem === "function") ? cfgServiceItem(svc) : null;
                  const label = norm(((it && (it.label || it.name)) || svc));

                  if (label.includes(tok)) {
                    matches.push(svc);
                    continue;
                  }

                  // typo-close su parole (es. "reffil" -> "refill")
                  if (tok.length >= 4 && typeof isTypoClose === "function") {
                    const ws = String(label).split(/\s+/).filter(Boolean);
                    if (ws.some((w) => isTypoClose(tok, w))) {
                      matches.push(svc);
                      continue;
                    }
                  }

                  const syns = (typeof cfgServiceSynonyms === "function") ? (cfgServiceSynonyms(svc) || []) : [];
                  if (syns.some((sy) => {
                    const n = norm(sy);
                    if (!n) return false;
                    if (n === tok || n.includes(tok)) return true;

                    if (tok.length >= 4 && typeof isTypoClose === "function") {
                      const ws = String(n).split(/\s+/).filter(Boolean);
                      return ws.some((w) => isTypoClose(tok, w));
                    }
                    return false;
                  })) {
                    matches.push(svc);
                  }
                }

                // Se per un token trovo >=2 match, lo considero "omonimia" e mostro TUTTI i match.
                if (matches.length >= 2) {
                  homToken = tok;
                  opts = matches;
                  break;
                }
              }
            } catch { }

            // aggiorna candidates in stato, così la scelta numerica punta alla lista giusta
            col.serviceCandidates = opts.slice();

            const lines = opts
              .map((svc, i) => {
                const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;

                const label = (it && (it.label || it.name)) ? (it.label || it.name) : svc;
                const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "";
                const price = (priceRaw && String(priceRaw).trim()) ? String(priceRaw).trim() : "prezzo su richiesta";
                const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
                const durTxt = typeof formatDurationMin === "function" ?
                  (formatDurationMin(dur) || `${dur} min`) :
                  `${dur} min`;
                return ` ${i + 1}) *${label}* • ${price} • ${durTxt}`;
              })
              .join("\n");

            const header = homToken ?
              ` “${homToken}” può indicare più trattamenti. Quale intendi?` :
              ` Quello che hai scritto può indicare più trattamenti. Quale intendi?`;

            const dayTxt = col.when ?
              (typeof fmtWeekdayDateLongIT === "function" ?
                fmtWeekdayDateLongIT(col.when) :
                fmtWeekdayDateShortIT(col.when)) :
              "";

            const prefTxt = (state?.context?.preferredTime || col._preferredTime) ?
              String(state?.context?.preferredTime || col._preferredTime) :
              "";

            const recap = [
              dayTxt && `il giorno *${dayTxt}*`,
              prefTxt && `alle *${prefTxt}*`
            ].filter(Boolean).join(" • ");

            const recapLine = recap ? ` Ok! Ho segnato: ${recap}.\n\n` : "";

            await reply(
              client,
              chatId,
              `${recapLine}${header}\n${lines}\n(1-${opts.length})\n*Scrivi un numero o il nome del trattamento!*`
            );
            return "";
          }

          if (intake.service) col.service = col.service || intake.service;
          if (intake.when && !col.when) {
            const __d = new Date(intake.when);
            col.when = Number.isNaN(__d.getTime()) ? null : __d;
          }
          if (intake.time) col.time = col.time || intake.time;

          // score basso/medio: suggerisci senza auto-selezionare
          const __canAskSvcFix = (!state.step || state.step === "collect" || state.step === "start");

          // se il messaggio è “voglio un appuntamento” (senza servizio/data/ora) => riparto chiedendo il servizio
          const __m = String(msg || "");

          const __genericBookingNoSvc =
            __canAskSvcFix &&
            (
              hasBookingVerb(__m) ||
              /\bappuntamento\b/i.test(__m) ||
              /\bprenot\w+\b/i.test(__m) ||
              /\bquando\b.*\bappuntamento\b/i.test(__m) ||
              /\bprossim\w*\s+appuntamento\b/i.test(__m)
            ) &&
            !hasDateOrTime(__m) &&
            !parseHHMM(__m) &&
            !intake.service &&
            !intake.when &&
            !intake.time &&
            !intake.serviceCandidate &&
            !intake.serviceCandidates;

          if (__genericBookingNoSvc) {
            // reset leggero: tengo solo il nome se già lo ho
            const keepName = col.customerName || null;
            for (const k of Object.keys(col)) delete col[k];
            if (keepName) col.customerName = keepName;

            state.step = "choose_service";
            pending.set(chatId, state);

            // se hai il builder lista servizi, usalo; altrimenti chiedi testo libero
            try {
              const {
                available,
                msg: svcMsg
              } = buildServicesMessageForPro(null);
              col.serviceOptions = available;
              col.svcOptions = available;
              try {
                ensureUI(state);
                state.ui.lastServiceList = available;
              } catch { }
              await reply(client, chatId, svcMsg, {
                noFooter: true
              });
            } catch {
              await reply(client, chatId, "Ok  Che trattamento vuoi prenotare? (es. refill gel, semipermanente, pedicure)", {
                noFooter: true
              });
            }
            return "";
          }

          // Score medio: non costringere l'utente a riscrivere → fai scegliere 1-2 opzioni
          if (__canAskSvcFix && !col.service && intake.serviceCandidate && Number.isFinite(+intake.serviceCandidateScore)) {
            const best = intake.serviceCandidate;
            const second = intake.serviceCandidateSecond || null;

            const opts = [best, second].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
            if (opts.length) {
              col.serviceCandidates = opts.slice();
              state.step = "confirm_service";
              pending.set(chatId, state);

              const lines = opts.map((svc, i) => {
                const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;

                const label = (it && (it.label || it.name)) ? (it.label || it.name) : svc;
                const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "";
                const price = (priceRaw && String(priceRaw).trim()) ? String(priceRaw).trim() : "prezzo su richiesta";
                const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
                const durTxt = typeof formatDurationMin === "function" ?
                  (formatDurationMin(dur) || `${dur} min`) :
                  `${dur} min`;
                return ` ${i + 1}) *${label}* • ${price} • ${durTxt}`;
              }).join("\n");

              await reply(
                client,
                chatId,
                ` Non sono sicuro al 100%. Quale trattamento intendi?\n${lines}\n(1-${opts.length})`, {
                noFooter: true
              }
              );
              return "";
            }
          }

          if (intake.weekOffset != null) {
            ensureContext(state);
            state.context.weekOffset = intake.weekOffset;
          }

          if (typeof intake.professionalAny === "boolean") col.professionalAny = intake.professionalAny;
          if (intake.professionalName) col.professionalName = intake.professionalName;
          if (intake.professionalEmail) col.professionalEmail = intake.professionalEmail;

          // Se l'utente ha indicato un professionista, non trattarlo come "qualsiasi"
          if ((intake.professionalName || intake.professionalEmail) && typeof intake.professionalAny !== "boolean") {
            col.professionalAny = false;
          }

          // REVIEW INTAKE: riepilogo + menu (solo all'inizio, mai su re-enter)
          const __initialForReview = (!state.step || state.step === "collect" || state.step === "start");
          const __hasAnyForReview = !!(
            intake.service ||
            intake.when ||
            intake.time ||
            intake.professionalName ||
            intake.professionalEmail ||
            typeof intake.professionalAny === "boolean"
          );

          if (!__isReenter && __initialForReview && __hasAnyForReview) {
            // Default: professionista = qualsiasi, salvo esplicita scelta dell'utente
            if (!col.professionalName && !col.professionalEmail && typeof col.professionalAny !== "boolean") col.professionalAny = true;

            // Caso: l'utente dà già giorno/ora ma NON dice il trattamento
            // Esempio: "voglio un appuntamento il 15 alle 13"
            const __wantsBooking = /\b(prenot|appunt|fiss|posto|disponibil)\w*/i.test(String(msg || ""));
            if (__wantsBooking && !col.service && (col.when || col.time)) {
              // tratta l'orario come PREFERENZA (non come time confermato)
              try {
                if (col.time) {
                  ensureContext(state);
                  state.context.preferredTime = col.time;
                  col._preferredTime = col.time;
                  col.time = null;
                }
              } catch { }

              const dayTxt = col.when ?
                (typeof fmtWeekdayDateLongIT === "function" ?
                  fmtWeekdayDateLongIT(col.when) :
                  fmtWeekdayDateShortIT(col.when)) :
                "";
              const prefTxt = (state?.context?.preferredTime || col._preferredTime) ? String(state.context.preferredTime || col._preferredTime) : "";
              const recap = [dayTxt && `il giorno *${dayTxt}*`, prefTxt && `alle *${prefTxt}*`].filter(Boolean).join(" • ");

              state.step = "choose_service";
              pending.set(chatId, state);

              try {
                const {
                  available,
                  msg: svcMsg
                } = buildServicesMessageForPro(null);
                col.serviceOptions = available;
                col.svcOptions = available;
                try {
                  ensureUI(state);
                  state.ui.lastServiceList = available;
                } catch { }

                await reply(
                  client,
                  chatId,
                  `${recap ? `Ok! Ho segnato: ${recap}.\n` : ""}Ora dimmi *che trattamento* vuoi prenotare:\n\n${svcMsg}`, {
                  noFooter: true
                }
                );
              } catch {
                await reply(
                  client,
                  chatId,
                  `${recap ? `Ok! Ho segnato: ${recap}.\n` : ""}Ora dimmi *che trattamento* vuoi prenotare (es. refill gel, semipermanente, pedicure).`, {
                  noFooter: true
                }
                );
              }
              return "";
            }

            // Se l'utente ha scritto un giorno senza mese (es. "giovedì 18"), chiedi conferma per ridurre errori.
            try {
              const __dmCtx = (intake.when ? __buildDayMonthConfirmFromText(String(msg || ""), new Date()) : null);
              if (__dmCtx) {
                ensureContext(state);
                state.context.dayMonthConfirm = __dmCtx;
                // evita di salvare un "when" potenzialmente sbagliato
                col.when = null;
                state.step = "confirm_day_month";
                pending.set(chatId, state);
                await reply(client, chatId, __dmCtx.prompt, {
                  noFooter: true
                });
                return "";
              }
            } catch { }

            // Default: review intake
            ensureContext(state);
            const built = (typeof buildReviewIntakePrompt === "function") ?
              buildReviewIntakePrompt(col) : {
                msg: "Ok! Procediamo ",
                map: {
                  "1": "continue"
                }
              };
            state.context.reviewIntakeMap = built.map;
            state.context.reviewIntakeMsg = built.msg;
            state.step = "review_intake";
            pending.set(chatId, state);
            await reply(client, chatId, built.msg, {
              noFooter: true
            });
            return "";
          }

          if (col.service && !state.step) {
            // Default: professionista = qualsiasi, salvo esplicita scelta dell'utente
            if (!col.professionalName && !col.professionalEmail && typeof col.professionalAny !== "boolean") col.professionalAny = true;
            state.step = "choose_day";
            col.options = null; //  FIX Bug #8: Reset options;
            pending.set(chatId, state);
          }
        }
      }
    }

    // ============================================================================
    // SEZIONE 7: CANCELLAZIONE GLOBALE
    // ============================================================================
    if (
      /^(annulla|annula|cancel|stop|fine|esci)\b/i.test(t) ||
      (typeof fuzzyCmd === "function" && fuzzyCmd((String(t || "").trim().split(/\s+/)[0] || ""), ["annulla", "annula", "cancel", "stop", "fine", "esci"]))
    ) {
      const st = pending.get(chatId);

      if (st && /^edit_/.test(st.step)) {
        pending.delete(chatId);
        try {
          releaseSoftHoldByChat(chatId);
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }
        await reply(client, chatId, " Ho chiuso la gestione dell'appuntamento. Nessuna modifica applicata.");
        return "";
      }

      if (st) unlockBooking(st);
      pending.delete(chatId);

      try {
        releaseSoftHoldByChat(chatId);
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      const lang = getLang(chatId);
      if (lang === "en") {
        await reply(client, chatId, ' Operation canceled. If you want to start over, type "book" or "appointment".');
      } else {
        await reply(client, chatId, ' Operazione annullata. Se vuoi ricominciare, scrivi "prenota" o "appuntamento".');
      }
      return "";
    }

    // ============================================================================
    // SEZIONE 8: RISPOSTE INFO RAPIDE (indirizzo, orari)
    // ============================================================================
    if (!isInCriticalStep(state.step)) {
      const RE_ADDR = /(indirizz[oi]|dove\s+(siete|vi\s+trovate)|mappa|google\s*maps|come\s+raggiungerci|ubicazion[ei]|posizion[ei])/i;

      if (RE_ADDR.test(t)) {
        const prevStep = String(state.step || "collect");
        const resume = prevStep && prevStep !== "collect" && !String(prevStep).startsWith("edit_");

        if (resume) {
          ensureContext(state);
          state.context._resumeStep = prevStep;
          state.step = "resume_confirm";
          pending.set(chatId, state);
        }

        const addr = (config?.address || config?.addr || "Via Bosco, 44/a, 42019 Reggio Emilia RE").trim();
        await reply(
          client,
          chatId,
          `Ci trovi in ${addr}. ` + (resume ? `\n\nVuoi continuare con la prenotazione da dove eravamo rimasti? (si/no)` : "")
        );
        return "";
      }
      const RE_HOURS = /(quando\s+(aprite|chiudete|siete\s+aperti?|siete\s+chiusi?|fate)|a\s+che\s+ora|che\s+ore\s+fate|siete\s+aperti?|aperto|chiuso|disponibilit[aà])/i;
      if (RE_HOURS.test(t)) {
        const prevStep = String(state.step || "collect");
        const resume = prevStep && prevStep !== "collect" && !String(prevStep).startsWith("edit_");

        if (resume) {
          ensureContext(state);
          state.context._resumeStep = prevStep;
          state.step = "resume_confirm";
          pending.set(chatId, state);
        }

        const businessHours = config?.businessHours;
        const formattedHours = formatBusinessHours(businessHours);

        await reply(
          client,
          chatId,
          (formattedHours ?
            `I nostri orari sono:\n${formattedHours}` :
            `Siamo aperti dal Lunedì al Venerdì, dalle 9:00 alle 19:00, e il Sabato dalle 9:00 alle 17:00. Domenica chiuso.`) +
          (resume ? `\n\nVuoi continuare con la prenotazione da dove eravamo rimasti? (si/no)` : "")
        );
        return "";
      }
    }

    // Guard: booking bloccato
    if (isBookingLocked(state) && !/^(annula|annulla|cancel|stop|fine|esci)\b/i.test(t)) {
      if (!isInCriticalStep(state.step) && state.step !== "collect") {
        await safeSend(
          client,
          chatId,
          ' Sembra che stiamo già completando una prenotazione.\nSe vuoi interrompere: scrivi *annulla*.\nSe invece vuoi continuare, dimmi pure cosa ti serve ', {
          noFooter: true
        }
        );
        return "";
      }
    }

    let col = state.collected || (state.collected = {});

    // ============================================================================
    // SEZIONE 9: PATCH INTERPRETAZIONE "N" COME "N:00"
    // ============================================================================
    if (Array.isArray(col?.options) && col.options.length) {
      const optionsLookLikeTimes = col.options.every(opt => {
        const t = typeof opt === "string" ? opt : opt?.time || "";
        return typeof t === "string" && (/^\s*\d{1,2}[:.]\d{2}\s*$/.test(t.trim()) || /^\s*\d{1,2}\s*$/.test(t.trim()));
      });

      if (optionsLookLikeTimes && pureNumber.test(msg)) {
        const hour = parseInt(String(msg).replace(/\D/g, ""), 10);

        if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
          await safeSend(client, chatId, "Orario non valido. Scrivi un orario nel formato 9 o 9:00 o 09:00.");
          return "";
        }

        const normalized = col.options.map((opt, i) => {
          const raw = typeof opt === "string" ? opt : (opt?.time || "");
          const clean = String(raw).trim().replace(".", ":");
          if (/^\d{1,2}$/.test(clean)) return {
            time: `${String(clean).padStart(2, "0")}:00`,
            idx: i
          };
          if (/^\d{1,2}:\d{2}$/.test(clean)) {
            const parts = clean.split(":");
            return {
              time: `${String(parts[0]).padStart(2, "0")}:${parts[1]}`,
              idx: i
            };
          }
          return {
            time: null,
            idx: i
          };
        }).filter(x => x.time);

        const match = normalized.find(x => {
          const [h, m] = x.time.split(":").map(Number);
          return h === hour && m === 0;
        });

        if (!match) {
          await safeSend(
            client,
            chatId,
            `Non ho trovato disponibilità esatta per ${String(hour).padStart(2, "0")}:00. Scrivi l'orario completo (es. "10:00") o scegli un altro orario disponibile.`
          );
          return "";
        }

        let item = col.options[match.idx];
        let time = match.time;
        col.time = time;
        col.selectedOptionIndex = match.idx;
        pending.set(chatId, state);

        if (typeof scheduleReenter === "function") {
          await scheduleReenter(client, chatId, `ok ${time}`, tools);
          return "";
        }
        return "";
      }
    }

    // ============================================================================
    // SEZIONE 10: COMANDI VELOCI MODIFICA
    // ============================================================================
    if (/^(modifica|cambia|sposta|spostare)\s+(data|giorno)\b/i.test(t) || /^\/data\b/i.test(t)) {
      await startEditDate(client, chatId);
      return "";
    }

    // Reset forzato se utente vuole nuova prenotazione durante edit
    if (state.step && state.step.startsWith("edit_")) {
      const newBookingIndicators = /\b(avresti\s+posto|prenotare|prenota|appuntamento|disponibilità)\b/i;

      if (newBookingIndicators.test(t) && !wantsEditMenu(t)) {
        log("info", "[RESET] Utente esce dal menu edit per nuova prenotazione", {
          chatId,
          text
        });
        pending.delete(chatId);

        try {
          releaseSoftHoldByChat(chatId);
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }

        state.step = "collect";
        state.collected = {};
        state.edit = null;
        pending.set(chatId, state);
      }
    }

    if (/^(modifica|cambia|sposta|spostare)\s+(ora|orario)\b/i.test(t) || /^\/orario\b/i.test(t)) {
      await startEditTime(client, chatId);
      return "";
    }

    if (/^(modifica|cambia|sposta|spostare)\s+(professionista|operatrice|operatore)\b/i.test(t) || /^\/pro(f)?\b/i.test(t)) {
      await startEditProfessional(client, chatId);
      return "";
    }

    if (/^(modifica|cambia|sposta|spostare)\s+(nome|intestazione)\b/i.test(t) || /^\/nome\b/i.test(t)) {
      await startEditName(client, chatId);
      return "";
    }

    if (/^\/?modifica\b/i.test(t) || wantsEditMenu(t) || __intentHint === "edit") {
      const phone = phoneFromChatId(chatId);
      const bookings = getUserActiveBookingsAll(phone);

      if (!bookings.length) {
        if (state) unlockBooking(state);
        pending.delete(chatId);
        await reply(client, chatId, " Non risulta alcuna prenotazione futura da modificare.");
        return "";
      }

      if (bookings.length === 1) {
        const booking = bookings[0];
        _editSnapshotStateFromBooking(state, booking);
        state.step = "edit_menu";
        state.edit = {
          target: booking
        };
        pending.set(chatId, state);
        await reply(client, chatId, showEditMenu(booking), {
          noFooter: true
        });
        return "";
      }

      await startEditChooseBooking(client, chatId, bookings, null);
      return "";
    }

    // ============================================================================
    // SEZIONE 11: EDIT FLOW - MODIFICA DATA
    // ============================================================================
    if (state.step === "edit_reschedule_date") {
      const booking = state.edit?.target;
      if (!booking) {
        pending.delete(chatId);
        await reply(client, chatId, 'Sessione scaduta. Scrivi "modifica" per ripartire.');
        return "";
      }

      let newDay = null;
      try {
        newDay = _editParseNewDate ? _editParseNewDate(msg) : parseUnifiedDate(msg);
      } catch (parseErr) {
        log('error', '[EDIT_DATE] Parsing fallito', {
          input: msg,
          err: parseErr?.message
        });
      }

      if (!newDay) {
        await reply(client, chatId, 'Non ho capito la data. Scrivi "oggi", "domani", "tra 7 giorni" oppure in formato GG/MM.');
        return "";
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dayNormalized = new Date(newDay);
      dayNormalized.setHours(0, 0, 0, 0);

      if (dayNormalized < today) {
        await reply(client, chatId, 'Quella data è già passata. Scrivi una data valida (es. "domani" o "12 dicembre").');
        return "";
      }

      const duration = _editDuration ? _editDuration(booking) : null;
      const pro = booking.professionalEmail || null;

      try {
        releaseSoftHoldByChat(chatId);
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      const rawSlots = await fetchSlots({
        service: booking.service,
        day: typeof atNoon === "function" ? atNoon(dayNormalized) : dayNormalized,
        duration,
        professional: pro,
        wantDetail: true,
      });

      const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawSlots) : rawSlots) || [];

      if (!slots.length) {
        const dateStr = typeof formatDateWithWeekdayIT === "function" ?
          formatDateWithWeekdayIT(dayNormalized) :
          (typeof fmtDate === "function" ? fmtDate(dayNormalized) : dayNormalized.toLocaleDateString());
        pending.set(chatId, state);
        await reply(client, chatId, `Non ci sono orari liberi per ${dateStr}. Prova un altro giorno.`);
        return "";
      }

      state.step = "edit_reschedule_time";
      state.edit = state.edit || {};
      state.edit.target = booking;
      state.edit.day = dayNormalized;
      state.collected = state.collected || {};
      state.collected.options = slots;
      pending.set(chatId, state);

      const dateStr = typeof formatDateWithWeekdayIT === "function" ?
        formatDateWithWeekdayIT(dayNormalized) :
        (typeof fmtDate === "function" ? fmtDate(dayNormalized) : dayNormalized.toLocaleDateString());
      const lines = typeof renderSlotsList === "function" ? renderSlotsList(slots) : (slots || []).join("\n");

      await reply(
        client,
        chatId,
        `Disponibilità per ${dateStr}:\n${lines}\n\n Scrivi l'orario desiderato (es. "14:30", "14.30" oppure "alle 14").\nSe vuoi cambiare ancora giorno, scrivi la nuova data. Digita "annulla" per uscire.`
      );
      return "";
    }

    // ============================================================================
    // SEZIONE 12: EDIT FLOW - MODIFICA NOME
    // ============================================================================
    if (state.step === "edit_change_name") {
      const booking = state.edit?.target;
      if (!booking) {
        pending.delete(chatId);
        await reply(client, chatId, 'Sessione scaduta. Scrivi "modifica appuntamento" per ripartire.');
        return "";
      }

      const newNameRaw = String(msg || "").trim();
      const newName = extractCustomerName(newNameRaw) || newNameRaw;

      if (!newName) {
        await reply(client, chatId, "Scrivi il nuovo nome e cognome per la prenotazione.");
        return "";
      }

      const ok = await _editApplyUpdate({
        booking,
        newName
      });
      if (!ok) {
        await reply(client, chatId, " Non sono riuscito ad aggiornare il nome. Riprova tra poco.");
        return "";
      }

      state.step = "edit_menu";
      let updated = booking;
      try {
        const all = getUserActiveBookingsAll(booking.clientPhone) || [];
        const match = all.find((b) => b.eventId === booking.eventId);
        if (match) updated = match;
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      state.edit = {
        target: updated
      };
      pending.set(chatId, state);

      await reply(client, chatId, ` Nome aggiornato.\n\n${showEditMenu(updated)}`);
      return "";
    }

    // ============================================================================
    // SEZIONE 12B: FALLBACK INTENT (non avvia prenotazione su messaggi generici)
    // ============================================================================
    const __isInitialForFallback = (!state.step || state.step === "collect" || state.step === "start");
    const __wantsEditHere = (typeof wantsEditMenu === "function" ? wantsEditMenu(text) : false) || /^\/?(?:modifica|edit)\b/i.test(t) || __intentHint === "edit";
    const __wantsInfoHere = /\b(?:info|prezz\w*|listino|serviz\w*|trattament\w*|costo|quanto|orari|apert\w*|indirizzo)\b/i.test(t) || __intentHint === "info";

    if (!__isReenter && __isInitialForFallback && !pureNumber.test(text) && !((looksLikeBooking(t) || __intentHint === "appointment") || __intentHint === "appointment") && !__wantsEditHere && !__wantsInfoHere) {
      const helpMsg =
        "Ciao!  Sono *synk*\n\n" +
        " Per *prenotare* scrivi *prenota* (oppure: trattamento + giorno + ora).\n" +
        " Per *modificare* un appuntamento scrivi *modifica*.\n" +
        " Per *info/listino* scrivi *info*.\n\n" +
        "Esempi:\n" +
        "• \"prenota refill gel domani alle 15\"\n" +
        "• \"modifica appuntamento\"";
      await reply(client, chatId, helpMsg, {
        noFooter: true
      });
      return "";
    }

    // ============================================================================
    // SEZIONE 13: STEP 1 - SCELTA PROFESSIONISTA
    // ============================================================================
    const inEditFlowGlobal = state.step && typeof state.step === "string" && state.step.startsWith("edit_");
    const needPro = false; // non chiediamo più il professionista come step iniziale
    const alreadyAskingPro = (state.step === "pick_professional");
    const isInitialState = !state.step || state.step === "collect" || state.step === "start";
    const awaitingName = !!(state?.context?.awaitingName);
    const hasService = !!(col?.service);

    // Nuovo comportamento: il professionista NON si chiede all'inizio.
    // Default: qualsiasi, salvo esplicita scelta dell'utente (es. "con Diana").
    if (!inEditFlowGlobal && isInitialState && !awaitingName && (looksLikeBooking(t) || __intentHint === "appointment")) {
      if (!col.professionalName && !col.professionalEmail && typeof col.professionalAny !== "boolean") {
        col.professionalAny = true;
      }
    }

    // Gestione risposta scelta professionista
    if (!inEditFlowGlobal && state.step === "pick_professional") {
      const pros = getAllProsList();
      const txt = String(text || "").trim();

      if (!pros.length) {
        await reply(client, chatId, "Nessun professionista configurato. Contatta il salone.");
        state.step = "collect";
        pending.set(chatId, state);
        return "";
      }

      const preSvc = state?.context?.preferredService;
      const isAny =
        /^\s*0\s*[\).]?\s*$/.test(txt) ||
        /\b(non\s+mi\s+interessa|chiunque|qualsiasi|indifferente|nessuna\s+preferenza)\b/i.test(txt);

      // Opzione 0: Non mi interessa
      if (isAny) {
        col.professionalAny = true;
        col.professionalEmail = null;
        col.professionalName = null;
        col.proOptions = null;

        if (preSvc) {
          // Se l'utente ha scelto "Non mi interessa" e il servizio era già stato capito prima,
          // manteniamo la scelta "qualunque professionista" e lo assegniamo DOPO l'orario scelto.

          col.service = preSvc;
          state.context.preferredService = null;

          // Assicura che il nome sia stato raccolto PRIMA di chiedere giorno/orario
          ensureContext(state);
          if (!state.context?.nameConfirmed || !col.customerName) {
            state.step = "collect_name";
            state.context.awaitingName = true;
            pending.set(chatId, state);
            await reply(
              client,
              chatId,
              'Per favore scrivi nome e cognome (es. "Maria Rossi") per completare la prenotazione.', {
              noFooter: true
            }
            );
            return "";
          }

          state.step = "choose_day";
          pending.set(chatId, state);
          await reply(client, chatId, `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23 ottobre", "28 ottobre")`);
          return "";
        }

        const {
          available,
          msg: svcMsg
        } = buildServicesMessageForPro(null);
        col.serviceOptions = available;
        col.svcOptions = available;
        ensureUI(state);
        state.ui.lastServiceList = available;
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      // Numero 1..N
      if (pureNumber.test(txt)) {
        const idx = parseListIndex(txt, pros.length);

        // FIX CRITICO: idx è null se invalido, oppure numero 1..N
        if (idx == null || !Number.isFinite(idx)) {
          pending.set(chatId, state);
          await reply(
            client,
            chatId,
            ` Scelta non valida. Scrivi *0* per nessuna preferenza oppure un numero *1-${pros.length}*.`
          );
          return "";
        }

        // FIX CRITICO: converti da 1-based a 0-based
        const arrayIndex = idx - 1;

        // Verifica bounds
        if (arrayIndex < 0 || arrayIndex >= pros.length) {
          pending.set(chatId, state);
          await reply(client, chatId, ` Numero fuori range. Scrivi un numero tra 1 e ${pros.length}.`);
          return "";
        }

        const chosen = pros[arrayIndex];

        // Validazione oggetto
        if (!chosen || !chosen.name) {
          pending.set(chatId, state);
          await reply(client, chatId, ` Errore nel recupero del professionista. Riprova.`);
          return "";
        }

        col.professionalAny = false;
        col.professionalEmail = chosen.email || null;
        col.professionalName = chosen.name || chosen.email || null;
        col.proOptions = null;

        if (preSvc) {
          const ok = isServiceAvailableForPro(preSvc, col.professionalEmail);
          if (ok) {
            col.service = preSvc;
            state.context.preferredService = null;

            // (Nome raccolto più avanti, dopo data e orario)

            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(client, chatId, `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23 ottobre", "28 ottobre")`);
            return "";
          } else {

            state.context.preferredService = null;
            col.service = null;
            await reply(client, chatId, ` *${chosen.name}* non esegue *${preSvc}*.\nSeleziona un altro trattamento:`);
          }
        }

        const {
          available,
          msg: svcMsg
        } = buildServicesMessageForPro(col.professionalEmail);
        col.serviceOptions = available;
        col.svcOptions = available;
        ensureUI(state);
        state.ui.lastServiceList = available;
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      // Match per nome/frase (es. "con la Diana ...")
      let choice = typeof resolveProReply === "function" ? resolveProReply(txt, pros) : null;

      // "uguale / come prima" -> riusa ultimo professionista (se noto) oppure 0
      if ((!choice || (choice && !choice.any && !choice.email && !choice.name)) && /\b(uguale|come\s+prima|stess[oa])\b/i.test(txt)) {
        const lastEmail = state?.context?.lastProfessionalEmail || null;
        const lastName = state?.context?.lastProfessionalName || null;
        if (lastEmail || lastName) {
          const email =
            lastEmail ||
            (typeof proEmailByName === "function" && lastName ? proEmailByName(lastName) : null);
          const name =
            lastName ||
            (email && typeof proNameByEmailSafe === "function" ? proNameByEmailSafe(email) : null) ||
            email;
          choice = {
            any: false,
            email,
            name
          };
        } else {
          choice = {
            any: true
          };
        }
      }

      const hit = (choice && choice.any) ? null : choice;

      if (hit) {
        col.professionalAny = false;
        col.professionalEmail = hit.email || null;
        col.professionalName = hit.name || hit.email || null;
        col.proOptions = null;

        if (preSvc) {
          const ok = isServiceAvailableForPro(preSvc, col.professionalEmail);
          if (ok) {
            col.service = preSvc;
            state.context.preferredService = null;

            // (Nome raccolto più avanti, dopo data e orario)

            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(client, chatId, `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23 ottobre", "28 ottobre")`);
            return "";
          } else {

            state.context.preferredService = null;
            col.service = null;
            await reply(client, chatId, ` *${hit.name}* non esegue *${preSvc}*.\nSeleziona un altro trattamento:`);
          }
        }

        const {
          available,
          msg: svcMsg
        } = buildServicesMessageForPro(col.professionalEmail);
        col.serviceOptions = available;
        col.svcOptions = available;
        ensureUI(state);
        state.ui.lastServiceList = available;
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      pending.set(chatId, state);
      await reply(client, chatId, `Scrivi *0* oppure un numero da *1* a *${pros.length}* (oppure il nome del professionista).`);
      return "";
    }
    // ============================================================================
    // SEZIONE 14: STEP 2 - SCELTA SERVIZIO
    // ============================================================================
    const inEditFlow = state.step && typeof state.step === "string" && state.step.startsWith("edit_");

    if (!inEditFlow && !col.service && (!isInitialState || (looksLikeBooking(t) || __intentHint === "appointment"))) {

      const hasProfessional = col.professionalAny || col.professionalEmail || col.professionalName;

      if (!hasProfessional) {
        // Default: qualsiasi professionista
        col.professionalAny = true;
      }

      // Se l'utente ha scelto "Non mi interessa", NON assegnare un pro ora
      let proEmail = null;
      if (!col.professionalAny) {
        proEmail = col.professionalEmail ||
          (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null);
        col.professionalEmail = proEmail;
      }

      const {
        available,
        msg: svcMsg
      } = buildServicesMessageForPro(proEmail);
      col.serviceOptions = Array.isArray(col.serviceOptions) && col.serviceOptions.length ?
        col.serviceOptions :
        available;

      const svcs = col.serviceOptions || [];

      if (!svcs.length) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      // Applica servizio preferito se disponibile
      if (state?.context?.preferredService) {
        const preSvcRaw = String(state.context.preferredService || "").trim();
        const guess =
          (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(preSvcRaw) : null) ||
          (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(preSvcRaw) : null) ||
          preSvcRaw;

        const found =
          svcs.find((s) => norm(s) === norm(guess)) ||
          svcs.find((s) => norm(s) === norm(preSvcRaw));

        if (found) {
          col.service = found;

          const wasAny = !!col.professionalAny;
          // Se l'utente ha scelto "Non mi interessa", NON assegnare qui: il pro verrà scelto DOPO l'orario.

          state.context.preferredService = null;
          state.step = "choose_day";
          pending.set(chatId, state);

          await reply(client, chatId, ` Trattamento selezionato: *${col.service}*.\nOra dimmi il giorno (es. "domani", "23 ottobre").`);
          return "";
        }

        state.context.preferredService = null;
      }

      // Parsing servizio dall'input
      const pickFromFilteredByText = (raw) => {
        const input = String(raw || "").trim();
        if (!input) return null;

        if (pureNumber.test(input)) {
          const n = parseInt(input, 10);
          if (n >= 1 && n <= svcs.length) return svcs[n - 1];
          return "__INVALID_RANGE__";
        }

        const low = input.toLowerCase();
        let idx = svcs.map(s => String(s).toLowerCase()).indexOf(low);
        if (idx === -1) idx = svcs.findIndex(s => String(s).toLowerCase().startsWith(low));
        if (idx !== -1) return svcs[idx];

        let svcMatch = null;
        try {
          svcMatch = (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(input) : null) ||
            (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(input) : null) || null;
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }

        if (svcMatch && svcs.some(s => norm(s) === norm(svcMatch))) return svcMatch;

        try {
          const all = (typeof cfgServices === "function" ? (cfgServices() || []) : []) || [];
          const exists = all.find(s => norm(s) === norm(svcMatch || input));
          if (exists && !isServiceAvailableForPro(exists, proEmail))
            return {
              __UNAVAILABLE__: true,
              svc: exists
            };
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }

        return null;
      };

      const picked = pickFromFilteredByText(msg);

      if (!picked) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      if (picked === "__INVALID_RANGE__") {
        await reply(client, chatId, `Numero non valido. Scegli un numero (1-${svcs.length}).`);
        return "";
      }

      if (typeof picked === "object" && picked.__UNAVAILABLE__) {
        const svc = picked.svc;
        const emails = serviceProsEmails(svc);
        const names = emails.map(proNameByEmailSafe).filter(Boolean);
        const who = names.length ? names.join(", ") : "-";
        await reply(
          client,
          chatId,
          ` *${svc}* non è disponibile con *${proNameByEmailSafe(proEmail)}*.\n` +
          ` Disponibile con: ${who}\n\n` +
          ` Scegli un altro trattamento tra quelli disponibili per *${proNameByEmailSafe(proEmail)}* (vedi lista sotto).`
        );
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      col.service = picked;

      const wasAny = !!col.professionalAny;
      // Se l'utente ha scelto "Non mi interessa", NON assegnare qui: il pro verrà scelto DOPO l'orario.

      // Validazione compatibilità professionista-servizio solo se ha già un professionista specifico
      if (!wasAny) {
        try {
          if (col.professionalEmail && typeof validateProfessionalForService === "function") {
            const chk = await validateProfessionalForService(col.service, col.professionalEmail);

            if (!chk.ok) {
              log('warn', '[SERVICE_PICK] Incompatibile', {
                service: col.service,
                pro: col.professionalEmail
              });
              state.step = "choose_service";
              pending.set(chatId, state);
              await reply(
                client,
                chatId,
                (chk.reason || "Questo servizio non è disponibile con il professionista selezionato.") +
                "\n\nScegli un altro trattamento."
              );
              return "";
            }
          }
        } catch (e) {
          log("error", "validate after service pick failed", e?.stack || e?.message || e);
        }
      }

      // Se avevi già giorno+orario, dopo scelta trattamento vai diretto alla richiesta nome
      if (col.when && col.time) {
        state.step = "collect_name";
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          'Perfetto  Per completare la prenotazione scrivi *nome e cognome* (es. "Maria Rossi").', {
          noFooter: true
        }
        );
        return "";
      }

      // Se hai già il giorno, NON entrare in pick_time senza opzioni: carica gli slot e mostra la lista.
      if (col.when && !col.time) {
        const day = (col.when instanceof Date) ? col.when : new Date(col.when);
        col.when = day;

        const duration = (typeof cfgServiceDuration === "function") ?
          (cfgServiceDuration(col.service) || 30) :
          30;

        const professional = col.professionalAny ?
          null :
          (col.professionalEmail || col.professionalName || null);

        let rawList = [];
        try {
          rawList = await fetchSlots({
            service: col.service,
            day,
            duration,
            professional,
            wantDetail: true,
          });
        } catch {
          rawList = [];
        }

        let slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

        // Se oggi, elimina orari passati
        try {
          if (typeof filterOutPastTimesForToday === "function" && slots.length) {
            const allowed = filterOutPastTimesForToday(day, slots.map((x) => x.time));
            const set = new Set(allowed);
            slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
          }
        } catch { }

        if (!slots.length) {
          const dayStr = (typeof formatDateWithWeekdayIT === "function") ?
            formatDateWithWeekdayIT(day) :
            day.toLocaleDateString("it-IT");

          col.when = null;
          col.options = null;
          state.step = "choose_day";
          pending.set(chatId, state);

          await reply(client, chatId, `Nessun orario libero per ${dayStr} \nVuoi provare un altro giorno?`, {
            noFooter: true
          });
          return "";
        }

        col.options = slots;
        state.step = "pick_time";

        try {
          ensureContext(state);
          state.context.availOffset = 0;
          state.context.availFilterPart = null;
        } catch { }

        const availMsg = (typeof buildAvailabilityCompactMessage === "function") ?
          buildAvailabilityCompactMessage(day, slots, {
            offset: 0,
            pageSize: AVAIL_PAGE_SIZE
          }) :
          `Disponibilità per ${day.toLocaleDateString("it-IT")}:\n` + slots.map((s) => `• ${s.time}`).join("\n");

        pending.set(chatId, state);
        await reply(client, chatId, availMsg, {
          noFooter: true
        });
        return "";
      }

      state.step = "choose_day";
      pending.set(chatId, state);
      const proLine = wasAny && col.professionalEmail ?
        `Hai scelto *${proNameByEmailSafe(col.professionalEmail)}* per il tuo appuntamento.\n` :
        "";

      await reply(client, chatId, `${proLine}Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23 ottobre", "28 ottobre")`);
      return "";
    }

    // ============================================================================
    // SEZIONE 15: STEP 3 - SCELTA GIORNO
    // ============================================================================
    if (state.step === "choose_day") {
      state.step = "choose_day";

      const col = state.collected || (state.collected = {});

      // Se manca il trattamento ma arriva un numero, probabilmente l'utente sta rispondendo alla lista servizi
      if (!col.service) {
        const raw = String(msg || "").trim();

        if (typeof pureNumber !== "undefined" && pureNumber.test(raw)) {
          state.step = "choose_service";
          pending.set(chatId, state);

          // re-enter: riusa la logica già presente di choose_service (parseListIndex + lastServiceList)
          if (typeof scheduleReenter === "function") {
            await scheduleReenter(client, chatId, raw, tools);
            return "";
          }

          await reply(client, chatId, "Perfetto  Ora scegli il trattamento: rispondi con il numero della lista (es. 4).", {
            noFooter: true
          });
          return "";
        }

        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, "Prima dimmi che trattamento vuoi prenotare ", {
          noFooter: true
        });
        return "";
      }

      let userInput = String(msg || "").trim();

      // Conferma mese/giorno se l'utente scrive solo il numero del giorno o "giovedì 18" senza mese
      try {
        ensureContext(state);
        const dm = state?.context?.dayMonthConfirm || null;
        const rawIn = String(userInput || "").trim();
        const low = rawIn.toLowerCase();

        // se stiamo aspettando la risposta (1/2/3), trasformo in data esplicita e continuo nel flow normale
        if (dm && dm.awaiting) {
          if (/^\s*0\s*[\).]?\s*$/.test(rawIn) || /^(annulla|annula|cancel|stop|fine|esci)\b/i.test(low)) {
            state.context.dayMonthConfirm = null;
            pending.set(chatId, state);
            await reply(client, chatId, 'Ok  Dimmi un altro giorno (es. "domani", "23 ottobre").', {
              noFooter: true
            });
            return "";
          }

          let chosen = null;
          const num = rawIn.match(/^\s*(\d+)\s*[\).]?\s*$/);
          if (num) {
            const n = parseInt(num[1], 10);
            if (n === 1 && dm.cand1ISO) chosen = new Date(dm.cand1ISO);
            else if (n === 2 && dm.cand2ISO) chosen = new Date(dm.cand2ISO);
            else if (n === 3 && dm.show3 && dm.cand3ISO) chosen = new Date(dm.cand3ISO);
          } else {
            try {
              chosen = safeParseDateWithLock(chatId, rawIn);
            } catch { }
          }

          if (!(chosen instanceof Date) || Number.isNaN(chosen.getTime())) {
            await reply(client, chatId, dm.prompt, {
              noFooter: true
            });
            return "";
          }

          // preserva eventuale orario del messaggio originale
          if (dm.preferredTime && !col._preferredTime) {
            col._preferredTime = dm.preferredTime;
            try {
              state.context.preferredTime = dm.preferredTime;
            } catch { }
          }

          // sostituisci input con data esplicita (evita ambiguità)
          userInput = (typeof fmtDate === "function") ? fmtDate(chosen) : chosen.toLocaleDateString("it-IT");

          state.context.dayMonthConfirm = null;
          pending.set(chatId, state);
        } else {
          // se NON stiamo aspettando, valuta se serve chiedere conferma
          const ctx = __buildDayMonthConfirmFromText(rawIn, new Date());
          if (ctx) {
            state.context.dayMonthConfirm = ctx;
            pending.set(chatId, state);
            await reply(client, chatId, ctx.prompt, {
              noFooter: true
            });
            return "";
          }
        }
      } catch { }

      // Quick command: cambio trattamento durante il flow
      if (/\b(?:cambia|modifica)\s+(?:il\s+)?(?:trattament\w*|serviz\w*)\b/i.test(userInput)) {
        // reset servizio e torna alla lista
        col.service = null;
        state.context = state.context || {};
        state.context.preferredService = null;

        // calcola lista servizi rispettando eventuale professionista scelto
        if (!col.professionalName && !col.professionalEmail && typeof col.professionalAny !== 'boolean') col.professionalAny = true;
        let proEmail = null;
        if (!col.professionalAny) {
          proEmail = col.professionalEmail || (typeof proEmailByName === 'function' ? proEmailByName(col.professionalName) : null);
          col.professionalEmail = proEmail;
        }

        const {
          available,
          msg: svcMsg
        } = buildServicesMessageForPro(proEmail);
        col.serviceOptions = available;
        col.svcOptions = available;
        ensureUI(state);
        state.ui.lastServiceList = available;
        state.step = 'choose_service';
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg, {
          noFooter: true
        });
        return '';
      }

      // Nota UX: permettiamo di scegliere giorno/orario anche prima del nome.
      // Il nome verrà comunque richiesto esplicitamente prima della conferma finale.

      if (__dateParsingLocks.has(chatId)) {
        log('warn', '[CHOOSE_DAY] Parsing già in corso, ignoro', {
          chatId
        });
        return "";
      }

      if (!userInput || userInput.length < 2) {
        await reply(client, chatId, `Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23 ottobre", "28 ottobre")`);
        return "";
      }

      // Parsing della data (con auto-scelta se l'utente delega: "dimmi tu", "quando preferisci", ...)
      __dateParsingLocks.add(chatId);
      let parsedDate = null;
      let precomputedSlots = null;

      try {
        // Se l'utente delega la scelta del giorno, prova a selezionare automaticamente il primo giorno con disponibilità
        const delegationPatterns = [
          // 1. DELEGA DIRETTA ("dimmi tu", "scegli tu", "decidi tu")
          /\b(dimmi|fai|scegli|decidi|vedi|pensa|proponi|suggerisci|indica|organizza|sistema|arrangia(?:ti)?|gestisci|trova)\s+tu\b/i,

          // 2. PREFERENZE DELL'OPERATORE ("come vuoi", "come preferisci")
          /\bcome\s+(vuoi|preferisci|ti\s+(?:pare|sembra|va|piace|conviene)|meglio\s+(?:credi|pensi|ritieni)|preferisce|vuole|ritieni|pensi|credi|ti\s+(?:è|e)\s+(?:più\s+)?comodo|vi\s+(?:pare|sembra|va|conviene))\b/i,

          // 3. QUANDO VUOI/PUOI/PREFERISCI
          /\bquando\s+(vuoi|preferisci|puoi|riesci|preferisce|vuole|[èeé]\s+disponibile|(?:ti\s+|vi\s+)?(?:[èeé]|e)\s+(?:più\s+)?comodo|(?:ti\s+|vi\s+)?(?:va|conviene)\s+(?:meglio|bene)|hai\s+(?:un\s+)?(?:posto|buco|slot)|avete\s+(?:un\s+)?(?:posto|buco|slot)|siete\s+liber[ie])\b/i,

          // 4. QUANDO TI/LE FA COMODO
          /\bquando\s+(ti|le|vi)\s+((?:[èeé]|e)\s+comodo|fa\s+comodo|(?:va|viene)\s+(?:meglio|bene)|conviene)\b/i,

          // 5. QUANDO HAI TEMPO/POSTO/DISPONIBILITÀ
          /\bquando\s+(hai|avete|c['']?(?:[èeé]|e)|ci\s+(?:[èeé]|e|sono))\s+(tempo|posto|posti|buco|buchi|slot|disponibilit[aàá]|un\s+(?:posto|buco|slot)|dei\s+posti|qualche\s+(?:posto|buco))\b/i,

          // 6. VA BENE TUTTO / QUALSIASI / QUALUNQUE
          /\b(va\s+bene|vanno\s+bene|[èeé]\s+(?:uguale|lo\s+stesso|indifferente)|qualsiasi|qualunque|(?:non\s+)?importa|fa\s+(?:lo\s+stesso|uguale))\s+(tutto|quando|giorno|giorni|data|date|orario|orari|momento|cosa|slot)\b/i,

          // 7. VA BENE QUALSIASI (forma invertita)
          /\b(qualsiasi|qualunque|ogni|tutti\s+(?:i|gli)|tutte\s+le)\s+(giorno|data|orario|momento|slot)\s+(va\s+bene|vanno\s+bene|[èeé]\s+(?:ok|buon[oa])|mi\s+(?:va|and[aà])\s+bene)\b/i,

          // 8. PRIMO/PRIMA DISPONIBILE
          /\b(prim[oaie]|prima)\s+(disponibile|liber[oaie]|posto|data|slot|orario|buco|(?:che|che\s+c[''](?:[èeé]|e))\s+(?:c[''](?:[èeé]|e)|trovi|hai|avete))\b/i,

          // 9. APPENA/PRIMA POSSIBILE
          /\b(appena|prima|quanto\s+prima|al\s+più\s+presto|il\s+prima)\s+possibile\b/i,

          // 10. SECONDO DISPONIBILITÀ / A DISCREZIONE
          /\b(secondo|in\s+base\s+(?:a|alla)|sulla\s+base\s+(?:di|della)|a)\s+(disponibilit[aàá]|discrezion[ee]|tue\s+esigenze|vostre\s+esigenze|vostra\s+(?:agenda|disponibilit[aàá])|tua\s+(?:agenda|disponibilit[aàá]))\b/i,

          // 11. DIMMI/PROPONIMI/SUGGERISCI + QUANDO/ORARIO/DATA
          /\b(dimmi|proponimi|suggerisci|indica(?:mi)?|consiglia(?:mi)?|proporr[eei]|suggerir[eei]|di['']?\s*(?:mi|a\s+me)|fammi\s+sapere)\s+(quando|un\s+(?:orario|giorno|momento)|una\s+data|(?:un|dei|degli|delle)\s+(?:orari|giorni|date|momenti|slot)|(?:il|la)\s+(?:giorno|data|orario|momento)|cosa\s+(?:[èeé]|e)\s+(?:meglio|disponibile))\b/i,

          // 12. NON HO PREFERENZE / NON IMPORTA QUANDO
          /\bnon\s+(ho\s+(?:preferenze|esigenze\s+particolari|problemi|vincoli)|importa\s+(?:quando|il\s+giorno|l['']orario|quale\s+(?:giorno|orario|data))|mi\s+(?:importa|cambia)|fa\s+differenza|c[''](?:[èeé]|e)\s+(?:problema|differenza))\b/i,

          // 13. INDIFFERENTE / MI ADATTO / FLESSIBILE
          /\b(indifferente|mi\s+(?:adatto|adeguo|regolo)|ci\s+(?:adattiamo|adeguiamo|regoliamo)|(?:sono|siamo)\s+flessibil[ie]|flessibilit[aàá]\s+(?:totale|completa|massima)|nessun[ao]?\s+(?:problema|preferenza|vincolo)|va\s+(?:tutto\s+)?bene|(?:non|senza)\s+problemi)\b/i,

          // 14. COME MEGLIO PER TE/VOI
          /\b(come|quando|quello\s+che)\s+(?:[èeé]\s+)?(?:meglio|più\s+comodo)\s+per\s+(?:te|voi|lei|il\s+salone|l['']operatric[ee])\b/i,

          // 15. AFFIDATI A TE/VOI
          /\b(mi\s+affido|ci\s+affidiamo|affidati|(?:mi|ci)\s+fid[oi]|lasci[oa]\s+(?:fare|decidere|scegliere)\s+a\s+(?:te|voi|lei)|rimetto\s+a\s+(?:te|voi|lei))\b/i,

          // 16. TU SAI MEGLIO / VOI SAPETE MEGLIO
          /\b(tu|voi|lei)\s+(sai|sapete|sa|conosci|conoscete|conosce)\s+(meglio|(?:di|più)\s+(?:me|noi)|cosa\s+(?:[èeé]|e)\s+meglio|come\s+organizzare|(?:la|le)\s+(?:tue|vostre|sue)\s+(?:esigenze|disponibilit[aàá]|agenda))\b/i,

          // 17. DECIDI TU / SCEGLI TU (forma imperativa pura)
          /^(?:decidi(?:\s+tu)?|scegli(?:\s+tu)?|vedi(?:\s+tu)?|organizza(?:\s+tu)?|fai(?:\s+tu)?|pensa(?:\s+tu)?|sistema(?:\s+tu)?)\s*[!.?]?\s*$/i,

          // 18. QUANDO CAPITA / QUANDO C'È POSTO
          /\bquando\s+(capita|c[''](?:[èeé]|e)\s+(?:posto|un\s+buco|disponibilit[aàá])|si\s+(?:libera|apre)\s+un\s+(?:posto|buco|slot)|(?:hai|avete)\s+(?:un\s+)?(?:buco|momento|spazio))\b/i,

          // 19. NON HO VINCOLI / NESSUN VINCOLO
          /\b((?:non|senza)\s+(?:vincoli|limiti|restrizioni|problemi\s+di\s+(?:orario|giorni))|nessun\s+(?:vincolo|limite|restrizione|problema))\b/i,

          // 20. COME TI/VI PARE / COME TI/VI TORNA
          /\bcome\s+(ti|vi|le)\s+(pare|sembra|torna|(?:va|viene)\s+(?:meglio|bene)|(?:[èeé]|e)\s+(?:più\s+)?comodo)\b/i,

          // 21. L'IMPORTANTE È / BASTA CHE
          /\b(l['']important[ee]\s+(?:[èeé]|e)|basta\s+che|purch[eéè]|l['']essential[ee]\s+(?:[èeé]|e))\s+((?:ci\s+)?sia|(?:ci\s+)?siano|si\s+(?:faccia|riesca)|venga\s+(?:fatto|fatta)|si\s+possa\s+(?:fare|venire))\b/i,

          // 22. VA BENE QUANDO VUOI/PUOI (forma completa)
          /\b(va\s+bene|[èeé]\s+ok|perfetto|d['']accordo)\s+quando\s+(vuoi|puoi|preferisci|riesci|(?:ti|vi|le)\s+(?:va|conviene|[èeé]\s+comodo))\b/i,

          // 23. TOTALE FLESSIBILITÀ / MASSIMA DISPONIBILITÀ
          /\b(totale|completa|massima|piena|assoluta)\s+(flessibilit[aàá]|disponibilit[aàá]|apertura)\b/i,

          // 24. NON HO IMPEGNI / SONO LIBERO
          /\b(non\s+ho|non\s+abbiamo|non\s+ci\s+sono)\s+(impegni|vincoli|(?:altri\s+)?appuntamenti|cose\s+particolari)\b/i,

          // 25. SONO LIBERO / SIAMO LIBERI (generico)
          /\b((?:sono|siamo)\s+liber[oiae]|ho\s+tempo|abbiamo\s+tempo)(?:\s+(?:(?:tutto|tutti)\s+(?:il\s+giorno|i\s+giorni)|sempre|praticamente\s+sempre|quasi\s+sempre))?\b/i,

          // 26. QUANDO VUOI / QUANDO VOLETE (standalone)
          /^quando\s+(vuoi|volete|preferisci|preferite|ti\s+(?:va|pare)|vi\s+(?:va|pare))\s*[!.?]?\s*$/i,

          // 27. COME VUOI / COME VOLETE (standalone)
          /^come\s+(vuoi|volete|preferisci|preferite|ti\s+(?:va|pare)|vi\s+(?:va|pare)|meglio\s+(?:credi|credete))\s*[!.?]?\s*$/i,

          // 28. OK PER ME QUALSIASI COSA
          /\b(ok|va\s+bene|perfetto|d['']accordo)\s+per\s+me\s+(qualsiasi\s+(?:cosa|giorno|orario)|tutto|sempre)\b/i,

          // 29. VARIANTI CON "CE" (senza apostrofo)
          /\bquando\s+ce\s+(posto|posti|disponibilit[aàá]|un\s+buco)\b/i,

          // 30. MI VA BENE / CI VA BENE + TUTTO/QUALSIASI
          /\b(mi|ci|ti|vi)\s+va\s+bene\s+(tutto|qualsiasi\s+(?:cosa|giorno|orario|momento)|quando\s+(?:vuoi|volete))\b/i,

          // 31. FAI/FATE/FACCIA COME CREDI / COME RITIENI (carta libera)
          /\b(?:fai|fate|faccia)\s+come\s+(?:credi|ritieni|preferisci|ti\s+pare)\b/i,

          // 32. A (TUA/VOSTRA/SUA) SCELTA / A SCELTA (TUA/VOSTRA/SUA)
          /\b(?:a|alla)\s+(?:tua|vostra|sua)\s+scelta\b/i,
          /\ba\s+scelta\s+(?:tua|vostra|sua)\b/i,

          // 33. CARTA BIANCA (anche “ti lascio carta bianca”)
          /\b(?:ti\s+|vi\s+)?(?:lascio|do|d[oò])\s+carta\s+bianca\b/i,
          /\bcarta\s+bianca\b/i,

          // 34. METTI/FISSA/PRENOTA NEL PRIMO BUCO / PRIMO SPAZIO
          /\b(?:metti|fissa|prenota|piazza)\s+(?:pure\s+)?(?:nel|al)\s+(?:primo|prima)\s+(?:buco|spazio|slot|posto)\b/i,
          /\bnel\s+(?:primo|prima)\s+(?:buco|spazio|slot|posto)\s+(?:che\s+trovi|che\s+c['’]?(?:è|e))\b/i,

          // 35. APPENA TROVI POSTO / APPENA SI LIBERA (varianti più “parlate”)
          /\bappena\s+(?:trovi|trovate|ha[iy]|avete)\s+(?:un\s+)?(?:posto|buco|slot|spazio)\b/i,
          /\bappena\s+si\s+(?:libera|apre)\s+(?:un\s+)?(?:posto|buco|slot|spazio)\b/i,

          // 36. QUANDO TI/VI È PIÙ FACILE/SEMPLICE / QUANDO RIESCI (senza “quando vuoi”)
          /\bquando\s+(?:ti|vi|le)\s+(?:[èeé]|e)\s+pi[uù]\s+(?:facile|semplice|comodo)\b/i,
          /\bquando\s+(?:ti|vi|le)\s+(?:riesce|riesci|riuscite)\s+(?:meglio|bene)\b/i,

          // 37. IN QUALSIASI FASCIA ORARIA / QUALUNQUE MOMENTO DELLA GIORNATA
          /\b(?:in|a)\s+(?:qualsiasi|qualunque)\s+(?:fascia\s+oraria|momento\s+della\s+giornata|orario|momento)\b/i,
          /\b(?:mattina|pomeriggio|sera)\s+indifferente\b/i,

          // 38. NON HO FRETTA / SENZA FRETTA (delegazione “soft”)
          /\b(?:non\s+ho\s+fretta|nessuna\s+fretta|senza\s+fretta|con\s+calma)\b/i,

          // 39. UNO/UNA QUALSIASI (orario/giorno/data/slot)
          /\b(?:uno|una)\s+(?:qualsiasi|qualunque)\s+(?:orario|giorno|data|slot|momento)\b/i,

          // 40. BOH/MAH + SCEGLI/DECIDI TU (messaggistica informale)
          /\b(?:boh|mah|non\s+so)\s*,?\s*(?:scegli|decidi|fai)\s+tu\b/i,

          // 41. DECIDA/SCELGA LEI (formale)
          /\b(?:decida|scelga|veda)\s+lei\b/i,

          // 42. ABBREVIAZIONI “X ME” / “PER ME” + OK/TUTTO/QUALSIASI
          /\b(?:x|per)\s+me\s+(?:ok|va\s+bene|perfetto)\s*(?:tutto|qualsiasi)?\b/i,
        ];

        const isDelegated = delegationPatterns.some(pattern => pattern.test(userInput));

        if (isDelegated && col?.service) {
          const hasOggi = /\boggi\b/i.test(userInput) && !/\bnon\s+oggi\b/i.test(userInput);
          const hasDomani = /\bdomani\b/i.test(userInput) && !/\bnon\s+domani\b/i.test(userInput);

          const candidates = [];

          // Base di ricerca: rispetta eventuale preferenza "settimana prossima / tra N settimane"
          const weekOffset = Number.isInteger(state?.context?.weekOffset) ? state.context.weekOffset : null;
          const relToday = /\b(oggi|domani|dopodomani|dopo\s+domani)\b/i.test(userInput);

          const base = (() => {
            const d = new Date();
            d.setHours(12, 0, 0, 0);

            if (!relToday && weekOffset && weekOffset > 0) {
              const day = d.getDay(); // 0=dom, 1=lun...
              const diff = (day === 0 ? -6 : 1) - day; // lunedì settimana corrente
              d.setDate(d.getDate() + diff + weekOffset * 7);
              d.setHours(12, 0, 0, 0);
            }
            return d;
          })();

          // Caso tipico: "oggi o domani, dimmi tu"
          if (hasOggi) candidates.push(new Date(base));
          if (hasDomani) {
            const d = new Date(base);
            d.setDate(d.getDate() + 1);
            d.setHours(12, 0, 0, 0);
            candidates.push(d);
          }

          // Se non sono stati citati giorni specifici, prova "appena possibile" (fino a 14 giorni)
          if (!candidates.length) {
            for (let i = 0; i < 14; i++) {
              const d = new Date(base);
              d.setDate(d.getDate() + i);
              d.setHours(12, 0, 0, 0);
              candidates.push(d);
            }
          }

          const durationAuto = typeof cfgServiceDuration === "function" ? cfgServiceDuration(col.service) || 30 : 30;
          const professionalAuto = col.professionalAny ? null : col.professionalEmail || col.professionalName || null;

          for (const candDay of candidates) {
            if (typeof cfgClosedDay === "function" && cfgClosedDay(candDay)) continue;

            const raw = await fetchSlots({
              service: col.service,
              day: candDay,
              duration: durationAuto,
              professional: professionalAuto,
              wantDetail: true,
            });

            let slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(raw) : raw) || [];

            // Se oggi, elimina orari passati
            try {
              if (typeof filterOutPastTimesForToday === "function" && slots.length) {
                const allowed = filterOutPastTimesForToday(candDay, slots.map((x) => x.time));
                const set = new Set(allowed);
                slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
              }
            } catch (err) {
              log("warn", "[CATCH] Errore ignorato", {
                error: String(err)
              }); //  FIX Bug #17
            }

            if (slots.length) {
              parsedDate = candDay;
              precomputedSlots = slots;
              break;
            }
          }
        }

        if (!parsedDate) {
          const weekOffset = Number.isInteger(state?.context?.weekOffset) ? state.context.weekOffset : null;
          const relToday = /\b(oggi|domani|dopodomani|dopo\s+domani)\b/i.test(userInput);

          const baseForWeek = (!relToday && weekOffset && weekOffset > 0 && !/\b(?:tra|fra)\s+\d{1,2}\s+settimane?\b/i.test(userInput)) ?
            (() => {
              const d0 = new Date();
              d0.setHours(12, 0, 0, 0);
              const day = d0.getDay();
              const diff = (day === 0 ? -6 : 1) - day; // lunedì corrente
              d0.setDate(d0.getDate() + diff + weekOffset * 7);
              d0.setHours(12, 0, 0, 0);
              return d0;
            })() :
            null;

          parsedDate = safeParseDateWithLock(chatId, userInput, baseForWeek);
        }
      } finally {
        __dateParsingLocks.delete(chatId);
      }

      if (!parsedDate || isNaN(parsedDate.getTime())) {
        // Se l'utente ha scritto un TRATTAMENTO invece di una data (es. "refill gel mani"),
        // aggiorna il servizio e richiedi di nuovo il giorno.
        let maybeSvc = null;
        try {
          maybeSvc = (typeof resolveServiceFromText === "function" ? resolveServiceFromText(userInput) : null) || null;
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }
        if (maybeSvc) {
          col.service = maybeSvc;
          col.when = null;
          col.time = null;
          col.options = null;
          state.step = "choose_day";
          pending.set(chatId, state);
          await reply(client, chatId, `Perfetto! Ho impostato il trattamento: *${maybeSvc}*.\nOra dimmi che giorno preferisci (es. "domani", "23 ottobre").`);
          return "";
        }

        await reply(client, chatId, ` Non ho capito la data.
Prova a scrivere per esempio: *"domani"*, *"lunedì"* oppure una data, tipo: "*15 dicembre*". Se non sai cosa scegliere scrivi: *"scegli tu"* e ti scegliero la prima data disponibile.`);
        return "";
      }

      const day = typeof atNoon === "function" ? atNoon(parsedDate) : parsedDate;

      // Blocca date nel passato
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dayCheck = new Date(day);
      dayCheck.setHours(0, 0, 0, 0);

      if (dayCheck < today) {
        await reply(client, chatId, ` Quella data è già passata. Scegli una data futura (es. "domani" o "12 dicembre").`);
        return "";
      }

      // Verifica giorno chiuso
      if (typeof cfgClosedDay === "function" && cfgClosedDay(day)) {
        const dayStr = typeof formatDateWithWeekdayIT === "function" ?
          formatDateWithWeekdayIT(day) :
          day.toLocaleDateString();
        await reply(client, chatId, `Il giorno ${dayStr} siamo chiusi. Dimmi un altro giorno.`);
        return "";
      }

      col.when = day;

      // Se nello stesso messaggio c'era anche un orario ("... alle 16"), memorizzalo
      try {
        const pref =
          (typeof parseTimeSmart === "function" ? parseTimeSmart(userInput) : null) ||
          (typeof parseHHMM === "function" ? parseHHMM(userInput) : null);
        if (pref) col._preferredTime = pref;
      } catch { }

      // Recupera slot disponibili
      const duration = typeof cfgServiceDuration === "function" ? cfgServiceDuration(col.service) || 30 : 30;
      const professional = col.professionalAny ? null : col.professionalEmail || col.professionalName || null;

      let slots = precomputedSlots;

      if (!Array.isArray(slots) || !slots.length) {
        const rawList = await fetchSlots({
          service: col.service,
          day: day,
          duration,
          professional,
          wantDetail: true,
        });

        slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];
      }

      // Se oggi, elimina orari passati (coerente anche quando non si usa l'auto-scelta)
      try {
        if (typeof filterOutPastTimesForToday === "function" && slots.length) {
          const allowed = filterOutPastTimesForToday(day, slots.map((x) => x.time));
          const set = new Set(allowed);
          slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      if (!slots.length) {
        const dayStr = typeof formatDateWithWeekdayIT === "function" ?
          formatDateWithWeekdayIT(day) :
          day.toLocaleDateString();

        col.when = null;
        state.step = "choose_day";
        await reply(client, chatId, `Nessun orario libero per ${dayStr}
Vuoi provare un altro giorno?`);
        return "";
      }

      col.options = slots;

      // Fast-path: se l'orario richiesto è disponibile, selezionalo e prosegui
      if (col._preferredTime && /^\d{2}:\d{2}$/.test(col._preferredTime)) {
        const wanted = col._preferredTime;
        const okSlot = slots.find((s) => s && s.time === wanted);
        if (okSlot) {
          col.time = wanted;
          state.step = "pick_time";
          pending.set(chatId, state);

          if (typeof scheduleReenter === "function") {
            await scheduleReenter(client, chatId, `ok ${wanted}`, tools);
            return "";
          }
        }
      }

      state.step = "pick_time"; // options dovrebbero essere già settate;

      ensureContext(state);
      state.context.availOffset = 0;
      state.context.availFilterPart = null;

      const msgOut = buildAvailabilityCompactMessage(day, slots, {
        offset: 0,
        pageSize: AVAIL_PAGE_SIZE
      });

      pending.set(chatId, state);
      await reply(client, chatId, msgOut);
      pending.set(chatId, state);
      return "";
    }

    const isEditStep = typeof state.step === "string" && state.step.startsWith("edit_");
    const editTextSteps = state.step === "edit_reschedule_date" || state.step === "edit_change_name";

    if (isEditStep && !editTextSteps) {
      return await handleNumericReply(client, chatId, text, tools);
    }

    // ============================================================================
    // SEZIONE 16: STEP 4 - SCELTA ORARIO
    // ============================================================================
    if (
      state.step === "pick_time" &&
      (!col.time || state.step === "pick_time") &&
      !(typeof state.step === "string" && state.step.startsWith("edit_"))
    ) {
      state.step = "pick_time";

      // Nota UX: permettiamo di scegliere l'orario anche prima del nome.
      // Il nome verrà comunque richiesto esplicitamente prima della conferma finale.

      // Guard: se manca il giorno o gli slot, torna a chiedere la data
      if (!col.when || !Array.isArray(col.options) || !col.options.length) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23 ottobre", "28 ottobre")`
        );
        return "";
      }

      // Safety: stato incoerente → riparti dal punto giusto (evita "Disponibilità per :" vuoto)
      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, "Perfetto! Dimmi che trattamento vuoi prenotare ");
        return "";
      }
      if (!col.when || !Array.isArray(col.options) || col.options.length === 0) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Che giorno preferisci? (es. "domani", "lunedì prossimo", "23 ottobre")');
        return "";
      }

      const renderSlotsList = () => {
        return (col.options || [])
          .map((slot) => {
            const prosNames = slot.pros && slot.pros.length ? ` (${slot.pros.map((p) => p.name).join(", ")})` : "";
            return `• ${slot.time}${prosNames}`;
          })
          .join("\n");
      };

      const hhmmToMin = (s) => {
        const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        return +m[1] * 60 + +m[2];
      };

      const cleanedForTime = String(msg || "")
        .replace(/\b(verso|intorno|circa|per\s+le|alle|ore)\b/gi, " ")
        .replace(/[^\d:\.\s]/g, " ")
        .trim();
      const tryParseTime = () =>
        (typeof parseTimeSmart === "function" ? parseTimeSmart(cleanedForTime) : null) ||
        (typeof parseHHMM === "function" ? parseHHMM(cleanedForTime) : null);

      const resolveEmailByName = (nm) => {
        const tryMap = typeof proEmailByName === "function" ? proEmailByName(nm) : null;
        if (tryMap) return tryMap;

        const profEntry = Object.entries((config?.professionals || {})).find(([email, p]) => {
          const a = typeof simpleNorm === "function" ? simpleNorm(p?.name || "") : String(p?.name || "").toLowerCase();
          const b = typeof simpleNorm === "function" ? simpleNorm(nm) : String(nm || "").toLowerCase();
          return a === b;
        });
        return profEntry ? profEntry[0] : null;
      };

      const anyRe = /\b(chiunque|qualsiasi|va\s*bene\s*chiunque|non\s*mi\s*interessa)\b/i;

      const extractProFromText = (raw, preferredList) => {
        try {
          const txtN = typeof simpleNorm === "function" ? simpleNorm(raw) : String(raw || "").toLowerCase();

          const scan = (arr) => {
            for (const p of arr) {
              const nm = typeof simpleNorm === "function" ? simpleNorm(p?.name || "") : String(p?.name || "").toLowerCase();
              if (!nm) continue;
              if ((" " + txtN + " ").includes(" " + nm + " ")) return p;
            }
            return null;
          };

          if (preferredList && preferredList.length) {
            const hit = scan(preferredList);
            if (hit) return hit;
          }

          const pros = (
            typeof cfgServiceProfessionals === "function" ?
              cfgServiceProfessionals(col.service) || [] : []
          )
            .map((p) => (typeof p === "string" ? {
              name: p,
              email: p
            } : p))
            .filter((p) => p && p.name);

          return scan(pros);
        } catch {
          return null;
        }
      };

      // Carica slot se non ci sono
      if ((!col.options || !col.options.length) && col.when && col.service) {
        const professional = col.professionalAny ? null : (col.professionalEmail || null);
        const duration = (typeof getDurForPro === "function") ?
          getDurForPro(col.service, professional) :
          ((typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

        const list = await fetchSlots({
          service: col.service,
          day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
          duration,
          professional,
          wantDetail: true,
        });

        const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(list) : list) || [];
        col.options = Array.isArray(slots) ? slots : [];

        if (!col.options.length) {
          const dayStr = typeof fmtDateWithWeekdayIT === "function" ?
            fmtDateWithWeekdayIT(col.when) :
            (typeof fmtDate === "function" ? fmtDate(col.when) : col.when?.toLocaleDateString?.() || "");
          col.when = null;
          state.step = "choose_day";
          await reply(
            client,
            chatId,
            `Nessun orario libero per ${dayStr}
Vuoi provare un altro giorno?`
          );
          pending.set(chatId, state);
          return "";
        }
      }

      // Gestione cambio giorno durante pick_time
      const rawMsg = String(msg || "");
      const daySwitchHint =
        /\b(oggi|domani|dopodomani|tra|fra|settimana|prossim|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|\d{1,2}\s*[\/\-]\s*\d{1,2}|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/i;

      async function tryHandleDaySwitch(text) {
        const _daySwitchText = String(text || "");
        const _daySwitchLower = _daySwitchText.toLowerCase();

        // Se sembra un ORARIO (es. 12.30), non interpretarlo come data
        if (/(?:^|\b)(?:alle\s*)?(?:[01]?\d|2[0-3])\s*[:.]\s*[0-5]\d\b/.test(_daySwitchLower)) return false;

        // Richiesta generica di cambiare giorno senza specificare la data
        // (NB: "quando riesci/puoi" qui viene trattato come delega dell'ORARIO, non come cambio giorno)
        if (
          /\b(un'?altr[oa]|altro)\s+(giorn\w*|data)\b/.test(_daySwitchLower) ||
          /\bnon\s+posso\b/.test(_daySwitchLower)
        ) {
          state.step = "choose_day";
          pending.set(chatId, state);
          await reply(
            client,
            chatId,
            'Ok  Dimmi che giorno preferisci (es. "domani", "sabato", "10 gennaio").'
          );
          return true;
        }

        const _hasDayNumberCue =
          /\b(?:il|giorno|data|per\s+il)\s+\d{1,2}(?:\s*(?:°|º))?\b/i.test(_daySwitchText);
        if (!_hasDayNumberCue && !daySwitchHint.test(_daySwitchText)) return false;

        let parsedSwitch =
          (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, text) : null) ||
          (typeof parseNaturalDate === "function" ? parseNaturalDate(text) : null) ||
          null;

        // Supporto extra: frasi tipo "hai posto il 21" / "per il 22"
        if (!parsedSwitch) {
          const mDay = String(text || "").match(/\b(?:il|giorno|data|per\s+il)\s+(\d{1,2})(?:\s*(?:°|º))?\b/i);
          if (mDay) {
            const probe = `il ${mDay[1]}`;
            parsedSwitch =
              (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, probe) : null) ||
              (typeof parseNaturalDate === "function" ? parseNaturalDate(probe) : null) ||
              null;
          }
        }

        if (!parsedSwitch) return false;

        let newDay = parsedSwitch;
        if (!(newDay instanceof Date)) {
          try {
            newDay = new Date(parsedSwitch);
          } catch {
            newDay = null;
          }
        }
        if (!newDay || isNaN(newDay.getTime())) return false;

        const dayAtNoon =
          typeof atNoon === "function" ? atNoon(newDay) : new Date(newDay.getFullYear(), newDay.getMonth(), newDay.getDate(), 12, 0, 0, 0);

        if (typeof isPast === "function" && isPast(dayAtNoon)) {
          const formatted = typeof formatDateWithWeekdayIT === "function" ?
            formatDateWithWeekdayIT(dayAtNoon) :
            (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());
          await reply(client, chatId, `La data ${formatted} è nel passato. Scrivi un'altra data valida (es. "domani", "12 dicembre").`);
          pending.set(chatId, state);
          return true;
        }

        if (typeof cfgClosedDay === "function" && cfgClosedDay(dayAtNoon)) {
          const dayStrClosed =
            typeof formatDateWithWeekdayIT === "function" ?
              formatDateWithWeekdayIT(dayAtNoon) :
              (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());
          await reply(client, chatId, `Il giorno ${dayStrClosed} siamo chiusi. Dimmi un altro giorno (es. "domani", "sabato", "12 dicembre").`);
          pending.set(chatId, state);
          return true;
        }

        const professional = col.professionalAny ? null : (col.professionalEmail || null);
        const duration = (typeof getDurForPro === "function") ?
          getDurForPro(col.service, professional) :
          ((typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

        const rawList = await fetchSlots({
          service: col.service,
          day: typeof atNoon === "function" ? atNoon(dayAtNoon) : dayAtNoon,
          duration,
          professional,
          wantDetail: true,
        });

        const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

        if (!slots.length) {
          const dayStr =
            typeof formatDateWithWeekdayIT === "function" ?
              formatDateWithWeekdayIT(dayAtNoon) :
              (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());
          await reply(client, chatId, `Non ci sono orari liberi per ${dayStr}. Dimmi un altro giorno (es. "domani", "sabato", "12 dicembre").`);
          pending.set(chatId, state);
          return true;
        }

        col.when = dayAtNoon;
        col.options = Array.isArray(slots) ? slots : [];
        col.time = null;
        state.step = "pick_time";
        pending.set(chatId, state);

        const dayStr =
          typeof formatDateWithWeekdayIT === "function" ?
            formatDateWithWeekdayIT(col.when) :
            (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());

        ensureContext(state);
        state.context.availOffset = 0;
        state.context.availFilterPart = null;

        const msgOut = buildAvailabilityCompactMessage(col.when, col.options, {
          offset: 0,
          pageSize: AVAIL_PAGE_SIZE
        });

        pending.set(chatId, state);
        await reply(client, chatId, msgOut);

        return true;
      }

      const handledDaySwitch = await tryHandleDaySwitch(rawMsg);
      if (handledDaySwitch) return "";

      // Comandi rapidi sugli orari (max 5 per messaggio)
      if (/^\s*altri\s*$/i.test(rawMsg)) {
        ensureContext(state);
        const part = state.context.availFilterPart || null;
        const list = part ? filterSlotsByDaypart(col.options, part) : col.options;
        const items = uniqueTimesFromSlots(list);

        const cur = Math.max(0, Number(state.context.availOffset || 0) || 0);
        const next = (cur + AVAIL_PAGE_SIZE >= items.length) ? 0 : (cur + AVAIL_PAGE_SIZE);

        state.context.availOffset = next;
        pending.set(chatId, state);

        await reply(client, chatId, buildAvailabilityCompactMessage(col.when, list, {
          offset: next,
          pageSize: AVAIL_PAGE_SIZE
        }));
        return "";
      }

      const _mPart = rawMsg.trim().match(/^(mattina|pomeriggio|sera)$/i);
      if (_mPart) {
        ensureContext(state);
        state.context.availFilterPart = _mPart[1].toLowerCase();
        state.context.availOffset = 0;

        const list = filterSlotsByDaypart(col.options, state.context.availFilterPart);
        pending.set(chatId, state);

        await reply(client, chatId, buildAvailabilityCompactMessage(col.when, list, {
          offset: 0,
          pageSize: AVAIL_PAGE_SIZE
        }));
        return "";
      }

      // Se la fascia è dentro una frase (es. "quando vuoi tu, pomeriggio"), memorizzala comunque
      const __partHint = rawMsg.match(/\b(mattina|pomeriggio|sera)\b/i)?.[1]?.toLowerCase() || null;
      if (__partHint) {
        ensureContext(state);
        state.context.availFilterPart = __partHint;
      }

      // Parsing orario
      const isDelegatedTime = [

        /\b(dimmi|scegli|decidi|fai)\s+tu\b/i,
        /\bcome\s+(vuoi|preferisci|ti\s+pare|meglio\s+credi)\b/i,
        /\bquando\s+(?:vuoi|preferisci|puoi|riesci|sei\s+liber\w*|avrai\s+tempo)\b/i,
        /\b(primo|prima)\s+(orario|slot)\s+disponibile\b/i,
        /\b(appena|il\s+prima)\s+possibile\b/i,
      ].some((re) => re.test(rawMsg));

      // Supporta opzioni sia come stringhe ("10:00") sia come oggetti ({time:"10:00", pros:[...]})
      const __slotTime = (x) => (typeof x === "string" ? x : (x && x.time) ? x.time : null);

      let tParsed = null;

      // Conferma rapida dopo “Intendi 15:00?”
      ensureContext(state);
      if (state.context.pendingTimeConfirm) {
        const ans = String(msg || "").trim();
        if (/^(s[iì]|ok|va bene|certo|yes|y)\b/i.test(ans)) {
          tParsed = state.context.pendingTimeConfirm;
          state.context.pendingTimeConfirm = null;
        } else if (/^(no|n)\b/i.test(ans)) {
          state.context.pendingTimeConfirm = null;
        }
      }

      if (isDelegatedTime && Array.isArray(col.options) && col.options.length) {
        const part = state?.context?.availFilterPart || null;
        const baseList = part ? filterSlotsByDaypart(col.options, part) : col.options;
        const listForPick = (Array.isArray(baseList) && baseList.length) ? baseList : col.options;

        const sorted = [...listForPick].sort((a, b) => {

          const ta = __slotTime(a);
          const tb = __slotTime(b);
          return (hhmmToMin(ta) ?? 0) - (hhmmToMin(tb) ?? 0);
        });

        // Se la data è "oggi", scegli il primo slot NON nel passato (con un piccolo margine)
        const now = new Date();
        const day0 = (typeof atNoon === "function" && col.when) ? atNoon(col.when) : col.when;
        const isToday =
          day0 &&
          !isNaN(new Date(day0).getTime()) &&
          new Date(day0).toDateString() === now.toDateString();

        let picked = null;
        if (isToday) {
          const marginMs = 2 * 60 * 1000; // 2 minuti
          for (const s of sorted) {
            const hhmm = __slotTime(s);
            if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) continue;
            const d = new Date(day0);
            d.setHours(+hhmm.slice(0, 2), +hhmm.slice(3, 5), 0, 0);
            if (d.getTime() >= now.getTime() + marginMs) {
              picked = s;
              break;
            }
          }
        }

        tParsed = __slotTime(picked || sorted[0]) || null;
      } else {
        tParsed = tryParseTime();
      }

      if (!tParsed || !/^\d{2}:\d{2}$/.test(tParsed)) {
        log('warn', '[PICK_TIME] Orario non valido', {
          input: msg,
          parsed: tParsed
        });

        ensureContext(state);
        const part = state.context.availFilterPart || null;
        const list = part ? filterSlotsByDaypart(col.options, part) : col.options;
        const offset = Math.max(0, Number(state.context.availOffset || 0) || 0);
        const availMsg = buildAvailabilityCompactMessage(col.when, list, {
          offset,
          pageSize: AVAIL_PAGE_SIZE
        });

        await reply(client, chatId, `Non ho capito l'orario.\n${availMsg}`);
        pending.set(chatId, state);
        return "";
      }

      // Match esatto orario
      let chosenSlot = col.options.find((s) => __slotTime(s) === tParsed);

      if (!chosenSlot) {
        // 1) Disambiguazione 12h (es. "alle 3" -> potrebbe voler dire 15:00)
        try {
          const hh = parseInt(String(tParsed).slice(0, 2), 10);
          const mm = String(tParsed).slice(3, 5);
          if (Number.isFinite(hh) && hh >= 0 && hh <= 7) {
            const alt = String((hh + 12) % 24).padStart(2, "0") + ":" + mm;
            const altSlot = col.options.find((s) => __slotTime(s) === alt);
            if (altSlot) {
              ensureContext(state);
              state.context.pendingTimeConfirm = alt;

              await reply(
                client,
                chatId,
                `Intendi *${alt}*? \nRispondi *sì* (oppure scrivi *${alt}*). Se no, scegli un altro orario dalla lista.`, {
                noFooter: true
              }
              );
              pending.set(chatId, state);
              return "";
            }
          }
        } catch { }

        // 2) Niente snap silenzioso: proponi orari vicini e fai scegliere
        ensureContext(state);
        const part = state.context.availFilterPart || null;
        const list = part ? filterSlotsByDaypart(col.options, part) : col.options;

        const times =
          (typeof uniqueTimesFromSlots === "function") ?
            uniqueTimesFromSlots(list) :
            (list || []).map((s) => __slotTime(s)).filter(Boolean);

        const near = (typeof nearestTimes === "function") ?
          nearestTimes(times, tParsed, 3) : [];

        const availMsg = buildAvailabilityCompactMessage(col.when, list, {
          offset: 0,
          pageSize: AVAIL_PAGE_SIZE
        });

        if (near && near.length) {
          await reply(
            client,
            chatId,
            `Non abbiamo *${tParsed}* tra gli orari disponibili.\nOrari vicini:\n${near.map((t) => `• ${t}`).join("\n")}\n\nScrivi un orario (es. *${near[0]}*).\n\n${availMsg}`, {
            noFooter: true
          }
          );
        } else {
          await reply(client, chatId, `Orario non disponibile.\n${availMsg}`, {
            noFooter: true
          });
        }

        pending.set(chatId, state);
        return "";
      }

      col.time = __slotTime(chosenSlot);

      // Risoluzione professionista
      const ensureProFromSlot = async () => {
        const __pros =
          (chosenSlot && typeof chosenSlot === "object" && Array.isArray(chosenSlot.pros)) ?
            chosenSlot.pros : [];

        // Nessun professionista associato allo slot
        if (__pros.length === 0) return "none";

        // Se nello slot c'è un solo professionista, selezionalo automaticamente
        if (__pros.length === 1) {
          const only = __pros[0];
          col.professionalName = only.name;
          col.professionalEmail = only.email || resolveEmailByName(only.name) || null;
          col.professionalAny = false;
          return "one";
        }

        // Pro estratto dal testo (nome/sinonimi) tra quelli disponibili nello slot
        const pick = extractProFromText(msg, __pros);
        if (pick) {
          col.professionalName = pick.name;
          col.professionalEmail = pick.email || resolveEmailByName(pick.name) || null;
          col.professionalAny = false;
          return "one";
        }

        // L'utente dice "chiunque / non importa"
        if (anyRe.test(msg)) {
          col.professionalAny = true;
          col.professionalName = null;
          col.professionalEmail = null;
          return "any";
        }

        // Altrimenti chiedi quale preferisce
        col.proOptions = __pros.slice();
        state.step = "pick_professional_for_time";

        const prosList = __pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");

        await reply(
          client,
          chatId,
          `Chi preferisci alle ${__slotTime(chosenSlot)}?\n${prosList}\nRispondi con un numero (1-${__pros.length}).`
        );

        pending.set(chatId, state);
        return "ask";
      };

      const pickAutoProFromChosenSlot = async () => {
        const arr = (chosenSlot && Array.isArray(chosenSlot.pros)) ? chosenSlot.pros.filter(Boolean) : [];
        if (!arr.length) return false;

        // Preferisci un pro davvero libero per QUESTO orario, considerando eventuale durata specifica per pro
        const dayForCheck = (typeof atNoon === "function" && col.when) ? atNoon(col.when) : col.when;
        for (const p0 of arr) {
          const email0 = p0?.email || resolveEmailByName(p0?.name) || null;
          if (!email0) continue;
          let dur0 = null;
          try {
            dur0 = (typeof getDurForPro === "function") ? getDurForPro(col.service, email0) : null;
          } catch {
            dur0 = null;
          }
          const duration0 = (Number.isFinite(+dur0) && +dur0 > 0) ?
            +dur0 :
            ((typeof cfgServiceDuration === "function") ? (cfgServiceDuration(col.service) || 30) : 30);

          try {
            const times0 = await fetchSlots({
              service: col.service,
              day: dayForCheck,
              duration: duration0,
              professional: email0,
              wantDetail: false,
            });
            if (Array.isArray(times0) && times0.includes(chosenSlot.time)) {
              col.professionalName = p0?.name || proNameByEmail(email0) || email0;
              col.professionalEmail = email0;
              col._autoProEmail = email0; // interno
              col.professionalAny = true; // l’utente resta “Non mi interessa”
              return true;
            }
          } catch (err) {
            log("warn", "[CATCH] Errore ignorato", {
              error: String(err)
            }); //  FIX Bug #17
          }
        }

        // Fallback: primo pro della lista
        const p = arr[0];
        const email = p?.email || resolveEmailByName(p?.name) || null;
        col.professionalName = p?.name || (email ? (proNameByEmail(email) || email) : null) || null;
        col.professionalEmail = email;
        col._autoProEmail = email; // interno
        col.professionalAny = true; // l’utente resta “Non mi interessa”
        return !!email;
      };

      const pickRandomProFromChosenSlot = () => {
        const arr = (chosenSlot && Array.isArray(chosenSlot.pros)) ? chosenSlot.pros.filter(Boolean) : [];
        if (!arr.length) return false;

        // Deterministico: ordina per email/nome e prende il primo
        const sorted = arr.slice().sort((a, b) => {
          const ka = String(a?.email || a?.name || "").toLowerCase();
          const kb = String(b?.email || b?.name || "").toLowerCase();
          if (ka < kb) return -1;
          if (ka > kb) return 1;
          return 0;
        });

        const p = sorted[0];
        const email = p?.email || resolveEmailByName(p?.name) || null;

        col.professionalEmail = email;
        col.professionalName =
          p?.name ||
          (email ? (typeof proNameByEmail === "function" ? (proNameByEmail(email) || email) : email) : null) ||
          null;

        col._autoProEmail = email; // interno
        col.professionalAny = true; // l’utente resta “Non mi interessa”
        return !!email;
      };

      // Se l'utente ha già scelto "Non mi interessa", assegna automaticamente un pro tra quelli disponibili per quello slot
      if (col.professionalAny && !col.professionalEmail && !col.professionalName) {
        await pickAutoProFromChosenSlot();
      }

      if (!col.professionalEmail && !col.professionalName) {
        const mode = await ensureProFromSlot();
        if (mode === "ask") return "";
        // Se nel messaggio l'utente ha risposto "chiunque/qualsiasi", ora assegna random
        if (col.professionalAny && !col.professionalEmail && !col.professionalName) {
          await pickRandomProFromChosenSlot();
        }
      }

      // Safety: se è rimasto ANY e lo slot ha pro, assegna random
      if (col.professionalAny && !col.professionalEmail && !col.professionalName) {
        await pickRandomProFromChosenSlot();
      }

      // Prosegui al prossimo step (il nome va sempre richiesto esplicitamente, ma non duplicarlo)
      const __nameValidNow = !!state.context?.nameConfirmed &&
        col.customerName &&
        String(col.customerName).trim().split(/\s+/).filter(Boolean).length >= 2;

      if (!__nameValidNow) {
        state.step = "collect_name";
        ensureContext(state);
        state.context.awaitingName = true; //  chiediamo subito il nome
        state.context.nameConfirmed = false;
        pending.set(chatId, state);

        // IMPORTANTISSIMO: rispondi subito e NON usare "fai tu" come possibile nome
        await reply(
          client,
          chatId,
          'Perfetto  Per completare la prenotazione scrivi *nome e cognome* (es. "Maria Rossi").', {
          noFooter: true
        }
        );
        return "";
      } else {
        pending.set(chatId, state);
      }

    }

    // ============================================================================
    // SEZIONE 17: STEP 5 - RACCOLTA NOME
    // ============================================================================
    if (state.step === "collect_name") {
      const col = state.collected || (state.collected = {});
      const raw = String(msg || "").trim();

      const newName = (typeof extractCustomerName === "function" ? extractCustomerName(raw) : raw) || raw;

      if (!newName || String(newName).trim().split(/\s+/).filter(Boolean).length < 2) {
        ensureContext(state);
        state.context.awaitingName = true;
        state.context.nameConfirmed = false;
        state.step = "collect_name"; // resta qui finché non ricevo nome e cognome
        pending.set(chatId, state);

        await reply(
          client,
          chatId,
          'Per favore scrivi nome e cognome (es. "Maria Rossi") per completare la prenotazione.', {
          noFooter: true
        }
        );
        return "";
      }

      col.customerName = String(newName).trim();
      ensureContext(state);
      if (state.context) {
        state.context.awaitingName = false;
        state.context.nameConfirmed = true;
      }
      pending.set(chatId, state);
    }

    // ============================================================================
    // SEZIONE 18: STEP 6 - CREAZIONE FINALE EVENTO
    // ============================================================================
    col = state.collected || (state.collected = {});

    // Validazioni finali (fondamentali per il "messaggio unico" / intake)
    // Se l'utente manda già data+ora+servizio (e magari anche professionista), può saltare choose_day/pick_time:
    // qui blocchiamo SEMPRE date chiuse/fuori range/orari non disponibili prima di chiedere il nome o creare l'evento.
    const __isEditFlowNow = typeof state.step === "string" && state.step.startsWith("edit_");
    if (!__isEditFlowNow) {

      // Safety: senza trattamento non confermare mai la prenotazione
      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, "Prima dimmi che trattamento vuoi prenotare ", {
          noFooter: true
        });
        return "";
      }

      // 1) Data valida + non chiusa + in range
      if (col.when) {
        const dayAtNoon = (typeof atNoon === "function" ?
          atNoon(col.when) :
          (col.when instanceof Date ? col.when : new Date(col.when)));

        if (!dayAtNoon || isNaN(dayAtNoon.getTime())) {
          col.when = null;
          col.time = null;
          col.options = null;
          state.step = "choose_day";
          pending.set(chatId, state);
          await reply(client, chatId, ` Non ho capito la data.
Prova così: domani • lunedì • 15 dicembre`);
          return "";
        }

        // Range prenotazioni (default 120 giorni)
        try {
          const maxDays = 120;
          if (typeof validateDateInRange === "function" && !validateDateInRange(dayAtNoon, maxDays)) {
            const dayStr = typeof formatDateWithWeekdayIT === "function" ?
              formatDateWithWeekdayIT(dayAtNoon) :
              (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());

            col.when = null;
            col.time = null;
            col.options = null;
            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(client, chatId, ` La data ${dayStr} è troppo distante. Dimmi un altro giorno più vicino.`);
            return "";
          }
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }

        // Giorno chiuso (domenica/festivi/chiusure)
        try {
          if (typeof cfgClosedDay === "function" && cfgClosedDay(dayAtNoon)) {
            const dayStr = typeof formatDateWithWeekdayIT === "function" ?
              formatDateWithWeekdayIT(dayAtNoon) :
              (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());

            const next = (typeof nextOpenDay === "function" ? nextOpenDay(dayAtNoon) : null);
            const nextStr = next ?
              (typeof formatDateWithWeekdayIT === "function" ?
                formatDateWithWeekdayIT(next) :
                (typeof fmtDate === "function" ? fmtDate(next) : next.toLocaleDateString())) :
              null;

            col.when = null;
            col.time = null;
            col.options = null;
            state.step = "choose_day";
            pending.set(chatId, state);

            await reply(
              client,
              chatId,
              nextStr ?
                `Il giorno ${dayStr} siamo chiusi. Dimmi un altro giorno (es. "domani").\n Prossimo giorno utile: ${nextStr}.` :
                `Il giorno ${dayStr} siamo chiusi. Dimmi un altro giorno (es. "domani").`
            );
            return "";
          }
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }

        // Normalizza sempre a mezzogiorno
        col.when = dayAtNoon;
      }

      // 2) Se ho già anche l'orario, verifico che sia effettivamente uno slot valido
      if (col.service && col.when && col.time) {
        const hasOptions = Array.isArray(col.options) && col.options.length > 0;
        const timeAlreadyInOptions = hasOptions && col.options.some((s) => s && s.time === col.time);

        if (!timeAlreadyInOptions) {
          const proEmailTmp = col.professionalAny ?
            null :
            col.professionalEmail ||
            (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null) ||
            null;

          const durationTmp =
            (typeof getDurForPro === "function" ?
              getDurForPro(col.service, proEmailTmp) :
              (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

          let rawList = [];
          try {
            rawList = await fetchSlots({
              service: col.service,
              day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
              duration: durationTmp,
              professional: proEmailTmp, // null => qualsiasi pro
              wantDetail: true,
            });
          } catch (e) {
            log("error", "[FINAL_VALIDATE] fetchSlots failed", e?.stack || e?.message || e);
            rawList = [];
          }

          const slots =
            (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

          if (!slots.length) {
            const dayStr = typeof formatDateWithWeekdayIT === "function" ?
              formatDateWithWeekdayIT(col.when) :
              (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());

            col.when = null;
            col.time = null;
            col.options = null;
            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(client, chatId, `Spiacente, non abbiamo posto per ${dayStr}. Dimmi un altro giorno.`);
            return "";
          }

          const chosen = slots.find((s) => s && s.time === col.time) || null;

          // Se l'orario richiesto non esiste, proponi lista
          if (!chosen) {
            col.options = slots;
            col.time = null;
            state.step = "pick_time";
            pending.set(chatId, state);

            const dayStr = typeof formatDateWithWeekdayIT === "function" ?
              formatDateWithWeekdayIT(col.when) :
              (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());

            const lines = slots
              .map((s) => {
                const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
                return `• ${s.time}${prosNames}`;
              })
              .join("\n");

            await reply(
              client,
              chatId,
              ` ${dayStr} all'orario che hai richiesto siamo pieni.\n Questi sono gli orari liberi per tutta la giornata:\n${lines}\n\n Scrivi l'orario desiderato (es. "14:30").`
            );
            return "";
          }

          // Se era ANY e lo slot ha 1 pro, assegnalo; se più pro, chiedi
          if (col.professionalAny && !col.professionalEmail && !col.professionalName) {
            if (Array.isArray(chosen.pros) && chosen.pros.length === 1) {
              const only = chosen.pros[0];
              col.professionalName = only.name || null;
              col.professionalEmail =
                only.email ||
                (typeof proEmailByName === "function" ? proEmailByName(only.name) : null) ||
                null;
              col.professionalAny = false;
            } else if (Array.isArray(chosen.pros) && chosen.pros.length > 1) {
              col.proOptions = chosen.pros.slice();
              state.step = "pick_professional_for_time";
              pending.set(chatId, state);
              const list = chosen.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
              await reply(
                client,
                chatId,
                `Chi preferisci alle ${col.time}?\n${list}\nRispondi con un numero (1-${chosen.pros.length}).`
              );
              return "";
            }
          }

          col.options = slots;
        }
      }
    }

    // Validazione finale nome (va sempre richiesto esplicitamente nel flow)
    const nameValid = !!state.context?.nameConfirmed &&
      col.customerName &&
      String(col.customerName).trim().split(/\s+/).filter(Boolean).length >= 2;

    if (!nameValid) {
      const nameAttemptStart = state.context?.nameAttemptStart || 0;
      if (nameAttemptStart && (Date.now() - nameAttemptStart > 30000)) {
        log('warn', '[NAME] Timeout raccolta nome, uso fallback', {
          chatId
        });
        col.customerName = col.customerName || null; //  FIX Bug #10;
      } else {
        state.step = "collect_name";
        ensureContext(state);
        state.context.awaitingName = true;
        state.context.nameConfirmed = false;
        state.context.nameAttemptStart = state.context.nameAttemptStart || Date.now();
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          'Per favore scrivi nome e cognome (es. "Maria Rossi") per completare la prenotazione.', {
          noFooter: true
        }
        );
        return "";
      }
    }

    const attendeeName = String(col.customerName).trim();

    // Se siamo in edit flow, mostra menu
    if (typeof state.step === "string" && state.step.startsWith("edit_")) {
      const booking = state.edit?.target;
      if (booking) {
        await reply(client, chatId, showEditMenu(booking), {
          noFooter: true
        });
      } else {
        await reply(client, chatId, 'Sei nella modifica dell\'appuntamento. Scegli un\'opzione dal menu oppure scrivi \"annulla\".');
      }
      return "";
    }

    // Verifica che abbiamo tutti i dati necessari
    if (!col.service || !col.when || !col.time) {
      if (!col.service) {
        const hasPro = !!(col.professionalAny || col.professionalEmail || col.professionalName);

        if (!hasPro) {
          state.step = "pick_professional";
          const pros = getAllProsList();

          if (!pros.length) {
            await reply(client, chatId, "Nessun professionista configurato. Contatta il salone.");
            pending.set(chatId, state);
            return "";
          }

          const list =
            `Prima scegli il professionista:\n` +
            `0) Non mi interessa\n` +
            pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n") +
            `\n(0-${pros.length})`;

          await reply(client, chatId, list);
          pending.set(chatId, state);
          return "";
        }

        state.step = "choose_service";
        const proEmail =
          col.professionalAny ?
            null :
            col.professionalEmail || (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null);

        const {
          msg: svcMsg
        } = buildServicesMessageForPro(proEmail);
        await reply(client, chatId, svcMsg);
        pending.set(chatId, state);
        return "";
      } else if (!col.when) {
        state.step = "choose_day";
        await reply(client, chatId, `Che giorno preferisci? (es. "domani", "23 ottobre")`);
        pending.set(chatId, state);
        return "";
      } else {
        state.step = "pick_time";
        if (col.options && col.options.length) {
          const availMsg = buildAvailabilityCompactMessage(col.when, col.options, {
            offset: 0,
            pageSize: AVAIL_PAGE_SIZE
          });
          await reply(client, chatId, availMsg);
        } else {
          state.step = "choose_day";
          await reply(client, chatId, `Che giorno preferisci? (es. "domani", "23 ottobre")`);
        }
        pending.set(chatId, state);
        return "";
      }
    }

    // Crea timestamp finale
    const start = typeof setTime === "function" ? setTime(col.when, col.time) : new Date(+col.when);

    // Verifica che non sia nel passato
    if (typeof isPast === "function" && isPast(start)) {
      const oldDateStr = typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString();
      col.time = null;
      state.step = "pick_time";

      // Verifica professionista per l'orario scelto
      if (!col.professionalAny && !col.professionalEmail && !col.professionalName) {
        const chosenSlot = (col.options || []).find((s) => s && s.time === col.time);
        if (chosenSlot && Array.isArray(chosenSlot.pros) && chosenSlot.pros.length) {
          if (chosenSlot.pros.length === 1) {
            const only = chosenSlot.pros[0];
            col.professionalName =
              only.name || (typeof proNameByEmail === "function" ? proNameByEmail(only.email) : null) || null;
            col.professionalEmail =
              only.email || (typeof proEmailByName === "function" ? proEmailByName(only.name) : null) || null;
            col.professionalAny = false;
          } else {
            col.proOptions = chosenSlot.pros.slice();
            state.step = "pick_professional_for_time";
            const list = chosenSlot.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
            await reply(
              client,
              chatId,
              `Chi preferisci alle ${col.time}?\n${list}\nRispondi con un numero (1-${chosenSlot.pros.length}).`
            );
            pending.set(chatId, state);
            return "";
          }
        }
      }

      const professional = col.professionalAny ? null : (col.professionalEmail || null);
      const duration = (typeof getDurForPro === "function") ?
        getDurForPro(col.service, professional) :
        ((typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

      const list = await fetchSlots({
        service: col.service,
        day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
        duration,
        professional,
        wantDetail: true,
      });

      const slots = typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(list) : list;

      if (!slots || !slots.length) {
        col.when = null;
        state.step = "choose_day";
        await reply(
          client,
          chatId,
          `L'orario selezionato è passato e non ci sono altri orari disponibili per ${oldDateStr}. Scegli un altro giorno.`
        );
        pending.set(chatId, state);
        return "";
      }

      col.options = slots;
      const lines = slots
        .map((s) => {
          const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
          return `• ${s.time}${prosNames}`;
        })
        .join("\n");
      await reply(client, chatId, `L'orario scelto è nel passato. Disponibili invece:\n${lines}`);
      pending.set(chatId, state);
      return "";
    }

    // Assicurati di avere un professionista definitivo (anche se l'utente ha scelto "non mi interessa")
    let proEmail = col.professionalEmail ||
      (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null) || null;

    if (!proEmail && col.professionalAny) {
      const chosenSlot = (col.options || []).find((s) => s && s.time === col.time);
      const arr = (chosenSlot && Array.isArray(chosenSlot.pros)) ? chosenSlot.pros.filter(Boolean) : [];
      if (arr.length) {
        const p = arr[0];
        const email = p?.email || resolveEmailByName(p?.name) || null;
        if (email) {
          proEmail = email;
          // l'utente NON ha scelto un pro: resta "Non mi interessa"
          // (salvo solo internamente l'email per creare evento)
          col._autoProEmail = email;
          col.professionalAny = true;
        }
      }
    }

    if (!proEmail) {
      await reply(client, chatId, " Non riesco a determinare un professionista per quell'orario. Scegli un altro orario o un altro giorno.");
      col.time = null;
      state.step = "pick_time";
      pending.set(chatId, state);
      return "";
    }

    const durationMin = (proEmail && col.service) ?
      (typeof getServiceDurationForPro === "function" ? (getServiceDurationForPro(col.service, proEmail) || 30) : 30) :
      (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30);

    // Validazione finale professionista-servizio
    if (col.service && !col.professionalAny) {
      try {
        if (typeof validateProfessionalForService === "function") {
          const chkFinal = await validateProfessionalForService(col.service, proEmail);
          if (!chkFinal.ok) {
            state.step = "choose_service";
            pending.set(chatId, state);
            await reply(
              client,
              chatId,
              (chkFinal.reason || "Questo servizio non è disponibile con il professionista selezionato.") +
              "\n\nScegli un altro trattamento."
            );
            return "";
          }
        }
      } catch (e) {
        log("error", "validateProfessionalForService(final) failed", e?.stack || e?.message || e);
        await reply(client, chatId, "Errore tecnico durante la validazione del trattamento. Riprova tra poco o contatta il salone.");
        return "";
      }
    }

    // Acquisisci hold con validazione
    let holdOk = false;
    try {
      if (typeof acquireSoftHold === "function") {
        if (!start || isNaN(start.getTime())) {
          throw new Error('Start time non valido per hold');
        }

        holdOk = await acquireSoftHold({
          chatId,
          professionalEmail: proEmail || (col.professionalAny ? "" : ""),
          startTime: start,
          durationMin,
        });

      } else {
        holdOk = true;
      }
    } catch (err) {
      log('error', '[HOLD] Acquisizione fallita', {
        chatId,
        err: err?.message
      });
      holdOk = false;
    }

    if (!holdOk) {
      // Slot occupato: aggiorna lista
      const professional = proEmail || null;
      const list = await fetchSlots({
        service: col.service,
        day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
        duration: durationMin,
        professional,
        wantDetail: true,
      });

      const slots = typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(list) : list;

      if (!slots || !slots.length) {
        await reply(client, chatId, "Quel posto è appena stato occupato. Non ho più disponibilità per quel giorno.");
        col.when = null;
        state.step = "choose_day";
        pending.set(chatId, state);
        return "";
      }

      col.options = slots;
      state.step = "pick_time";
      const lines = slots
        .map((s) => {
          const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
          return `• ${s.time}${prosNames}`;
        })
        .join("\n");
      await reply(client, chatId, `Quel posto è appena stato occupato . Disponibili invece:\n${lines}`);
      pending.set(chatId, state);
      return "";
    }

    // Verifica dati obbligatori
    if (!col.service || !start || !durationMin || !phone) {
      await reply(client, chatId, "Errore: alcuni dati obbligatori per la prenotazione non sono disponibili. Riprova dall'inizio digitando 'annulla'.");
      pending.delete(chatId);
      return "";
    }

    // Verifica professionista
    if (!col.professionalEmail && !col.professionalName && !col.professionalAny) {
      const slot = (col.options || []).find((s) => s && s.time === col.time);
      const pros = (slot?.pros) || (state?.proOptions) || (typeof cfgServiceProfessionals === "function" ? cfgServiceProfessionals(col.service) : []) || [];

      if (Array.isArray(pros) && pros.length > 0) {
        state.step = "pick_professional_for_time";
        col.proOptions = pros;
        pending.set(chatId, state);

        let list = "Scegli il professionista desiderato:\n";
        pros.forEach((p, i) => {
          const raw =
            (p && typeof p === "object" ?
              (p.name || p.displayName || p.email || p.mail || "") :
              (typeof p === "string" ? p : "")
            );

          const pName = String(raw || "").includes("@") ?
            ((typeof proNameByEmail === "function" ? proNameByEmail(raw) : "") || "Professionista") :
            (raw || "Professionista");

          list += `${i + 1}) ${pName}\n`;
        });
        list += "\n0) Qualsiasi professionista (assegniamo il primo disponibile)\n\nRispondi con il numero corrispondente.";

        await reply(client, chatId, list);
        return "";
      }
    }

    if (!proEmail && !col.professionalAny) {
      await reply(client, chatId, " Nessun professionista selezionato o disponibile per l'orario scelto. Riprova.");
      col.time = null;
      state.step = "pick_time";
      pending.set(chatId, state);
      return "";
    }

    // Conferma finale (opzionale)
    if (process.env.REQUIRE_FINAL_CONFIRM === "1" && state.step !== "confirm_final") {
      state.step = "confirm_final";
      pending.set(chatId, state);
      const hh = String(start.getHours()).padStart(2, "0");
      const mi = String(start.getMinutes()).padStart(2, "0");
      const proLine = (!col.professionalAny && col.professionalName) ? ` con ${col.professionalName}` : "";
      const dateStr = formatDateWithWeekdayIT(start);
      const timeStr = `${hh}:${mi}`;
      await reply(client, chatId, `Confermi ${col.service}${proLine} ${dateStr} alle ${timeStr}?`);
      return "";
    }

    if (state.step === "confirm_final") {
      if (!/\b(si|sì|yes|ok)\b/i.test(msg)) {
        await reply(client, chatId, 'Ok, annullato. Scrivi "prenota" per ricominciare.');
        pending.delete(chatId);
        try {
          releaseSoftHoldByChat?.(chatId);
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }
        return "";
      }
    }

    // HARD CHECK: evita doppie prenotazioni (booking già presente) ignorando il nostro hold
    try {
      const sMs = start instanceof Date ? start.getTime() : new Date(start).getTime();
      const eMs = sMs + (Number(durationMin) || 0) * 60_000;
      if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs) {
        if (slotOverlapsExistingBookings(proEmail, sMs, eMs, {
          ignoreChatId: chatId
        })) {
          try {
            releaseSoftHoldByChat?.(chatId);
          } catch { }
          await reply(client, chatId, "Quel posto è appena stato occupato . Scegli un altro orario o un altro giorno.");
          // Rimani nel flow di scelta orario
          col.time = null;
          state.step = "pick_time";
          pending.set(chatId, state);
          return "";
        }
      }
    } catch (hardCheckErr) {
      log('warn', '[BOOKING] Hard-check overlap fallito (ignorato)', {
        chatId,
        err: hardCheckErr?.message
      });
    }

    // Creazione evento con rollback
    // Creazione evento con rollback
    let ev = null;
    let eventCreated = false;

    // Risolvi ID DB (service_id obbligatorio per public.appointments)
    let __svcId = null;
    let __proId = null;

    try {
      const chkIds = await validateProfessionalForService(col.service, proEmail || null);
      __svcId = Number(chkIds?.service_id) || null;
      __proId = Number(chkIds?.professional_id) || null;
    } catch (vErr) {
      log("warn", "[BOOKING] validateProfessionalForService eccezione", {
        service: col.service,
        proEmail,
        error: String(vErr?.message || vErr)
      });
    }

    // Fallback 1: mappa in RAM (popolata all'avvio e aggiornata ogni 5 min)
    if (!__svcId) {
      try {
        __svcId = shared.__svcNameToId.get(String(col.service || "")) || null;
        if (!__svcId && shared.__svcNameToId.size === 0) {
          await __loadIdMaps();
          __svcId = shared.__svcNameToId.get(String(col.service || "")) || null;
        }
        if (__svcId) log("debug", "[BOOKING] service_id risolto via mappa RAM", {
          service: col.service,
          service_id: __svcId
        });
      } catch { }
    }

    // Fallback 2: query diretta al DB — usato quando la mappa RAM è stale o la chiave
    // ha una piccola differenza (es. spazi, encoding). Garanzia finale prima di bloccare.
    if (!__svcId && __pgPool) {
      try {
        const rows = await __pgQuery(
          `SELECT service_id FROM public.services
                     WHERE is_active = true AND lower(service_name) = lower($1) LIMIT 1`,
          [String(col.service || "")]
        );
        if (rows && rows[0]) {
          __svcId = Number(rows[0].service_id) || null;
          if (__svcId) log("debug", "[BOOKING] service_id risolto via query diretta DB", {
            service: col.service,
            service_id: __svcId
          });
        }
      } catch (dbErr) {
        log("warn", "[BOOKING] query diretta service_id fallita", {
          service: col.service,
          error: String(dbErr?.message || dbErr)
        });
      }
    }

    if (!__svcId) {
      log("error", "[BOOKING] service_id non risolvibile — servizio non configurato nel DB", {
        service: col.service,
        mapSize: shared.__svcNameToId.size,
        hint: "Verificare che il servizio esista in public.services con is_active=true",
      });
      state.step = "choose_service";
      pending.set(chatId, state);
      await reply(client, chatId, "Servizio non configurato.\n\nScegli un altro trattamento.");
      return "";
    }

    // Fail closed: a booking without a normalized professional_id would bypass
    // the PostgreSQL exclusion constraint and allow a double reservation.
    if (!__proId) {
      log('error', '[BOOKING] professional_id missing; cannot enforce overlap constraint');
      await reply(client, chatId,
        'Il professionista selezionato non è ancora configurato correttamente. Contatta il salone.');
      return '';
    }

    let sagaEventId = null;
    try {
      // Register durable intent BEFORE publishing the remote Google event.
      sagaEventId = await beginCalendarSaga(__pgPool);
      ev = await makeEvent({
        eventId: sagaEventId,
        serviceName: col.service,
        professionalEmail: proEmail,
        professionalName: col.professionalName || undefined,
        clientPhone: phone,
        customerName: col.customerName || undefined,
        startTime: start,
        durationMin,
        notes: col.notes || undefined,
        price: typeof cfgServicePriceText === "function" ? cfgServicePriceText(col.service) : undefined,
      });

      eventCreated = true;

      const __startMs = (start instanceof Date ? start.getTime() : new Date(start).getTime());
      const __endMs = __startMs + (Number(durationMin) || 30) * 60_000;

      const bookingRecord = {
        eventId: ev?.id || ev?.eventId || `${Date.now()}-${Math.random().toString(36).slice(2)}`,

        // compat: nome + id
        service: col.service,
        serviceName: col.service,
        serviceId: __svcId,
        service_id: __svcId,

        // opzionale (se la tua tabella lo usa)
        professionalName: col.professionalName || null,
        professionalEmail: proEmail || null,
        professionalId: __proId,
        professional_id: __proId,

        clientPhone: phone,
        clientChatId: chatId,
        customerName: col.customerName || null,

        // campi robusti per availability/overlap
        startTime: new Date(__startMs).toISOString(),
        startMs: __startMs,
        endMs: __endMs,
        endTime: new Date(__endMs).toISOString(),

        durationMin,
        status: "confirmed",
        createdAt: new Date().toISOString(),
      };

      // Implementare saveBooking se necessario
      const okSaved = await persistBooking(bookingRecord);
      if (!okSaved) {
        throw new Error("Salvataggio su database fallito");
      }
      // A failed journal update must never cancel a correctly persisted booking.
      try {
        await completeCalendarSaga(__pgPool, sagaEventId, 'committed');
      } catch (journalError) {
        log('warn', '[calendar-saga] Mark committed failed', { code: journalError?.code || 'unknown' });
      }

    } catch (bookingErr) {
      log('error', '[BOOKING] Persistenza fallita', {
        chatId,
        err: bookingErr?.message
      });

      // Rollback: cancella evento Google Calendar se il salvataggio DB è fallito.
      //  Se anche il rollback fallisce rimane un "ghost event" nel calendario senza
      // corrispondente record DB — viene loggato esplicitamente per facilitare il cleanup manuale.
      if (eventCreated && ev?.id) {
        try {
          const cancelled = await cancelEventSafe(ev.id);
          if (!cancelled) throw new Error('Compensazione remota non confermata');
          await completeCalendarSaga(__pgPool, sagaEventId, 'compensated');
          log('info', '[BOOKING] Evento rollback OK', {
            eventId: ev.id
          });
        } catch (rollbackErr) {
          log('error', '[BOOKING]   GHOST EVENT: rollback fallito — evento Calendar orfano da rimuovere manualmente', {
            eventId: ev.id,
            calendarErr: rollbackErr?.message,
            originalErr: bookingErr?.message,
            chatId,
          });
        }
      }

      await reply(client, chatId, " Errore durante il salvataggio. Riprova o contatta il salone.");
      return "";
    }

    // Cleanup finale
    try {
      releaseSoftHoldByChat?.(chatId);
    } catch (cleanupErr) {
      log('warn', '[CLEANUP] Hold release fallito', {
        chatId,
        err: cleanupErr?.message
      });
    }

    // Reset conversazione ma preserva contesto utile (es. "uguale")
    try {
      const prevCtx = (state && state.context) ? state.context : {};
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
          ...prevCtx,
          lastService: col.service || prevCtx.lastService || null,
          lastProfessionalEmail: proEmail || prevCtx.lastProfessionalEmail || null,
          lastProfessionalName: (col.professionalName || prevCtx.lastProfessionalName || null),
        },
      });
    } catch {
      pending.delete(chatId);
    }
    __dateParsingLocks.delete(chatId);

    // Messaggio di conferma
    const hh = String(start.getHours()).padStart(2, "0");
    const mi = String(start.getMinutes()).padStart(2, "0");
    const proLine = (!col.professionalAny && col.professionalName) ? ` con ${col.professionalName}` : "";

    const tmpBooking = {
      startTime: start,
      service: col.service,
      professionalName: col.professionalName || null,
      professionalEmail: proEmail || null,
      customerName: col.customerName || null,
    };
    const line =
      typeof _fmtBookingLine === "function" ?
        _fmtBookingLine(tmpBooking) :
        `${col.service}${proLine} ${formatDateWithWeekdayIT(start)} alle ${hh}:${mi}.`;

    await reply(
      client,
      chatId,
      ` Prenotazione confermata!\n *${line}*\n\n Per spostare o cancellare: scrivi *modifica*.`, {
      noFooter: true
    }
    );

    return "";

  } catch (e) {
    const code = `BKG-${Math.floor(100 + Math.random() * 900)}`;

    log("error", "handleMessage critical error", {
      code,
      err: String(e?.stack || e?.message || e),
      chatId,
      step: state?.step,
    });

    // Cleanup forzato su errore critico
    try {
      pending.delete(chatId);
      __dateParsingLocks.delete(chatId);
      releaseSoftHoldByChat?.(chatId);
    } catch (cleanupErr) {
      log("warn", "[CLEANUP] Errore durante cleanup critico", {
        err: cleanupErr?.message,
        code
      });
    }

    try {
      await reply(client, chatId, ` Ops, ho avuto un intoppo tecnico. Riprova tra poco. (codice: ${code})`, {
        noFooter: true
      });
    } catch (sendErr) {
      log("warn", "Invio messaggio errore fallito", sendErr?.message);
    }

    return "";

  } finally {
    __busyChats.delete(chatId);
    __busySince.delete(chatId);
  }
}

  return { handleMessage };
}
