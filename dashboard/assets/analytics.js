'use strict';
// Compatibility entry points: the removed browser/JSON editor cannot save data.
function saveBooking() {
  synkUseCanonicalAppointments();
  return;
}
function openNewBookingModal() {
  synkUseCanonicalAppointments();
  void runAction(()=>gApptOpenForm(null));
}
function closeBookingModal() {
  $('gApptDialog').close();
}
