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
// attiva di default Servizi
document.querySelector('[data-tab="servizi"]').click();

// **SEZIONE SERVIZI**
async function loadServizi() {
  const cfg = await get('/config');
  const tbody = document.querySelector('#tbl-servizi tbody');
  tbody.innerHTML = '';
  Object.entries(cfg.services).forEach(([name, s]) => {
    const pros = s.professionals || [];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td contenteditable>${name}</td>
      <td contenteditable>${s.duration}</td>
      <td contenteditable>${s.price}</td>
      <td contenteditable>${pros.join(',')}</td>
      <td><button class="del">✖️</button></td>
    `;
    tr.querySelector('.del').onclick = async () => {
      delete cfg.services[name];
      await put('/config', cfg);
      loadServizi();
    };
    Array.from(tr.children).forEach(td => td.addEventListener('blur', async () => {
      const newServices = {};
      document.querySelectorAll('#tbl-servizi tbody tr').forEach(r => {
        const [n,d,p,pr] = Array.from(r.children).slice(0,4).map(x=>x.innerText.trim());
        newServices[n] = { duration:+d, price:+p, professionals: pr? pr.split(','): [] };
      });
      cfg.services = newServices;
      await put('/config', cfg);
      loadServizi();
    }));
    tbody.appendChild(tr);
  });
}

document.getElementById('form-add-service').addEventListener('submit', async e => {
  e.preventDefault();
  const name  = document.getElementById('svc-name').value.trim();
  const dur   = parseInt(document.getElementById('svc-duration').value,10);
  const price = parseFloat(document.getElementById('svc-price').value);
  const pros  = document.getElementById('svc-pros').value.split(',').map(s=>s.trim()).filter(Boolean);
  const cfg   = await get('/config');
  cfg.services[name] = { duration: dur, price, professionals: pros };
  await put('/config', cfg);
  e.target.reset();
  loadServizi();
});

document.getElementById('btn-add-servizio').onclick = async () => {
  const cfg = await get('/config');
  const defaultName = `Nuovo Servizio ${Date.now()}`;
  cfg.services[defaultName] = { duration:60, price:0, professionals:[] };
  await put('/config', cfg);
  loadServizi();
};

// **SEZIONE ORARI**
async function loadOrari() {
  const cfg = await get('/config');
  const tbody = document.querySelector('#tbl-orari tbody');
  tbody.innerHTML = '';
  Object.entries(cfg.businessHours).forEach(([day, arr]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${day}</td>
      <td contenteditable>${arr[0]||''}-${arr[1]||''}</td>
      <td contenteditable>${arr[2]||''}-${arr[3]||''}</td>
      <td><button class="del">✖️</button></td>
    `;
    tr.querySelector('.del').onclick = async () => {
      delete cfg.businessHours[day];
      await put('/config', cfg);
      loadOrari();
    };
    Array.from(tr.children).slice(1,3).forEach(td => td.addEventListener('blur', async () => {
      const newBH = {};
      document.querySelectorAll('#tbl-orari tbody tr').forEach(r => {
        const dayKey = r.children[0].innerText.trim();
        const [mIn,mOut] = r.children[1].innerText.split('-');
        const [pIn,pOut] = r.children[2].innerText.split('-');
        newBH[dayKey] = [mIn||'', mOut||'', pIn||'', pOut||''];
      });
      cfg.businessHours = newBH;
      await put('/config', cfg);
      loadOrari();
    }));
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-add-orario').onclick = async () => {
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
    tr.querySelector('.del').onclick = async () => {
      its.splice(i,1);
      await put('/intents', its);
      loadIntents();
    };
    Array.from(tr.children).slice(0,3).forEach(td => td.addEventListener('blur', async () => {
      const newIts = [];
      document.querySelectorAll('#tbl-intents tbody tr').forEach(r => {
        const [intent, patt, resp] = Array.from(r.children).slice(0,3).map(x=>x.innerText.trim());
        newIts.push({ intent, pattern: patt, responses: resp.split('|').map(s=>({ text: s.trim() })) });
      });
      await put('/intents', newIts);
      loadIntents();
    }));
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-add-intent').onclick = async () => {
  const its = await get('/intents');
  its.push({ intent: 'new', pattern: '^$', responses: [{ text: 'Nuova risposta' }] });
  await put('/intents', its);
  loadIntents();
};

// **SEZIONE PROFESSIONISTI**
async function loadProfessionisti() {
  const cfg   = await get('/config');
  const profs = cfg.professionals || [];
  const tbody = document.querySelector('#tbl-professionisti tbody');
  tbody.innerHTML = '';
  profs.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td contenteditable>${p.name}</td>
      <td contenteditable>${p.email}</td>
      <td><button class="del">✖️</button></td>
    `;
    tr.querySelector('.del').onclick = async () => {
      cfg.professionals = cfg.professionals.filter(x => x.id !== p.id);
      await put('/config', cfg);
      loadProfessionisti();
    };
    Array.from(tr.querySelectorAll('td[contenteditable]')).forEach((td, idx) => td.addEventListener('blur', async e => {
      if(idx === 0) p.name = e.target.innerText.trim(); else p.email = e.target.innerText.trim();
      await put('/config', cfg);
      loadProfessionisti();
    }));
    tbody.appendChild(tr);
  });
}

document.getElementById('form-add-professional').addEventListener('submit', async e => {
  e.preventDefault();
  const name  = document.getElementById('pro-name').value.trim();
  const email = document.getElementById('pro-email').value.trim();
  const cfg   = await get('/config');
  const maxId = cfg.professionals.reduce((m,p)=>Math.max(m,p.id), 0);
  cfg.professionals.push({ id: maxId+1, name, email });
  await put('/config', cfg);
  e.target.reset();
  loadProfessionisti();
});

document.querySelectorAll('.tabs button').forEach(btn=>btn.addEventListener('click',()=>{}));

// Caricamento iniziale dei dati
window.addEventListener('load', () => {
  loadServizi();
  loadOrari();
  loadIntents();
  loadProfessionisti();
});