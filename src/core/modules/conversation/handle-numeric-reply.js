import { createModule as createAvailabilityDayChoice } from './availability-day-choice.js';
import { enqueueCalendarJob } from '../../../services/calendar-outbox.js';
import { offerVerifiedSlot } from '../../../services/waitlist/waitlist.js';
import { verifyReleasedSlot } from '../../../services/waitlist/availability.js';
import { createNumericRouter } from './fsm/route-numeric.js';
import { createModule as createConfirmService } from './confirm-service-choice.js';
import { createModule as createListedService } from './listed-service-choice.js';
import { createModule as createhandleProfessionalChoice } from "./professional-choice.js";
import { createModule as createhandleReviewIntake } from "./review-intake.js";
/**
 * conversation/handle-numeric-reply: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const {
    AVAIL_PAGE_SIZE,
    __pgPool,
    _editApplyUpdate,
    _editDayFromBooking,
    _editDuration,
    _editParseNewDate,
    _editSnapshotStateFromBooking,
    _fmtBookingLine,
    askQA,
    atNoon,
    buildAvailabilityCompactMessage,
    buildQAPromptWithMemory,
    buildReviewIntakePrompt,
    buildServicesMessageForPro,
    cancelEventSafe,
    cfgClosedDay,
    cfgServiceDuration,
    cfgServicePriceText,
    cfgServiceProfessionals,
    cfgServices,
    compareHHMM,
    composeInfoPrompt,
    config,
    daysInMonth,
    ensureContext,
    ensureUI,
    extractReviewEntities,
    fetchSlots,
    filterOutPastTimesForToday,
    filterSlotsByWindow,
    fmtDate,
    fmtDateWithWeekdayIT,
    formatDateWithWeekdayIT,
    formatDurationMin,
    getAllProsList,
    getDaypartBoundaries,
    getDurForPro,
    getLastInfoTopic,
    getState,
    getUserActiveBookingsAll,
    groupSlotsByDaypart,
    isoWeekday,
    itaWeekdayName,
    labelProsForSlot,
    log,
    nextOpenDay,
    norm,
    normalizeSlotsDetail,
    now,
    parseDaypartWindow,
    parseHHMM,
    parseListIndex,
    parseTimeSmart,
    pending,
    phoneFromChatId,
    pickBookingMatchFromFreeText,
    proEmailByName,
    proNameByEmail,
    releaseSoftHoldByChat,
    rememberService,
    renderEditBookingList,
    renderSlotsList,
    reply,
    resolveProReply,
    resolveReviewMenuIntent,
    safeParseDateWithLock,
    safeSend,
    scheduleReenter,
    setAndPersist,
    showEditMenu,
    startEditChooseBooking,
    timeToMinutes,
    tr,
    unlockBooking,
    updateBookingByComposite,
    updateBookingByEventId,
    validateProfessionalForService,
  } = dependencies;
  const handleProfessionalChoice = createhandleProfessionalChoice(dependencies);
  const handleReviewIntake = createhandleReviewIntake(dependencies);
  const handleConfirmService = createConfirmService(dependencies);
  const handleListedService = createListedService(dependencies);
  const routeAvailabilityDay = createAvailabilityDayChoice(dependencies, { buildAvailabilityMessage: (...args) => buildAvailabilityMessage(...args) });
  const routeEarlyNumeric = createNumericRouter({
    review: ctx => handleReviewIntake(ctx),
    professional: ctx => handleProfessionalChoice(ctx),
    confirmService: ctx => handleConfirmService(ctx),
    selectService: ctx => handleListedService(ctx),
  });

async function handleNumericReply(client, chatId, textRaw, tools = {}) {
  // === corpo di handleNumericReply (versione patchata) ===
  const msg = (textRaw || "").trim();
  const pureNumber = /^\s*\d+\s*[\).]?\s*$/; // accetta "2", "2)", "2."
  const t = typeof norm === "function" ? norm(msg) : msg.toLowerCase();
  let n = NaN;
  const sRaw = String(msg || "");
  const sNorm = typeof norm === "function" ? norm(sRaw) : sRaw.toLowerCase().trim();
  const s = pending.get(chatId);
  if (!s) return safeSend(client, chatId, "Nessuna scelta in corso.");

  const state = s;
  const col = state.collected || (state.collected = {});
  const setAndPersist = () => pending.set(chatId, state);

  const early = await routeEarlyNumeric({client,chatId,msg,pureNumber,state,col,tools,setAndPersist});
  if (early.handled) return early.result;

  const availability = await routeAvailabilityDay({ client, chatId, msg, state });
  if (availability.handled) return availability.result;

  // ==== MENU DI MODIFICA (prenotazione esistente) ====
  // ==== Scelta prenotazione da modificare (quando ce ne sono più di una) ====
  if (state.step === "edit_pick_booking") {
    const list = (state.edit && state.edit.list) || [];
    if (!list.length) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        'Sessione scaduta. Scrivi "modifica appuntamento" per ripartire.'
      );
    }

    // UX: uscita rapida dalla selezione
    if (/\b(annulla|esci|stop|chiudi)\b/i.test(String(msg || ""))) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        'Ok\nQuando vuoi: scrivi "prenota" per fissare un appuntamento oppure "modifica" per gestirne uno esistente.', {
        noFooter: true
      }
      );
    }

    let n = parseListIndex(msg, list.length);

    // Permetti selezione anche scrivendo il trattamento (es. "ceretta", "ceretta alle 09", "alle 18")
    if (!Number.isFinite(n) || n < 1 || n > list.length) {
      const m =
        typeof pickBookingMatchFromFreeText === "function" ?
          pickBookingMatchFromFreeText(msg, list) :
          null;

      if (m && m.kind === "hit" && Number.isFinite(m.idx)) {
        n = m.idx + 1;
      } else if (
        m &&
        m.kind === "ambiguous" &&
        Array.isArray(m.candidates) &&
        m.candidates.length
      ) {
        const lines = m.candidates
          .map((idx) => {
            const b = list[idx];
            const line =
              typeof _fmtBookingLine === "function" ?
                _fmtBookingLine(b) :
                String(b?.service || b?.serviceName || "Prenotazione");
            return `*${idx + 1})* ${line}`;
          })
          .join("\n");

        return reply(
          client,
          chatId,
          `Ho trovato più prenotazioni che combaciano con "${String(msg).trim()}":
${lines}

Scrivi il numero (1-${list.length}).`
        );
      }
    }

    // Permetti selezione anche scrivendo una data (es. "27 gennaio", "27 gennaio", "27-01-2026")
    if (!Number.isFinite(n) || n < 1 || n > list.length) {
      let pickedByDate = null;
      try {
        const parsed = safeParseDateWithLock(chatId, msg);
        if (parsed && !isNaN(parsed.getTime())) {
          const d = parsed.getDate();
          const m = parsed.getMonth();
          const y = parsed.getFullYear();
          const hasYear = /\b(19|20)\d{2}\b/.test(msg);

          const matches = list
            .map((b, idx) => ({
              b,
              idx: idx + 1
            }))
            .filter(({
              b
            }) => {
              const dt = b?.startTime instanceof Date ? b.startTime : new Date(b?.startTime);
              if (!dt || isNaN(dt.getTime())) return false;
              if (dt.getDate() !== d) return false;
              if (dt.getMonth() !== m) return false;
              if (hasYear && dt.getFullYear() !== y) return false;
              return true;
            });

          if (matches.length === 1) pickedByDate = matches[0].idx;
          if (matches.length > 1) {
            return reply(
              client,
              chatId,
              `Ho trovato più prenotazioni in quella data.\nScegli il numero nella lista (1-${list.length}):\n\n${renderEditBookingList(list)}\n\n(1-${list.length})`
            );
          }
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      if (pickedByDate != null) {
        n = pickedByDate;
      } else {
        return reply(
          client,
          chatId,
          `Scegli un numero valido (1-${list.length}).\n\n${renderEditBookingList(list)}\n\nTip: puoi anche scrivere il trattamento (es. "ceretta") o la data (es. "30 dicembre").\nComandi: annulla`
        );
      }
    }

    const chosen = list[n - 1];
    _editSnapshotStateFromBooking(state, chosen);
    const nextStep = state.edit && state.edit.nextStep;

    // Se il comando rapido voleva una modifica specifica (data)
    if (nextStep === "edit_reschedule_date") {
      state.step = "edit_reschedule_date";
      state.edit = {
        target: chosen
      };
      state.collected = state.collected || {};
      pending.set(chatId, state);

      return reply(
        client,
        chatId,
        `Vuoi cambiare la data di:\n${_fmtBookingLine(
          chosen
        )}\n\nDimmi la nuova data (GG/MM, "oggi" o "domani").`
      );
    }

    // Se il comando rapido voleva cambiare solo l'orario
    if (nextStep === "edit_reschedule_time") {
      const day = _editDayFromBooking(chosen);
      const duration = _editDuration(chosen);
      const pro = chosen.professionalEmail || null;

      try {
        releaseSoftHoldByChat(chatId);
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      const slots = normalizeSlotsDetail(
        await fetchSlots({
          service: chosen.service,
          day,
          duration,
          professional: pro,
          wantDetail: true,
        })
      );

      if (!slots.length) {
        pending.set(chatId, state);
        return reply(
          client,
          chatId,
          `Non vedo orari liberi per ${fmtDateWithWeekdayIT(
            day
          )} con il professionista attuale. Puoi cambiare data o professionista dal menu di modifica.`
        );
      }

      const col = state.collected || (state.collected = {});
      col.options = slots;

      state.step = "edit_reschedule_time";
      state.edit = {
        target: chosen,
        day
      };
      pending.set(chatId, state);

      return reply(
        client,
        chatId,
        `Orari disponibili per ${fmtDate(
          day
        )}:\n${renderSlotsList(slots)}\n\nScrivi l'orario desiderato (es. "14:30").`
      );
    }

    // Se il comando rapido voleva cambiare solo il professionista
    if (nextStep === "edit_pick_professional") {
      const pros = (cfgServiceProfessionals(chosen.service) || []).filter(
        (x) => x && x.name
      );

      if (!pros.length) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Non ho professionisti associati a questo servizio."
        );
      }

      state.step = "edit_pick_professional";
      state.edit = {
        target: chosen,
        proOptions: pros
      };
      pending.set(chatId, state);

      const listPros =
        "0) Indietro (tieni quello attuale)\n" +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
      return reply(
        client,
        chatId,
        `Scegli il professionista:\n${listPros}\n(0-${pros.length})`
      );
    }

    // Se il comando rapido voleva cambiare il nome
    if (nextStep === "edit_change_name") {
      state.step = "edit_change_name";
      state.edit = {
        target: chosen
      };
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        "Scrivi il nuovo nome e cognome per la prenotazione."
      );
    }

    // Default: apre il menu generico di modifica
    state.step = "edit_menu";
    state.edit = {
      target: chosen
    };
    pending.set(chatId, state);
    return reply(client, chatId, showEditMenu(chosen), {
      noFooter: true
    });
  }

  // ==== Gestione del MENU DI MODIFICA vero e proprio ====
  if (state.step === "edit_menu") {
    // Accetta sia numeri che testo (es. "nome", "orario", "data", "professionista", "annulla")
    const sRaw = String(msg || "");
    const sNorm =
      typeof norm === "function" ? norm(sRaw) : sRaw.toLowerCase().trim();
    let n = parseInt(sNorm, 10);

    // Mappa testo -> opzione
    // 0 = annulla prenotazione
    // 1 = cambia data
    // 2 = cambia orario
    // 3 = cambia professionista
    // 4 = cambia nome
    // 5 = gestisci un'altra prenotazione
    const map = [
      [0, /\b(annull|cancell|disd)(a|o|i|e)?\w*\b/],
      [1, /\b(data|giorno|gg|sposta\s+data|cambia\s+data|nuova\s+data)\b/],
      [2, /\b(ora|orario|time|slot|fascia|fascia\s+orar)\w*\b/],
      [
        3,
        /\b(professionista|operatric(e|i)?|operatore|pro\b|tecnic[oa]|nail|master)\b/,
      ],
      [4, /\b(nome|intestaz|intestat|cliente|intestatario)\w*\b/],
      [5, /\b(altr[ao]|un'?altr[ao])\s+(appunt|prenotaz)\w*\b|^modifica\b/],
      [6, /\b(esci|chiudi|stop|fine|annulla)\b/i],
    ];

    if (Number.isNaN(n)) {
      for (const [num, re] of map) {
        if (re.test(sNorm)) {
          n = num;
          break;
        }
      }
    }

    const booking = state.edit && state.edit.target;
    if (!booking) {
      return reply(
        client,
        chatId,
        "Ops, non trovo la prenotazione da gestire."
      );
    }

    // Range valido 0..5
    if (Number.isNaN(n) || n < 0 || n > 6) {
      return reply(
        client,
        chatId,
        "Scegli un numero valido (0-6) oppure scrivi: nome / orario / data / professionista / annulla / modifica / esci."
      );
    }

    // 5) Gestisci un'altra prenotazione -> torna alla lista prenotazioni
    if (n === 5) {
      const phone = booking.clientPhone || phoneFromChatId(chatId);
      const bookings = (getUserActiveBookingsAll(phone) || []).filter(Boolean);

      if (bookings.length <= 1) {
        pending.set(chatId, state);
        return reply(
          client,
          chatId,
          "Non ci sono altre prenotazioni future da scegliere.", {
          noFooter: true
        }
        );
      }

      return startEditChooseBooking(client, chatId, bookings, null);
    }

    // 6) Esci dal menu modifica (senza modifiche)
    if (n === 6) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        'Ok \nQuando vuoi: scrivi "prenota" per fissare un appuntamento oppure "modifica" per gestirne uno esistente.', {
        noFooter: true
      }
      );
    }

    // 0) Cancella prenotazione
    if (n === 0) {
      state.step = "edit_cancel_confirm";
      pending.set(chatId, state);
      const line = _fmtBookingLine(booking);
      return reply(
        client,
        chatId,
        `Vuoi cancellare questa prenotazione?\n*${line}*\n\nRispondi *sì* / *no*.`
      );
    }

    // 1) Cambia data -> passo a edit_reschedule_date
    if (n === 1) {
      state.step = "edit_reschedule_date";
      state.edit = {
        target: booking
      };
      state.collected = state.collected || {};
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        `Vuoi cambiare la data di:\n${_fmtBookingLine(
          booking
        )}\n\nDimmi la nuova data (GG/MM, "oggi" o "domani").`
      );
    }

    // 2) Cambia orario -> passo a edit_reschedule_time (con professionista attuale)
    if (n === 2) {
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
        pending.set(chatId, state);
        return reply(
          client,
          chatId,
          `Non vedo orari liberi per ${fmtDateWithWeekdayIT(
            day
          )} con il professionista attuale. Puoi cambiare data o professionista dal menu di modifica.`
        );
      }

      const col = state.collected || (state.collected = {});
      col.options = slots;

      state.step = "edit_reschedule_time";
      state.edit = {
        target: booking,
        day
      };
      pending.set(chatId, state);

      return reply(
        client,
        chatId,
        `Orari disponibili per ${fmtDate(
          day
        )}:\n${renderSlotsList(slots)}\n\nScrivi l'orario desiderato (es. "14:30").`
      );
    }

    // 3) Cambia professionista -> passo a edit_pick_professional
    if (n === 3) {
      const pros = (cfgServiceProfessionals(booking.service) || []).filter(
        (x) => x && x.name
      );

      if (!pros.length) {
        return reply(
          client,
          chatId,
          "Non ho professionisti associati a questo servizio."
        );
      }
      state.step = "edit_pick_professional";
      state.edit = {
        target: booking,
        proOptions: pros
      };
      pending.set(chatId, state);

      const listPros =
        "0) Indietro (tieni quello attuale)\n" +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
      return reply(
        client,
        chatId,
        `Scegli il professionista:\n${listPros}\n(0-${pros.length})`
      );
    }

    // 4) Cambia nome -> passo a edit_change_name
    if (n === 4) {
      state.step = "edit_change_name";
      state.edit = {
        target: booking
      };
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        "Scrivi il nuovo nome e cognome per la prenotazione."
      );
    }
  }

  // ==== EDIT FLOW: scelta orario (dopo cambio data/orario) ====
  if (state.step === "edit_reschedule_time") {
    const booking = state.edit?.target;
    const dayRaw = state.edit?.day || (booking ? _editDayFromBooking(booking) : null);
    const day = (dayRaw && (dayRaw instanceof Date ? dayRaw : new Date(dayRaw))) || null;

    const col = (state.collected = state.collected || {});
    const options = Array.isArray(col.options) ? col.options : [];

    // session validation
    if (!booking || !day || !options.length) {
      pending.delete(chatId);
      return reply(client, chatId, 'Sessione scaduta. Scrivi "modifica appuntamento" per ripartire.');
    }

    const raw = String(msg || "").trim();
    if (/^annulla|annula$/i.test(raw)) {
      pending.delete(chatId);
      return reply(client, chatId, "Operazione annullata.");
    }

    // 1) se l'utente ha scritto una nuova DATA -> cambia giorno e ricarica slot
    const _rawLooksLikeTime =
      // input puro tipo "10" / "10:30" / "10pm" / "10:30pm"
      /^\s*(?:\d{1,2}(?:\s*[:.]\s*[0-5]\d)?\s*(?:am|pm)?|\d{3,4}\s*(?:am|pm)?)\s*$/i.test(raw) ||
      // input con indizi tipo "alle 10", "ore 10", "h10", "alle 10pm"
      /\b(?:alle?\s*|ore\s*|h\s*)(?:\d{1,2})(?:\s*[:.]\s*[0-5]\d)?\s*(?:am|pm)?\b/i.test(raw);

    const maybeNewDay = (!_rawLooksLikeTime && _editParseNewDate) ? _editParseNewDate(raw) : null;
    if (maybeNewDay && maybeNewDay instanceof Date && !Number.isNaN(maybeNewDay.getTime())) {
      const newDay = new Date(maybeNewDay);
      newDay.setHours(0, 0, 0, 0);

      // check chiusure/validità (se esiste cfgClosedDay)
      if (typeof cfgClosedDay === "function" && cfgClosedDay(newDay)) {
        const dayStrClosed = typeof formatDateWithWeekdayIT === "function" ?
          formatDateWithWeekdayIT(newDay) :
          (typeof fmtDate === "function" ? fmtDate(newDay) : newDay.toLocaleDateString());
        pending.set(chatId, state);
        return reply(client, chatId, `Il giorno ${dayStrClosed} è chiuso. Prova un altro giorno.`);
      }

      // fetch nuovi slot per il nuovo giorno
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
        day: typeof atNoon === "function" ? atNoon(newDay) : newDay,
        duration,
        professional: pro,
        wantDetail: true,
      });

      const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawSlots) : rawSlots) || [];

      if (!slots.length) {
        pending.set(chatId, state);
        const dateStr = typeof formatDateWithWeekdayIT === "function" ?
          formatDateWithWeekdayIT(newDay) :
          (typeof fmtDate === "function" ? fmtDate(newDay) : newDay.toLocaleDateString());
        return reply(client, chatId, `Non ci sono orari liberi per ${dateStr}. Prova un altro giorno.`);
      }

      // aggiorna stato e mostra nuovo elenco
      state.edit.day = newDay;
      state.collected.options = slots;
      pending.set(chatId, state);

      const dateStr = typeof formatDateWithWeekdayIT === "function" ?
        formatDateWithWeekdayIT(newDay) :
        (typeof fmtDate === "function" ? fmtDate(newDay) : newDay.toLocaleDateString());
      const lines = typeof renderSlotsList === "function" ? renderSlotsList(slots) : slots.join("\n");

      return reply(
        client,
        chatId,
        `Orari disponibili per ${dateStr}:\n${lines}\n\n Scrivi l'orario desiderato (es. "14:30" oppure "alle 14").`
      );
    }

    // helper: normalizza stringa orario a "HH:MM"
    const parseUserTime = (text) => {
      const s = String(text || "").toLowerCase().trim();
      // supporta: "10", "10:00", "10.30", "alle 10", "9 e 30", "9:30"
      const m = s.match(/(?:alle\s*)?(\d{1,2})(?:\s*[:.\h,\s]\s*(\d{2}))?/i);
      if (!m) return null;
      const hh = parseInt(m[1], 10);
      const mm = m[2] == null ? 0 : parseInt(m[2], 10);
      if (!Number.isFinite(hh) || hh < 0 || hh > 23) return null;
      if (!Number.isFinite(mm) || mm < 0 || mm > 59) return null;
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    };

    // 2)  Nessuna selezione per indice sugli orari:
    //   anche "17" significa 17:00 (non "17° elemento" della lista).

    // 3) altrimenti provo a interpretare l'input come orario testuale
    const requestedHHMM = parseUserTime(raw);
    if (!requestedHHMM) {
      pending.set(chatId, state);
      return reply(client, chatId, `Scrivi l'orario in formato orario (es. "14:30", "14.30" oppure "alle 14").`);
    }

    // cerco lo slot corrispondente
    const found = options.find((o) => {
      const t = (typeof o === "string" ? o : (o && (o.time || o.hhmm))) || "";
      return String(t).replace(".", ":") === requestedHHMM;
    });

    if (!found) {
      pending.set(chatId, state);
      return reply(client, chatId, `Non ho trovato disponibilità alle ${requestedHHMM}. Scegli un orario dall'elenco mostrato.`);
    }

    // applico la modifica
    const hh = Number(requestedHHMM.split(":")[0]);
    const mm = Number(requestedHHMM.split(":")[1] || 0);
    const newDate = new Date(state.edit.day || day);
    newDate.setHours(hh, mm, 0, 0);
    const newStartISO = newDate.toISOString();

    const ok = await _editApplyUpdate({
      booking,
      newStartISO
    });
    if (!ok) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(client, chatId, "Quel posto sembra occupato. Puoi cambiare orario oppure scegliere un altro professionista.");
    }

    pending.delete(chatId);

    const tmp = {
      ...(booking || {}),
      startTime: newDate
    };
    const dateStr =
      typeof formatDateWithWeekdayIT === "function" ?
        formatDateWithWeekdayIT(newDate) :
        typeof fmtDate === "function" ?
          fmtDate(newDate) :
          newDate.toLocaleDateString("it-IT");

    const line =
      typeof _fmtBookingLine === "function" ?
        _fmtBookingLine(tmp) :
        `${dateStr} • ${requestedHHMM}`;

    return reply(client, chatId, `Orario spostato!\n *${line}*`);
  }

  // ==== EDIT FLOW: scelta professionista ====
  if (state.step === "edit_pick_professional") {
    const editState = state.edit || {};
    const booking = editState.target;
    const prosRaw = Array.isArray(editState.proOptions) ? editState.proOptions : [];
    const pros = prosRaw
      .map((p) => {
        if (!p) return null;
        if (typeof p === "string") {
          const name = String(p).trim();
          const email =
            typeof proEmailByName === "function" ? proEmailByName(name) || null : null;
          return name ? {
            name,
            email
          } : null;
        }
        const email =
          p.email ||
          (p.name && typeof proEmailByName === "function" ?
            proEmailByName(p.name) || null :
            null) ||
          null;
        const name =
          p.name ||
          (email && typeof proNameByEmail === "function" ? proNameByEmail(email) : null) ||
          email ||
          null;
        return name ? {
          name,
          email
        } : null;
      })
      .filter(Boolean);

    if (!booking || !pros.length) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        'Sessione scaduta. Scrivi "modifica appuntamento" per ripartire.'
      );
    }

    const txt = String(msg || "").trim();

    // Accetta sia numero (1..N) sia nome ("Evelin", "con Evelin", ecc.)
    const choice =
      typeof resolveProReply === "function" ? resolveProReply(txt, pros) : null;

    // 0 / "non mi interessa" = indietro (tieni quello attuale)
    if (choice && choice.any) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(client, chatId, showEditMenu(booking));
    }

    if (!choice) {
      return reply(
        client,
        chatId,
        `Risposta non valida. Rispondi con un numero (0-${pros.length}) oppure scrivi il nome del professionista.`
      );
    }

    const chosenName = choice.name || choice.email || "professionista";
    const newProEmail =
      choice.email ||
      (typeof proEmailByName === "function" ? proEmailByName(chosenName) : null);

    if (!newProEmail) {
      return reply(
        client,
        chatId,
        "Non riesco a collegare quel nome a un professionista valido. Riprova scegliendo dall’elenco."
      );
    }

    // Se ha scelto lo stesso professionista non faccio lavoro inutile
    if (booking.professionalEmail && booking.professionalEmail === newProEmail) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        `Hai già ${chosenName} assegnata/o a questo appuntamento, te lo ri-confermo! \n\n${showEditMenu(
          booking
        )}`
      );
    }

    // Controllo extra: il professionista deve essere abilitato per questo servizio
    const svcCfg =
      (config.services && config.services[booking.service]) || {};
    const svcPros = Array.isArray(svcCfg.professionals) ?
      svcCfg.professionals : [];

    const serviceLabel =
      booking.serviceName ||
      booking.serviceLabel ||
      booking.service ||
      "questo trattamento";

    const svcProsNorm = svcPros
      .map((x) => (typeof x === "string" ? x : (x && (x.email || x.name)) || ""))
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());

    const okForSvc = !svcProsNorm.length ||
      svcProsNorm.includes(String(newProEmail).toLowerCase()) ||
      svcProsNorm.includes(String(chosenName).toLowerCase());

    if (!okForSvc) {
      // Non applico l’update, torno semplicemente al menu di modifica
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        " " +
        chosenName +
        " non è configurata per eseguire " +
        serviceLabel +
        " nel gestionale. " +
        "Scegli un altro professionista (3) oppure lascia quello attuale."
      );
    }

    // Ok, applico il cambio professionista
    const ok = await _editApplyUpdate({
      booking,
      newProEmail
    });
    if (!ok) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        "Quel professionista sembra occupato in quell’orario . " +
        "Puoi cambiare orario (2) oppure scegliere un altro professionista (3)."
      );
    }

    // ricarico dal file booking per essere sicuro di avere la versione aggiornata
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

    state.step = "edit_menu";
    state.edit = {
      target: updated
    };
    pending.set(chatId, state);

    return reply(
      client,
      chatId,
      `Prenotazione aggiornata:\n${_fmtBookingLine(
        updated
      )}\n\n${showEditMenu(updated)}`
    );
  }

  // ==== Conferma cancellazione edit ====
  if (state.step === "edit_cancel_confirm") {
    const booking = state.edit && state.edit.target;
    if (!booking) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
      );
    }
    const sMsg = norm(String(msg || ""));
    const yes =
      /(?:^|[\s,.!?])(?:s[iì]|ok|va bene|confermo|confermare|procedi|procedere|certo|affermativo)(?=$|[\s,.!?])/i.test(sMsg);
    const no = /(?:^|[\s,.!?])(?:no|annula|annulla|indietro|stop)(?=$|[\s,.!?])/i.test(sMsg);
    if (yes) {
      // Idempotenza: se è già cancellata, non rifaccio la procedura
      const curStatus = String(booking.status || "").toLowerCase();
      if (/(cancel|annull)/.test(curStatus)) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Questa prenotazione risulta già cancellata nel sistema."
        );
      }

      // Update durable booking state first. Never delete the Calendar event
      // when PostgreSQL has rejected the cancellation.
      const patched = { status: 'cancelled', cancelledAt: new Date().toISOString() };
      let updated = false;
      try {
        updated = booking.eventId
          ? await updateBookingByEventId(booking.eventId, patched)
          : await updateBookingByComposite({ clientPhone: booking.clientPhone,
              startTime: booking.startTime }, patched);
      } catch (error) {
        log('error', 'booking_cancel_database_failed', { code: error?.code || 'unknown' });
      }
      if (!updated) {
        return reply(client, chatId,
          'Non sono riuscito a registrare la cancellazione. L’appuntamento resta attivo: contatta il salone.');
      }
      let gcalOk = false;
      try {
        gcalOk = await cancelEventSafe(booking.eventId);
      } catch (error) {
        log('warn', 'booking_cancel_calendar_failed', { code: error?.code || 'unknown' });
      }
      // Non perdere l'intenzione di cancellazione se Google è temporaneamente offline.
      // La coda retry è idempotente; i worker trattano 404 come già cancellato.
      if (!gcalOk && updated && booking.eventId && __pgPool && process.env.CALENDAR_OUTBOX_ENABLED === '1') {
        try { await enqueueCalendarJob(__pgPool, {operation:'cancel',eventId:booking.eventId}); }
        catch (error) { log('warn','calendar_cancel_queue_failed',{code:error.code||'unavailable'}); }
      }
      // Lista attesa solo dopo reale cancellazione remota e nuova verifica PG + Calendar.
      if (gcalOk && updated && process.env.WAITLIST_ENABLED === '1' && __pgPool &&
          booking.startTime && booking.endTime && booking.professionalId && booking.professionalEmail) {
        try {
          void await offerVerifiedSlot({db:__pgPool,start:booking.startTime,end:booking.endTime,
            professionalId:booking.professionalId,serviceId:booking.serviceId||null,
            verifyAvailability: args => verifyReleasedSlot({...args,db:__pgPool,professionalEmail:booking.professionalEmail}),
            notify: (to,message) => safeSend(client,to,message)});
        } catch(error) { log('warn','waitlist_offer_failed',{code:error.code||'unavailable'}); }
      }
      pending.delete(chatId);
      if (gcalOk && updated)
        return reply(client, chatId, "Prenotazione cancellata.");
      if (!gcalOk && updated)
        return reply(
          client,
          chatId,
          "Ho aggiornato il sistema interno, ma non sono riuscito a cancellare l’evento in calendario. Avvisa il salone se vedi ancora l’appuntamento."
        );
      return reply(
        client,
        chatId,
        "Errore interno durante la cancellazione. Riprova tra poco."
      );
    }
    if (no) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(client, chatId, showEditMenu(booking));
    }
    return reply(
      client,
      chatId,
      'Scrivi "sì" per confermare la cancellazione oppure "annulla" per tornare indietro.'
    );
  }

  // ==== Selezioni info/prezzi ====
  if (state.step === "info_select_service") {
    const n = parseInt(msg, 10);
    const list = col.infoOptions || [];
    const svc = list[n - 1];
    if (!svc)
      return safeSend(
        client,
        chatId,
        `Scegli un numero valido (1-${list.length}).`
      );
    state.step = "collect";
    col.infoOptions = null;
    rememberService(chatId, svc);
    pending.set(chatId, state);
    const topic = getLastInfoTopic(chatId);
    const base = composeInfoPrompt(svc, topic);
    let a = (
      await askQA(buildQAPromptWithMemory(chatId, base), tools, client)
    ).trim();
    if (!a)
      a = `• ${svc}: ${cfgServicePriceText(svc)} (durata ${formatDurationMin(cfgServiceDuration(svc)) || (cfgServiceDuration(svc) + " min")})`;
    return safeSend(client, chatId, a);
  }

  if (state.step === "price_select_service") {
    const n = parseInt(msg, 10);
    const list = col.infoOptions || [];
    const svc = list[n - 1];
    if (!svc)
      return safeSend(
        client,
        chatId,
        `Scegli un numero valido (1-${list.length}).`
      );
    state.step = "collect";
    col.infoOptions = null;
    rememberService(chatId, svc);
    pending.set(chatId, state);
    return safeSend(
      client,
      chatId,
      `• ${svc}: ${cfgServicePriceText(svc)} (durata ${formatDurationMin(cfgServiceDuration(svc)) || (cfgServiceDuration(svc) + " min")})`
    );
  }

  // ==== Orari (prenotazione standard) ====
  if (state.step !== "pick_time") {
    scheduleReenter(client, chatId, "ok professionista", tools);
    return "";
  }

  // assicurati che ci sia la data in contesto
  if (!(col && col.when)) {
    return safeSend(client, chatId, 'Mi manca il giorno: dimmi la data (es. domani / 12 dic / 12/12).');
  }

  // NEW: durante pick_time permetti cambio giorno (es. "giovedì", "martedì prossimo", "12 dicembre", "28 ottobre")
  const daySwitchHint =
    /\b(oggi|domani|dopodomani|tra|fra|settimana|prossim|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|\d{1,2}\s*[\/\-]\s*\d{1,2}|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/i;

  const _daySwitchText = String(msg || "");
  const _hasDayNumberCue = /\b(?:il|giorno|data|per\s+il)\s+\d{1,2}(?:\s*(?:°|º))?\b/i.test(_daySwitchText);

  if (_hasDayNumberCue || daySwitchHint.test(_daySwitchText)) {
    let parsedSwitch =
      (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, _daySwitchText) : null) ||
      null;

    if (!parsedSwitch) {
      const mDay = _daySwitchText.match(/\b(?:il|giorno|data|per\s+il)\s+(\d{1,2})(?:\s*(?:°|º))?\b/i);
      if (mDay) {
        const probe = `il ${mDay[1]}`;
        parsedSwitch =
          (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, probe) : null) ||
          null;
      }
    }

    if (parsedSwitch && !isNaN(parsedSwitch)) {
      const day =
        typeof atNoon === "function" ?
          atNoon(parsedSwitch) :
          new Date(parsedSwitch.getFullYear(), parsedSwitch.getMonth(), parsedSwitch.getDate(), 12, 0, 0, 0);

      if (typeof cfgClosedDay === "function" && cfgClosedDay(day)) {
        const dayStrClosed =
          typeof formatDateWithWeekdayIT === "function" ?
            formatDateWithWeekdayIT(day) :
            (typeof fmtDate === "function" ? fmtDate(day) : day.toLocaleDateString());
        pending.set(chatId, state);
        return safeSend(client, chatId, `Il giorno ${dayStrClosed} siamo chiusi. Dimmi un altro giorno (es. "domani", "sabato", "12 dicembre").`);
      }

      col.when = day;
      col.time = null;

      const duration = getDurForPro(col.service, col.professionalEmail);

      const professional = col.professionalAny ?
        null :
        col.professionalEmail || col.professionalName || null;

      const rawList = await fetchSlots({
        service: col.service,
        day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
        duration,
        professional,
        wantDetail: true,
      });

      const slots =
        (typeof normalizeSlotsDetail === "function" ?
          normalizeSlotsDetail(rawList) :
          rawList) || [];

      if (!slots.length) {
        const dayStr =
          typeof formatDateWithWeekdayIT === "function" ?
            formatDateWithWeekdayIT(col.when) :
            (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());
        col.when = null;
        state.step = "choose_day";
        pending.set(chatId, state);
        return safeSend(client, chatId, `Non ci sono orari liberi per ${dayStr}. Dimmi un altro giorno (es. "domani", "sabato", "12 dicembre").`);
      }

      col.options = slots;
      state.step = "pick_time";
      pending.set(chatId, state);

      const lines = slots
        .map((s) => {
          const prosNames =
            s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
          return `• ${s.time}${prosNames}`;
        })
        .join("\n");

      const dayStr =
        typeof formatDateWithWeekdayIT === "function" ?
          formatDateWithWeekdayIT(col.when) :
          (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());

      return safeSend(
        client,
        chatId,
        `Disponibilità per ${dayStr}:\n${lines}\n\n Scrivi l'orario desiderato (es. "14:30", "14.30" oppure "alle 14")`
      );
    }
  }

  // PATCH: accetta SOLO orari testuali (HH:MM), NON numeri di lista
  const parsedTime = (typeof parseTimeSmart === "function" ? parseTimeSmart(msg) : null) ||
    (typeof parseHHMM === "function" ? parseHHMM(msg) : null);

  if (!parsedTime) {
    return safeSend(
      client,
      chatId,
      `Scrivi un orario tipo "14:30" o "14.30" (va bene anche "alle 14" / "verso le 15").`

    );
  }

  // Trova lo slot corrispondente all'orario scritto
  const matchedSlot = (col.options || []).find(s => s.time === parsedTime);

  if (!matchedSlot) {
    // Orario non disponibile: suggerisci alternative
    const nearest = typeof nearestTimes === "function" ?
      nearestTimes(col.options.map(s => s.time), parsedTime, 3) : [];

    if (nearest.length) {
      return safeSend(
        client,
        chatId,
        `L'orario ${parsedTime} non è disponibile. Orari vicini:\n${nearest.map(t => `• ${t}`).join('\n')}\n\nScrivi uno di questi orari.`
      );
    }

    return safeSend(client, chatId, `L'orario ${parsedTime} non è disponibile. Scegli tra quelli mostrati sopra.`);
  }
  // dichiarazioni preliminari per evitare ReferenceError
  let item = null;
  let time = null;

  // Orario valido: continua con matchedSlot
  item = matchedSlot;
  time = item && item.time ? item.time : null;
  col.time = time;

  // Gli orari non sono mai selezionati per indice.
  //   Qui usiamo sempre l'orario scritto dall'utente (es. "10", "10:00", "10.30", "alle 10").

  // Gestione professionisti
  const needPro = !col.professionalEmail && !col.professionalName && !col.professionalAny;

  const hasPros = item && Array.isArray(item.pros);

  if (needPro && hasPros && item.pros.length > 1) {
    // più professionisti disponibili a quell'orario: chiedi quale
    col.proOptions = item.pros.slice(); // OGGETTI {name,email}
    state.step = "pick_professional_for_time";
    pending.set(chatId, state);

    const list = item.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
    await reply(
      client,
      chatId,
      tr(chatId, "CHOOSE_PRO_FOR_TIME", time, list, item.pros.length)
    );
    return "";
  }

  if (
    hasPros &&
    item.pros.length === 1 &&
    !col.professionalEmail &&
    !col.professionalName
  ) {
    // un solo professionista: assegnalo automaticamente
    const only = item.pros[0];
    col.professionalName = only.name;
    col.professionalEmail =
      only.email ||
      (typeof proEmailByName === "function" ? proEmailByName(only.name) : null);
    col.professionalAny = false;
  }

  // Se vuoi bloccare il caso "nessun pro e non è ANY", scommenta:
  // if (needPro && (!hasPros || item.pros.length === 0)) {
  //  return safeSend(client, chatId, tr(chatId, "NO_PRO_AVAILABLE_FOR_TIME", time));
  // }

  state.step = "collect";
  pending.set(chatId, state);

  if (typeof scheduleReenter === "function") {
    await scheduleReenter(client, chatId, `ok ${time}`, tools);
    return "";
  }
  // fallback (non dovrebbe servire, ma è sicuro):
  return ""; // evita recursion in-handleMessage

  // ============== Parsing e altre funzioni ==============
  function parseDaypartWindow(text) {
    const t = norm(text);
    const dp = getDaypartBoundaries();
    if (/\bmattin/.test(t)) return dp.mattina;
    if (/\bpomeriggio\b/.test(t)) return dp.pomeriggio;
    if (/\bsera\b/.test(t)) return dp.sera;
    return null;
  }

  // === Giorno chiuso? (settimana + date specifiche)
  function cfgClosedDay(date) {
    const d = date instanceof Date ? date : new Date(date);
    const dayKey = isoWeekday(d); // '1'..'7'

    // chiusure settimanali
    const closed = config.closedDays ?? config.daysOff ?? {};
    if (Array.isArray(closed)) {
      if (closed.map(String).includes(dayKey)) return true;
    } else if (closed && typeof closed === "object") {
      // se esiste la chiave ed è truthy (o non esplicitamente false) consideriamo chiuso
      if (
        Object.prototype.hasOwnProperty.call(closed, dayKey) &&
        closed[dayKey] !== false
      )
        return true;
    }

    // date specifiche (ferie/festivi)
    const toYMD = (dd) =>
      `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(dd.getDate()).padStart(2, "0")}`;
    const ymd = toYMD(d);
    const closedDates = Array.isArray(config.holidays) ?
      config.holidays :
      Array.isArray(config.closedDates) ?
        config.closedDates : [];
    if (closedDates.includes(ymd)) return true;

    return false;
  }

  // === Orari vicini a un target (es. se 10:30 non c'è, proponi 10:00/11:00…)
  function nearestTimes(slots, target, count = 3) {
    const tm = timeToMinutes(target);
    return (slots || [])
      .map((s) => ({
        s,
        d: Math.abs(timeToMinutes(s) - tm)
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
      .map((x) => x.s);
  }

  // === Prompt “scegli servizio” (lista da config)
  function askService(stateIn, chatId) {
    const svcs = cfgServices();
    if (!svcs.length) return "Quale trattamento desideri prenotare?";

    const st = stateIn || getState(chatId);
    st.ui = st.ui || {};
    st.ui.lastServiceList = svcs; // già c’è
    st.collected ||= {};
    st.collected.svcOptions = svcs; // <-- AGGIUNGI QUESTA RIGA
    pending.set(chatId, st);

    return `Quale trattamento desideri prenotare?\n${svcs
      .map((s, i) => `${i + 1}) ${s}`)
      .join("\n")}\n(1-${svcs.length})`;
  }

  // === Filtra times con vincoli after/before tipo "dopo 15:00" / "prima 18:00"
  function filterTimesByAfterBefore(
    times, {
      after = null,
      before = null
    } = {}
  ) {
    let out = Array.isArray(times) ? times.slice() : [];
    if (after) {
      const a = timeToMinutes(after);
      out = out.filter((t) => timeToMinutes(t) >= a);
    }
    if (before) {
      const b = timeToMinutes(before);
      out = out.filter((t) => timeToMinutes(t) <= b);
    }
    return out.sort(compareHHMM);
  }

  // === Se il giorno è oggi, elimina gli orari già passati
  function filterOutPastTimesForToday(day, times) {
    const D = day instanceof Date ? day : new Date(day);
    const now = new Date();
    const isSameDate =
      D.getFullYear() === now.getFullYear() &&
      D.getMonth() === now.getMonth() &&
      D.getDate() === now.getDate();
    if (!isSameDate) return times;

    const curMin = now.getHours() * 60 + now.getMinutes();
    return (times || [])
      .filter((t) => timeToMinutes(t) >= curMin)
      .sort(compareHHMM);
  }

  // FIX Bug #15: Wrapper per garantire filtro past times
  function __ensureFilterPastTimes(day, slots) {
    if (!Array.isArray(slots) || !slots.length) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkDay = day instanceof Date ? new Date(day) : new Date(day);
    checkDay.setHours(0, 0, 0, 0);

    // Applica filtro solo se è oggi
    if (checkDay.getTime() === today.getTime()) {
      try {
        if (typeof filterOutPastTimesForToday === 'function') {
          const times = slots.map(s => typeof s === 'string' ? s : s?.time).filter(Boolean);
          const allowed = filterOutPastTimesForToday(day, times);
          const allowedSet = new Set(allowed);
          return slots.filter(s => {
            const t = typeof s === 'string' ? s : s?.time;
            return allowedSet.has(t);
          });
        }
      } catch (err) {
        log('warn', '[FILTER] Errore filtro past times', {
          error: String(err)
        });
      }
    }

    return slots;
  }

  // === Messaggio di disponibilità (giorno singolo) con raggruppamento per fasce e lista pro nello slot
  async function buildAvailabilityMessage({
    day,
    service = null, // nome servizio (opzionale)
    duration = null, // in minuti (se assente, prende da config servizio o 30)
    professional = null, // email o nome pro (opzionale)
    window = null, // es. ['09:00','12:30']
    after = null, // 'HH:MM'
    before = null, // 'HH:MM'
  } = {}) {
    try {
      const D = atNoon(day);
      if (cfgClosedDay(D)) {
        const next = nextOpenDay(D);
        return `Il giorno ${fmtDate(D)} siamo chiusi. Ti va bene ${fmtDate(
          next
        )}?`;
      }

      // Risoluzione pro
      const proEmail = professional ?
        professional.includes("@") ?
          professional :
          proEmailByName(professional) || null :
        null;

      // Durata
      let durMin = Number(duration);
      if (!Number.isFinite(durMin) || durMin <= 0) {
        durMin = service ? cfgServiceDuration(service) : 30;
      }

      // Prendi slots dettagliati (time + pros)
      const detail = await fetchSlots({
        service,
        day: D,
        duration: durMin,
        professional: proEmail || professional || null,
        wantDetail: true,
      });
      const list = Array.isArray(detail) ? detail : [];
      let times = list.map((x) => x.time);

      // Finestra “mattina/pomeriggio/sera”
      if (window && Array.isArray(window) && window.length === 2) {
        times = filterSlotsByWindow(times, window);
      }

      // Vincoli after/before
      times = filterTimesByAfterBefore(times, {
        after,
        before
      });

      // Se oggi, elimina orari passati
      times = filterOutPastTimesForToday(D, times);

      if (!times.length) {
        const fascia = window ? " nella fascia richiesta" : "";
        return `Per ${fmtDateWithWeekdayIT(D)} non vedo orari liberi${service ? ` per ${service}` : ""
          }${fascia}.`;
      }

      // Mappa time -> dettaglio (per label dei pro)
      const byTime = new Map(list.map((x) => [x.time, x]));

      // Raggruppamento in blocchi
      const grouped = groupSlotsByDaypart(times);
      const renderGroup = (title, arr) => {
        if (!arr || !arr.length) return null;
        const lines = arr
          .map((h) => {
            const item = byTime.get(h) || {
              pros: []
            };
            const lbl = labelProsForSlot(item); // usa la tua versione già presente
            return `• ${h}${lbl ? ` (${lbl})` : ""}`;
          })
          .join("\n");
        return `${title}\n${lines}`;
      };

      const headSvc = service ? ` • ${service}` : "";
      const proLabel = proEmail ? (proNameByEmail(proEmail) || "").trim() : "";
      const headPro = proLabel ? ` • ${proLabel}` : "";
      const blocks = [
        renderGroup(" Mattina", grouped.mattina),
        renderGroup(" Pomeriggio", grouped.pomeriggio),
        renderGroup(" Sera", grouped.sera),
      ]
        .filter(Boolean)
        .join("\n");

      return buildAvailabilityCompactMessage(D, list, {
        offset: 0,
        pageSize: AVAIL_PAGE_SIZE
      });
    } catch (err) {
      log("error", "[AVAIL] buildAvailabilityMessage failed", {
        error: String(err?.stack || err?.message || err),
        day: String(day),
        service,
        duration,
        professional
      });
      return ' Ops, non riesco a calcolare le disponibilità in questo momento. Riprova tra poco oppure scrivi solo il giorno (es. "venerdì") e poi scegli l’orario.';
    }
  }
}

  return { handleNumericReply };
}
