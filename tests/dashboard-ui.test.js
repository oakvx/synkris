import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const catalog={services:[{service_id:1,service_name:'Manicure <script>alert(1)</script>',default_duration_min:30,buffer_after_min:10,is_active:true},{service_id:2,service_name:'Pedicure',default_duration_min:40,buffer_after_min:5,is_active:true}],professionals:[{professional_id:1,full_name:'Operatrice',is_active:true,email:'test@example.com'}],assignments:[{professional_id:1,service_id:1,duration_min:45},{professional_id:1,service_id:2,duration_min:40}]};
async function page(handler=()=>undefined) {
  const dom=new JSDOM(read('dashboard/view.html').replaceAll('{{CSRF_TOKEN}}','test-csrf').replaceAll('{{VERSION}}','1.2.0-rc.6'),{url:'https://salon.example/',runScripts:'outside-only'});
  await new Promise(resolve=>dom.window.document.addEventListener('DOMContentLoaded',resolve,{once:true}));
  const {window:w}=dom;const requests=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  w.confirm=()=>true;
  w.fetch=async(url,options={})=>{
    const uri=new URL(url,'https://salon.example');const route=uri.searchParams.get('route');const bridge=uri.searchParams.get('path');
    const request={route,bridge,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined,headers:options.headers};requests.push(request);
    const custom=await handler(request);
    if(custom)return{ok:custom.status<400,status:custom.status,json:async()=>custom.body};
    const data=route==='db_catalog'?structuredClone(catalog):route==='db_clients'?{clients:[{client_id:7,full_name:'Cliente <img src=x onerror=alert(1)>'}]}:route==='db_appointments'?{appointments:[],limit:100,maintenance:false}:bridge==='/api/operations'?{database:true,whatsapp:false,syncStatus:'disabled',incidents:{privacy:[]},backlog:[]}:bridge?.startsWith('/api/analytics')?{months:[]}:{ok:true};
    return{ok:true,status:200,json:async()=>data};
  };
  const context=dom.getInternalVMContext();
  for(const name of ['app','management-appointments','management-catalog','operations','analytics'])vm.runInContext(read('dashboard/assets/'+name+'.js'),context,{filename:name+'.js'});
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));await tick();
  return{dom,w,requests,eval:code=>vm.runInContext(code,context),$:id=>w.document.getElementById(id)};
}
test('dashboard uses real service states and safe navigation without inline scripts',async()=>{
  const ui=await page();try{
    assert.match(ui.$('statusCards').textContent,/Non connesso/);
    await ui.eval("synkShowPage('appointments')");
    assert.equal(ui.w.document.querySelector('[data-section="appointments"]').hidden,false);
    assert.equal(ui.w.document.querySelector('[data-section="overview"]').hidden,true);
    assert.match(ui.$('appointmentList').textContent,/Nessun appuntamento/);
    assert.equal(ui.w.document.querySelectorAll('script:not([src])').length,0);
  }finally{ui.w.close();}
});
test('appointment editor loads clients independently and includes personalized duration and buffer',async()=>{
  const ui=await page();try{
    await ui.eval('gApptOpenForm(null)');
    assert.ok(ui.requests.some(r=>r.route==='db_clients'));
    ui.$('gApptProfessional').value='1';ui.$('gApptProfessional').dispatchEvent(new ui.w.Event('change'));
    const checks=ui.w.document.querySelectorAll('.gApptSvcCheck');
    for(const check of checks){check.checked=true;check.dispatchEvent(new ui.w.Event('change'));}
    assert.equal(ui.$('gApptTotal').textContent,'100 min');
    assert.equal(ui.$('gApptServices').querySelector('script'),null);
    assert.equal(ui.$('gApptClient').querySelector('img'),null);
    assert.match(ui.$('gApptClient').textContent,/<img/);
    assert.equal(ui.$('gApptDialog').open,true);
  }finally{ui.w.close();}
});
test('failed Calendar save cannot close the form or show successful booking',async()=>{
  const ui=await page(r=>r.route==='db_appointment_save'?{status:503,body:{error:'calendar_unavailable'}}:undefined);
  try{
    await ui.eval('gApptOpenForm(null)');ui.$('gApptProfessional').value='1';ui.$('gApptProfessional').dispatchEvent(new ui.w.Event('change'));
    const check=ui.w.document.querySelector('.gApptSvcCheck');check.checked=true;check.dispatchEvent(new ui.w.Event('change'));
    ui.$('gApptClient').value='7';ui.$('gApptStart').value='2099-01-15T09:30';
    ui.$('gApptForm').dispatchEvent(new ui.w.SubmitEvent('submit',{cancelable:true,submitter:ui.$('gApptSave')}));await tick();await tick();
    assert.equal(ui.$('gApptDialog').open,true);
    assert.equal(ui.$('toast').classList.contains('is-error'),true);
    assert.match(ui.$('toast').textContent,/Nessuna conferma/);
    assert.equal(ui.requests.filter(r=>r.route==='db_appointment_save').length,1);
    const save=ui.requests.find(r=>r.route==='db_appointment_save');assert.equal(save.headers['X-CSRF-Token'],'test-csrf');
    assert.equal(save.body.startTime,'2099-01-15T09:30');
    assert.equal(ui.w.localStorage.length,0);
  }finally{ui.w.close();}
});
test('successful local save is explicitly shown as queued Calendar synchronization',async()=>{
  const ui=await page(r=>r.route==='db_appointment_save'?{status:201,body:{id:10,calendarStatus:'pending'}}:undefined);
  try{
    await ui.eval('gApptOpenForm(null)');ui.$('gApptProfessional').value='1';ui.$('gApptProfessional').dispatchEvent(new ui.w.Event('change'));
    const check=ui.w.document.querySelector('.gApptSvcCheck');check.checked=true;check.dispatchEvent(new ui.w.Event('change'));
    ui.$('gApptClient').value='7';ui.$('gApptStart').value='2099-01-15T09:30';
    for(let i=0;i<2;i++)ui.$('gApptForm').dispatchEvent(new ui.w.SubmitEvent('submit',{cancelable:true,submitter:ui.$('gApptSave')}));
    await tick();await tick();
    assert.equal(ui.requests.filter(r=>r.route==='db_appointment_save').length,1);
    assert.equal(ui.$('gApptDialog').open,false);
    assert.match(ui.$('toast').textContent,/Sincronizzazione Calendar in coda/);
  }finally{ui.w.close();}
});
test('failed agenda loads clear the in-memory projection rather than falling back to browser data',async()=>{
  const ui=await page(r=>r.route==='db_appointments'?{status:503,body:{error:'database_unavailable'}}:undefined);
  try{
    ui.eval('APP.bookings=[{id:123}]');
    await assert.rejects(ui.eval('gLoadAppointments()'));
    assert.equal(ui.eval('APP.bookings.length'),0);
    assert.match(ui.$('appointmentList').textContent,/Nessun dato locale sostitutivo/);
  }finally{ui.w.close();}
});
