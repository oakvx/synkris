'use strict';
async function loadBookings() {
  try {
    const result = await gFetch('db_appointments');
    APP.bookings = result.appointments;
    return APP.bookings;
  } catch (error) {
    APP.bookings = [];
    showToast('Agenda non disponibile. Usa Gestione appuntamenti e verifica il database.', true);
    throw error;
  }
}
