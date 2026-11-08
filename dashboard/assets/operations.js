'use strict';
async function loadOverview() {
  const [data,analytics] = await Promise.all([synkBridge('/api/operations'),synkBridge('/api/analytics?months=6')]);
  $('maintenanceBanner').hidden=!data.calendarMaintenance;
  const cards=[['WhatsApp',data.whatsapp?'Connesso':'Non connesso',data.whatsapp?'La sessione è operativa.':'Verifica il QR nelle conversazioni.',data.whatsapp],['Database',data.database?'Raggiungibile':'Non disponibile','PostgreSQL sul PC del salone.',data.database],['Google Calendar',data.calendarMaintenance?'Sospeso':(data.syncStatus||'Stato da verificare'),data.lastSync?'Ultima sincronizzazione: '+formatDate(data.lastSync):'Nessuna sincronizzazione entrante confermata.',!data.calendarMaintenance&&data.syncStatus==='ok']];
  $('statusCards').replaceChildren(...cards.map(([title,value,note,ok])=>el('article',{class:'card'},el('p',{class:'stat-label',text:title}),el('p',{class:'stat-value',text:value}),el('p',{class:'stat-note',text:note}),badge(ok?'OPERATIVO':'DA VERIFICARE',ok?'good':'warning'))));
  const items=[];
  for (const backlog of data.backlog||[]) items.push(listRow('Sincronizzazione '+(backlog.status==='attention'?'da verificare':'in coda'),backlog.count+' operazioni',badge(backlog.status==='attention'?'TECNICO':'IN ATTESA',backlog.status==='attention'?'bad':'warning')));
  for (const item of data.incidents?.calendar||[]) items.push(listRow('Operazione Calendar #'+item.job_id,`${item.operation} · tentativi ${item.attempts} · ${item.last_error||'errore provider'}`,badge('VERIFICA','bad')));
  for (const item of data.incidents?.conflicts||[]) items.push(listRow('Conflitto Calendar',`${item.reason} · ${formatDate(item.last_seen_at)}`,badge('TECNICO','warning')));
  for (const item of data.incidents?.sagas||[]) items.push(listRow('Creazione evento da riconciliare',formatDate(item.updated_at),badge('TECNICO','warning')));
  $('incidents').replaceChildren(...(items.length?items:[empty('Nessuna anomalia registrata. Continua a verificare gli stati dei servizi.')]));
  $('analytics').replaceChildren(...(analytics.months?.length?analytics.months.map(month=>listRow(month.month,`${month.total} appuntamenti · ${month.completed} completati · ${month.cancelled} annullati`)):[empty('Ancora nessuna attività nel periodo.')]));
  $('privacyRequests').replaceChildren(...(data.incidents?.privacy?.length?data.incidents.privacy.map(item=>{
    const buttons=[];
    for (const [status,label] of [['in_progress','Prendi in esame'],['closed','Chiudi revisione']]) {
      const button=el('button',{class:'secondary',text:label,disabled:item.status===status});
      button.addEventListener('click',()=>void runAction(async()=>{
        if (!confirm(status==='closed'?'Confermi di aver verificato Google, WhatsApp e gli obblighi di conservazione? La chiusura non elimina automaticamente quei dati.':'Prendere in esame questa richiesta?')) return;
        await synkBridge('/api/privacy/request/review',{method:'POST',body:{requestId:Number(item.request_id),status}});await loadOverview();
      },button));buttons.push(button);
    }
    return listRow('Richiesta #'+item.request_id+(item.client_id?' · cliente #'+item.client_id:''),formatDate(item.requested_at)+' · '+item.status,...buttons);
  }):[empty('Nessuna richiesta privacy aperta.')]));
}
async function loadClientsPage() {
  const data=await synkBridge('/api/clients/search?q='+encodeURIComponent($('clientSearch').value));
  $('clientList').replaceChildren(...data.clients.map(client=>{
    const open=el('button',{class:'secondary',text:'Apri scheda'});open.addEventListener('click',()=>void runAction(()=>loadClient(client.client_id),open));
    return listRow(client.full_name,'Cliente #'+client.client_id,open);
  }),...(data.clients.length?[]:[empty('Nessuna cliente trovata.')]));
}
async function loadClient(id) {
  const {client}=await synkBridge('/api/client?id='+Number(id));
  const note=el('textarea',{rows:4,maxLength:1000,value:client.note,'aria-label':'Nota cliente, solo locale'});
  const save=el('button',{text:'Salva nota locale',type:'submit'});
  const form=el('form',{class:'stack'},el('label',{},'Nota riservata al team (massimo 1000 caratteri)',note),save);
  form.addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    await synkBridge('/api/client/note',{method:'PUT',body:{id:Number(id),note:note.value}});showToast('Nota salvata. Non viene inviata all’AI.');
  },save);});
  $('clientDetails').replaceChildren(el('h2',{text:client.full_name}),el('p',{class:'muted',text:client.appointment_count+' appuntamenti registrati'}),form,el('h3',{text:'Ultimi 20 appuntamenti'}),...client.appointments.map(a=>listRow(a.service_name,`${formatDate(a.start_time)} · ${a.professional_name} · ${a.status}`)));
}
async function loadQr() {
  const data=await synkBridge('/api/session/qr');
  $('qrStatus').textContent=data.connected?'WhatsApp collegato.':'Sessione non collegata. Attendi un QR aggiornato.';
  const safe=typeof data.qr==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qr);
  $('whatsappQr').hidden=!safe;
  if (safe) $('whatsappQr').src=data.qr;else $('whatsappQr').removeAttribute('src');
}
async function loadChats() {
  const data=await synkBridge('/api/chats');
  $('chatList').replaceChildren(...data.chats.map(chat=>{
    const button=el('button',{class:'secondary',text:chat.paused?'In carico':'Apri'});
    button.addEventListener('click',()=>void runAction(()=>selectChat(chat),button));
    return listRow(chat.chatId.replace('@c.us',''),chat.preview||'Nessun messaggio recente',button);
  }),...(data.chats.length?[]:[empty('Nessuna conversazione disponibile.')]));
  await loadQr();
}
async function selectChat(chat) {
  APP.selectedChat=chat;
  $('chatTitle').textContent=chat.chatId.replace('@c.us','');
  $('chatHandoff').disabled=$('chatSend').disabled=$('chatDelete').disabled=true;
  $('chatMessages').replaceChildren(empty('Caricamento conversazione…'));
  $('chatHandoff').textContent=chat.paused?'Restituisci al bot':'Prendi in carico';
  $('chatState').textContent=chat.paused?'Conversazione in carico al team. Bot sospeso per questa chat.':'Bot attivo. L’invio come operatrice attiverà la presa in carico.';
  const data=await synkBridge('/api/messages?chatId='+encodeURIComponent(chat.chatId));
  if (APP.selectedChat?.chatId!==chat.chatId) return;
  $('chatHandoff').disabled=$('chatSend').disabled=$('chatDelete').disabled=false;
  $('chatMessages').replaceChildren(...data.messages.map(m=>el('div',{class:'message '+(m.direction==='out'?'out':'in')},m.body,el('small',{text:formatDate(m.at)}))));
  $('chatMessages').scrollTop=$('chatMessages').scrollHeight;
}
const WEEKDAYS=['Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato','Domenica'];
async function loadSchedule() {
  const [plan,team]=await Promise.all([synkBridge('/api/schedule'),synkBridge('/api/absences')]);
  $('hoursRows').replaceChildren(...plan.hours.map((day,index)=>{
    const closed=el('input',{type:'checkbox',checked:day.closed,'aria-label':WEEKDAYS[index]+' chiuso','data-hour-field':'closed'});
    const times=['open','close','breakStart','breakEnd'].map(key=>el('input',{type:'time',value:day[key]||'',disabled:day.closed,'aria-label':WEEKDAYS[index]+' '+key,'data-hour-field':key}));
    closed.addEventListener('change',()=>{for (const input of times)input.disabled=closed.checked;});
    return el('tr',{'data-weekday':day.weekday},el('td',{text:WEEKDAYS[index]}),el('td',{},closed),...times.map(input=>el('td',{},input)));
  }));
  $('closedDates').value=plan.closedDates.join('\n');
  setOptions($('absenceProfessional'),team.professionals,'professional_id','full_name','Seleziona');
  $('absenceList').replaceChildren(...team.absences.map(absence=>{
    const remove=el('button',{class:'danger',text:'Rimuovi'});remove.addEventListener('click',()=>void runAction(async()=>{
      if (!confirm('Rimuovere questa assenza?'))return;
      await synkBridge('/api/absences/delete',{method:'POST',body:{id:Number(absence.absence_id)}});await loadSchedule();
    },remove));return listRow(absence.full_name,absence.start_day+' → '+absence.end_day,remove);
  }),...(team.absences.length?[]:[empty('Nessuna assenza registrata.')]));
}
async function loadWaitlist() {
  const data=await synkBridge('/api/waitlist/options');
  setOptions($('synkWaitService'),data.services,'service_id','service_name','Seleziona un trattamento');
  setOptions($('synkWaitProfessional'),data.professionals,'professional_id','full_name','Qualsiasi abilitata');
}
async function loadSettings() {
  const [settings,backups,diagnostics,ai]=await Promise.all([synkBridge('/api/settings'),synkBridge('/api/backups'),synkBridge('/diagnostics'),synkBridge('/api/ai')]);
  for (const input of $('settingsForm').querySelectorAll('[name]'))input.value=settings.settings[input.name]||'';
  $('backupList').replaceChildren(...backups.backups.map(backup=>{
    const link=el('a',{href:'/bridge.php?path='+encodeURIComponent('/api/backups/download?name='+encodeURIComponent(backup.name)),text:'Scarica dump',download:backup.name});
    link.addEventListener('click',event=>{if (!confirm('Il file contiene dati personali e NON è cifrato. Salvarlo solo su un supporto protetto. Continuare?'))event.preventDefault();});
    return listRow(backup.name,(backup.size/1024/1024).toFixed(1)+' MB · database non cifrato',link);
  }),...(backups.backups.length?[]:[empty('Nessun backup disponibile. Chiedi al tecnico di verificare il servizio backup.')]));
  $('aiStatus').replaceChildren(badge(!ai.enabled?'AI DISATTIVATA':ai.available?'AI LOCALE RAGGIUNGIBILE':'AI NON DISPONIBILE',ai.enabled&&ai.available?'good':'neutral'),el('p',{class:'muted',text:ai.enabled?`Informazioni: ${ai.info?'modello presente':'non disponibile'} · intenti: ${ai.intent?'modello presente':'non disponibile'}`:'Nessun modello AI contattato.'}));
  $('diagnostics').replaceChildren(...[['WhatsApp',diagnostics.whatsappReady?'Operativo':'Non pronto'],['Database',diagnostics.databaseReady?'Operativo':'Non pronto'],['Licenza',diagnostics.licenseStatus],['Ultimo recupero Calendar',diagnostics.lastCalendarRecoveryAt?formatDate(diagnostics.lastCalendarRecoveryAt):'Mai'],['Sync entrante',diagnostics.lastInboundSyncStatus],['Prenotazioni',diagnostics.calendarMaintenance?'Sospese per riconciliazione':'Controlli attivi']].flatMap(([key,value])=>[el('dt',{text:key}),el('dd',{text:value||'Non disponibile'})]));
}
Object.assign(PAGE_LOADERS,{overview:loadOverview,clients:loadClientsPage,chats:loadChats,schedule:loadSchedule,waitlist:loadWaitlist,settings:loadSettings});
document.addEventListener('DOMContentLoaded',()=>{
  $('clientSearchForm').addEventListener('submit',event=>{event.preventDefault();void runAction(loadClientsPage,event.submitter);});
  $('chatHandoff').addEventListener('click',event=>void runAction(async()=>{
    const chat=APP.selectedChat;if(!chat)return;
    await synkBridge('/api/handoff',{method:'POST',body:{chatId:chat.chatId,paused:!chat.paused}});chat.paused=!chat.paused;await selectChat(chat);await loadChats();
  },event.currentTarget));
  $('chatSendForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    const chat=APP.selectedChat;if(!chat)throw new Error('Seleziona una conversazione.');
    const result=await synkBridge('/api/send',{method:'POST',body:{to:chat.chatId,message:$('chatText').value,handoff:true}});
    $('chatText').value='';chat.paused=true;showToast(result.recorded?'Messaggio inviato.': 'Messaggio inviato, ma cronologia non salvata. Non inviarlo di nuovo.',!result.recorded);await selectChat(chat);await loadChats();
  },event.submitter);});
  $('chatDelete').addEventListener('click',event=>void runAction(async()=>{
    const chat=APP.selectedChat;if(!chat||!confirm('Eliminare la chat locale? Verrà aperta una revisione privacy; Google e WhatsApp non vengono cancellati.'))return;
    await synkBridge('/api/chats/delete',{method:'POST',body:{chatId:chat.chatId}});APP.selectedChat=null;$('chatMessages').replaceChildren();$('chatTitle').textContent='Seleziona una conversazione';$('chatSend').disabled=$('chatHandoff').disabled=true;await loadChats();
  },event.currentTarget));
  $('hoursForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    const hours=[...$('hoursRows').children].map(row=>{const get=key=>row.querySelector(`[data-hour-field="${key}"]`);const closed=get('closed').checked;return {weekday:Number(row.dataset.weekday),closed,open:get('open').value,close:get('close').value,breakStart:closed?'':get('breakStart').value,breakEnd:closed?'':get('breakEnd').value};});
    const closedDates=$('closedDates').value.split(/\s+/).filter(Boolean);
    await synkBridge('/api/schedule',{method:'PUT',body:{hours,closedDates}});showToast('Orari salvati. Verifica eventuali appuntamenti già presenti.');await loadSchedule();
  },event.submitter);});
  $('absenceForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    await synkBridge('/api/absences',{method:'POST',body:{professionalId:Number($('absenceProfessional').value),startDay:$('absenceStart').value,endDay:$('absenceEnd').value}});await loadSchedule();showToast('Assenza registrata. Verifica gli appuntamenti già presenti.');
  },event.submitter);});
  $('waitlistForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    const dates=await gFetch('db_datetime',{qs:'&start='+encodeURIComponent($('synkWaitStart').value)+'&end='+encodeURIComponent($('synkWaitEnd').value)});
    await synkBridge('/api/waitlist/opt-in',{method:'POST',body:{chatId:$('synkWaitPhone').value+'@c.us',serviceId:Number($('synkWaitService').value),professionalId:$('synkWaitProfessional').value?Number($('synkWaitProfessional').value):null,earliestAt:dates.start,latestAt:dates.end,consent:$('synkWaitConsent').checked}});
    showToast('Richiesta registrata con consenso. Nessuna prenotazione ancora confermata.');$('waitlistForm').reset();await loadWaitlist();
  },event.submitter);});
  $('synkWaitWithdraw').addEventListener('click',event=>void runAction(async()=>{
    const phone=$('synkWaitPhone').value;if(!/^[0-9]{5,20}$/.test(phone))throw new Error('Inserisci un numero WhatsApp valido.');
    if(!confirm('Revocare tutte le richieste attive per questo numero?'))return;
    const result=await synkBridge('/api/waitlist/withdraw',{method:'POST',body:{chatId:phone+'@c.us'}});showToast('Richieste revocate: '+result.withdrawn);
  },event.currentTarget));
  $('settingsForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    const settings=await synkBridge('/api/settings');let saved=0;
    try{for(const input of $('settingsForm').querySelectorAll('[name]')){const value=input.value.trim();if(value!==String(settings.settings[input.name]||'')){if(!value)throw new Error('I valori già impostati non possono essere cancellati da questa schermata.');await synkBridge('/api/settings',{method:'PUT',body:{key:input.name,value}});saved++;}}}
    catch(error){throw new Error(`Impostazioni salvate: ${saved}. ${errorMessage(error)}`);}
    showToast(saved?'Impostazioni salvate. Il nome del salone sarà riletto dal bot al prossimo riavvio.':'Nessuna modifica.');
  },event.submitter);});
});
