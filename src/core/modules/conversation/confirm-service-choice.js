/** Pure step boundary: delegated from numeric conversation router.
 * Does not use Ollama; all transitions remain deterministic. */
export function createModule(dependencies) {
  const { AVAIL_PAGE_SIZE, buildAvailabilityCompactMessage, buildReviewIntakePrompt,
    cfgServiceDuration, compareHHMM, config, ensureContext, fetchSlots,
    filterOutPastTimesForToday, formatDateWithWeekdayIT, log,
    normalizeSlotsDetail, parseListIndex, pending, reply, safeSend,
    validateProfessionalForService } = dependencies;
  return async function confirm_service_choice({ client, chatId, msg, state, col, pureNumber }) {
    const opts = Array.isArray(col.serviceCandidates) ? col.serviceCandidates : [];
    if (!opts.length) {
      state.step = "collect";
      pending.set(chatId, state);
      return safeSend(client, chatId, 'Sessione scaduta. Scrivi di nuovo il trattamento (es. "refill gel").');
    }

    if (!pureNumber.test(String(msg || "").trim())) {
      return safeSend(client, chatId, `Scegli un numero valido (1-${opts.length}).`);
    }

    const n = parseListIndex(msg, opts.length);
    if (!Number.isFinite(n) || n < 1 || n > opts.length) {
      return safeSend(client, chatId, `Scegli un numero valido (1-${opts.length}).`);
    }

    const chosen = opts[n - 1];
    col.service = typeof chosen === "string" ? chosen : String(chosen);

    // pulizia
    col.serviceCandidates = null;

    // Prosegui col flusso normale: prima professionista, poi giorno
    // DEFAULT: se l'utente non ha specificato un pro, è come "Non mi interessa"
    if (!col.professionalName && !col.professionalEmail && col.professionalAny !== true) {
      col.professionalAny = true;
    }

    if (!col.professionalAny && !col.professionalName && !col.professionalEmail) {
      state.step = "pick_professional";
      pending.set(chatId, state);

      const pros = Object.entries(config?.professionals || {}).map(([email, p]) => ({
        email,
        name: (p?.name) || email,
      }));

      if (!pros.length) {
        return safeSend(client, chatId, "Nessun professionista configurato. Contatta il salone.");
      }

      const list =
        `Prima scegli il professionista:\n` +
        `0) Non mi interessa\n` +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n") +
        `\n(0-${pros.length})`;

      await reply(client, chatId, list);
      return "";
    }

    // Se l'utente aveva già dato qualche dettaglio (giorno/orario/pro), mostra il riepilogo "Ho capito così"
    //   e lascia che scelga "5) Conferma e continua" (o modifichi dal menu).
    try {
      // normalizza col.when se arriva serializzato (stringa/timestamp)
      if (col.when && !(col.when instanceof Date)) {
        const __d = new Date(col.when);
        if (!Number.isNaN(__d.getTime())) col.when = __d;
      }

      const hasAnyDetail = !!(col.when || col.time || col._preferredTime || col.professionalAny === true || col.professionalEmail || col.professionalName);

      if (hasAnyDetail && typeof buildReviewIntakePrompt === "function") {
        const built = buildReviewIntakePrompt(col);
        try {
          ensureContext(state);
        } catch { }
        try {
          state.context.reviewIntakeMap = built.map;
          state.context.reviewIntakeMsg = built.msg;
        } catch { }
        state.step = "review_intake";
        pending.set(chatId, state);
        await reply(client, chatId, built.msg, {
          noFooter: true
        });
        return "";
      }
    } catch { }

    // Se l'utente ha già indicato la data (fast-path), non chiedere di nuovo: mostra direttamente gli slot
    if (col.when && !Number.isNaN(new Date(col.when).getTime())) {
      const day = (col.when instanceof Date) ? col.when : new Date(col.when);
      col.when = day; // normalizza (se era stringa)

      const duration = typeof cfgServiceDuration === "function" ? cfgServiceDuration(col.service) || 30 : 30;
      const professional = col.professionalEmail || col.professionalName || null;

      const rawList = await fetchSlots({
        service: col.service,
        day,
        duration,
        professional,
        wantDetail: true,
      });

      let slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

      // Se oggi, elimina orari passati (coerente con lo step choose_day)
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
      state.step = "pick_time";

      const availMsg = buildAvailabilityCompactMessage(day, slots, {
        offset: 0,
        pageSize: AVAIL_PAGE_SIZE
      });
      await reply(client, chatId, availMsg);

      pending.set(chatId, state);
      return "";
    }

    state.step = "choose_day"; // data non ancora indicata
    pending.set(chatId, state);

    await reply(
      client,
      chatId,
      `Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23 ottobre", "28 ottobre")`
    );
    return "";

  };
}
