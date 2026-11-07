/**
 * Localized text used by the WhatsApp booking conversation.
 * The translation functions intentionally keep the existing signatures.
 */
export const MESSAGES = {
  it: {
    CHOOSE_SLOT_FOR_DAY: (day, lines, n) =>
      `Disponibilità per ${day}:\n${lines}\n\nScrivi l'orario desiderato (es. "14:30").`,
    INVALID_RANGE: (n) => `Scrivi un numero valido (1-${n})`,
    CHOOSE_PRO_FOR_TIME: (hhmm, list, n) =>
      `Chi preferisci alle ${hhmm}?\n${list}\n(1-${n})`,
    NO_FUTURE_BOOKINGS: "Non ho trovato prenotazioni future col tuo numero.",
    PICK_BOOKING_TO_EDIT: (lines, n) =>
      `Quale prenotazione vuoi gestire?\n${lines}\n(1-${n})`,
  },
  en: {
    CHOOSE_SLOT_FOR_DAY: (day, lines, n) =>
      `Availability for ${day}:\n${lines}\n\nType the time you want (e.g. "14:30").`,
    INVALID_RANGE: (n) => `Please send a valid number (1-${n})`,
    CHOOSE_PRO_FOR_TIME: (hhmm, list, n) =>
      `Who do you prefer at ${hhmm}?\n${list}\n(1-${n})`,
    NO_FUTURE_BOOKINGS: "I couldn't find any upcoming bookings for your number.",
    PICK_BOOKING_TO_EDIT: (lines, n) =>
      `Which booking do you want to manage?\n${lines}\n(1-${n})`,
  },
};
