/** Input lifecycle: privacy notice, inactivity resets and conversation telemetry. */
export function createModule(dependencies) {
  const { __dateParsingLocks, chatdbDeleteEntry, ensureContext, getPrivacyText, getState, greetIfReturningUser, isBookingFlowActive, log, markPrivacySent, maybeHandleReviewReply, maybeSendPrivacyNotice, now, pending, privacyCommandKind, releaseSoftHoldByChat, reply, safeSend } = dependencies;
  return async function prepareMessageLifecycle({ client, chatId, textRaw, state, __isReenter }) {
  if (!__isReenter) {
    const __txt = String(textRaw ?? "").trim();

    // Comandi privacy espliciti
    const __pc = privacyCommandKind(__txt);
    if (__pc === "show") {
      await safeSend(client, chatId, getPrivacyText(chatId), {
        noFooter: true
      });
      try {
        markPrivacySent(chatId);
      } catch { }
      return { stopped: true, state };
    }
    if (__pc === "delete") {
      const ok = chatdbDeleteEntry(chatId);
      await safeSend(
        client,
        chatId,
        ok ?
          " Ok! Ho cancellato la cronologia chat salvata. Se vuoi ripartire, scrivi \"prenota\"." :
          "Non ho trovato dati salvati per questo numero.", {
        noFooter: true
      }
      );
      return { stopped: true, state };
    }

    // Privacy automatica al primo messaggio
    let __privacySentNow = false;
    try {
      __privacySentNow = await maybeSendPrivacyNotice(client, chatId);
    } catch (err) {
      log("warn", "[privacy] errore ignorato", err?.message || err);
    }

    // Review reply (non avvia prenotazione)
    try {
      if (__txt) {
        const __handled = await maybeHandleReviewReply(client, chatId, __txt, state);
        if (__handled) return { stopped: true, state };
      }
    } catch (err) {
      log("warn", "[review-reply] errore ignorato", err?.message || err);
    }

    // Saluto solo se NON ho appena inviato privacy (evita doppio messaggio)
    if (!__privacySentNow) {
      await greetIfReturningUser(chatId, client, state);
    }
  }

  // Timeout automatico (anti-incastro): se l'utente sparisce, resetta lo stato
  if (!__isReenter) try {
    ensureContext(state);
    const MAX_IDLE_MIN = Number(process.env.FLOW_IDLE_RESET_MIN || 15);
    const MAX_IDLE = Math.max(5, MAX_IDLE_MIN) * 60 * 1000;

    const lastAt = Number(state.context.lastMessageAt || 0) || 0;
    const inFlow = !!(state.step && state.step !== "collect");

    if (inFlow && lastAt && Date.now() - lastAt > MAX_IDLE) {
      try {
        pending.delete(chatId);
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }
      try {
        __dateParsingLocks.delete(chatId);
      } catch { }
      try {
        releaseSoftHoldByChat?.(chatId);
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", {
          error: String(err)
        }); //  FIX Bug #17
      }

      // Riparti pulito
      state = getState(chatId);
      ensureContext(state);
      state.step = "collect";
      pending.set(chatId, state);

      await reply(
        client,
        chatId,
        "Ho messo da parte la richiesta precedente perché è passato un po’ di tempo  Vuoi *prenotare* o *modificare*?", {
        noFooter: true
      }
      );
      return { stopped: true, state };
    }
  } catch (err) {
    log("warn", "[CATCH] Errore ignorato", {
      error: String(err)
    }); //  FIX Bug #17
  }

  // Tracking leggero per capire se l'utente è bloccato nello stesso step (per suggerimenti)
  if (!__isReenter) try {
    ensureContext(state);
    const nowTs = Date.now();
    const prev = String(state.context._lastStepForCount || "");
    const cur = String(state.step || "");
    state.context.sameStepCount = (prev && prev === cur) ?
      (Number(state.context.sameStepCount || 0) || 0) + 1 :
      0;
    state.context._lastStepForCount = cur;
    state.context.lastMessageAt = nowTs;
    state.context.messageCount = (Number(state.context.messageCount || 0) || 0) + 1;

    const col0 = state.collected || {};
    const active0 = (typeof isBookingFlowActive === "function" && isBookingFlowActive(state, col0));
    if (active0 && !state.context.startedAt) state.context.startedAt = nowTs;

    if (process?.env?.ANALYTICS_BOOKING === "1" && active0) {
      log("analytics", "booking_step", {
        chatId,
        step: state.step,
        messageCount: state.context.messageCount,
        elapsedMs: nowTs - (Number(state.context.startedAt || nowTs) || nowTs),
      });
    }

    pending.set(chatId, state);
  } catch (err) {
    log("warn", "[CATCH] Errore ignorato", {
      error: String(err)
    }); //  FIX Bug #17
  }

    return { stopped: false, state };
  };
}
