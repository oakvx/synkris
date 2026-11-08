'use strict';
// Deliberately refuses legacy browser writes, including notification shortcuts.
function saveBookingEdits(andNotify) {
  synkUseCanonicalAppointments();
  return;
}
