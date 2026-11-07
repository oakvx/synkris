/**
 * conversation/transport: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const { __FOOTER_COOLDOWN, __SEND_DEDUP, __dbInsertChatMessage, ensureContext, isBookingFlowActive, isBookingLocked, log, now, pending } = dependencies;

function __dedupAllow(chatId, text, windowMs = 2000) {
  const now = Date.now();
  const key = String(chatId || "");
  const last = __SEND_DEDUP.get(key);
  if (last && last.text === text && now - last.at < windowMs) return false;
  return true;
}

function __dedupRemember(chatId, text) {
  const key = String(chatId || "");
  __SEND_DEDUP.set(key, {
    text,
    at: Date.now()
  });
}

async function safeSend(client, chatId, text, opts = {}) {
  const t = String(text ?? "");
  if (!t.trim()) return "";

  if (!chatId) {
    log("warn", "safeSend called without chatId", {
      preview: t.slice(0, 120)
    });
    return "";
  }

  // Dedup: se inviamo lo stesso testo a distanza ravvicinata, salta
  const __win = Math.max(0, Number(opts?.dedupWindowMs) || 2000);
  if (!__dedupAllow(chatId, t, __win)) return "";

  // PATCH: Verifica che il client sia pronto
  if (!client || typeof client.sendText !== "function") {
    log("warn", "safeSend: client.sendText not available", {
      chatId
    });
    return "";
  }

  // PATCH: Aggiungi retry con delay
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await client.sendText(chatId, t);
      __dedupRemember(chatId, t);
      void __dbInsertChatMessage(chatId, "out", t);
      log("debug", `[SEND OK] attempt ${attempt}`);
      break; // Successo, esci dal loop
    } catch (e) {
      if (e?.outcome === 'unknown') {
        // v5 may fail after submitting the message. Retrying can send it twice.
        __dedupRemember(chatId, t);
        log('warn', 'Esito invio WhatsApp non confermato; nessun retry automatico');
        return t;
      }
      log("warn", `[SEND FAIL] attempt ${attempt}/${MAX_RETRIES}`, {
        chatId,
        err: e?.message || String(e)
      });

      if (attempt === MAX_RETRIES) {
        log("error", "safeSend: tutti i tentativi falliti", {
          chatId
        });
        return "";
      }

      // Attendi prima di riprovare
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }

  // Footer automatico (solo dopo invio riuscito)
  try {
    if (typeof postReplyHook === "function") {
      await postReplyHook(client, chatId, t, opts);
    }
  } catch (e) {
    log("warn", "safeSend: postReplyHook threw", {
      chatId,
      err: e?.stack || e?.message || e
    });
  }

  return t;
}

async function reply(client, chatId, text, opts = {}) {
  return safeSend(client, chatId, text, opts);
}

async function postReplyHook(client, chatId, sentText, opts = {}) {
  try {
    if (!chatId) return;
    if (opts?.noFooter) return;
    if (!pending || typeof pending.get !== "function") return;

    const st = pending.get(chatId);
    if (!st) return;

    // Solo durante un flow di prenotazione (non in edit/listini)
    const col = st.collected || {};
    const inEdit = typeof st.step === "string" && st.step.startsWith("edit_");
    const inInfo = ["info_select_service", "price_select_service"].includes(st.step);
    if (inEdit || inInfo) return;

    const active =
      (typeof isBookingFlowActive === "function" && isBookingFlowActive(st, col)) ||
      (typeof isBookingLocked === "function" && isBookingLocked(st));
    if (!active) return;

    // Mostra il suggerimento solo se l'utente sembra bloccato nello stesso step
    ensureContext(st);
    const confusion = Number(st.context.sameStepCount || 0) || 0;
    if (confusion < 2) return;

    const HINT = ' Suggerimento: scrivi *annulla* per ricominciare o *modifica* per gestire una prenotazione.';

    // evita loop: se il messaggio appena inviato contiene già il suggerimento, non reinviare
    if (String(sentText || "").includes("Suggerimento:")) return;

    // Cooldown: evita spam
    const __last = __FOOTER_COOLDOWN.get(chatId) || 0;
    if (Date.now() - __last < 60000) return;

    if (!client || typeof client.sendText !== "function") {
      log("warn", "postReplyHook: client.sendText not available", {
        chatId
      });
      return;
    }

    try {
      await client.sendText(chatId, HINT);
      __FOOTER_COOLDOWN.set(chatId, Date.now());
      __dedupRemember(chatId, HINT);
    } catch (e) {
      log("warn", "postReplyHook: client.sendText failed", {
        chatId,
        err: e?.stack || e?.message || e
      });
    }
  } catch (e) {
    log("warn", "postReplyHook", e?.stack || e?.message || e);
  }
}

  return { __dedupAllow, __dedupRemember, safeSend, reply, postReplyHook };
}
