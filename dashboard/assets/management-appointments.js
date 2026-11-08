'use strict';
let gApptEditing = null;
let gApptSelectedServices = [];
let gClientSearchSequence = 0;
function gProDuration(proId, serviceId) {
  const assignment = APP.catalog.assignments.find(x=>Number(x.professional_id)===Number(proId)&&Number(x.service_id)===Number(serviceId));
  const service = APP.catalog.services.find(x=>Number(x.service_id)===Number(serviceId));
  return assignment && service ? Number(assignment.duration_min)+Number(service.buffer_after_min) : 0;
}
function gRenderServices() {
  const proId = Number($('gApptProfessional').value);
  const allowed = APP.catalog.services.filter(s=>s.is_active && gProDuration(proId,s.service_id)>0);
  gApptSelectedServices = gApptSelectedServices.filter(id=>allowed.some(s=>Number(s.service_id)===id));
  $('gApptServices').replaceChildren(...allowed.map(service=>{
    const id = Number(service.service_id);
    const check = el('input',{type:'checkbox',class:'gApptSvcCheck',value:id,checked:gApptSelectedServices.includes(id)});
    check.addEventListener('change',()=>{
      if (check.checked && gApptSelectedServices.length>=6) { check.checked=false; showToast('Puoi scegliere al massimo 6 trattamenti.',true); return; }
      gApptSelectedServices = check.checked ? [...gApptSelectedServices,id] : gApptSelectedServices.filter(x=>x!==id);
      gRenderServiceOrder();
    });
    return el('label',{class:'checkbox'},check,`${service.service_name} · ${gProDuration(proId,id)} min (buffer ${service.buffer_after_min})`);
  }),...(allowed.length ? [] : [empty('Nessun trattamento abilitato per questa operatrice.') ]));
  gRenderServiceOrder();
}
function gRenderServiceOrder() {
  $('gApptOrder').replaceChildren(...gApptSelectedServices.map((id,index)=>{
    const service = APP.catalog.services.find(x=>Number(x.service_id)===id);
    const move = delta => { const target=index+delta; [gApptSelectedServices[index],gApptSelectedServices[target]]=[gApptSelectedServices[target],gApptSelectedServices[index]]; gRenderServiceOrder(); };
    const up = el('button',{type:'button',text:'↑',disabled:index===0,'aria-label':'Anticipa '+service.service_name}); up.addEventListener('click',()=>move(-1));
    const down = el('button',{type:'button',text:'↓',disabled:index===gApptSelectedServices.length-1,'aria-label':'Posticipa '+service.service_name}); down.addEventListener('click',()=>move(1));
    return el('li',{},service.service_name,up,down);
  }));
  $('gApptTotal').textContent = gApptSelectedServices.reduce((sum,id)=>sum+gProDuration($('gApptProfessional').value,id),0)+' min';
}
async function gLoadClients(query = '', selected = null) {
  const sequence = ++gClientSearchSequence;
  const result = await gFetch('db_clients',{qs:'&q='+encodeURIComponent(query)});
  if (sequence !== gClientSearchSequence) return;
  const rows = result.clients;
  if (gApptEditing && !rows.some(r=>Number(r.client_id)===Number(gApptEditing.client_id))) rows.push({client_id:gApptEditing.client_id,full_name:gApptEditing.client_name});
  setOptions($('gApptClient'),rows,'client_id','full_name','Seleziona una cliente');
  if (selected !== null) $('gApptClient').value = String(selected);
}
async function gApptOpenForm(appointment) {
  await loadCatalog(true);
  gApptEditing = appointment;
  $('gApptForm').reset();
  $('gApptTitle').textContent = appointment ? 'Modifica appuntamento' : 'Nuovo appuntamento';
  setOptions($('gApptProfessional'),APP.catalog.professionals.filter(p=>p.is_active),'professional_id','full_name','Seleziona un’operatrice');
  if (appointment) $('gApptProfessional').value = String(appointment.professional_id);
  gApptSelectedServices = appointment ? appointment.service_ids.map(Number) : [];
  $('gApptStart').value = appointment ? salonLocalInput(appointment.start_time) : '';
  gRenderServices();
  await gLoadClients(appointment?.client_name||'',appointment?.client_id||null);
  if (!$('gApptDialog').open) $('gApptDialog').showModal();
}
function gSyncBadge(status) {
  const labels = {pending:['IN CODA','warning'],attention:['VERIFICA TECNICA','bad'],synced:['SINCRONIZZATO','good'],unbound:['NON COLLEGATO','bad']};
  return badge(...(labels[status]||['SCONOSCIUTO','warning']));
}
async function gLoadAppointments() {
  $('appointmentList').replaceChildren(empty('Caricamento agenda…'));
  const params = new URLSearchParams({mode:$('gApptMode').value,from:$('gApptFrom').value,to:$('gApptTo').value});
  try {
    const data = await gFetch('db_appointments',{qs:'&'+params.toString()});
    APP.appointments = data.appointments; APP.bookings = data.appointments;
    $('maintenanceBanner').hidden = !data.maintenance;
    const tbody = el('tbody');
    for (const row of data.appointments) {
      const actions = [];
      const active = ['confirmed','pending'].includes(row.status);
      if (active) {
        const edit = el('button',{class:'secondary',text:'Modifica',disabled:row.calendar_status!=='synced'||data.maintenance});
        edit.addEventListener('click',()=>void runAction(()=>gApptOpenForm(row),edit));
        const cancel = el('button',{class:'danger',text:'Annulla',disabled:row.calendar_status!=='synced'||data.maintenance});
        cancel.addEventListener('click',()=>void runAction(async()=>{
          if (!confirm('Annullare questo appuntamento? Per riattivarlo dovrai creare una nuova prenotazione.')) return;
          await gFetch('db_appointment_cancel',{method:'POST',body:{id:Number(row.appointment_id),updatedAt:row.updated_at,status:'cancelled'}});
          showToast('Annullamento registrato. Aggiornamento Google Calendar in coda.'); await gLoadAppointments();
        },cancel));
        actions.push(edit,cancel);
        if (new Date(row.end_time)<new Date()) {
          for (const [state,label] of [['completed','Completato'],['no_show','Assente']]) {
            const button = el('button',{class:'secondary',text:label,disabled:row.calendar_status!=='synced'||data.maintenance});
            button.addEventListener('click',()=>void runAction(async()=>{
              if (!confirm('Impostare lo stato «'+label+'»?')) return;
              await gFetch('db_appointment_cancel',{method:'POST',body:{id:Number(row.appointment_id),updatedAt:row.updated_at,status:state}}); await gLoadAppointments();
            },button)); actions.push(button);
          }
        }
      }
      const status = {confirmed:'Confermato nel DB',pending:'In attesa',cancelled:'Annullato',completed:'Completato',no_show:'Assente'}[row.status]||row.status;
      tbody.append(el('tr',{},el('td',{},formatDate(row.start_time),el('small',{text:'Fine: '+formatDate(row.end_time)})),el('td',{},row.client_name,el('small',{text:row.professional_name||'Non assegnata'})),el('td',{},row.service_names||'Trattamento non disponibile'),el('td',{},status,el('div',{},gSyncBadge(row.calendar_status))),el('td',{},el('div',{class:'button-row'},...actions))));
    }
    const table = el('table',{},el('thead',{},el('tr',{},...['Quando','Cliente e operatrice','Trattamenti','Stato','Azioni'].map(t=>el('th',{scope:'col',text:t})))),tbody);
    $('appointmentList').replaceChildren(...(data.appointments.length ? [table,empty(`Mostrati al massimo ${data.limit} appuntamenti. Restringi le date per consultare gli altri.`)] : [empty('Nessun appuntamento per questi filtri.') ]));
  } catch (error) { APP.appointments=[]; APP.bookings=[]; $('appointmentList').replaceChildren(empty('Agenda non disponibile. Nessun dato locale sostitutivo.')); throw error; }
}
PAGE_LOADERS.appointments = gLoadAppointments;
document.addEventListener('DOMContentLoaded',()=>{
  const localToday = salonLocalInput().slice(0,10);
  $('gApptFrom').value = localToday;
  $('appointmentFilters').addEventListener('submit',event=>{event.preventDefault();void runAction(gLoadAppointments,event.submitter);});
  $('gApptMode').addEventListener('change',()=>{ if ($('gApptMode').value!=='future'&&$('gApptFrom').value===localToday) $('gApptFrom').value=''; });
  $('gApptClose').addEventListener('click',()=>$('gApptDialog').close());
  $('gApptProfessional').addEventListener('change',gRenderServices);
  let debounce;
  $('gApptClientSearch').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>void runAction(()=>gLoadClients($('gApptClientSearch').value)),350);});
  $('gApptCreateClient').addEventListener('click',event=>void runAction(async()=>{
    const name = $('gApptNewClientName').value.trim(), phone = $('gApptNewClientPhone').value.trim();
    if (!name) throw new Error('Inserisci il nome della cliente.');
    const result = await gFetch('db_client_create',{method:'POST',body:{name,phone}});
    await gLoadClients(name,result.id); $('gApptNewClientName').value=''; $('gApptNewClientPhone').value='';
    showToast('Cliente registrata e selezionata.');
  },event.currentTarget));
  $('gApptForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    if (!gApptSelectedServices.length) throw new Error('Seleziona almeno un trattamento.');
    const body = {clientId:Number($('gApptClient').value),professionalId:Number($('gApptProfessional').value),serviceIds:gApptSelectedServices,startTime:$('gApptStart').value};
    if (gApptEditing) {body.id=Number(gApptEditing.appointment_id);body.updatedAt=gApptEditing.updated_at;}
    await gFetch('db_appointment_save',{method:'POST',body}); $('gApptDialog').close();
    showToast('Appuntamento registrato nel database. Sincronizzazione Calendar in coda.');
    await gLoadAppointments();
  },event.submitter);});
});
