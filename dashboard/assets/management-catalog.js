'use strict';
async function gLoadCatalogPage() {
  await loadCatalog(true);
  $('serviceList').replaceChildren(...APP.catalog.services.map(service=>{
    const edit = el('button',{class:'secondary',text:'Modifica'});
    edit.addEventListener('click',()=>{
      $('gSvcId').value=service.service_id;$('gSvcName').value=service.service_name;
      $('gSvcDuration').value=service.default_duration_min;$('gSvcBuffer').value=service.buffer_after_min;
      $('gSvcPrice').value=service.base_price??'';$('gSvcActive').checked=Boolean(service.is_active);
      $('gSvcName').focus();
    });
    return listRow(service.service_name,`${service.default_duration_min} min + ${service.buffer_after_min} min buffer · ${service.is_active?'attivo':'non attivo'}`,edit);
  }),...(APP.catalog.services.length?[]:[empty('Registra il primo trattamento.')]));
  $('professionalList').replaceChildren(...APP.catalog.professionals.map(pro=>{
    const edit = el('button',{class:'secondary',text:'Modifica'});
    edit.addEventListener('click',()=>{
      $('gProId').value=pro.professional_id;$('gProName').value=pro.full_name;$('gProEmail').value=pro.email||'';$('gProActive').checked=Boolean(pro.is_active);gRenderAssignments();
    });
    return listRow(pro.full_name,`${pro.email||'Calendario non configurato'} · ${pro.is_active?'attiva':'non attiva'}`,edit);
  }),...(APP.catalog.professionals.length?[]:[empty('Registra la prima operatrice.')]));
  gRenderAssignments();
}
function gRenderAssignments() {
  const proId = Number($('gProId').value);
  $('saveAssignments').disabled=!proId;
  $('assignmentList').replaceChildren(...(proId?APP.catalog.services.map(service=>{
    const assignment=APP.catalog.assignments.find(a=>Number(a.professional_id)===proId&&Number(a.service_id)===Number(service.service_id));
    const check=el('input',{type:'checkbox',checked:Boolean(assignment),'data-service':service.service_id});
    const input=el('input',{class:'gProDuration',type:'number',min:1,max:960,required:true,value:assignment?.duration_min||service.default_duration_min,disabled:!assignment,'data-duration-service':service.service_id,'aria-label':'Durata per '+service.service_name});
    check.addEventListener('change',()=>input.disabled=!check.checked);
    return el('div',{class:'form-grid'},el('label',{class:'checkbox'},check,service.service_name),el('label',{},'Durata (min), buffer escluso',input));
  }):[empty('Seleziona un’operatrice per configurare i trattamenti.')]));
}
PAGE_LOADERS.catalog=gLoadCatalogPage;
document.addEventListener('DOMContentLoaded',()=>{
  $('resetService').addEventListener('click',()=>{$('serviceForm').reset();$('gSvcId').value='';});
  $('resetProfessional').addEventListener('click',()=>{$('professionalForm').reset();$('gProId').value='';gRenderAssignments();});
  $('serviceForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    const body={name:$('gSvcName').value,durationMin:Number($('gSvcDuration').value),bufferAfterMin:Number($('gSvcBuffer').value),price:$('gSvcPrice').value,active:$('gSvcActive').checked};
    if ($('gSvcId').value) body.id=Number($('gSvcId').value);
    await gFetch('db_service_save',{method:'POST',body});$('serviceForm').reset();$('gSvcId').value='';await gLoadCatalogPage();showToast('Trattamento salvato.');
  },event.submitter);});
  $('professionalForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    const body={name:$('gProName').value,email:$('gProEmail').value,active:$('gProActive').checked};
    if ($('gProId').value) body.id=Number($('gProId').value);
    const result=await gFetch('db_professional_save',{method:'POST',body});$('gProId').value=result.id;await gLoadCatalogPage();showToast('Operatrice salvata. Verifica la condivisione del calendario Google.');
  },event.submitter);});
  $('assignmentForm').addEventListener('submit',event=>{event.preventDefault();void runAction(async()=>{
    const services=[...$('assignmentList').querySelectorAll('[data-service]:checked')].map(check=>({serviceId:Number(check.dataset.service),durationMin:Number($('assignmentList').querySelector(`[data-duration-service="${check.dataset.service}"]`).value)}));
    await gFetch('db_professional_services_save',{method:'POST',body:{professionalId:Number($('gProId').value),services}});await gLoadCatalogPage();showToast('Abilitazioni salvate. Il bot ricaricherà il catalogo entro circa 90 secondi.');
  },event.submitter);});
});
