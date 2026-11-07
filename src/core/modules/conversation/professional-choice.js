/** Dedicated state handler: pick_professional_for_time. Preserves the legacy handler contract. */
export function createModule(dependencies) {
  const { parseListIndex, pending, resolveProReply, safeSend, scheduleReenter, setAndPersist } = dependencies;
  return async function handleProfessionalChoice(ctx) {
    const { client, chatId, msg, pureNumber, state, col, tools, setAndPersist } = ctx;

    const pros =
      Array.isArray(col.proOptions) && col.proOptions.length ?
        col.proOptions.slice() :
        Array.isArray(state.proOptions) && state.proOptions.length ?
          state.proOptions.slice() : [];

    if (!pros.length) {
      state.step = "collect";
      pending.set(chatId, state);
      return safeSend(client, chatId, "Ops, non riesco a trovare i professionisti disponibili. Riprova.");
    }

    // Parsing numero
    if (pureNumber.test(msg)) {
      const idx = parseListIndex(msg, pros.length);
      if (!Number.isFinite(idx) || idx < 1 || idx > pros.length) {
        return safeSend(client, chatId, `Scegli un numero valido (1-${pros.length}).`);
      }
      const chosen = pros[idx - 1];
      col.professionalName = chosen && chosen.name ? chosen.name : null;
      col.professionalEmail = chosen && chosen.email ? chosen.email : null;
      col.professionalAny = false;
      col.proOptions = null;

      // FIX: Passa a "collect" e re-entra
      state.step = "collect";
      pending.set(chatId, state);

      if (typeof scheduleReenter === "function") {
        await scheduleReenter(client, chatId, "ok professionista", tools);
        return "";
      }
      return ""; // evita recursion in-handleMessage

    }

    // Parsing testo (nome professionista)
    const choice =
      typeof resolveProReply === "function" ? resolveProReply(msg, pros) : null;
    if (choice) {
      if (choice.any) {
        col.professionalAny = true;
        col.professionalName = null;
        col.professionalEmail = null;
      } else {
        col.professionalName = choice.name || null;
        col.professionalEmail = choice.email || null;
        col.professionalAny = false;
      }
      col.proOptions = null;

      // FIX: Passa a "collect" per permettere al flusso normale di gestire il prossimo step
      state.step = "collect";
      pending.set(chatId, state);

      // Re-entra nel flusso per processare il giorno (se già presente) o chiederlo
      if (typeof scheduleReenter === "function") {
        await scheduleReenter(client, chatId, "ok professionista", tools);
        return "";
      }
      return ""; // evita recursion in-handleMessage
    }

    // Risposta non valida
    return safeSend(
      client,
      chatId,
      `Risposta non valida. Rispondi con il numero (1-${pros.length}) oppure scrivi il nome del professionista.`
    );
  };
}
