/**
 * Numeric day selection for the availability flow.
 *
 * This module handles only selection. Availability rules and provider access
 * remain with buildAvailabilityMessage so they can be tested independently.
 */
export function createModule({
  parseListIndex,
  daysInMonth,
  atNoon,
  itaWeekdayName,
  safeSend,
  pending,
}, { buildAvailabilityMessage }) {
  function chosenDate(flow, input) {
    if (flow.mode === 'month') {
      const lastDay = daysInMonth(flow.year, flow.monthIdx);
      const day = parseListIndex(input, lastDay);
      if (!Number.isInteger(day) || day < 1 || day > lastDay) {
        return { error: `Giorno non valido (1-${lastDay}).` };
      }
      return { day: new Date(flow.year, flow.monthIdx, day, 12, 0, 0, 0) };
    }

    if (flow.mode === 'week') {
      const days = flow.days || [];
      const selection = parseListIndex(input, days.length);
      const day = days[selection - 1] || days.find(item => item.getDate() === selection);
      if (day) return { day };
      const options = days.map((date, index) =>
        `${index + 1}) ${String(date.getDate()).padStart(2, '0')} ${itaWeekdayName(date)}`);
      return { error: `Scegli 1-${days.length} o un giorno presente nella lista:\n${options.join('\n')}` };
    }

    return { error: 'Selezione non valida. Riprova indicando un giorno.' };
  }

  return async function chooseAvailabilityDay({ client, chatId, msg, state }) {
    const flow = state?.availFlow;
    if (flow?.awaiting !== 'day') return { handled: false };

    const selected = chosenDate(flow, msg);
    if (!selected.day) {
      return { handled: true, result: await safeSend(client, chatId, selected.error) };
    }

    const collected = state.collected || {};
    const message = await buildAvailabilityMessage({
      day: atNoon(selected.day),
      service: collected.service || null,
      duration: null,
      professional: collected.professionalEmail || collected.professionalName || null,
    });
    state.availFlow = null;
    pending.set(chatId, state);
    return { handled: true, result: await safeSend(client, chatId, message) };
  };
}
