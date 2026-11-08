import {buildOnboardingStatus} from '../../src/services/onboarding-status.js';
// Documentation-only, read-only frontend rendering. No PHP/Node application server,
// licensing bypass, real database, account, session, credentials or provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const tools=createRequire(new URL('../../.cache/readme-tools/package.json',import.meta.url));
const puppeteer=tools('puppeteer-core');
const chromium=tools('@sparticuz/chromium');
const output=path.join(root,'docs/assets');
await fs.mkdir(output,{recursive:true});

const catalog={
  services:[
    {service_id:1,service_name:'Manicure semipermanente',default_duration_min:40,buffer_after_min:10,base_price:35,is_active:true},
    {service_id:2,service_name:'Pedicure spa',default_duration_min:40,buffer_after_min:5,base_price:45,is_active:true},
    {service_id:3,service_name:'Trattamento viso',default_duration_min:60,buffer_after_min:10,base_price:65,is_active:true},
  ],
  professionals:[
    {professional_id:1,full_name:'Elisa · demo',email:'elisa@example.com',is_active:true},
    {professional_id:2,full_name:'Marta · demo',email:'marta@example.com',is_active:true},
  ],
  assignments:[
    {professional_id:1,service_id:1,duration_min:45},{professional_id:1,service_id:2,duration_min:40},
    {professional_id:1,service_id:3,duration_min:60},{professional_id:2,service_id:1,duration_min:40},
    {professional_id:2,service_id:2,duration_min:45},
  ],
};
const clients=[1,2,3,4,5,6].map(id=>({client_id:id,full_name:`Cliente esempio ${String(id).padStart(2,'0')}`}));
const appointments=[
  ['09:00','09:55',1,1,[1],'Manicure semipermanente','synced'],
  ['09:15','10:05',2,2,[2],'Pedicure spa','pending'],
  ['10:15','11:25',3,1,[3],'Trattamento viso','synced'],
  ['11:00','11:50',4,2,[1],'Manicure semipermanente','attention'],
  ['14:00','15:40',5,1,[1,2],'Manicure semipermanente → Pedicure spa','synced'],
  ['15:30','16:20',6,2,[2],'Pedicure spa','pending'],
].map(([start,end,client,pro,services,label,status],index)=>({
  appointment_id:index+1,client_id:client,client_name:clients[client-1].full_name,
  professional_id:pro,professional_name:catalog.professionals[pro-1].full_name,
  service_ids:services,service_names:label,start_time:`2026-11-09T${start}:00+01:00`,
  end_time:`2026-11-09T${end}:00+01:00`,updated_at:'2026-11-08T12:00:00Z',
  status:'confirmed',calendar_status:status,
}));
const operations={
  database:true,whatsapp:false,calendarMaintenance:false,syncStatus:'Dimostrativo',lastSync:null,
  backlog:[{status:'pending',count:2},{status:'attention',count:1}],
  incidents:{calendar:[],conflicts:[],sagas:[],privacy:[]},
};
const analytics={months:[
  {month:'2026-11',total:34,completed:24,cancelled:2},
  {month:'2026-10',total:82,completed:73,cancelled:4},
  {month:'2026-09',total:76,completed:67,cancelled:3},
]};
const staticFiles=new Set([
  '/assets/logo.svg','/dashboard/assets/app.css','/dashboard/assets/app.js',
  '/dashboard/assets/management-appointments.js','/dashboard/assets/management-catalog.js',
  '/dashboard/assets/operations.js','/dashboard/assets/onboarding.js','/dashboard/assets/analytics.js',
]);
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
let template=(await fs.readFile(path.join(root,'dashboard/view.html'),'utf8'))
  .replaceAll('{{CSRF_TOKEN}}','documentation-fixture-not-a-session').replaceAll('{{VERSION}}',version)
  // Use an ASCII plus when the isolated browser lacks CJK/full-width fallback fonts.
  .replaceAll('＋','+')
  .replace('Riepilogo mensile da PostgreSQL. Nessun dato dimostrativo.','Anteprima del riepilogo mensile · valori sintetici.');
template=template.replace('</head>',`<style>
.docs-preview-strip{height:32px;position:fixed;inset:0 0 auto;z-index:99;background:#12392d;color:#dfefdc;font:600 10px/32px Arial,sans-serif;text-align:center;letter-spacing:1.2px}
.sidebar{top:32px}.workspace{padding-top:32px}
.docs-dialog-note{padding:7px 10px;margin-bottom:15px;background:#eaf2e6;border-radius:6px;color:#216353;font:600 10px/1.5 Arial,sans-serif;letter-spacing:.8px}
</style></head>`).replace('<body>','<body><div class="docs-preview-strip">ANTEPRIMA DOCUMENTALE · DATI SINTETICI · NESSUN PROVIDER REALE COLLEGATO</div>');
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://docs.invalid');
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(req.method!=='GET')return json(403,{error:'documentation_preview_is_read_only'});
    const route=url.searchParams.get('route');
    if(url.pathname==='/'&&route){
      const data={db_catalog:catalog,db_clients:{clients},db_appointments:{appointments,limit:100,maintenance:false}}[route];
      return json(data?200:404,data||{error:'no_documentation_fixture'});
    }
    if(url.pathname==='/bridge.php'){
      const bridge=url.searchParams.get('path');
      const data=bridge==='/api/onboarding'?buildOnboardingStatus({state:{dbOnline:true,licenseStatus:'valid',online:false},catalog:{services:2,professionals:1,assignments:2,opening_days:6,unassigned_services:0},now:Date.parse('2026-11-08T12:00:00Z')}):bridge==='/api/operations'?operations:bridge==='/api/analytics?months=6'?analytics:null;
      return json(data?200:404,data||{error:'no_documentation_fixture'});
    }
    if(url.pathname==='/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(template);return;
    }
    if(!staticFiles.has(url.pathname)){res.writeHead(404);res.end();return;}
    const file=path.join(root,url.pathname.slice(1));
    const mime=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'image/svg+xml';
    res.writeHead(200,{'Content-Type':mime+'; charset=utf-8'});res.end(await fs.readFile(file));
  } catch(error){res.writeHead(500);res.end('Documentation rendering failed.');console.error(error);}
});
await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const env={...process.env};
  const bundledLibraries=path.join(root,'.cache/readme-tools/runtime/lib');
  try { await fs.access(bundledLibraries);env.LD_LIBRARY_PATH=[bundledLibraries,env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter); } catch {}
  browser=await puppeteer.launch({args:[...chromium.args,'--lang=it-IT'],executablePath:await chromium.executablePath(),headless:'shell',env});
  const page=await browser.newPage();
  await page.setViewport({width:1440,height:1050,deviceScaleFactor:1.5});
  await page.emulateTimezone('Europe/Rome');
  await page.setExtraHTTPHeaders({'Accept-Language':'it-IT,it;q=0.9'});
  const session=await page.createCDPSession();
  await session.send('Emulation.setLocaleOverride',{locale:'it_IT'});
  await page.setRequestInterception(true);
  page.on('request',request=>request.url().startsWith(origin+'/')?request.continue():request.abort());
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.evaluateOnNewDocument(()=>{
    const RealDate=Date;const now=RealDate.parse('2026-11-09T07:00:00Z');
    window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  });
  await page.goto(origin,{waitUntil:'networkidle0'});
  await page.waitForSelector('#statusCards .card');
  assert.equal(await page.$eval('#pageError',node=>node.hidden),true);
  await page.screenshot({path:path.join(output,'dashboard-overview.webp'),type:'webp',quality:88});
  await page.evaluate(()=>synkShowPage('appointments'));
  await page.waitForSelector('#appointmentList tbody tr');
  assert.equal(await page.$$eval('#appointmentList tbody tr',rows=>rows.length),6);
  await page.screenshot({path:path.join(output,'dashboard-agenda.webp'),type:'webp',quality:88});
  await page.evaluate(async()=>{
    await gApptOpenForm(null);
    const note=document.createElement('div');
    note.className='docs-dialog-note';note.textContent='ANTEPRIMA DOCUMENTALE · DATI SINTETICI · NESSUN SALVATAGGIO REALE';
    document.getElementById('gApptForm').prepend(note);
    document.getElementById('gApptProfessional').value='1';
    document.getElementById('gApptProfessional').dispatchEvent(new Event('change'));
    for(const box of document.querySelectorAll('.gApptSvcCheck')){
      if(['1','2'].includes(box.value)){box.checked=true;box.dispatchEvent(new Event('change'));}
    }
    document.getElementById('gApptClient').value='1';
    document.getElementById('gApptStart').value='2026-11-09T14:00';
  });
  assert.equal(await page.$eval('#gApptTotal',node=>node.textContent),'100 min');
  await page.screenshot({path:path.join(output,'dashboard-editor.webp'),type:'webp',quality:88});
  assert.deepEqual(errors,[],'Preview must not conceal browser errors');

  // Check the generated artwork in Chromium as well as XML: catch text clipped at the canvas edge.
  const artwork=await browser.newPage();
  await fs.mkdir(path.join(root,'.cache/readme-qa'),{recursive:true});
  for(const name of (await fs.readdir(output)).filter(name=>name.endsWith('.svg'))){
    await artwork.goto(pathToFileURL(path.join(output,name)).href);
    const size=await artwork.evaluate(()=>({width:document.documentElement.viewBox.baseVal.width,height:document.documentElement.viewBox.baseVal.height}));
    const clipped=await artwork.evaluate(()=>{
      const box=document.documentElement.viewBox.baseVal;
      return [...document.querySelectorAll('text')].filter(node=>{const r=node.getBBox();return r.x<0||r.y<0||r.x+r.width>box.width||r.y+r.height>box.height;}).map(node=>node.textContent);
    });
    assert.deepEqual(clipped,[],name+' contains text clipped by the SVG canvas');
    await artwork.setViewport({width:size.width,height:size.height,deviceScaleFactor:1});
    await artwork.screenshot({path:path.join(root,'.cache/readme-qa',name.replace('.svg','.png'))});
  }
  console.log('Captured 3 documentation previews; rendered and checked 6 SVG assets. No real providers contacted.');
} finally {
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
