/** Pure step boundary: delegated from numeric conversation router.
 * Does not use Ollama; all transitions remain deterministic. */
export function createModule(dependencies) {
  const { AVAIL_PAGE_SIZE, buildAvailabilityCompactMessage, buildReviewIntakePrompt,
    cfgServiceDuration, compareHHMM, config, ensureContext, fetchSlots,
    filterOutPastTimesForToday, formatDateWithWeekdayIT, log,
    normalizeSlotsDetail, parseListIndex, pending, reply, safeSend,
    validateProfessionalForService } = dependencies;
  return async function listed_service_choice({ client, chatId, msg, state, col, pureNumber }) {
    const n = parseListIndex(
      msg,
      Array.isArray(state.ui && state.ui.lastServiceList) ?
        state.ui.lastServiceList.length :
        Array.isArray(col.svcOptions) ?
          col.svcOptions.length :
          Array.isArray(col.serviceOptions) ?
            col.serviceOptions.length :
            state.options && Array.isArray(state.options.services) ?
              state.options.services.length :
              Array.isArray(config?.services) ?
                config.services.length :
                0
    );

    const candidates = [
      state.ui && Array.isArray(state.ui.lastServiceList) ?
        state.ui.lastServiceList :
        null,
      Array.isArray(col.svcOptions) ? col.svcOptions : null, // <- aggiunto (tuo nome)
      Array.isArray(col.serviceOptions) ? col.serviceOptions : null, // <- legacy
      state.options && Array.isArray(state.options.services) ?
        state.options.services :
        null,
      Array.isArray(config?.services) ? config.services : null,
    ].filter(Boolean);

    const opts = candidates[0] || [];
    if (!Number.isFinite(n) || n < 1 || n > opts.length) {
      return safeSend(
        client,
        chatId,
        `Scegli un numero valido (1-${opts.length}).`
      );
    }

    const chosen = opts[n - 1];
    const svc =
      typeof chosen === "string" ?
        chosen :
        chosen?.name || chosen?.id || chosen?.title || String(chosen);

    col.service = svc;

    // Controllo compatibilità professionista  servizio
    const check = await validateProfessionalForService(col.service, col.professionalEmail);

    if (!check.ok) {
      await reply(client, chatId, check.reason || "Questo servizio non è disponibile con il professionista selezionato.");
      state.step = "choose_service";
      pending.set(chatId, state);
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
