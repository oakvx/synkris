/** Explicit transition registry for new flows; legacy states remain supported. */
const rules = Object.freeze({
  initial: Object.freeze(['choose_service', 'info_select_service', 'edit_pick_booking', 'privacy']),
  choose_service: Object.freeze(['confirm_service', 'pick_professional_for_time', 'initial']),
  confirm_service: Object.freeze(['pick_professional_for_time', 'choose_service', 'initial']),
  pick_professional_for_time: Object.freeze(['pick_date', 'pick_time', 'choose_service', 'initial']),
  edit_pick_booking: Object.freeze(['edit_menu', 'initial']),
  edit_menu: Object.freeze(['edit_reschedule_time', 'edit_cancel_confirm', 'edit_pick_professional', 'initial']),
  edit_cancel_confirm: Object.freeze(['initial', 'edit_menu']),
});
export function canTransition(from, to) {
  if (typeof to !== 'string' || !to || to.length > 80) return false;
  if (!Object.hasOwn(rules, from)) return null; // un-migrated state: do not block legacy flow
  return rules[from].includes(to);
}
export function transition(state, to, { onReject = () => {} } = {}) {
  const allowed = canTransition(state.step || 'initial', to);
  if (allowed === false) { onReject(state.step, to); return false; }
  if (state.step === to) return true;
  state.step = to;
  return true;
}
export function registeredFlows() { return structuredClone(rules); }
