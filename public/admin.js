// URL base delle API
const API = '/api';

// Helper fetch/JSON
async function get(path) {
  const res = await fetch(API + path);
  return res.json();
}
async function put(path, data) {
  await fetch(API + path, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  });
}

// Gestione tab
document.querySelectorAll('.tabs button').forEach(btn=>{
  btn.addEventListener('click', () => {
    document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});
// Attiva di default Servizi
document.querySelector('[data-tab="servizi"]').click();

// **SEZIONE SERVIZI**
async function loadServizi() {
  const cfg = await get('/config');
  const tbody = document.querySelector('#tbl-servizi tbody');
  tbody.innerHTML = '';
  for (let [name, s] of Object.entries(cfg.services)) {
    const pros = s.professionals || [];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td contenteditable>${name}</td>
      <td contenteditable>${s.duration}</td>
      <td contenteditable>${s.price}</td>
      <td contenteditable>${pros.join(',')}</td>
      <td><button class="del">✖️</button></td>
    `;
    tr.querySelector('.del').onclick = async ()=>{
      delete cfg.services[name];
      await put('/config', cfg);
      loadServizi();
    };
    tbody.appendChild(tr);
  }
  // salva on-edit
  tbody.querySelectorAll('tr').forEach(tr=>{
    Array.from(tr.children).forEach(td=>{
      td.addEventListener('blur', async()=>{
        // ricostruisci services
        const newServices = {};
        tbody.querySelectorAll('tr').forEach(r=>{
          const [n,d,p,pr] = Array.from(r.children).map(x=>x.innerText.trim());
          newServices[n] = { duration: +d, price: +p, professionals: pr ? pr.split(',') : [] };
        });
        cfg.services = newServices;
        await put('/config', cfg);
        loadServizi();
      });
    });
  });
}

document.getElementById('btn-add-servizio').onclick = async ()=>{
  const cfg = await get('/config');
  const defaultName = `Nuovo Servizio ${Date.now()}`;
  cfg.services[defaultName] = { duration: 60, price: 0, professionals: [] };
  await put('/config', cfg);
  loadServizi();
};

// **SEZIONE ORARI**
async function loadOrari() {
  const cfg = await get('/config');
  const tbody = document.querySelector('#tbl-orari tbody');
  tbody.innerHTML = '';
  for (let [day, arr] of Object.entries(cfg.businessHours)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${day}</td>
      <td contenteditable>${arr[0]||''}-${arr[1]||''}</td>
      <td contenteditable>${arr[2]||''}-${arr[3]||''}</td>
      <td><button class="del">✖️</button></td>
    `;
    tr.querySelector('.del').onclick = async ()=>{
      delete cfg.businessHours[day];
      await put('/config', cfg);
      loadOrari();
    };
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('tr').forEach(tr=>{
    Array.from(tr.children).slice(1,3).forEach(td=>{
      td.addEventListener('blur', async()=>{
        const newBH = {};
        tbody.querySelectorAll('tr').forEach(r=>{
          const day = r.children[0].innerText.trim();
          const [mIn,mOut] = r.children[1].innerText.split('-');
          const [pIn,pOut] = r.children[2].innerText.split('-');
          newBH[day] = [mIn||'', mOut||'', pIn||'', pOut||''];
        });
        cfg.businessHours = newBH;
        await put('/config', cfg);
        loadOrari();
      });
    });
  });
}

document.getElementById('btn-add-orario').onclick = async ()=>{
  const cfg = await get('/config');
  cfg.businessHours[Object.keys(cfg.businessHours).length] = ['', '', '', ''];
  await put('/config', cfg);
  loadOrari();
};

// **SEZIONE INTENTS**
async function loadIntents() {
  const its = await get('/intents');
  const tbody = document.querySelector('#tbl-intents tbody');
  tbody.innerHTML = '';
  its.forEach((it, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td contenteditable>${it.intent}</td>
      <td contenteditable>${it.pattern}</td>
      <td contenteditable>${it.responses.map(r=>r.text).join(' | ')}</td>
      <td><button class="del">✖️</button></td>
    `;
    tr.querySelector('.del').onclick = async ()=>{
      its.splice(i,1);
      await put('/intents', its);
      loadIntents();
    };
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('tr').forEach((tr, idx)=>{
    Array.from(tr.children).slice(0,3).forEach(td=>{
      td.addEventListener('blur', async()=>{
        // ricostruisci array intents
        const newIts = [];
        document.querySelectorAll('#tbl-intents tbody tr').forEach(r=>{
          const [intent, patt, resp] = Array.from(r.children).slice(0,3).map(x=>x.innerText.trim());
          newIts.push({
            intent,
            pattern: patt,
            responses: resp.split('|').map(s=>({ text: s.trim() }))
          });
        });
        await put('/intents', newIts);
        loadIntents();
      });
    });
  });
}

document.getElementById('btn-add-intent').onclick = async ()=>{
  const its = await get('/intents');
  its.push({ intent: 'new', pattern: '^$', responses: [{ text: 'Nuova risposta' }] });
  await put('/intents', its);
  loadIntents();
};

// Quando carica la pagina:
window.addEventListener('load', ()=>{
  loadServizi();
  loadOrari();
  loadIntents();
});
