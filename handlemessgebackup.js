
/* ===== DATA RESCUE LOADER v4 — carica bookings/config, fallback import, fix calcoli base ===== */
(function(){
  // ---- Tiny utils
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const ISO = d => {
    const x = (d instanceof Date) ? new Date(d) : new Date(d);
    if (isNaN(x)) return '';
    x.setHours(0,0,0,0);
    const y = x.getFullYear();
    const m = String(x.getMonth()+1).padStart(2,'0');
    const da= String(x.getDate()).padStart(2,'0');
    return `${y}-${m}-${da}`;
  };
  const safeNum = x => Number.isFinite(Number(x)) ? Number(x) : 0;
  const get = (o, ks, d=null) => { for (const k of ks) if (o && o[k]!=null) return o[k]; return d; };
  const st = b => String(get(b, ['status','state'], '')).toLowerCase();
  // Ensure S exists
  window.S = window.S || { data: [], charts:{}, history:[], future:[], settings: { currency:'EUR', locale:'it-IT', hoursPerDay:8, proShare:{}, proHours:{}, servicesConfig:{} } };
  // ---- Status chip
  function statusChip(msg, tone='info'){
    let el = document.querySelector('#dataRescueChip');
    if(!el){
      el = document.createElement('div');
      el.id = 'dataRescueChip';
      el.style.cssText = 'position:fixed;right:12px;bottom:12px;padding:8px 10px;border-radius:10px;background:#0f172a;color:#fff;font:12px system-ui;z-index:99999;opacity:.95;box-shadow:0 6px 18px rgba(0,0,0,.4)';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = tone==='error' ? '#7f1d1d' : (tone==='warn' ? '#1f2937' : '#0f172a');
  }
  // ---- Fetch tolerant
  async function fetchAsJsonTolerant(url){
    const bust = url.includes('?') ? '&' : '?';
    const req = url + bust + 'v=' + Date.now();
    const res = await fetch(req, {cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
    const txt = await res.text();
    const clean = txt.replace(/^\uFEFF/, '').trim();
    if(!clean) return null;
    try { return JSON.parse(clean); } catch(e){ throw new Error(`JSON malformato: ${url}`); }
  }
  async function fetchFirstOk(paths){
    for (const u of paths){
      try { const j = await fetchAsJsonTolerant(u); return [u, j]; }
      catch(e){ console.debug('[miss]', u, e.message); }
    }
    return [null, null];
  }
  // ---- Paths
  function baseURL(){
    if (window.DASH_BASE) return String(window.DASH_BASE);
    try { return new URL('.', location.href).href; } catch { return '/'; }
  }
  function buildPaths(fname){
    const B = baseURL();
    return [
      new URL(fname, B).href,
      new URL('./'+fname, B).href,
      new URL('../'+fname, B).href,
      '/'+fname,
      '/data/'+fname
    ];
  }
  // ---- Normalizers
  function asArray(x){
    if (Array.isArray(x)) return x;
    if (x && Array.isArray(x.bookings)) return x.bookings;
    if (x && Array.isArray(x.rows)) return x.rows;
    return [];
  }
  function mergeConfig(cfg){
    if(!cfg || typeof cfg!=='object') return;
    const Sset = S.settings;
    Sset.servicesConfig = cfg.servicesConfig ?? Sset.servicesConfig ?? {};
    Sset.proShare       = cfg.proShare       ?? Sset.proShare       ?? {};
    Sset.proHours       = cfg.proHours       ?? Sset.proHours       ?? {};
    if (cfg.currency) Sset.currency = cfg.currency;
    if (cfg.locale)   Sset.locale   = cfg.locale;
    if (cfg.ivaPct!=null) Sset.ivaPct = safeNum(cfg.ivaPct);
    // Opzionali mapping per unificare identità
    Sset.proEmailToName = cfg.proEmailToName ?? Sset.proEmailToName ?? {};
    Sset.proNameToEmail = cfg.proNameToEmail ?? Sset.proNameToEmail ?? {};
  }
  function pro(b){
    return (b && (b.professionalName || b.pro || b.proName)) || '';
  }
  function proEmail(b){
    return String((b && (b.professionalEmail || b.proEmail || b.email)) || '').toLowerCase();
  }
  function identityLabel(b){
    let em = proEmail(b);
    let nm = String(pro(b)||'').trim();
    const e2n = S.settings.proEmailToName || {};
    const n2e = S.settings.proNameToEmail || {};
    if (em && e2n[em]) nm = e2n[em];
    if (!em && nm && n2e[nm]) em = String(n2e[nm]||'').toLowerCase();
    const label = nm ? (em ? `${nm} (${em})` : nm) : (em || '—');
    const key = em || nm.toLowerCase() || '—';
    return {key, label, name: nm};
  }
  function start(b){
    const s = get(b,['start','startTime'],null);
    return s ? new Date(s) : null;
  }
  function end(b){
    if (b && b.endTime) return new Date(b.endTime);
    const s = start(b);
    const dur = safeNum(get(b,['durationMin'],0));
    if (!s) return null;
    const e = new Date(s); e.setMinutes(e.getMinutes()+dur); return e;
  }
  function service(b){
    return String(get(b, ['service','treatment','svc'], '')||'');
  }
  function priceFromConfig(svc){
    const cfg = S.settings.servicesConfig || {};
    const item = cfg[svc] || null;
    if (item && (item.price!=null)) return safeNum(item.price);
    return 0;
  }
  function sumRevenueByConfig(rows){
    let tot = 0;
    for (const b of rows || []){
      const svc = service(b);
      const p = priceFromConfig(svc);
      tot += p;
    }
    return tot;
  }
  window.sumRevenueByConfig = window.sumRevenueByConfig || sumRevenueByConfig;
  function minutes(a,b){
    if (!(a instanceof Date) || !(b instanceof Date)) return 0;
    return Math.max(0, Math.round((b.getTime()-a.getTime())/60000));
  }
  function currency(n){
    try {
      return new Intl.NumberFormat(S.settings.locale || 'it-IT', {style:'currency', currency: S.settings.currency || 'EUR'}).format(n||0);
    } catch {
      return (n||0).toFixed(2)+' '+(S.settings.currency||'EUR');
    }
  }
  // ---- Minimal fallback recompute (if the project's recompute fails)
  async function recomputeFallback(){
    const rows = Array.isArray(S.data) ? S.data : [];
    // Range (robusto)
    const fromEl = document.querySelector('#from'), toEl = document.querySelector('#to');
    let from = fromEl && fromEl.value ? new Date(fromEl.value) : null;
    let to   = toEl   && toEl.value   ? new Date(toEl.value)   : null;
    if (!from || isNaN(from)) from = new Date(Math.min(...rows.map(b=>start(b)?.getTime()||Infinity)));
    if (!to   || isNaN(to))   to   = new Date(Math.max(...rows.map(b=>end(b)?.getTime()||-Infinity)));
    from.setHours(0,0,0,0); to.setHours(23,59,59,999);
    const confirmed = rows.filter(b => st(b) !== 'cancelled' && start(b) && start(b)>=from && start(b)<=to);
    // Revenue totals
    const gross = sumRevenueByConfig(confirmed);
    const ivaPct = safeNum(S.settings.ivaPct ?? 22);
    const iva = gross * (ivaPct/100);
    const net = gross; // se price è già ivato o no dipende dal tuo schema; qui consideriamo price come imponibile
    // Update common IDs if present
    const setTxt = (sel, val) => { const el=document.querySelector(sel); if(el) el.textContent = val; };
    setTxt('#grossRevenue', currency(gross));
    setTxt('#netRevenue', currency(net));
    setTxt('#ivaAmount', currency(iva));
    setTxt('#ticketAvg', confirmed.length ? currency(gross/confirmed.length) : currency(0));
    setTxt('#appointmentsCount', String(confirmed.length));
    // Split entrate
    const splitTB = document.querySelector('#splitTable tbody') || document.querySelector('#splitTable') || null;
    if (splitTB){
      const map = new Map();
      for (const b of confirmed){
        const id = identityLabel(b);
        const r  = priceFromConfig(service(b));
        map.set(id.label, (map.get(id.label)||0) + r);
      }
      if (splitTB.tagName === 'TBODY') splitTB.innerHTML='';
      const rowsArr = [...map.entries()].sort((a,b)=>b[1]-a[1]);
      rowsArr.forEach(([lab,tot])=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${lab}</td><td class="num">${currency(tot)}</td>`;
        (splitTB.tagName==='TBODY'? splitTB : splitTB.appendChild(document.createElement('tbody'))).appendChild(tr);
      });
    }
    // Leaderboard pro (€/h)
    const leadTB = document.querySelector('#proLead tbody') || null;
    if (leadTB){
      leadTB.innerHTML='';
      const agg = new Map();
      for (const b of confirmed){
        const id = identityLabel(b);
        const r  = priceFromConfig(service(b));
        const m  = minutes(start(b), end(b));
        if (!agg.has(id.label)) agg.set(id.label,{rev:0,min:0,name:id.name});
        const x = agg.get(id.label); x.rev += r; x.min += m;
      }
      const days = Math.max(1, Math.round((to-from)/86400000)+1);
      [...agg.entries()].map(([lab,x])=>{
        const availMin = safeNum(S.settings.proHours?.[x.name] ?? S.settings.hoursPerDay ?? 8) * 60 * days;
        const perHour = x.min ? (x.rev/(x.min/60)) : 0;
        const util = availMin? Math.round((x.min/availMin)*100) : 0;
        return {lab, rev:x.rev, hours:(x.min/60), perHour, util};
      }).sort((a,b)=>b.perHour-a.perHour).forEach(r=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${r.lab}</td><td>${currency(r.rev)}</td><td>${r.hours.toFixed(1)}</td><td>${currency(r.perHour)}</td><td>${r.util}%</td>`;
        leadTB.appendChild(tr);
      });
    }
    // Pareto servizi (top->bottom)
    const paretoTB = document.querySelector('#pareto tbody') || null;
    if (paretoTB){
      paretoTB.innerHTML='';
      const bySvc = new Map();
      for (const b of confirmed){
        const svc = service(b);
        const r = priceFromConfig(svc);
        bySvc.set(svc, (bySvc.get(svc)||0) + r);
      }
      [...bySvc.entries()].sort((a,b)=>b[1]-a[1]).forEach(([svc,tot])=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${svc}</td><td class="num">${currency(tot)}</td>`;
        paretoTB.appendChild(tr);
      });
    }
    // Ricavi giornalieri (se c'è un canvas #revDaily)
    const cv = document.querySelector('#revDaily');
    if (cv && window.line){
      const byDay = new Map();
      for (const b of confirmed){
        const k = ISO(start(b));
        byDay.set(k, (byDay.get(k)||0) + priceFromConfig(service(b)));
      }
      const labels = [...byDay.keys()].sort();
      const values = labels.map(k=> byDay.get(k));
      window.line('revDaily', labels, values, 'revDaily');
    }
    // Forecast (SMA7 + weekday factors + trend)
    const cF = document.querySelector('#revForecast');
    if (cF && window.line){
      // Build daily series full range
      const byDay = new Map();
      const d0 = new Date(from); d0.setHours(0,0,0,0);
      const d1 = new Date(to);   d1.setHours(0,0,0,0);
      for (let d=new Date(d0); d<=d1; d.setDate(d.getDate()+1)){
        byDay.set(ISO(d), 0);
      }
      for (const b of confirmed){
        const k = ISO(start(b));
        byDay.set(k, (byDay.get(k)||0) + priceFromConfig(service(b)));
      }
      const dayLabels = [...byDay.keys()];
      const dayValues = dayLabels.map(k=>byDay.get(k));
      const mean = dayValues.reduce((a,b)=>a+b,0) / Math.max(1, dayValues.length);
      const wdSum = Array(7).fill(0), wdCnt = Array(7).fill(0);
      dayLabels.forEach((lab,i)=>{ const w=new Date(lab).getDay(); wdSum[w]+=dayValues[i]; wdCnt[w]++; });
      const seasonal = wdSum.map((s,i)=> wdCnt[i] ? (s/wdCnt[i]) / (mean || 1) : 1);
      const lastN = Math.min(21, dayValues.length);
      const ys = dayValues.slice(-lastN);
      const n = ys.length;
      const xmean = (n+1)/2;
      const ymean = ys.reduce((a,b)=>a+b,0)/Math.max(1,n);
      let num=0, den=0;
      for(let i=0;i<n;i++){ const x=i+1; num+=(x-xmean)*(ys[i]-ymean); den+=(x-xmean)*(x-xmean); }
      const slope = den ? num/den : 0;
      const m = Math.min(7, dayValues.length);
      const lastAvg = (m? dayValues.slice(-m).reduce((a,b)=>a+b,0)/m : 0);
      const proj = [], projLabels = [];
      for (let i=1;i<=30;i++){
        const nd = new Date(d1); nd.setDate(nd.getDate()+i);
        const w  = nd.getDay();
        const base = lastAvg + slope*i;
        const v = Math.max(0, base * (seasonal[w] || 1));
        proj.push(Math.round(v));
        projLabels.push(ISO(nd));
      }
      window.line('revForecast', dayLabels.concat(projLabels), dayValues.concat(proj), 'revForecast');
    }
    // Agenda semplice (se esiste #agendaList)
    const ul = document.querySelector('#agendaList');
    if (ul){
      ul.innerHTML='';
      confirmed.sort((a,b)=> start(a)-start(b)).forEach(b=>{
        const li = document.createElement('li');
        li.textContent = `${ISO(start(b))} — ${service(b)} — ${pro(b)}`;
        ul.appendChild(li);
      });
    }
  }
  // ---- Boot: load config + bookings + recompute
  async function boot(){
    try{
      statusChip('Carico config/bookings…');
      // CONFIG
      const [cfgURL, cfgRaw] = await fetchFirstOk(buildPaths('config.json'));
      if (!cfgURL){ statusChip('config.json non trovato (puoi importarlo)', 'warn'); }
      mergeConfig(cfgRaw||{});
      // BOOKINGS
      const [bokURL, bokRaw] = await fetchFirstOk(buildPaths('bookings.json'));
      let rows = asArray(bokRaw);
      if (!rows || !rows.length){
        // seed fallback
        const seedNode = document.querySelector('#seed');
        const seed = seedNode && seedNode.textContent && seedNode.textContent.trim();
        if (seed){
          try{
            const arr = JSON.parse(seed);
            if (Array.isArray(arr) && arr.length) rows = arr;
          }catch{}
        }
      }
      S.data = Array.isArray(rows) ? rows : [];
      const msg = `config: ${cfgURL? 'ok' : 'manca'} | bookings: ${S.data.length} eventi`;
      statusChip(msg, cfgURL && S.data.length ? 'info' : 'warn');
      // Recompute via project function or fallback
      const callRecompute = async () => {
        try{
          if (typeof window.recompute === 'function'){ await window.recompute(); }
          else { await recomputeFallback(); }
        }catch(e){
          console.error('recompute failed → fallback', e);
          await recomputeFallback();
        }
      };
      await callRecompute();
      // Esponi Import (per caricare file localmente se il fetch fallisce)
      makeImporters(callRecompute);
    }catch(e){
      console.error('boot error', e);
      statusChip('Errore bootstrap: '+e.message, 'error');
    }
  }
  // ---- Importers UI
  function makeImporters(onDone){
    let bar = document.querySelector('#dataRescueBar');
    if (!bar){
      bar = document.createElement('div');
      bar.id = 'dataRescueBar';
      bar.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;z-index:99998';
      bar.innerHTML = `
        <input id="impBookings" type="file" accept=".json,application/json" style="display:none">
        <input id="impConfig"   type="file" accept=".json,application/json" style="display:none">
        <button id="btnImpB" class="btn" style="padding:6px 10px;border-radius:8px;">Importa bookings.json</button>
        <button id="btnImpC" class="btn" style="padding:6px 10px;border-radius:8px;">Importa config.json</button>
      `;
      document.body.appendChild(bar);
      document.querySelector('#btnImpB').onclick = ()=> document.querySelector('#impBookings').click();
      document.querySelector('#btnImpC').onclick = ()=> document.querySelector('#impConfig').click();
      document.querySelector('#impBookings').addEventListener('change', async (e)=>{
        const f = e.target.files && e.target.files[0]; if (!f) return;
        const txt = await f.text(); let j=null;
        try{ j = JSON.parse(txt); }catch{ statusChip('bookings.json non è JSON valido', 'error'); return; }
        S.data = asArray(j);
        statusChip(`bookings importati: ${S.data.length}`);
        await onDone();
      });
      document.querySelector('#impConfig').addEventListener('change', async (e)=>{
        const f = e.target.files && e.target.files[0]; if (!f) return;
        const txt = await f.text(); let j=null;
        try{ j = JSON.parse(txt); }catch{ statusChip('config.json non è JSON valido', 'error'); return; }
        mergeConfig(j||{});
        statusChip(`config importato`);
        await onDone();
      });
    }
  }
  // ---- Start
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
})();
