/** Dedicated state handler: review_intake. Preserves the legacy handler contract. */
export function createModule(dependencies) {
  const { AVAIL_PAGE_SIZE, atNoon, buildAvailabilityCompactMessage, buildReviewIntakePrompt, buildServicesMessageForPro, cfgServiceDuration, compareHHMM, ensureContext, ensureUI, extractReviewEntities, fetchSlots, filterOutPastTimesForToday, formatDateWithWeekdayIT, getAllProsList, getDurForPro, log, normalizeSlotsDetail, pending, proEmailByName, releaseSoftHoldByChat, reply, resolveReviewMenuIntent, scheduleReenter, setAndPersist, unlockBooking, validateProfessionalForService } = dependencies;
  return async function handleReviewIntake(ctx) {
    const { client, chatId, msg, pureNumber, state, col, tools, setAndPersist } = ctx;

    try {
      ensureContext(state);
    } catch { }
    const map = state?.context?.reviewIntakeMap || null;
    const prompt = state?.context?.reviewIntakeMsg || null;

    const raw = String(msg || "").trim();
    const low = raw.toLowerCase();

    const clearReview = () => {
      try {
        ensureContext(state);
        state.context.reviewIntakeMap = null;
        state.context.reviewIntakeMsg = null;
      } catch { }
    };

    const cancelNow = () => {
      try {
        if (state) unlockBooking(state);
      } catch { }
      try {
        pending.delete(chatId);
      } catch { }
      try {
        releaseSoftHoldByChat(chatId);
      } catch { }
    };

    const wantsCancel =
      /^\s*0\s*[\).]?\s*$/.test(raw) ||
      /^(annulla|annula|cancel|stop|fine|esci)\b/i.test(low);

    if (wantsCancel) {
      clearReview();
      cancelNow();
      await reply(client, chatId, ' Operazione annullata. Se vuoi ricominciare, scrivi "prenota" o "appuntamento".', {
        noFooter: true
      });
      return "";
    }

    let action = null;

    // PRIORITÀ: comandi menu ("cambia trattamento/giorno/orario/pro") prima di fare slot-filling
    try {
      const intent = (typeof resolveReviewMenuIntent === "function") ? resolveReviewMenuIntent(raw) : null;
      if (intent) action = intent;
    } catch { }

    // Entity extractor: se nel testo libero ci sono info (servizio / pro / data / orario),
    // aggiorna gli slot e prosegui come se l'utente avesse scelto "continua".
    const ent = (!action && typeof extractReviewEntities === "function") ? extractReviewEntities(chatId, raw) : null;
    if (ent) {
      try {
        ensureContext(state);
      } catch { }

      // servizio
      if (ent.service) {
        col.service = ent.service;
        col.serviceCandidates = null;
        col.options = null;
        col.time = null;
      }

      // professionista
      if (typeof ent.professionalAny === "boolean") {
        col.professionalAny = ent.professionalAny;
        if (ent.professionalAny) {
          col.professionalEmail = null;
          col.professionalName = null;
        }
      }
      if (ent.professionalEmail || ent.professionalName) {
        col.professionalAny = false;
        if (ent.professionalName) col.professionalName = ent.professionalName;
        if (ent.professionalEmail) col.professionalEmail = ent.professionalEmail;
        if (!ent.professionalEmail && ent.professionalName && typeof proEmailByName === "function") {
          try {
            col.professionalEmail = proEmailByName(ent.professionalName) || col.professionalEmail || null;
          } catch { }
        }
        col.options = null;
        col.time = null;
      }

      // data
      if (ent.when) {
        col.when = ent.when;
        col.options = null;
        col.time = null;
      }

      // orario (preferenza)
      if (ent.time) {
        try {
          ensureContext(state);
          state.context.preferredTime = ent.time;
        } catch { }
        col._preferredTime = ent.time;
        col.time = null;
      }

      // Se (servizio, professionista) incompatibili, ripulisci lo slot che crea conflitto
      try {
        if (!col.professionalAny && col.professionalEmail && col.service && typeof validateProfessionalForService === "function") {
          const chk = await validateProfessionalForService(col.service, col.professionalEmail);
          if (chk && chk.ok === false) {
            // L'utente ha indicato un pro: meglio chiedere di cambiare trattamento (lista filtrata)
            col.service = null;
            col.options = null;
            col.time = null;
          }
        }
      } catch { }

      setAndPersist();

      // Feedback immediato: aggiorna "Ho capito così" quando l'utente scrive info spezzettate
      try {
        const built = buildReviewIntakePrompt(col);
        ensureContext(state);
        state.context.reviewIntakeMap = built.map;
        state.context.reviewIntakeMsg = built.msg;
        pending.set(chatId, state);
        await reply(client, chatId, built.msg, {
          noFooter: true
        });
        return "";
      } catch {
        // fallback: se qualcosa va storto, continua come prima
        action = "continue";
      }

    }

    const wantsContinueWord =
      /^\s*(?:(?:\p{Extended_Pictographic}|\uFE0F)+\s*)?(continua|ok(?:ay)?|va\s*bene(?:\s*cos[iì])?|va\s*benissimo|benissimo|perfetto|d['’]accordo|conferma|confermo|confermare|avanti|procedi|prosegui|vai|si|sì|yes)\b/i.test(low);

    if (!action && wantsContinueWord) {
      action = "continue";
    } else if (!action && pureNumber.test(raw) && map) {
      const m = raw.match(/^\s*(\d+)/);
      const key = m ? String(m[1]) : null;
      action = key && map[key] ? map[key] : null;
    }

    if (!action) {
      const intent = (typeof resolveReviewMenuIntent === "function") ? resolveReviewMenuIntent(raw) : null;
      if (intent) action = intent;
    }

    if (!action) {
      await reply(client, chatId, prompt || "Scegli un'opzione valida dal menu (oppure 0 per annullare).", {
        noFooter: true
      });
      return "";
    }

    // helper: mostra lista professionisti (step pick_professional)
    const showProsList = async () => {
      const pros = getAllProsList();
      if (!pros.length) {
        state.step = "collect";
        clearReview();
        pending.set(chatId, state);
        await reply(client, chatId, "Nessun professionista configurato. Contatta il salone.", {
          noFooter: true
        });
        return "";
      }

      const list =
        `Prima di tutto scegli *con chi vuoi effettuare il trattamento*:\n` +
        `0) Non mi interessa\n` +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n") +
        `\n(0-${pros.length})`;

      pending.set(chatId, state);
      await reply(client, chatId, list, {
        noFooter: true
      });
      return "";
    };

    // helper: mostra lista servizi (step choose_service)
    const showServicesList = async () => {
      const proEmail =
        col.professionalAny ?
          null :
          (col.professionalEmail ||
            (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null) ||
            null);

      const {
        available,
        msg: svcMsg
      } = buildServicesMessageForPro(proEmail);
      col.serviceOptions = available;
      col.svcOptions = available;
      try {
        ensureUI(state);
        state.ui.lastServiceList = available;
      } catch { }
      pending.set(chatId, state);
      await reply(client, chatId, svcMsg, {
        noFooter: true
      });
      return "";
    };

    // helper: mostra disponibilità orari (step pick_time)
    const showPickTime = async () => {
      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        return await showServicesList();
      }
      if (!col.when) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "23 ottobre")', {
          noFooter: true
        });
        return "";
      }

      const professional = col.professionalAny ? null : (col.professionalEmail || col.professionalName || null);
      const duration = (typeof getDurForPro === "function") ?
        getDurForPro(col.service, (col.professionalAny ? null : col.professionalEmail)) :
        ((typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

      const rawList = await fetchSlots({
        service: col.service,
        day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
        duration,
        professional,
        wantDetail: true,
      });

      let slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

      try {
        if (typeof filterOutPastTimesForToday === "function" && slots.length) {
          const allowed = filterOutPastTimesForToday(col.when, slots.map((x) => x.time));
          const set = new Set(allowed);
          slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        });
      }

      if (!slots.length) {
        const dayStr = typeof formatDateWithWeekdayIT === "function" ?
          formatDateWithWeekdayIT(col.when) :
          (col.when?.toLocaleDateString?.() || "");
        col.when = null;
        col.time = null;
        col.options = null;
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, `Nessun orario libero per ${dayStr} \nVuoi provare un altro giorno?`, {
          noFooter: true
        });
        return "";
      }

      col.options = slots;
      col.time = null;
      state.step = "pick_time";
      try {
        ensureContext(state);
        state.context.availOffset = 0;
        state.context.availFilterPart = null;
      } catch { }

      pending.set(chatId, state);
      const msgOut = buildAvailabilityCompactMessage(col.when, slots, {
        offset: 0,
        pageSize: AVAIL_PAGE_SIZE
      });
      await reply(client, chatId, msgOut, {
        noFooter: true
      });
      return "";
    };

    // ---- azioni menu ----
    if (action === "edit_service") {
      clearReview();
      col.service = null;
      col.serviceCandidates = null;
      col.time = null;
      col.options = null;
      state.step = "choose_service";
      pending.set(chatId, state);
      return await showServicesList();
    }

    if (action === "edit_professional") {
      clearReview();
      col.professionalAny = false;
      col.professionalName = null;
      col.professionalEmail = null;
      col.time = null;
      col.options = null;
      state.step = "pick_professional";
      pending.set(chatId, state);
      return await showProsList();
    }

    if (action === "edit_when") {
      clearReview();
      col.when = null;
      col.time = null;
      col.options = null;
      state.step = "choose_day";
      pending.set(chatId, state);
      await reply(client, chatId, 'Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "23 ottobre")', {
        noFooter: true
      });
      return "";
    }

    if (action === "edit_time") {
      clearReview();
      col.time = null;
      col.options = null;
      state.step = "pick_time";
      pending.set(chatId, state);
      return await showPickTime();
    }

    // continue
    if (action === "continue") {
      clearReview();

      const needPro = (!col.professionalAny && !col.professionalName && !col.professionalEmail);
      if (needPro) {
        state.step = "pick_professional";
        pending.set(chatId, state);
        return await showProsList();
      }

      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        return await showServicesList();
      }

      if (!col.when) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "23 ottobre")', {
          noFooter: true
        });
        return "";
      }

      if (!col.time) {
        state.step = "pick_time";
        pending.set(chatId, state);
        return await showPickTime();
      }

      // se abbiamo già tutto, chiedi nome (o finalizza se già ok)
      const nameOk = !!state.context?.nameConfirmed &&
        col.customerName &&
        String(col.customerName).trim().split(/\s+/).filter(Boolean).length >= 2;

      if (!nameOk) {
        state.step = "collect_name";
        try {
          ensureContext(state);
          state.context.awaitingName = true;
          state.context.nameConfirmed = false;
        } catch { }
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

      state.step = "finalize_booking";
      pending.set(chatId, state);
      if (typeof scheduleReenter === "function") {
        await scheduleReenter(client, chatId, "ok", tools);
      }
      return "";
    }

    await reply(client, chatId, prompt || "Scegli un'opzione valida dal menu (oppure 0 per annullare).", {
      noFooter: true
    });
    return "";
  };
}
