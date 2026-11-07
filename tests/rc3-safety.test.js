import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { overlapsBusyEvents, validateSlotRequest } from '../src/services/calendar-guard.js';
const read = p => fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('old routes cannot acknowledge booking writes when normalized outbox is bypassed',()=>{
  const php=read('dashboard/api/router.php');
  assert.match(php,/legacy_booking_write_disabled_use_gestione_appuntamenti/);
  assert.match(php,/],410\);/);
});
test('legacy browser actions cannot falsely show successful bookings',()=>{
  for(const [file,entry] of [
    ['dashboard/assets/analytics.js','function saveBooking()'],
    ['dashboard/assets/bookings-edit.js','function saveBookingEdits(andNotify)'],
    ['dashboard/assets/bookings-list.js','async function deleteBooking(id)']]) {
      const source=read(file);
      const start=source.indexOf(entry+' {');
      assert.ok(start>=0,file);
      assert.match(source.slice(start,start+220),/synkUseCanonicalAppointments\(\);\s*return;/);
    }
  const calendar=read('dashboard/assets/calendar.js');
  assert.match(calendar,/editable: false/);
  assert.match(calendar,/eventStartEditable: false/);
});
test('restore scripts recover from a pre-restore error but avoid an automatic restart after pg_restore',()=>{
 const restore=read('strumenti/ripristina.ps1');
 assert.match(restore,/\$servicesStopped -and -not \$restoreAttempted/);
 assert.match(restore,/\$restoreAttempted=\$true/);
 assert.match(restore,/elseif \(\$restoreAttempted\)/);
});
test('updater checks web dashboard in addition to bot health',()=>{
 const update=read('strumenti/aggiorna.ps1');
 assert.match(update,/127\.0\.0\.1:3000\/health/);
 assert.match(update,/127\.0\.0\.1:8080\//);
});
test('Calendar busy matching includes an all-day blocker and ignores non-busy events',()=>{
 const range={start:'2026-10-26T08:00:00.000Z',end:'2026-10-26T09:00:00.000Z'};
 assert.equal(overlapsBusyEvents([{id:'a',start:{date:'2026-10-26'},end:{date:'2026-10-27'}}],range),true);
 assert.equal(overlapsBusyEvents([{status:'cancelled',start:{date:'2026-10-26'},end:{date:'2026-10-27'}}],range),false);
 assert.equal(overlapsBusyEvents([{transparency:'transparent',start:{date:'2026-10-26'},end:{date:'2026-10-27'}}],range),false);
 assert.throws(()=>validateSlotRequest({professionalId:3,start:range.end,end:range.start}),/invalid_calendar_slot/);
});

test('database unavailability cannot silently restore old browser bookings',()=>{
 const s=read('dashboard/assets/whatsapp-templates.js');
 assert.doesNotMatch(s,/JSON\.parse\(localStorage\.getItem\("bookings"/);
 assert.match(s,/APP\.bookings = \[\];\s*showToast\('Agenda non disponibile/);
 assert.doesNotMatch(read('dashboard/assets/bookings-core.js'),/localStorage\.(setItem|removeItem)\('bookings'/);
});
test('new booking navigation opens authoritative normalized appointment editor',()=>{
 const s=read('dashboard/assets/analytics.js');
 const section=s.slice(s.indexOf('function openNewBookingModal()'),s.indexOf('function closeBookingModal()'));
 assert.match(section,/synkUseCanonicalAppointments\(\);/);
 assert.match(section,/gApptOpenForm\(null\)/);
});

test('normalized appointment editor can select clients without a previous appointment and create new clients',()=>{
 const php=read('dashboard/api/router.php');
 const js=read('dashboard/assets/management-appointments.js');
 assert.match(php,/db_clients','db_client_create/);
 assert.match(php,/SELECT client_id,full_name FROM public.clients/);
 assert.match(php,/INSERT INTO public.clients/);
 assert.match(js,/gFetch\('db_clients'/);
 assert.match(js,/gFetch\('db_client_create'/);
 assert.match(js,/gApptNewClientName/);
 assert.doesNotMatch(js,/const r = await gFetch\('db_appointments',\{method:'GET',qs:'&limit=500'\}\)/);
});
