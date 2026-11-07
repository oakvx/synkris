import { fmtDateLongIT } from './availability-format.js';

/** Create the follow-up message asking for a customer review. */
export function buildReviewMessage(booking) {
  const name = booking?.customerName ? ` ${booking.customerName}` : "";
  const svc = booking?.service || booking?.serviceName || "il trattamento";
  const pro = booking?.professionalName ? ` con ${booking.professionalName}` : "";
  // Il link e' specifico del salone; nessun indirizzo esterno incorporato nel codice.
  const rawLink = String(process.env.REVIEW_URL || '').trim();
  const link = /^https:\/\/[^\s]+$/i.test(rawLink) ? rawLink : '';
  const linkLine = link ? `\nLasciaci una recensione qui: ${link}` : "";
  return `Ciao${name}! Com'è andata la ${svc}${pro}? Il tuo feedback ci aiuta a migliorare.${linkLine}`;
}

/** Create the reminder sent shortly before an appointment. */
export function buildConfirmMessage(booking) {
  const name = booking?.customerName ? ` ${booking.customerName}` : "";
  const svc = booking?.service || "il trattamento";
  const pro = booking?.professionalName ? ` con ${booking.professionalName}` : "";
  const dt = booking?.startTime ? new Date(booking.startTime) : null;

  // Formato leggibile, senza anno: "2 gennaio".
  const dd = dt ? fmtDateLongIT(dt, {
    includeYear: false
  }) : "";

  const tt = dt ?
    `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}` :
    "";

  return `Ciao${name}! Promemoria: ${svc}${pro} il ${dd} alle ${tt}. Non vediamo l'ora di vederti!\n\nNota: per modificare la prenotazione devi rifarla da capo.`;
}
