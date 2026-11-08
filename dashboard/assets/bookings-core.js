'use strict';
// A read-only in-memory projection, never persisted to localStorage.
function synkLegacyBookings() {
  return Object.freeze(APP.bookings.map(row=>Object.freeze({...row})));
}
