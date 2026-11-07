import { answerServiceQuestion } from '../../../ai/information-assistant.js';
/** Conversation handler: SEZIONE 1 */
export function createModule(dependencies) {
  const { bestServiceBySynonyms, cfgServiceDuration, cfgServiceItem, cfgServicePriceText, cfgServices, ensureContext, formatDurationMin, isInCriticalStep, log, pending, reply } = dependencies;
  return async function routeInformation({client, chatId, textRaw, state, __isReenter, intentHint = null}) {
  if (!__isReenter) try {
    if (typeof textRaw === "string" && textRaw.trim()) {
      const raw = textRaw.trim();

      const inEdit = typeof state.step === "string" && state.step.startsWith("edit_");
      if (!isInCriticalStep(state.step) && !inEdit) {
        // Keyword info prioritarie
        const INFO_PATTERNS = [
          // Comandi secchi (quando l'utente scrive solo "info")
          /^\s*(?:info|listino|prezzi?|tariffe?)\s*$/i,

          // Prezzi e costi - richiede contesto più specifico
          /\b(?:qual(?:e|i)\s+(?:è|sono)\s+(?:il|i|la|le)\s+)?(prezzo|costo|tariffa|listino)\b/i,
          /\bquanto\s+(?:costa(?:no)?|dura(?:no)?|viene(?:gono)?)\b/i,

          // Prima volta - richiede contesto di cliente
          /\b(?:sono|è)\s+(?:un[oa]?\s+)?(?:nuov[oa]|prim[oa])\s+client[ea]\b/i,
          /\b(?:è|sarebbe)\s+la\s+(?:mia|sua)\s+prima\s+volta\b/i,

          // Richieste informazioni esplicite
          /\b(?:vorrei|posso\s+avere|mi\s+(?:serve(?:no)?|servirebbero?))\s+(?:delle?\s+)?informazioni\b/i,
          /\b(?:mi\s+)?(?:puoi|può)\s+(?:dare|fornire|spiegare)\s+(?:delle?\s+)?(?:info|informazioni|dettagli)\b/i,
          /\b(?:mi\s+)?(?:servirebbero?|avrei\s+bisogno\s+di)\s+(?:delle?\s+)?(?:info|informazioni|dettagli)\b/i,

          // Durata con contesto
          /\b(?:quanto\s+tempo|quale\s+(?:è|sono)\s+la)\s+durat[ae]\b/i,
          /\bper\s+quanto\s+tempo\b/i
        ];

        const BOOKING_PATTERNS = [
          // Prenotazioni esplicite
          /\b(?:vorrei|voglio|posso|potrei)\s+(?:fare\s+)?(?:un[ao]?\s+)?(?:prenotazione|appuntamento)\b/i,
          /\b(?:prenot[ao]|prenot(?:are|iamo)|prenoterei)\b/i,

          // Typo “apputmamento / appuntameto / …”
          /\bappu\w{0,8}mento\b/i,

          // Disponibilità con intent chiaro
          /\b(?:avete|ci\s+sono|c'è|controllare)\s+(?:un\s+)?(?:posto|slot|buco|disponibilit[àa])\b/i,
          /\b(?:siete|sei)\s+(?:liber[io]|disponibil[io])\b/i,

          // Richieste orari/posti specifiche
          /\bavete\s+(?:posti|orari)\s+(?:liberi|disponibili)\b/i,
          /\bposso\s+(?:venire|passare)\s+(?:domani|oggi|stasera)\b/i
        ];

        const isInfoLike = INFO_PATTERNS.some(p => p.test(raw));

        // When hints più restrittivi - richiede contesto di prenotazione
        const hasWhenHint = (
          // Solo se c'è già un pattern di booking
          BOOKING_PATTERNS.some(p => p.test(raw)) && (
            // Temporal references
            /\b(?:per\s+)?(?:oggi|domani|dopodomani|stasera|stamattina|pomeriggio)\b/i.test(raw) ||
            /\b(?:per\s+)?(?:lun(?:ed[iì])?|mar(?:ted[iì])?|mer(?:coled[iì])?|gio(?:ved[iì])?|ven(?:erd[iì])?|sab(?:ato)?|dom(?:enica)?)\b/i.test(raw) ||
            /\btra\s+\d+\s+(?:giorn[io]|settimane)\b/i.test(raw) ||
            // Time formats (solo se preceduti da "alle" o "verso")
            /\b(?:alle|verso|per\s+le)\s+([01]?\d|2[0-3])[:.][0-5]\d\b/i.test(raw) ||
            // Date formats (solo se con separatore chiaro)
            /\b([0-3]?\d)\s*[\/\-]\s*([01]?\d)(?:\s*[\/\-]\s*\d{2,4})?\b/.test(raw)
          )
        );

        const isBookingLike = BOOKING_PATTERNS.some(p => p.test(raw)) || hasWhenHint;

        if ((intentHint === 'info' || isInfoLike) && !isBookingLike) {
          const svcs = cfgServices() || [];
          if (!svcs.length) {
            await reply(client, chatId, "Nessun trattamento configurato. Contatta il salone.");
            return true;
          }

          // Estrai servizio menzionato
          const svcHit = typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(raw) : null;
          // Ricorda il trattamento: se l'utente poi scrive solo giorno/ora, possiamo proseguire più facilmente
          if (svcHit) {
            try {
              ensureContext(state);
              state.context.preferredService = svcHit;
              pending.set(chatId, state);
            } catch (err) {
              log("warn", "[CATCH] Errore ignorato", {
                error: String(err)
              });
            }
          }
          const pick = svcHit && svcs.includes(svcHit) ? [svcHit] : svcs;

          // Output migliorato senza numeri
          const lines = pick.map((svc) => {
            const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;

            const label = (it && (it.label || it.name)) || svc;

            const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "";
            const price = (priceRaw && String(priceRaw).trim()) || "su richiesta";

            const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
            const durTxt = typeof formatDurationMin === "function" ?
              (formatDurationMin(dur) || `${dur} min`) :
              `${dur} min`;

            // Mostra nome del servizio, prezzo e durata senza elementi decorativi.
            return `*${label}* • ${price} • ${durTxt}`;
          });

          const header = svcHit ? "Dettagli trattamento:" : "I nostri trattamenti:";
          let msg = `${header}\n\n` + lines.join("\n\n");

          // Optional, grounded response: the model only sees one public service entry.
          if (svcHit && pick.length === 1) {
            const item = typeof cfgServiceItem === 'function' ? cfgServiceItem(svcHit) : null;
            const generated = await answerServiceQuestion({
              question: raw,
              facts: {
                service: item?.label || item?.name || svcHit,
                price: typeof cfgServicePriceText === 'function' ? cfgServicePriceText(svcHit) : '',
                duration: typeof cfgServiceDuration === 'function' ? `${cfgServiceDuration(svcHit)} minuti` : '',
                description: item?.description || '',
              },
            });
            if (generated) msg = generated;
          }
          msg += "\n\n_Se vuoi prenotare, dimmi giorno e ora._";

          await reply(client, chatId, msg, {
            noFooter: true
          });
          return true;
        }
      }
    }
  } catch (err) {
    log("warn", "[INFO/LISTINO] Errore rilevamento info", err?.message || err);
  }


    return false;
  };
}
