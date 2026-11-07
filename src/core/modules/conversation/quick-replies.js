/** Conversation handler: SEZIONE 2 */
export function createModule(dependencies) {
  const { COURTESY_PATTERNS, COURTESY_RESPONSES, SALON_PHONE, bestServiceBySynonyms, buildServicesMessageForPro, ensureUI, fuzzyService, hasDateOrTime, isUrgencyMessage, loadChatDB, log, looksLikeBooking, now, pending, primaryIntent, releaseSoftHoldByChat, reply, unlockBooking, wantsEditMenu } = dependencies;
  return async function routeQuickReplies({client, chatId, textRaw, state, __isReenter, intentHint = null}) {
  if (!__isReenter && textRaw) {
    const __raw = String(textRaw || "").trim();

    // Cortesia SOLO se NON siamo dentro un flow attivo
    // (altrimenti "ok/va bene" rubano la conferma del menu "Ho capito così")
    const __stepNow = String((pending.get(chatId) || state)?.step || "collect");
    const __inFlowNow = !!(__stepNow && __stepNow !== "collect");

    if (!__inFlowNow && __raw && COURTESY_PATTERNS.some((pattern) => pattern.test(__raw))) {
      // Non rispondere "a caso" se nel messaggio c'è un intento (prenotazione/modifica/info).
      const __intent = intentHint || ((typeof primaryIntent === "function") ? primaryIntent(__raw) : null);
      const __wantsEdit = (typeof wantsEditMenu === "function" ? wantsEditMenu(__raw) : false) || /\b(?:modifica|cambia|sposta|annulla)\b/i.test(__raw);
      const __isBookingLike = (__intent === "appointment") || (typeof looksLikeBooking === "function" ? looksLikeBooking(__raw) : /\b(?:prenot\w*|appunt\w*)\b/i.test(__raw));
      const __isInfoLike = (__intent === "info") || /\b(?:info|informazioni|prezz\w*|listino|costo|quanto\s+(?:costa|dura))\b/i.test(__raw);

      if (!__isBookingLike && !__isInfoLike && !__wantsEdit) {
        // Social / cortesia: rispondi senza toccare lo stato
        const randomResponse = COURTESY_RESPONSES[Math.floor(Math.random() * COURTESY_RESPONSES.length)];
        await reply(client, chatId, randomResponse, {
          noFooter: true
        });
        return { handled: true, textRaw, state };
      }
    }
  }
  // Ringraziamenti = chiusura silenziosa (come "annulla" ma senza messaggi)
  // Serve per evitare loop tipo: bot chiede data -> utente dice "grazie" -> bot resta bloccato sullo step data.
  if (!__isReenter && textRaw && /^(grazie|grazie mille|grazie infinite|ti ringrazio|grazie di tutto|thanks?|thank you|thx)[\s!.]*/i.test(textRaw.trim())) {
    const st = pending.get(chatId);

    try {
      if (st) unlockBooking(st);
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
    try {
      releaseSoftHoldByChat(chatId);
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", {
        error: String(err)
      }); //  FIX Bug #17
    }
    await reply(client, chatId, "Grazie a te per aver usato il nostro servizio! \n");
    return { handled: true, textRaw, state };
  }

  // Uscita rapida (basta/bye) = annulla tutto e chiudi senza rimanere bloccati in un flow
  if (!__isReenter && textRaw && /^(basta(\s+io)?|stop|fine|esci|bye(\s+bye)?|arrivederci|a presto)[\s!.]*$/i.test(textRaw.trim())) {
    const st = pending.get(chatId);
    try {
      if (st) unlockBooking(st);
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
    try {
      releaseSoftHoldByChat(chatId);
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", {
        error: String(err)
      }); //  FIX Bug #17
    }
    await reply(client, chatId, "Va bene, a presto! ", {
      noFooter: true
    });
    return { handled: true, textRaw, state };
  }

  // Gestione saluto + intent di prenotazione (rimuovi saluto e continua)

  // Saluti di apertura (solo se step iniziale)
  if (textRaw && /^(ciao|buongiorno|buonasera|buon\s+giorno|buona\s+sera|salve|hey|ehi|hi|hello)[\s!.]*$/i.test(textRaw.trim()) && state.step === "collect") {
    // Evita doppio saluto: se è appena partito il "bentornato" (inactivity greet), non inviare anche il welcome.
    try {
      const db = loadChatDB();
      const lastGreet = Number(db?.[chatId]?.lastGreet || 0);
      if (lastGreet && Date.now() - lastGreet < 5000) return { handled: true, textRaw, state };
    } catch (e) { }

    await reply(
      client,
      chatId,
      `Ciao! Benvenuto da ${String(process.env.SALON_NAME || 'il salone').slice(0, 80)}, sono _synk_!\n\n` +
      'Come posso aiutarti oggi?\n' +
      '• Scrivi "_*prenota*_" per un nuovo appuntamento\n' +
      '• Scrivi "_*modifica*_" per gestire una prenotazione esistente'
    );
    return { handled: true, textRaw, state };
  }

  // Gestione saluto + intent di prenotazione (rimuovi saluto e continua)
  const hasGreeting = /\b(ciao|buongiorno|buonasera|salve|hey|hi|hello)\b/i.test(textRaw);
  const hasBookingIntent = /\b(prenot|appunt|fiss|riserv|disponibil|posto|quando\s+avete)\w*/i.test(textRaw);
  if (hasGreeting && hasBookingIntent) {
    textRaw = textRaw.replace(/^(ciao|buongiorno|buonasera|buon\s+giorno|buona\s+sera|salve|hey|ehi|hi|hello)[,!\s]*/i, '').trim();
  }

  // Kickoff "prenota" senza dettagli -> vai diretto a choose_service + lista servizi
  if (!__isReenter) {
    const __t = String(textRaw || "").trim();
    let __hasSvc = false;
    let __hasWhen = false;
    try {
      __hasSvc = !!bestServiceBySynonyms(__t) || !!fuzzyService(__t);
    } catch { }
    try {
      __hasWhen = !!hasDateOrTime(__t);
    } catch { }

    const __bareBookingPatterns = [
      // comandi secchi
      /^\s*(?:prenota(?:re)?|prenotazione|appuntamento)\s*[!.?]*\s*$/iu,

      // "voglio/vorrei/mi serve/devo prenotare (un appuntamento)"
      /^\s*(?:voglio|vorrei|volevo|mi\s+serve|devo|posso|potrei)\s+prenotare(?:\s+(?:un|una|uno)\s+appuntamento)?\s*[!.?]*\s*$/iu,

      // "mi serve / voglio un appuntamento"
      /^\s*(?:voglio|vorrei|volevo|mi\s+serve|devo)\s+(?:un|una|uno)\s+appuntamento\s*[!.?]*\s*$/iu,

      // "quando riesci/puoi farmi (un appuntamento)" (messaggio corto)
      /^\s*quando\s+(?:riesci|puoi|potresti)\s+(?:a\s+)?farmi(?:\s+(?:un|una|uno)\s+appuntamento)?\s*[!.?]*\s*$/iu,

      // "quando avete/hai posto"
      /^\s*quando\s+(?:avete|hai)\s+(?:posto|un\s+posto|disponibilit[àa])\s*[!.?]*\s*$/iu,
    ];

    const __bareBooking = !__hasSvc && !__hasWhen && (intentHint === 'appointment' || __bareBookingPatterns.some(r => r.test(__t)));

    if (__bareBooking) {
      // reset soft ma senza rompere stato
      state = pending.get(chatId) || state;
      state.collected = state.collected || {};
      const col = state.collected;

      // non trascinare roba vecchia
      col.service = null;
      col.serviceCandidates = null;
      col.when = null;
      col.time = null;
      col.options = null;

      // scegli servizio
      state.step = "choose_service";

      // usa la stessa builder del menu servizi (come showServicesList)
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

      pending.set(chatId, state);
      await reply(client, chatId, `Ok  Che trattamento vuoi prenotare?\n\n${svcMsg}`, {
        noFooter: true
      });
      return { handled: true, textRaw, state };
    }
  }

  // Scuse
  if (textRaw && /^(scusa|scusami|mi scuso|perdon[ao]|sorry)[\s!.]*$/i.test(textRaw.trim())) {
    const responses = ["Nessun problema! ", "Tranquillo/a, tutto ok! ", "Non ti preoccupare! "];
    await reply(client, chatId, responses[Math.floor(Math.random() * responses.length)]);
    return { handled: true, textRaw, state };
  }

  // Complimenti
  if (textRaw && /^(bravo|brava|ottimo|perfetto|fantastico|bene|ben fatto|complimenti)[\s!.]*$/i.test(textRaw.trim())) {
    const responses = ["Grazie mille! ", "Sono felice di aiutarti! ", "Grazie, è un piacere! "];
    await reply(client, chatId, responses[Math.floor(Math.random() * responses.length)]);
    return { handled: true, textRaw, state };
  }

  // Frustrazione
  if (textRaw && /^(boh|mah|non lo so|che palle|mannaggia)[\s!.]*/i.test(textRaw.trim())) {
    await reply(client, chatId, 'Capisco che possa essere frustrante \nSe hai dubbi, scrivi "aiuto" e ti guiderò passo passo!');
    return { handled: true, textRaw, state };
  }

  // Presenza
  if (textRaw && /^(ci sei|ci sei\?|sei là|hello\?)[\s!.]*/i.test(textRaw.trim())) {
    await reply(client, chatId, "Sì, sono qui!  Come posso aiutarti?");
    return { handled: true, textRaw, state };
  }

  // Urgenze (unghia rotta ecc.) -> chiamata diretta
  if (textRaw && isUrgencyMessage(textRaw)) {
    await reply(
      client,
      chatId,
      `Per le urgenze (es. unghia rotta) ti chiediamo di chiamarci direttamente:  ${SALON_PHONE}`
    );
    return { handled: true, textRaw, state };
  }

  // Contatto diretto
  if (textRaw && /^(numero|telefono|chiamare|contatto diretto|parlare con qualcuno)[\s!.]*/i.test(textRaw.trim())) {
    await reply(client, chatId, `Puoi chiamarci al numero: ${SALON_PHONE}

Oppure continua a chattare con me per prenotare! `);
    return { handled: true, textRaw, state };
  }

  // Conferma generica ( solo in step iniziale, per non rubare i menu/step del booking)
  if (textRaw && state.step === "collect" && /^(okay|va bene|d'?accordo|perfetto|ok)[\s!.]*$/i.test(textRaw.trim())) {
    await reply(client, chatId, "Perfetto! Se hai bisogno di altro, sono qui ");
    return { handled: true, textRaw, state };
  }

  // Aiuto
  if (textRaw && /^(aiuto|help|non capisco|cosa posso fare|come funziona)[\s!.]*/i.test(textRaw.trim())) {
    await reply(
      client,
      chatId,
      'Certo! Ecco cosa posso fare per te:\n\n' +
      'Prenotazioni:\n' +
      '• Scrivi "prenota" per fissare un appuntamento\n' +
      '• Scrivi "modifica" per cambiare una prenotazione\n\n' +
      'Informazioni:\n' +
      '• Chiedi l\'indirizzo o gli orari\n' +
      '• Chiedi info sui trattamenti\n\n' +
      'Come posso aiutarti? '
    );
    return { handled: true, textRaw, state };
  }

  // Saluti di chiusura
  if (!__isReenter && textRaw && /^(arrivederci|a presto|ci vediamo|buona giornata|buona serata|addio|bye|goodbye|see you)[\s!.]*$/i.test(textRaw.trim())) {
    const responses = ["Ciao! A presto! ", "Arrivederci! ", "Buona giornata! ", "A presto! ", "Ci vediamo! "];
    await reply(client, chatId, responses[Math.floor(Math.random() * responses.length)]);
    return { handled: true, textRaw, state };
  }


    return { handled: false, textRaw, state };
  };
}
