/* Strat lab core (lives inside index.html): engine detection (Python backend -> results/lab/*.json -> in-browser JS),
   data loading, parameter form, tab registry. */
(function (root) {
  'use strict';
  const E = root.StratEngine, $ = id => document.getElementById(id);
  const PAIRS = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURGBP','EURJPY','GBPJPY','EURCHF','EURAUD','EURCAD','AUDJPY','CADJPY','CHFJPY'];
  const DIRS = { D1: 'data/broker', H4: 'data/broker_h4', H1: 'data/broker_h1' };
  const Lab = {
    mode: 'browser', E, tabs: [{ id: 'benchmark', title: 'Benchmark', noData: true }], cur: null, cleanup: null, raw: null, d: null, st: {}, static: {},
    params: { lookback: 20, htf: 'continuity', entry: 'intrabar', target: 'structural', bothHit: 'skip', spreadMult: 1,
      spreadPoints: 10, frictionBp: 1, sunday: 'keep', dayShift: 2, start: '', end: '' },
  };
  Lab.ready = new Promise(r => { Lab._ready = r; });  // resolves once the engine (backend / static / browser) is known
  const fmt = (x, d = 2) => x == null || !isFinite(x) ? '–' : (+x).toFixed(d);
  const pct = (x, d = 1) => x == null || !isFinite(x) ? '–' : (x * 100).toFixed(d) + '%';
  Lab.fmt = fmt; Lab.pct = pct;
  Lab.cls = x => x > 0 ? 'up' : x < 0 ? 'dn' : '';
  Lab.esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---- engine detection ---- */
  async function getJson(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 2500);
    try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' }); if (!r.ok) throw 0; return await r.json(); }
    finally { clearTimeout(t); }
  }
  Lab.detect = async function () {
    if (location.protocol === 'file:') { Lab.mode = 'browser'; return; }
    try { const m = await getJson('api/lab/meta', 1500); if (m && m.ok) { Lab.mode = 'backend'; Lab.meta = m; return; } } catch (e) {}
    try { const ix = await getJson('results/lab/index.json'); if (ix && ix.tfs && ix.tfs.length) { Lab.mode = 'static'; Lab.index = ix; return; } } catch (e) {}
    Lab.mode = 'browser';
  };
  const MODE_TXT = { backend: 'Python + Numba backend', static: 'Precomputed results (workflow)', browser: 'Browser JS engine (limited)' };
  /* Full analyses: backend -> live; static -> results/lab/<TF>.json; browser -> null (caller falls back). */
  Lab.api = async function (kind, cfg) {
    if (Lab.mode === 'backend') {
      const r = await fetch('api/lab/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, cfg }) });
      const j = await r.json(); if (j.error) throw new Error(j.error); return j;
    }
    if (Lab.mode === 'static') {
      const tf = cfg.tf || 'D1';
      if (!Lab.static[tf]) Lab.static[tf] = await getJson('results/lab/' + tf + '.json', 15000);
      const r = Lab.static[tf][kind]; if (!r) throw new Error('not in precomputed file'); return r;
    }
    return null;
  };
  Lab.pyCfg = function () {
    const p = Lab.params, tf = $('tf').value;
    return { tf, pairs: [$('pair').value.toUpperCase()], start: p.start || undefined, end: p.end || undefined, sunday: p.sunday, day_shift_hours: tf === 'D1' ? 0 : p.dayShift,
      params: { lookback: p.lookback, htf: p.htf, entry: p.entry, target: p.target, both_hit: p.bothHit,
        spread_mult: p.spreadMult, spread_points: p.spreadPoints, friction_bp: p.frictionBp } };
  };
  Lab.jsParams = function () {
    const p = Lab.params;
    return { tf: $('tf').value, lookback: p.lookback, htf: p.htf, entry: p.entry, target: p.target, bothHit: p.bothHit,
      spreadMult: p.spreadMult, spreadPoints: p.spreadPoints, frictionBp: p.frictionBp };
  };

  /* ---- data ---- */
  function synthetic(pair, tf) {
    const step = { D1: 86400, H4: 14400, H1: 3600 }[tf], n = { D1: 3200, H4: 4000, H1: 6000 }[tf];
    let a = 7; const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const time = [], open = [], high = [], low = [], close = [];
    let t = Date.UTC(2014, 0, 1) / 1000, px = pair.indexOf('JPY') >= 0 ? 110 : 1.1;
    const vol = { D1: 0.005, H4: 0.002, H1: 0.001 }[tf];
    while (time.length < n) {
      const wd = new Date(t * 1000).getUTCDay();
      if (wd !== 0 && wd !== 6) {
        const o = px, c = o * (1 + vol * g());
        time.push(t); open.push(o); close.push(c);
        high.push(Math.max(o, c) * (1 + vol * 0.5 * rnd())); low.push(Math.min(o, c) * (1 - vol * 0.5 * rnd())); px = c;
      }
      t += step;
    }
    return { symbol: pair, point: pair.indexOf('JPY') >= 0 ? 0.001 : 0.00001, time, open, high, low, close, n: time.length, synthetic: true };
  }
  Lab.setBars = function (bars) { Lab.raw = bars; Lab.rebuild(); };
  Lab.rebuild = function () {
    if (!Lab.raw) return;
    const tf = $('tf').value; let b = Lab.raw;
    if (tf === 'D1' && Lab.params.sunday === 'merge') b = E.mergeSunday(b);
    Lab.d = E.prepare(b, tf, null, tf === 'D1' ? 0 : Lab.params.dayShift);
    Lab.range = (function () {
      const t = Lab.d.time, s = Lab.params.start ? Date.parse(Lab.params.start) / 1000 : -Infinity, e = Lab.params.end ? Date.parse(Lab.params.end) / 1000 + 86399 : Infinity;
      let i0 = 2, i1 = t.length; while (i0 < t.length && t[i0] < s) i0++; while (i1 > i0 && t[i1 - 1] > e) i1--;
      return [Math.max(2, i0), i1];
    })();
    $('lab-msg').textContent = Lab.d.symbol + ' ' + tf + ': ' + Lab.d.time.length + ' bars' + (Lab.raw.synthetic ? ' (synthetic)' : '');
    Lab.show(Lab.cur || 'benchmark');
  };
  Lab.loadFetch = async function () {
    const pair = $('pair').value.toUpperCase(), tf = $('tf').value, msg = $('lab-msg');
    msg.textContent = 'loading…';
    try {
      const r = await fetch(DIRS[tf] + '/' + pair + '.csv'); if (!r.ok) throw new Error('HTTP ' + r.status);
      Lab.setBars(E.parseCsv(await r.text(), pair));
    } catch (e) {
      msg.textContent = 'No file at ' + DIRS[tf] + '/' + pair + '.csv (' + e.message + '). Use CSV to pick a file, or Sample.';
    }
  };

  /* ---- parameter form ---- */
  const FIELDS = [
    ['lookback', 'Target lookback', 'number'], ['htf', 'HTF filter', ['continuity', 'reversal', 'all']],
    ['entry', 'Entry', ['intrabar', 'close']], ['target', 'Target', ['structural', '2r']], ['bothHit', 'Both triggers hit', ['skip', 'loss']],
    ['sunday', 'Sunday bar (D1)', ['keep', 'merge']], ['spreadPoints', 'Spread (points)', 'number'], ['spreadMult', 'Spread ×', 'number'],
    ['frictionBp', 'Friction bp', 'number'], ['dayShift', 'HTF day shift h (H1/H4)', 'number'], ['start', 'Start', 'date'], ['end', 'End', 'date'],
  ];
  function buildForm() {
    const f = $('pform'); f.innerHTML = '';
    for (const [k, label, type] of FIELDS) {
      const l = document.createElement('label'); l.textContent = label; let el;
      if (Array.isArray(type)) { el = document.createElement('select'); type.forEach(v => { const o = document.createElement('option'); o.textContent = v; el.appendChild(o); }); }
      else { el = document.createElement('input'); el.type = type; if (type === 'number') el.step = 'any'; }
      el.value = Lab.params[k];
      el.onchange = () => { Lab.params[k] = type === 'number' ? +el.value : el.value; Lab.rebuild(); };
      l.appendChild(el); f.appendChild(l);
    }
  }

  /* ---- tabs ---- */
  Lab.addTab = (id, title, render) => Lab.tabs.push({ id, title, render });
  Lab.show = function (id) {
    if (Lab.cleanup) { try { Lab.cleanup(); } catch (e) {} Lab.cleanup = null; }
    const tab = Lab.tabs.find(t => t.id === id) || Lab.tabs[0]; if (!tab) return;
    Lab.cur = tab.id;
    const nav = $('tabs'); nav.innerHTML = '';
    for (const t of Lab.tabs) { const b = document.createElement('button'); b.textContent = t.title; if (t.id === tab.id) b.className = 'on'; b.onclick = () => Lab.show(t.id); nav.appendChild(b); }
    const isBench = tab.id === 'benchmark';   // the Benchmark tab is the static dashboard in index.html
    $('bench').hidden = !isBench; $('lab').hidden = isBench;
    if (isBench) return;
    const v = $('view'); v.innerHTML = '';
    if (tab.id !== 'help' && !Lab.d && !tab.noData) { v.innerHTML = '<div class="card">Load data first: Load data (needs a server), CSV (pick a file), or Sample.</div>'; return; }
    try { const r = tab.render(v); if (typeof r === 'function') Lab.cleanup = r; }
    catch (e) { v.innerHTML = '<div class="card dn">Error: ' + Lab.esc(e.message) + '</div>'; }
  };

  Lab.boot = async function () {
    $('lab-pairs').innerHTML = PAIRS.map(p => '<option>' + p + '</option>').join('');
    buildForm();
    $('load').onclick = Lab.loadFetch;
    $('synth').onclick = () => Lab.setBars(synthetic($('pair').value.toUpperCase(), $('tf').value));
    $('tf').onchange = () => { Lab.raw = null; Lab.d = null; if (Lab.mode !== 'browser') Lab.loadFetch(); else $('lab-msg').textContent = 'Pick a CSV or Sample for ' + $('tf').value; Lab.show(Lab.cur); };
    $('file').onchange = ev => {
      const f = ev.target.files[0]; if (!f) return; const r = new FileReader();
      r.onload = () => { try { const sym = (f.name.match(/[A-Za-z]{6}/) || [$('pair').value])[0].toUpperCase(); $('pair').value = sym; Lab.setBars(E.parseCsv(r.result, sym)); } catch (e) { $('lab-msg').textContent = e.message; } };
      r.readAsText(f);
    };
    await Lab.detect();
    const m = $('mode'); m.textContent = MODE_TXT[Lab.mode]; m.className = 'badge' + (Lab.mode === 'backend' ? '' : ' sim');
    Lab._ready();
    Lab.show('benchmark');
    if (Lab.mode !== 'browser') Lab.loadFetch();
  };
  root.Lab = Lab;
})(window);
