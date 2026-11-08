'use strict';
const APP = {page:'overview',bookings:[],catalog:null,appointments:[],selectedChat:null};
const $ = id => document.getElementById(id);
const PAGE_INFO = {
  overview:['Centro operativo','Una visione chiara di ciò che succede nel salone.'],
  appointments:['Appuntamenti','Il tempo delle tue clienti, organizzato con cura.'],
  clients:['Clienti','Le persone al centro del tuo lavoro.'],
  chats:['Conversazioni','Il tuo team e WhatsApp, nella stessa conversazione.'],
  catalog:['Trattamenti e team','Competenze, durate e piccoli dettagli che fanno la differenza.'],
  schedule:['Orari e assenze','Organizza il ritmo della settimana.'],
  waitlist:['Lista d’attesa','Un’opportunità in più, solo con il consenso della cliente.'],
  settings:['Impostazioni e backup','Le informazioni del salone e la cura dei tuoi dati.'],
};
const PAGE_LOADERS = {};
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) throw new Error('Inline handlers are not permitted');
    else if (key in node && !key.startsWith('aria') && !key.startsWith('data-')) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function empty(message = 'Nessun elemento da mostrare.') { return el('p', {class:'muted',text:message}); }
function badge(text, kind = 'neutral') { return el('span', {class:'badge '+kind,text}); }
function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('it-IT',{timeZone:'Europe/Rome',dateStyle:'short',timeStyle:'short'}).format(date) : '—';
}
function salonLocalInput(value = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const ERRORS = {
  login_required:'Sessione scaduta. Ricarica la pagina e accedi di nuovo.', csrf_invalid:'Sessione non valida. Ricarica la pagina.',
  calendar_unavailable:'Google Calendar non è disponibile. Nessuna conferma: riprova dopo la verifica tecnica.',
  calendar_slot_occupied:'Questo orario è occupato su Google Calendar.', calendar_reconciliation_required:'Prenotazioni sospese: contatta il tecnico per la riconciliazione Calendar.',
  conflict_reload_before_retry:'Conflitto con dati già presenti. Aggiorna e verifica prima di riprovare.',
  appointment_changed_reload:'L’appuntamento è stato modificato. Chiudi e riapri la scheda prima di riprovare.',
  calendar_sync_pending_or_attention:'Attendi la sincronizzazione Calendar o richiedi una verifica tecnica.',
  calendar_link_requires_review:'Collegamento Calendar da verificare con il tecnico.',
  ambiguous_or_nonexistent_local_time:'Orario ambiguo o inesistente per il cambio dell’ora. Scegli un altro orario.',
  outside_business_hours:'L’appuntamento deve rientrare negli orari di apertura.', salon_closed:'Il salone è chiuso in quella data.',
  lunch_break:'L’appuntamento si sovrappone alla pausa.', professional_unavailable:'L’operatrice non è disponibile.',
  trattamento_non_abilitato_per_operatrice:'Uno dei trattamenti non è abilitato per l’operatrice selezionata.',
  appointment_must_be_future:'Scegli un orario futuro.', move_future_appointments_before_calendar_change:'Sposta o annulla gli appuntamenti futuri prima di cambiare il calendario o disattivare l’operatrice.',
};
function errorMessage(error) { return ERRORS[error?.code] || error?.message || 'Operazione non disponibile. Nessuna conferma ricevuta.'; }
async function synkRequest(url, {method='GET',body} = {}) {
  const ctl = new AbortController(); const timeout = setTimeout(()=>ctl.abort(),25000);
  try {
    const response = await fetch(url,{method,credentials:'same-origin',cache:'no-store',signal:ctl.signal,
      headers:{'Accept':'application/json','X-CSRF-Token':document.querySelector('meta[name="csrf-token"]').content,...(body !== undefined ? {'Content-Type':'application/json'} : {})},
      ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
    let data; try { data = await response.json(); } catch { throw new Error('Risposta non valida. Verifica il collegamento e ricarica la pagina.'); }
    if (!response.ok || data?.error) {
      const error = new Error(ERRORS[data?.error] || `Operazione non riuscita (${data?.error || response.status}).`);
      error.code = data?.error; throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Connessione interrotta. Il risultato potrebbe essere incerto: aggiorna i dati prima di ripetere un salvataggio.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function gFetch(route, options = {}) {
  return synkRequest('/?route='+encodeURIComponent(route)+(options.qs||''), {method:options.method||'GET',body:options.body});
}
function synkBridge(path, options = {}) { return synkRequest('/bridge.php?path='+encodeURIComponent(path),options); }
let toastTimer;
function showToast(message, isError = false) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = 'toast'+(isError?' is-error':''); $('toast').hidden = false;
  toastTimer = setTimeout(()=>$('toast').hidden=true,isError?10000:6500);
}
async function runAction(task, button) {
  if (button?.disabled) return;
  const controls = button ? [button] : [];
  for (const control of controls) control.disabled = true;
  try { return await task(); }
  catch (error) { showToast(errorMessage(error),true); }
  finally { for (const control of controls) control.disabled = false; }
}
async function synkShowPage(page) {
  if (!PAGE_INFO[page]) page = 'overview';
  APP.page = page;
  for (const section of document.querySelectorAll('[data-section]')) section.hidden = section.dataset.section !== page;
  for (const button of document.querySelectorAll('[data-page]')) { button.classList.toggle('active',button.dataset.page===page); button.setAttribute('aria-current',button.dataset.page===page?'page':'false'); }
  $('pageTitle').textContent = $('breadcrumb').textContent = PAGE_INFO[page][0]; $('pageSubtitle').textContent = PAGE_INFO[page][1];
  $('pageError').hidden = true;
  if (location.hash !== '#'+page) history.replaceState(null,'','#'+page);
  try { if (PAGE_LOADERS[page]) await PAGE_LOADERS[page](); }
  catch (error) { if (APP.page===page) { $('pageError').textContent = errorMessage(error); $('pageError').hidden = false; } }
}
function synkUseCanonicalAppointments() { void synkShowPage('appointments'); }
function listRow(title, subtitle, ...actions) {
  return el('div',{class:'list-item'},el('div',{},el('strong',{text:title}),...(subtitle ? [el('p',{text:subtitle})] : [])),el('div',{class:'button-row'},...actions));
}
function setOptions(select, rows, valueKey, labelKey, placeholder) {
  select.replaceChildren(...(placeholder ? [el('option',{value:'',text:placeholder})] : []),...rows.map(r=>el('option',{value:r[valueKey],text:r[labelKey]})));
}
async function loadCatalog(force = false) {
  if (!APP.catalog || force) APP.catalog = await gFetch('db_catalog');
  return APP.catalog;
}
document.addEventListener('DOMContentLoaded',()=>{
  $('today').textContent = new Intl.DateTimeFormat('it-IT',{timeZone:'Europe/Rome',weekday:'long',day:'numeric',month:'long'}).format(new Date());
  document.addEventListener('click',event=>{
    const page = event.target.closest('[data-page]'); if (page) void synkShowPage(page.dataset.page);
    const refresh = event.target.closest('[data-action="refresh"]'); if (refresh) void runAction(()=>synkShowPage(APP.page),refresh);
  });
  $('newAppointment').addEventListener('click',()=>{ void synkShowPage('appointments'); void runAction(()=>gApptOpenForm(null)); });
  window.addEventListener('hashchange',()=>void synkShowPage(location.hash.slice(1)));
  void synkShowPage(location.hash.slice(1)||'overview');
  setInterval(()=>{ if (!document.hidden && APP.page==='overview') void synkShowPage('overview'); },60000);
  setInterval(()=>{ if (!document.hidden && APP.page==='chats') void runAction(loadQr); },15000);
});
