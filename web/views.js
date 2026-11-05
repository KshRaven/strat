/* Result views (no JSON reading needed) + automatic observations.
   Data comes from Lab.api (backend or workflow files); without either, the Summary and Validation
   tabs use the in-browser engine on the loaded pair and the others explain what is needed. */
(function () {
  'use strict';
  const Lab = window.Lab, E = Lab.E, f = Lab.fmt, pct = Lab.pct, cls = Lab.cls, esc = Lab.esc;
  const kpi = (k, v, c) => `<div><span class="mut">${k}</span><b class="${c || ''}">${v}</b></div>`;
  const note = (el, html) => { el.innerHTML = '<div class="card">' + html + '</div>'; };
  const NEED = 'This view needs the Python backend (<code>python py/server.py</code>) or precomputed results (run the "Strat lab batch" workflow, then reload). The browser fallback only covers Summary, Validation and Replay.';

  /* ---- small canvas helpers ---- */
  function lineChart(cv, series, opts) {
    opts = opts || {}; const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = opts.h || 220;
    cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = n => getComputedStyle(document.getElementById('lab')).getPropertyValue(n).trim(), cols = [cs('--acc'), cs('--up'), cs('--dn'), cs('--warn')];
    let lo = Infinity, hi = -Infinity, n = 0; series.forEach(s => { s.v.forEach(x => { if (x != null && isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }); n = Math.max(n, s.v.length); });
    if (opts.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); } if (!(hi > lo)) { hi = lo + 1; }
    const L = 44, R = 6, T = 8, B = 16, X = i => L + i / Math.max(1, n - 1) * (W - L - R), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    g.font = '11px system-ui'; g.fillStyle = cs('--mut'); g.strokeStyle = cs('--line');
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4, y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(opts.pct ? (v * 100).toFixed(0) + '%' : v.toFixed(2), 2, y + 3); }
    if (opts.zero) { g.strokeStyle = cs('--mut'); const y = Y(0); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); }
    series.forEach((s, k) => { g.strokeStyle = s.color || cols[k % 4]; g.lineWidth = 1.5; g.beginPath(); let st = false; s.v.forEach((v, i) => { if (v == null) return; const x = X(i), y = Y(v); st ? g.lineTo(x, y) : (g.moveTo(x, y), st = true); }); g.stroke(); });
    if (opts.labels) { g.fillStyle = cs('--mut'); g.fillText(opts.labels[0], L, H - 3); const t = opts.labels[1]; g.fillText(t, W - R - g.measureText(t).width, H - 3); }
  }
  function bars(cv, vals, labels, opts) {
    opts = opts || {}; const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = opts.h || 180;
    cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = n => getComputedStyle(document.getElementById('lab')).getPropertyValue(n).trim();
    const m = Math.max(1e-9, ...vals.map(Math.abs)), mid = H / 2 - 6, bw = (W - 10) / vals.length;
    g.font = '10px system-ui'; g.fillStyle = cs('--mut'); g.strokeStyle = cs('--line'); g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
    vals.forEach((v, i) => { g.fillStyle = v >= 0 ? cs('--up') : cs('--dn'); const h = Math.abs(v) / m * (mid - 8); g.fillRect(5 + i * bw + 1, v >= 0 ? mid - h : mid, Math.max(1, bw - 2), h);
      if (labels && bw > 26) { g.fillStyle = cs('--mut'); g.fillText(labels[i], 5 + i * bw, H - 3); } });
  }

  /* ---- observation engine: plain-language reading of any result set ---- */
  function observe(R) {
    const o = [], add = (lvl, t) => o.push({ lvl, t });
    if (R.stress) {
      const sc = R.stress.scenarios.filter(s => s.stats), base = sc.find(s => s.name === 'baseline'), worst = sc.find(s => s.name === 'pessimistic combo');
      if (base && worst) {
        const b = base.stats.avgNetR, w = worst.stats.avgNetR;
        if (w <= 0 && b > 0) add('bad', `The edge disappears under pessimistic assumptions: baseline ${f(b, 3)}R per trade becomes ${f(w, 3)}R. Treat the baseline as an upper bound, not a forecast.`);
        else if (w > 0 && b > 0 && w / b < 0.5) add('meh', `More than half of the baseline edge (${f(b, 3)}R) is lost under pessimistic assumptions (${f(w, 3)}R). Costs and fill assumptions matter a lot.`);
        else if (w > 0) add('good', `Still positive under pessimistic assumptions: ${f(w, 3)}R per trade (baseline ${f(b, 3)}R).`);
      }
      const bl = sc.find(s => s.name === 'both-hit = booked loss');
      if (base && bl && base.stats.avgNetR - bl.stats.avgNetR > 0.03) add('bad', `Booking the "both triggers hit" bars as losses costs ${f(base.stats.avgNetR - bl.stats.avgNetR, 3)}R per trade. The skip rule flatters results: use the booked-loss variant.`);
      const th = sc.find(s => s.name === 'spread x3'); if (base && th && th.stats.avgNetR <= 0 && base.stats.avgNetR > 0) add('meh', 'A spread three times the assumed one wipes out the edge: only trade this with a tight-spread broker and check live spreads.');
      const bs = R.stress.bySetup || {}, ks = Object.keys(bs).filter(k => bs[k].trades >= 30);
      if (ks.length) { const best = ks.sort((a, b) => bs[b].avgNetR - bs[a].avgNetR); add('meh', `By setup (≥30 trades): best ${best[0]} ${f(bs[best[0]].avgNetR, 3)}R, worst ${best[best.length - 1]} ${f(bs[best[best.length - 1]].avgNetR, 3)}R. Differences between setups are noisy unless trade counts are large.`); }
    }
    if (R.walkforward && R.walkforward.folds) {
      const fo = R.walkforward.folds, pos = fo.filter(x => x.stats.avgNetR > 0).length;
      add(pos === fo.length ? 'good' : pos >= fo.length / 2 ? 'meh' : 'bad', `${pos} of ${fo.length} date folds have positive average R. ${pos === fo.length ? 'Consistent across periods.' : 'The result depends on which period you look at.'}`);
      const b = R.walkforward.bootstrap; if (b && b.mean05 != null) add(b.mean05 > 0 ? 'good' : 'meh', `Bootstrap 5th percentile of mean R per trade is ${f(b.mean05, 3)}: ${b.mean05 > 0 ? 'the mean stays above zero in 95% of resamples.' : 'a zero edge cannot be ruled out statistically.'}`);
      const bp = R.walkforward.byPair || {}, pn = Object.keys(bp), pp = pn.filter(k => bp[k].avgNetR > 0).length;
      if (pn.length > 3) add(pp / pn.length >= 0.7 ? 'good' : pp / pn.length >= 0.5 ? 'meh' : 'bad', `${pp} of ${pn.length} pairs are positive. ${pp / pn.length < 0.6 ? 'The edge is carried by a few pairs; that is a concentration risk.' : 'Reasonably broad across pairs.'}`);
    }
    if (R.robustness) {
      const d = R.robustness.monthlyDsr; if (d != null) add(d > 0.95 ? 'good' : d > 0.5 ? 'meh' : 'bad', `Deflated Sharpe probability ${f(d, 2)} (after counting the variants tried): ${d > 0.95 ? 'unlikely to be luck.' : d > 0.5 ? 'inconclusive.' : 'consistent with luck once you account for how many variants were tried.'}`);
    }
    if (R.portfolio_robustness && R.portfolio_robustness.dsr != null) { const d = R.portfolio_robustness.dsr; add(d > 0.95 ? 'good' : d > 0.5 ? 'meh' : 'bad', `Portfolio-level deflated Sharpe probability ${f(d, 2)}.`); }
    if (R.portfolio) {
      const p = R.portfolio, m = p.metrics;
      add(m.maxDD < -0.25 ? 'bad' : m.maxDD < -0.15 ? 'meh' : 'good', `Portfolio max drawdown ${pct(m.maxDD)} against CAGR ${pct(m.cagr)} (Sharpe ${f(m.sharpe)}). Compare with what you could actually sit through.`);
      const bl = p.blocks || []; if (bl.length > 1) { const neg = bl.filter(x => x.cagr < 0); if (neg.length) add('meh', `Negative sub-periods: ${neg.map(x => x.name).join(', ')}. The strategy has stretches that lose money.`); }
      if (p.bootstrap && p.bootstrap.sharpe05 < 0) add('meh', `Block-bootstrap 5th percentile Sharpe is ${f(p.bootstrap.sharpe05)}, below zero.`);
    }
    if (R.grid && R.grid.rows) {
      const rows = R.grid.rows.filter(r => r.trades >= 30), pos = rows.filter(r => r.avgNetR > 0).length;
      if (rows.length) add(pos / rows.length > 0.7 ? 'good' : pos / rows.length > 0.4 ? 'meh' : 'bad', `${pos} of ${rows.length} parameter combinations are positive. ${pos / rows.length > 0.7 ? 'The result is not a single lucky setting.' : 'The result is sensitive to parameters; beware picking the best cell.'}`);
    }
    if (!o.length) add('meh', 'No analyses loaded yet.');
    return o;
  }
  Lab.observe = observe;
  const obsHtml = list => '<ul class="obs">' + list.map(x => `<li class="${x.lvl}">${esc(x.t)}</li>`).join('') + '</ul>';

  /* gather everything available for the loaded pair/timeframe */
  async function gather(kinds) {
    const cfg = Lab.pyCfg(), out = {};
    for (const k of kinds) { try { const r = await Lab.api(k, k === 'portfolio' || k === 'walkforward' || k === 'stress' || k === 'portfolio_robustness' || k === 'grid' ? Object.assign({}, cfg, { pairs: null, folds: k === 'grid' ? 1 : 4, grid: k === 'grid' ? { axes: [{ param: 'lookback', values: [10, 20, 40] }, { param: 'htf', values: ['continuity', 'all', 'reversal'] }, { param: 'both_hit', values: ['skip', 'loss'] }] } : undefined }) : cfg); if (r) out[k] = r; } catch (e) { out[k + '_err'] = e.message; } }
    return out;
  }
  function jsStress() { const d = Lab.d, [a, b] = Lab.range, base = Lab.jsParams(); return { scenarios: E.stress(d, base, a, b), bySetup: {} }; }

  /* ---- Summary ---- */
  Lab.addTab('summary', 'Summary', function (el) {
    const d = Lab.d, [a, b] = Lab.range, r = E.run(d, Lab.jsParams(), a, b), s = r.stats;
    let eq = 1; const curve = [1], rs = [];
    eq = 1; r.trades.forEach(t => { eq *= 1 + 0.01 * t.netR; curve.push(eq); rs.push(t.netR); });
    const bySetup = {}; r.trades.forEach(t => { const x = bySetup[t.setup] = bySetup[t.setup] || { n: 0, r: 0, w: 0 }; x.n++; x.r += t.netR; if (t.netR > 0) x.w++; });
    el.innerHTML = `<div class="card"><b>${d.symbol} ${d.tf}</b> <span class="mut">${Lab.range[1] - Lab.range[0]} bars, in-browser engine${d.synthetic ? ' · synthetic data' : ''}</span>
      <div class="kpi" style="margin-top:8px">${kpi('Trades', s.trades)}${kpi('Win rate', pct(s.winRate))}${kpi('Avg net R', f(s.avgNetR, 3), cls(s.avgNetR))}${kpi('Avg gross R', f(s.avgGrossR, 3))}${kpi('Cost R', f(s.costR, 3))}${kpi('Profit factor', f(s.profitFactor))}${kpi('Max DD', pct(s.maxDrawdown), 'dn')}${kpi('Sharpe', f(s.sharpe))}${kpi('Both-hit bars', r.both)}</div></div>
      <div class="row"><div class="card"><b>Equity (1% risk per trade)</b><canvas id="c1"></canvas></div><div class="card"><b>R per trade</b><canvas id="c2"></canvas></div></div>
      <div class="row"><div class="card"><b>Exits</b><div class="kpi" style="margin-top:6px">${Object.keys(r.exits).map(k => kpi(k, r.exits[k])).join('')}</div></div>
      <div class="card"><b>By setup</b><table><tr><th>Setup</th><th>Trades</th><th>Win</th><th>Avg R</th></tr>${Object.keys(bySetup).sort().map(k => { const x = bySetup[k]; return `<tr><td>${k}</td><td>${x.n}</td><td>${pct(x.w / x.n, 0)}</td><td class="${cls(x.r)}">${f(x.r / x.n, 3)}</td></tr>`; }).join('')}</table></div></div>
      <div class="card"><b>Observations</b><div id="obs"></div></div>`;
    lineChart(el.querySelector('#c1'), [{ v: curve }]); bars(el.querySelector('#c2'), rs.slice(-120), null);
    const obs = [];
    if (s.trades < 100) obs.push({ lvl: 'meh', t: `Only ${s.trades} trades: too few to say anything about an edge.` });
    if (d.synthetic) obs.push({ lvl: 'meh', t: 'Synthetic random data: any edge here is noise, which makes it a good control. Expect about zero before costs.' });
    if (s.costR > Math.abs(s.avgGrossR) * 0.5) obs.push({ lvl: 'bad', t: `Costs (${f(s.costR, 3)}R) eat more than half of the gross edge (${f(s.avgGrossR, 3)}R).` });
    if (r.both > s.trades * 0.1 && Lab.params.bothHit === 'skip') obs.push({ lvl: 'bad', t: `${r.both} bars touched both triggers and were skipped (${pct(r.both / Math.max(1, s.trades), 0)} of trades). Switch "Both triggers hit" to loss to see the realistic effect.` });
    obs.push({ lvl: s.avgNetR > 0 ? 'good' : 'meh', t: `Net ${f(s.avgNetR, 3)}R per trade on this pair/period. One pair is one sample; use Validation and Portfolio for breadth.` });
    el.querySelector('#obs').innerHTML = obsHtml(obs);
  });

  /* ---- Validation (stress ladder, works in all modes) ---- */
  Lab.addTab('validation', 'Validation', function (el) {
    note(el, 'Running realism ladder…');
    (async () => {
      let st = null, src = '';
      try { const r = await Lab.api('stress', Object.assign({}, Lab.pyCfg(), { pairs: null })); if (r) { st = r; src = 'all pairs, ' + Lab.mode; } } catch (e) {}
      if (!st) { st = jsStress(); src = Lab.d.symbol + ' only, browser engine'; }
      const base = st.scenarios.find(s => s.name === 'baseline');
      el.innerHTML = `<div class="card"><b>Realism ladder</b> <span class="mut">${src}. Same rule, one pessimistic assumption at a time.</span><div class="scroll"><table><tr><th>Scenario</th><th>Trades</th><th>Avg net R</th><th>Δ vs base</th><th>Win</th><th>PF</th><th>Max DD</th><th>Cost R</th></tr>` +
        st.scenarios.map(s => s.stats ? `<tr><td>${esc(s.name)}</td><td>${s.stats.trades}</td><td class="${cls(s.stats.avgNetR)}">${f(s.stats.avgNetR, 3)}</td><td>${base && base.stats ? f(s.stats.avgNetR - base.stats.avgNetR, 3) : ''}</td><td>${pct(s.stats.winRate, 0)}</td><td>${f(s.stats.profitFactor)}</td><td>${pct(s.stats.maxDrawdown, 0)}</td><td>${f(s.stats.costR, 3)}</td></tr>` : `<tr><td>${esc(s.name)}</td><td colspan="7" class="mut">${esc(s.skipped || 'n/a')}</td></tr>`).join('') + `</table></div></div>
        <div class="card"><b>Avg net R by scenario</b><canvas id="vb"></canvas></div><div class="card"><b>Observations</b>${obsHtml(observe({ stress: st }))}</div>`;
      const ok = st.scenarios.filter(s => s.stats); bars(el.querySelector('#vb'), ok.map(s => s.stats.avgNetR), ok.map(s => s.name.slice(0, 10)));
    })();
  });

  /* ---- Backend-only views ---- */
  function needBackend(id, title, kind, render) {
    Lab.addTab(id, title, function (el) {
      if (Lab.mode === 'browser') { note(el, NEED); return; }
      note(el, 'Loading ' + title + '…');
      Lab.api(kind, Object.assign({}, Lab.pyCfg(), kind === 'robustness' ? {} : { pairs: null }, kind === 'walkforward' ? { folds: 4 } : {}, kind === 'grid' ? { folds: 1, grid: { axes: [{ param: 'lookback', values: [10, 20, 40] }, { param: 'htf', values: ['continuity', 'all', 'reversal'] }, { param: 'both_hit', values: ['skip', 'loss'] }] } } : {}))
        .then(r => { el.innerHTML = ''; render(el, r); }).catch(e => note(el, 'Error: ' + esc(e.message) + '<br><span class="mut">' + NEED + '</span>'));
    });
    Lab.tabs[Lab.tabs.length - 1].noData = true;
  }
  needBackend('grid', 'Grid', 'grid', (el, r) => {
    const ax = r.axes, rows = r.rows.filter(x => x.fold === 0);
    el.innerHTML = `<div class="card"><b>Parameter grid</b> <span class="mut">${r.combinations} runs in ${f(r.seconds, 1)}s over ${r.pairs.length} pairs. Cell = avg net R (pooled).</span><div id="gt" class="scroll"></div></div><div class="card"><b>Observations</b>${obsHtml(observe({ grid: r }))}</div>`;
    const a0 = ax[0], a1 = ax[1], a2 = ax[2], cell = (v0, v1, v2) => { const m = rows.find(x => x.axes[a0.param] === v0 && (!a1 || x.axes[a1.param] === v1) && (!a2 || x.axes[a2.param] === v2)); return m; };
    let h = '';
    (a2 ? a2.values : [null]).forEach(v2 => {
      h += `<table style="margin-bottom:8px">${a2 ? `<caption class="mut" style="text-align:left">${a2.param} = ${v2}</caption>` : ''}<tr><th>${a0.param} \\ ${a1 ? a1.param : ''}</th>${(a1 ? a1.values : ['']).map(v => `<th>${v}</th>`).join('')}</tr>`;
      a0.values.forEach(v0 => { h += `<tr><td>${v0}</td>` + (a1 ? a1.values : [null]).map(v1 => { const c = cell(v0, v1, v2); if (!c) return '<td>–</td>'; const x = c.avgNetR || 0, k = Math.max(-1, Math.min(1, x / 0.15)); return `<td style="background:${k >= 0 ? 'rgba(26,159,98,' : 'rgba(217,67,59,'}${Math.abs(k) * 0.45})" title="${c.trades} trades, PF ${f(c.profitFactor)}">${f(x, 3)}<br><span class="mut">${c.trades}</span></td>`; }).join('') + '</tr>'; });
      h += '</table>';
    });
    el.querySelector('#gt').innerHTML = h;
  });
  needBackend('walkforward', 'Walk-forward', 'walkforward', (el, r) => {
    el.innerHTML = `<div class="card"><b>Date folds (fixed rule, pooled trades)</b><div class="scroll"><table><tr><th>Period</th><th>Trades</th><th>Avg R</th><th>Win</th><th>PF</th><th>Sharpe</th><th>Mean R 5–95%</th></tr>` +
      r.folds.map(x => `<tr><td>${x.from} → ${x.to}</td><td>${x.stats.trades}</td><td class="${cls(x.stats.avgNetR)}">${f(x.stats.avgNetR, 3)}</td><td>${pct(x.stats.winRate, 0)}</td><td>${f(x.stats.profitFactor)}</td><td>${f(x.stats.sharpe)}</td><td>${x.bootstrap ? f(x.bootstrap.mean05, 3) + ' … ' + f(x.bootstrap.mean95, 3) : '–'}</td></tr>`).join('') + `</table></div></div>
      <div class="row"><div class="card"><b>Avg R by fold</b><canvas id="wf"></canvas></div><div class="card"><b>Avg R by pair</b><canvas id="wp"></canvas></div></div><div class="card"><b>Observations</b>${obsHtml(observe({ walkforward: r }))}</div>`;
    bars(el.querySelector('#wf'), r.folds.map(x => x.stats.avgNetR), r.folds.map(x => x.from.slice(0, 4)));
    const pk = Object.keys(r.byPair).sort(); bars(el.querySelector('#wp'), pk.map(k => r.byPair[k].avgNetR), pk);
  });
  needBackend('robustness', 'Robustness', 'robustness', (el, r) => {
    const names = Object.keys(r.variants);
    el.innerHTML = `<div class="card"><b>${r.pair}: rule variants</b><div class="scroll"><table><tr><th>Variant</th><th>Trades</th><th>Avg R</th><th>Win</th><th>PF</th><th>Max DD</th><th>Trade Sharpe</th></tr>` +
      names.map(n => { const v = r.variants[n]; return `<tr><td>${n}</td><td>${v.trades}</td><td class="${cls(v.avgNetR)}">${f(v.avgNetR, 3)}</td><td>${pct(v.winRate, 0)}</td><td>${f(v.profitFactor)}</td><td>${pct(v.maxDrawdown, 0)}</td><td>${f(r.tradeSharpes[n])}</td></tr>`; }).join('') + `</table></div></div>
      <div class="card"><b>Bootstrap & deflated Sharpe</b><div class="kpi" style="margin-top:6px">${r.bootstrap ? kpi('Mean R 5%', f(r.bootstrap.mean05, 3)) + kpi('Mean R 95%', f(r.bootstrap.mean95, 3)) : ''}${kpi('Deflated Sharpe prob.', r.monthlyDsr == null ? 'n/a' : f(r.monthlyDsr, 2))}</div></div>
      <div class="card"><b>Observations</b>${obsHtml(observe({ robustness: r }))}</div>`;
  });
  needBackend('portfolio', 'Portfolio', 'portfolio', (el, r) => {
    const m = r.metrics, c = r.curve;
    el.innerHTML = `<div class="card"><b>Portfolio</b> <span class="mut">${r.pairs.length} pairs, ${r.start} → ${r.end}, ${pct(r.settings.risk_per_trade, 2)} risk/trade, max ${r.settings.max_positions} positions</span>
      <div class="kpi" style="margin-top:8px">${kpi('CAGR', pct(m.cagr), cls(m.cagr))}${kpi('Vol', pct(m.vol))}${kpi('Sharpe', f(m.sharpe))}${kpi('Max DD', pct(m.maxDD), 'dn')}${kpi('Trades', r.trades)}${kpi('Exposure', pct(r.exposure, 0))}${kpi('Max open', r.maxConcurrentPositions)}${kpi('Max open risk', pct(r.maxOpenRiskRatio))}</div></div>
      <div class="row"><div class="card"><b>Equity</b><canvas id="pe"></canvas></div><div class="card"><b>Drawdown</b><canvas id="pd"></canvas></div></div>
      <div class="row"><div class="card"><b>Monthly returns</b><canvas id="pm"></canvas></div><div class="card"><b>PnL by pair (% of start equity)</b><canvas id="pp"></canvas></div></div>
      <div class="card"><b>3-year blocks</b><table><tr><th>Block</th><th>CAGR</th><th>Sharpe</th><th>Max DD</th></tr>${(r.blocks || []).map(b => `<tr><td>${b.name}</td><td class="${cls(b.cagr)}">${pct(b.cagr)}</td><td>${f(b.sharpe)}</td><td>${pct(b.maxDD)}</td></tr>`).join('')}</table></div>
      <div class="card"><b>Observations</b>${obsHtml(observe({ portfolio: r }))}</div>`;
    lineChart(el.querySelector('#pe'), [{ v: c.equity }], { labels: [new Date(c.t[0] * 1000).toISOString().slice(0, 10), new Date(c.t[c.t.length - 1] * 1000).toISOString().slice(0, 10)] });
    lineChart(el.querySelector('#pd'), [{ v: c.drawdown, color: getComputedStyle(document.getElementById('lab')).getPropertyValue('--dn') }], { pct: true, zero: true });
    bars(el.querySelector('#pm'), r.monthly.map(x => x.value), r.monthly.map(x => x.month.slice(2)));
    const pk = Object.keys(r.pairPnlPct).sort(); bars(el.querySelector('#pp'), pk.map(k => r.pairPnlPct[k]), pk);
  });

  /* ---- Findings: everything the backend/workflow has, merged into one verdict ---- */
  Lab.addTab('findings', 'Findings', function (el) {
    if (Lab.mode === 'browser') { note(el, 'Browser mode: see Summary and Validation observations. For a full verdict (walk-forward, deflated Sharpe, portfolio) use the backend or the workflow. ' + NEED); return; }
    note(el, 'Collecting results…');
    gather(['stress', 'walkforward', 'portfolio', 'portfolio_robustness', 'grid']).then(R => {
      const rob = Lab.api('robustness', Lab.pyCfg()).catch(() => null);
      return rob.then(r => { if (r) R.robustness = r; return R; });
    }).then(R => {
      const list = observe(R), bad = list.filter(x => x.lvl === 'bad').length, good = list.filter(x => x.lvl === 'good').length;
      const verdict = bad >= 2 ? ['dn', 'Not convincing: several checks fail. Do not trade this as is.'] : bad === 1 ? ['warn', 'Mixed: one serious check fails. Investigate it before going further.'] : good >= 3 ? ['up', 'Encouraging, not proof: the checks here pass, but the rule was designed on this history. Paper-trade it next.'] : ['warn', 'Inconclusive.'];
      el.innerHTML = `<div class="card"><b class="${verdict[0]}">${verdict[1]}</b><div class="mut">${good} supportive, ${bad} serious, ${list.length - good - bad} cautions. Mode: ${Lab.mode}.</div></div><div class="card">${obsHtml(list)}</div>
        <div class="card mut">Missing parts: ${Object.keys(R).filter(k => k.endsWith('_err')).map(k => k.replace('_err', '') + ' (' + esc(R[k]) + ')').join(', ') || 'none'}. These are reading aids, not a statistical proof; the rule was designed after looking at this history.</div>`;
    });
  });

  Lab.tabs.find(t => t.id === 'findings').noData = true;
  Lab.addTab('help', 'Help', function (el) {
    el.innerHTML = `<div class="card"><b>Engines</b><p>The badge at the top shows which engine is active: <b>Python + Numba backend</b> (start with <code>python py/server.py</code>, open <code>/</code>), <b>Precomputed results</b> (GitHub workflow wrote <code>results/lab/*.json</code>), or the <b>Browser JS engine</b> (works anywhere, Summary/Validation/Replay only). The Benchmark tab has its own engine switch: Python backend for large sweeps, browser worker for small ones.</p>
      <p><b>Data</b>: D1 <code>data/broker</code>, H4 <code>data/broker_h4</code> (from <code>python py/resample.py</code>), H1 <code>data/broker_h1</code> (<code>bun run fetch-h1</code>). On a phone preview, pick a CSV or use Sample.</p></div>`;
  }); Lab.tabs[Lab.tabs.length - 1].noData = true;
  // order: Replay first (registered earlier by replay.js), then these
})();
