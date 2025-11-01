
// WebWorker: heavy computations (forecast, cohort, rfm) to keep UI smooth
self.onmessage = (e) => {
  const { fn, payload } = e.data || {};
  if (fn === 'smooth') {
    const {series, alpha} = payload;
    if(!series || !series.length) return self.postMessage({ fn, result: [] });
    let s = series[0]; const out=[s];
    for (let i=1;i<series.length;i++) { s = alpha*series[i] + (1-alpha)*s; out.push(s); }
    self.postMessage({ fn, result: out });
  }
  if (fn === 'rfm') {
    const { rows } = payload; // [{k, name, lastISO, count, spend}]
    const today = new Date();
    const items = rows.map(x => ({
      name: x.name, R: Math.round((today - new Date(x.lastISO))/86400000), F: x.count, M: x.spend
    }));
    const q=(arr)=>{ const s=[...arr].sort((a,b)=>a-b); const p=[0.2,0.4,0.6,0.8].map(t=> s[Math.floor(t*(s.length-1))]||0); return p; };
    const qR=q(items.map(x=>x.R)), qF=q(items.map(x=>x.F)), qM=q(items.map(x=>x.M));
    const score=(v,qs,desc=false)=>{ let s=1; for(const t of qs) s += (desc? v<t : v>t); return s; };
    const rows2 = items.map(x => ({...x, S: score(x.R,qR,true)+score(x.F,qF,false)+score(x.M,qM,false)})).sort((a,b)=> b.S-a.S).slice(0,200);
    self.postMessage({ fn, result: rows2 });
  }
};
