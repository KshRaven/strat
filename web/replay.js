/* Replay tab: step/play through bars and watch labels, setups, triggers, HTF bias, positions, deals. */
(function () {
  'use strict';
  const Lab = window.Lab, E = Lab.E, f = Lab.fmt;

  Lab.addTab('replay', 'Replay', function (el) {
    const d = Lab.d, [r0, r1] = Lab.range, P = Lab.jsParams();
    // run once with a trace; frames[i] describes what the rule saw and did at bar i
    const frames = new Array(d.time.length), res = E.run(d, P, r0, r1, ev => { frames[ev.i] = ev; });
    const trades = res.trades;
    const exitsAt = {}, entryAt = {};
    trades.forEach((t, k) => { (exitsAt[t.exitIndex] = exitsAt[t.exitIndex] || []).push(k); entryAt[t.entryIndex] = k; });
    const st = { i: r0, win: 60, playing: false, speed: 6, acc: 0, last: 0 };
    const tfBars = d.tf;

    el.innerHTML = `
      <div class="card">
        <canvas id="rc" height="360"></canvas>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px">
          <button id="rb-start" title="Start">⏮</button><button id="rb-prev">◀</button>
          <button id="rb-play" class="pri" style="min-width:70px">▶ Play</button>
          <button id="rb-next">▶|</button><button id="rb-nt" title="Next trade entry">Next trade ⏭</button>
          <label class="mut">Speed <input id="rb-speed" type="range" min="0" max="100" value="45" style="width:110px"> <span id="rb-sp"></span></label>
          <label class="mut">Window <input id="rb-win" type="range" min="20" max="200" value="60" style="width:90px"></label>
        </div>
        <input id="rb-scrub" type="range" min="${r0}" max="${r1 - 1}" value="${r0}" style="width:100%;margin-top:6px">
      </div>
      <div class="row">
        <div class="card" id="rinfo"></div>
        <div class="card"><b>Deals</b> <span class="mut">(closed up to this bar)</span><div class="scroll" style="max-height:230px;overflow-y:auto"><table id="rdeals"></table></div></div>
      </div>
      <div class="card mut" style="font-size:12px">
        Candle labels: 1 inside, 2U/2D directional, 3 outside. The label of the current bar is hidden (shown “·”) until it closes:
        the rule only reads bars ≤ i−1. Dashed lines at the setup bar's high/low are the resting-order triggers; bar i's range
        is only used to see whether a trigger was reached. Bottom strips are HTF bias at the setup bar (green up, red down).
      </div>`;
    const cv = el.querySelector('#rc'), $ = s => el.querySelector(s);
    const css = n => getComputedStyle(document.getElementById('lab')).getPropertyValue(n).trim();

    function draw() {
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 360;
      cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const up = css('--up'), dn = css('--dn'), fg = css('--fg'), mut = css('--mut'), acc = css('--acc'), line = css('--line');
      g.clearRect(0, 0, W, H); g.font = '11px system-ui,sans-serif';
      const i = st.i, a = Math.max(0, i - st.win + 1), n = i - a + 1, fr = frames[i];
      const plotH = H - 22 - 14 * d.levels.length, top = 16, left = 4, right = 58, pw = W - left - right, step = pw / Math.max(n, 1);
      let hi = -Infinity, lo = Infinity;
      for (let j = a; j <= i; j++) { hi = Math.max(hi, d.high[j]); lo = Math.min(lo, d.low[j]); }
      const pos = fr && fr.pos, info = fr && fr.info;
      if (pos) { lo = Math.min(lo, pos.stop); hi = Math.max(hi, pos.stop); const rg = hi - lo; if (Math.abs(pos.target - (hi + lo) / 2) < rg * 1.5) { hi = Math.max(hi, pos.target); lo = Math.min(lo, pos.target); } }
      const pad = (hi - lo) * 0.06 || d.point * 10; hi += pad; lo -= pad;
      const y = p => top + (hi - p) / (hi - lo) * (plotH - top), x = j => left + (j - a + 0.5) * step;
      const dec = d.point < 0.0001 ? 3 : 5;
      // grid + axis
      g.strokeStyle = line; g.fillStyle = mut; g.lineWidth = 1;
      for (let k = 0; k <= 4; k++) { const p = lo + (hi - lo) * k / 4, yy = y(p); g.beginPath(); g.moveTo(left, yy); g.lineTo(W - right, yy); g.stroke(); g.fillText(p.toFixed(dec), W - right + 3, yy + 3); }
      // candles
      const bw = Math.max(1, Math.min(14, step * 0.7));
      for (let j = a; j <= i; j++) {
        const col = d.close[j] >= d.open[j] ? up : dn, xx = x(j);
        g.strokeStyle = col; g.fillStyle = col;
        g.beginPath(); g.moveTo(xx, y(d.high[j])); g.lineTo(xx, y(d.low[j])); g.stroke();
        const yo = y(d.open[j]), yc = y(d.close[j]); g.fillRect(xx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yo - yc)));
        if (step >= 9) {
          g.fillStyle = j === i ? mut : fg; g.globalAlpha = j === i ? 0.6 : 0.85; g.textAlign = 'center';
          g.fillText(j === i ? '·' : E.TYPE_NAMES[d.typ[j]], xx, y(d.high[j]) - 4); g.globalAlpha = 1; g.textAlign = 'left';
        }
      }
      // setup bar + triggers
      if (info && info.armed) {
        const s = info.s; if (s >= a) { g.strokeStyle = acc; g.lineWidth = 2; g.strokeRect(x(s) - step / 2 + 1, y(d.high[s]) - 1, step - 2, y(d.low[s]) - y(d.high[s]) + 2); g.lineWidth = 1; g.fillStyle = acc; g.fillText(info.setup, x(s) - 8, y(d.low[s]) + 12); }
        g.setLineDash([5, 4]); g.strokeStyle = acc;
        for (const p of [info.th, info.tl]) { g.beginPath(); g.moveTo(x(Math.max(s, a)), y(p)); g.lineTo(x(i) + step, y(p)); g.stroke(); }
        g.setLineDash([]);
      }
      // open position or exit at this bar
      const draw = (p, ent, ex, col, txt) => { const yy = y(p); if (yy < top - 30 || yy > plotH + 30) return; g.strokeStyle = col; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x(Math.max(ent, a)), yy); g.lineTo(W - right, yy); g.stroke(); g.setLineDash([]); g.fillStyle = col; g.fillText(txt, W - right + 3, yy - 3); };
      let shown = pos; const ex = fr && fr.events && fr.events.find(e => e.type === 'exit' || e.type === 'both');
      if (!shown && ex) shown = { e: ex.trade.entryIndex, er: ex.trade.entry, stop: ex.trade.stop, target: ex.trade.target, dir: ex.trade.direction };
      if (shown) {
        draw(shown.er, shown.e, 0, fg, 'entry'); draw(shown.stop, shown.e, 0, dn, 'stop');
        if (isFinite(shown.target)) draw(shown.target, shown.e, 0, up, 'target');
      }
      // past trades markers
      for (let k = 0; k < trades.length; k++) {
        const t = trades[k]; if (t.entryIndex > i) break; const col = t.netR > 0 ? up : dn;
        if (t.entryIndex >= a) { g.fillStyle = col; g.beginPath(); const xx = x(t.entryIndex), yy = y(t.entry), s = 5; if (t.direction > 0) { g.moveTo(xx, yy - 1); g.lineTo(xx - s, yy + 2 * s); g.lineTo(xx + s, yy + 2 * s); } else { g.moveTo(xx, yy + 1); g.lineTo(xx - s, yy - 2 * s); g.lineTo(xx + s, yy - 2 * s); } g.fill(); }
        if (t.exitIndex <= i && t.exitIndex >= a) { g.strokeStyle = col; g.beginPath(); const xx = x(t.exitIndex), yy = y(t.exit); g.moveTo(xx - 4, yy - 4); g.lineTo(xx + 4, yy + 4); g.moveTo(xx + 4, yy - 4); g.lineTo(xx - 4, yy + 4); g.stroke(); }
      }
      // HTF bias strips at each bar's own setup bar (bias read at s = j-1)
      d.levels.forEach((lv, k) => {
        const yy = plotH + 6 + k * 14; g.fillStyle = mut; g.fillText(lv, 2, yy + 9);
        for (let j = a; j <= i; j++) { const b = d.bias[k][Math.max(0, j - 1)]; g.fillStyle = b > 0 ? up : b < 0 ? dn : line; g.globalAlpha = 0.7; g.fillRect(x(j) - step / 2 + 0.5, yy, Math.max(1, step - 1), 10); g.globalAlpha = 1; }
      });
      g.fillStyle = mut; g.fillText(new Date(d.time[i] * 1000).toISOString().slice(0, tfBars === 'D1' ? 10 : 16).replace('T', ' ') + ' (UTC)  bar ' + i, left + 4, 11);
    }

    function openTrades(i) { let k = 0, cum = 0, wins = 0; const done = []; for (; k < trades.length; k++) { if (trades[k].exitIndex > i) break; done.push(trades[k]); cum += trades[k].netR; if (trades[k].netR > 0) wins++; } return { done, cum, wins }; }
    function panel() {
      const i = st.i, fr = frames[i], info = fr && fr.info, pos = fr && fr.pos;
      const { done, cum, wins } = openTrades(i);
      const bias = d.levels.map((lv, k) => { const b = d.bias[k][i - 1]; return `<span class="${b > 0 ? 'up' : b < 0 ? 'dn' : 'mut'}">${lv} ${b > 0 ? '▲' : b < 0 ? '▼' : '–'}</span>`; }).join(' &nbsp; ');
      let h = `<b>Bar ${i}</b> <span class="mut">${new Date(d.time[i] * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span><br>`;
      h += `Setup bar s=${i - 1}: <b>${info && info.label ? info.label : '–'}</b> → setup <b>${info && info.setup ? info.setup : 'none'}</b><br>`;
      h += `HTF bias at s: ${bias}<br>`;
      if (info && info.armed) h += `Triggers: high ${info.th.toFixed(5)} (${info.longHit ? 'reached' : 'not reached'}), low ${info.tl.toFixed(5)} (${info.shortHit ? 'reached' : 'not reached'})<br>`;
      h += `Decision: <b>${info ? info.status : pos ? 'in position' : '–'}</b>`;
      if (info && info.rr) h += `<br>Target: ${info.targetHow}, reward/risk <b>${f(info.rr)}</b>`;
      const p = pos || (fr && fr.events && fr.events.find(e => e.type === 'entry') || {}).pos;
      if (p) h += `<br>Position: ${p.dir > 0 ? 'long' : 'short'} @ ${p.er.toFixed(5)}, stop ${p.stop.toFixed(5)}, target ${isFinite(p.target) ? p.target.toFixed(5) : '–'}, risk ${(p.risk / d.point).toFixed(0)} pts, ${i - p.e + 1}/${P.maxHold || E.TF[P.tf].maxHold} bars`;
      if (fr && fr.events) for (const e of fr.events) if (e.type === 'exit' || e.type === 'both') h += `<br><b class="${Lab.cls(e.trade.netR)}">Closed ${e.trade.reason}: ${f(e.trade.netR)}R</b>`;
      h += `<hr style="border:0;border-top:1px solid var(--line)">Closed: <b>${done.length}</b> &nbsp; wins ${done.length ? Lab.pct(wins / done.length, 0) : '–'} &nbsp; cumulative <b class="${Lab.cls(cum)}">${f(cum)}R</b> &nbsp; both-hit bars ${res.both}`;
      $('#rinfo').innerHTML = h;
      const last = done.slice(-12).reverse();
      $('#rdeals').innerHTML = '<tr><th>Setup</th><th>Dir</th><th>Exit</th><th>Bars</th><th>R</th><th>Cost R</th></tr>' + last.map(t => `<tr><td>${t.setup}</td><td>${t.direction > 0 ? 'L' : 'S'}</td><td>${t.reason}</td><td>${t.barsHeld}</td><td class="${Lab.cls(t.netR)}">${f(t.netR)}</td><td>${f(t.costR, 3)}</td></tr>`).join('');
      $('#rb-scrub').value = i;
    }
    function render() { draw(); panel(); }
    function goto(i) { st.i = Math.max(r0, Math.min(r1 - 1, i)); render(); }

    $('#rb-start').onclick = () => goto(r0);
    $('#rb-prev').onclick = () => { st.playing = false; setPlay(); goto(st.i - 1); };
    $('#rb-next').onclick = () => { st.playing = false; setPlay(); goto(st.i + 1); };
    $('#rb-nt').onclick = () => { for (let j = st.i + 1; j < r1; j++) if (entryAt[j] !== undefined) { goto(j); return; } };
    $('#rb-scrub').oninput = e => goto(+e.target.value);
    $('#rb-win').oninput = e => { st.win = +e.target.value; render(); };
    const sp = () => { st.speed = 0.5 * Math.pow(240, +$('#rb-speed').value / 100); $('#rb-sp').textContent = st.speed.toFixed(1) + ' bars/s'; };
    $('#rb-speed').oninput = sp; sp();
    function setPlay() { $('#rb-play').textContent = st.playing ? '⏸ Pause' : '▶ Play'; }
    $('#rb-play').onclick = () => { st.playing = !st.playing; st.last = 0; setPlay(); if (st.playing) raf = requestAnimationFrame(tick); };
    let raf = 0, dead = false;
    function tick(ts) {
      if (dead || !st.playing) return;
      if (st.last) { st.acc += (ts - st.last) / 1000 * st.speed; const k = Math.floor(st.acc); if (k > 0) { st.acc -= k; goto(st.i + k); if (st.i >= r1 - 1) { st.playing = false; setPlay(); return; } } }
      st.last = ts; raf = requestAnimationFrame(tick);
    }
    const onResize = () => render(); window.addEventListener('resize', onResize);
    goto(Math.min(r1 - 1, r0 + st.win));
    return () => { dead = true; cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  });
})();
