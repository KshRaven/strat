/* Browser engine: a line-by-line JS port of py/stratcore.py (_bt, _close_trade, classify, htf_bias).
   Plain script (no modules) so it also works from file:// previews in phone code editors.
   Exposes window.StratEngine. Same rules: signals use bars <= i-1; bar i only decides whether
   the resting order was reached. Used (a) as the fallback when no Python backend exists and
   (b) by the replay GUI, which needs per-bar stepping. */
(function (root) {
  'use strict';
  const SETUP_NAMES = { 1: '2-1', 2: '3-1', 3: '1-2', 4: '2-2', 5: '3-2', 6: '1-1', 7: '3' };
  const SETUP_IDS = {}; for (const k in SETUP_NAMES) SETUP_IDS[SETUP_NAMES[k]] = +k;
  const TYPE_NAMES = ['-', '1', '2U', '2D', '3'];
  const TF = {
    D1: { maxHold: 10, barsPerYear: 252, barsPerDay: 1, levels: ['W', 'M'] },
    H4: { maxHold: 12, barsPerYear: 1512, barsPerDay: 6, levels: ['D', 'W', 'M'] },
    H1: { maxHold: 24, barsPerYear: 6048, barsPerDay: 24, levels: ['D', 'W', 'M'] },
  };
  const DEFAULTS = {
    tf: 'D1', lookback: 20, maxHold: null, risk: 0.01, spreadMult: 1, spreadPoints: 10, frictionBp: 1.0,
    swapMode: 'flat', swapSpreadBp: 0.2, flatSwapBp: 0.2, htf: 'continuity', entry: 'intrabar',
    target: 'structural', bothHit: 'skip', setups: ['2-1', '3-1', '1-2', '2-2', '3-2'], minTargetR: 0.5, rr: 2,
  };
  const HTF = { all: 0, none: 0, continuity: 1, reversal: 2 };

  function classify(h, l) {
    const n = h.length, t = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      const hh = h[i] > h[i - 1], ll = l[i] < l[i - 1];
      t[i] = hh && ll ? 4 : hh ? 2 : ll ? 3 : 1;
    }
    return t;
  }
  function periodId(sec, lv) {
    if (lv === 'H1') return Math.floor(sec / 3600);
    if (lv === 'H4') return Math.floor(sec / 14400);
    if (lv === 'D') return Math.floor(sec / 86400);
    if (lv === 'W') return Math.floor((Math.floor(sec / 86400) + 3) / 7);
    const d = new Date(sec * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  function htfBias(o, c, t, levels, shiftH) {
    const sh = (shiftH || 0) * 3600;
    const n = t.length, out = [];
    for (const lv of levels) {
      const b = new Int8Array(n); let st = 0, prev = null;
      for (let i = 0; i < n; i++) {
        const id = periodId(t[i] + sh, lv);
        if (id !== prev) { st = i; prev = id; }
        b[i] = Math.sign(c[i] - o[st]);
      }
      out.push(b);
    }
    return out;
  }
  function prepare(bars, tf, levels, shiftH) {
    levels = levels || TF[tf].levels;
    const d = Object.assign({}, bars);
    d.typ = classify(bars.high, bars.low);
    d.bias = htfBias(bars.open, bars.close, bars.time, levels, shiftH);
    d.levels = levels; d.tf = tf;
    return d;
  }
  function setupId(ts, tp) {
    if (ts === 1) return tp === 2 || tp === 3 ? 1 : tp === 4 ? 2 : tp === 1 ? 6 : 0;
    if (ts === 2 || ts === 3) return tp === 1 ? 3 : tp === 4 ? 5 : tp === 2 || tp === 3 ? 4 : 0;
    return ts === 4 ? 7 : 0;
  }
  function htfOk(bias, s, dir, mode) {
    if (mode === 0) return true;
    const want = mode === 1 ? dir : -dir;
    for (let k = 0; k < bias.length; k++) if (bias[k][s] !== want) return false;
    return true;
  }
  function norm(p) {
    const q = Object.assign({}, DEFAULTS, p || {}), d = TF[q.tf];
    if (q.maxHold == null) q.maxHold = d.maxHold;
    q.barsPerYear = q.barsPerYear || d.barsPerYear; q.barsPerDay = q.barsPerDay || d.barsPerDay;
    q.mask = 0; for (const n of q.setups) q.mask |= 1 << SETUP_IDS[n];
    return q;
  }

  /* Run bars [start,end). If `trace` is a function it is called with one event object per bar
     (state before/after) which the replay GUI uses to animate. Returns {trades, stats, exits, both}. */
  function run(d, params, start, end, trace) {
    const q = norm(params), o = d.open, h = d.high, l = d.low, c = d.close, typ = d.typ, bias = d.bias;
    const point = d.point || (d.symbol && d.symbol.indexOf('JPY') >= 0 ? 0.001 : 0.00001);
    const sp = q.spreadPoints * point * q.spreadMult, fr = q.frictionBp / 1e4;
    start = Math.max(2, start == null ? 2 : start); end = end == null ? d.time.length : end;
    const trades = [], exits = { stop: 0, target: 0, time: 0, eod: 0, bothhit: 0 };
    let both = 0, pos = null;
    const htfMode = HTF[q.htf];

    function close(dir, e, x, entryRaw, entryNet, exitPrice, reason, stop, target, risk, setup) {
      const held = x - e + 1, days = held / q.barsPerDay;
      const exitCost = sp / 2 + exitPrice * fr;
      const exitNet = dir > 0 ? exitPrice - exitCost : exitPrice + exitCost;
      const gross = dir * (exitPrice - entryRaw);
      // JS fallback has no rate table: carry unavailable -> flat swap (same as python when rates missing)
      const swap = q.swapMode === 'none' ? 0 : entryRaw * (q.flatSwapBp / 1e4) * days;
      const net = dir * (exitNet - entryNet) - swap;
      exits[reason]++;
      const t = { entryIndex: e, exitIndex: x, entryTime: d.time[e], exitTime: d.time[x], direction: dir,
        setup: SETUP_NAMES[setup], entry: entryRaw, exit: exitPrice, stop, target, risk, grossR: gross / risk,
        netR: net / risk, costR: (gross - net) / risk, swapR: swap / risk, barsHeld: held, reason };
      trades.push(t); return t;
    }

    for (let i = start; i < end; i++) {
      const ev = trace ? { i, events: [] } : null;
      if (pos) {
        let px = 0, reason = null; const op = o[i];
        if (pos.dir > 0) {
          if (op <= pos.stop) { px = op; reason = 'stop'; }
          else if (l[i] <= pos.stop) { px = pos.stop; reason = 'stop'; }
          else if (op >= pos.target) { px = op; reason = 'target'; }
          else if (h[i] >= pos.target) { px = pos.target; reason = 'target'; }
        } else {
          if (op >= pos.stop) { px = op; reason = 'stop'; }
          else if (h[i] >= pos.stop) { px = pos.stop; reason = 'stop'; }
          else if (op <= pos.target) { px = op; reason = 'target'; }
          else if (l[i] <= pos.target) { px = pos.target; reason = 'target'; }
        }
        if (!reason && i - pos.e + 1 >= q.maxHold) { px = c[i]; reason = 'time'; }
        if (reason) {
          const t = close(pos.dir, pos.e, i, pos.er, pos.en, px, reason, pos.stop, pos.target, pos.risk, pos.setup);
          if (ev) ev.events.push({ type: 'exit', trade: t });
          pos = null;
        }
        if (trace) { ev.pos = pos; trace(ev); }
        continue;
      }
      const s = i - 1;
      let info = { s, label: null, setup: null, th: h[s], tl: l[s], status: 'no setup' };
      if (s >= 2) {
        const sid = setupId(typ[s], typ[s - 1]);
        info.label = TYPE_NAMES[typ[s]] + ' after ' + TYPE_NAMES[typ[s - 1]];
        info.setup = sid ? SETUP_NAMES[sid] : null;
        if (!sid) info.status = 'no setup';
        else if (!((q.mask >> sid) & 1)) info.status = 'setup not enabled';
        else {
          const th = h[s], tl = l[s], lh = h[i] >= th, sh = l[i] <= tl;
          info.armed = true; info.longHit = lh; info.shortHit = sh;
          let dir = 0, status = '';
          if (lh && sh) {
            both++;
            if (q.bothHit === 'skip') status = 'both triggers hit: skipped';
            else if (htfMode === 0 || htfOk(bias, s, 1, htfMode)) dir = 1;
            else if (htfOk(bias, s, -1, htfMode)) dir = -1;
            else status = 'both hit, HTF blocks both';
            if (dir) {
              let er;
              if (q.entry === 'close') { er = c[i]; if ((dir > 0 && !(c[i] > th)) || (dir < 0 && !(c[i] < tl))) dir = 0; }
              else er = dir > 0 ? Math.max(o[i], th) : Math.min(o[i], tl);
              const stp = dir > 0 ? tl : th, rk = Math.abs(er - stp);
              if (dir && rk > 0) {
                const ec = sp / 2 + er * fr, en = dir > 0 ? er + ec : er - ec;
                const t = close(dir, i, i, er, en, stp, 'bothhit', stp, NaN, rk, sid);
                if (ev) ev.events.push({ type: 'both', trade: t });
                status = 'both hit: booked as loss';
              } else if (!status) status = 'rejected';
            }
          } else if (lh || sh) {
            const dc = lh ? 1 : -1;
            if (!htfOk(bias, s, dc, htfMode)) status = 'HTF filter blocked ' + (dc > 0 ? 'long' : 'short');
            else {
              let er = 0, ok = true;
              if (q.entry === 'close') { ok = dc > 0 ? c[i] > th : c[i] < tl; er = c[i]; }
              else er = dc > 0 ? Math.max(o[i], th) : Math.min(o[i], tl);
              const stp = dc > 0 ? tl : th, rk = Math.abs(er - stp);
              if (!ok) status = 'close did not confirm';
              else if (!(rk > 0)) status = 'zero risk';
              else {
                const ec = sp / 2 + er * fr, en = dc > 0 ? er + ec : er - ec;
                let tg, how = 'structural';
                if (q.target === '2r') { tg = er + dc * q.rr * rk; how = q.rr + 'R'; }
                else {
                  let tv = dc > 0 ? -Infinity : Infinity;
                  for (let j = Math.max(0, s - q.lookback); j < s; j++) tv = dc > 0 ? Math.max(tv, h[j]) : Math.min(tv, l[j]);
                  const usable = dc > 0 ? tv > er + q.minTargetR * rk : tv < er - q.minTargetR * rk;
                  if (!isFinite(tv) || !usable) { tg = er + dc * q.rr * rk; how = q.rr + 'R fallback'; } else tg = tv;
                }
                pos = { dir: dc, e: i, er, en, stop: stp, target: tg, risk: rk, setup: sid };
                status = 'ENTER ' + (dc > 0 ? 'long' : 'short');
                info.rr = Math.abs(tg - er) / rk; info.targetHow = how;
                if (ev) ev.events.push({ type: 'entry', pos });
              }
            }
          } else status = 'triggers not reached';
          info.status = status;
        }
      }
      if (trace) {
        ev.info = info; ev.pos = pos;
        ev.bias = bias.map(b => b[s]); ev.label = typ[s];
        trace(ev);
      }
    }
    if (pos) {
      const last = end - 1;
      close(pos.dir, pos.e, last, pos.er, pos.en, c[last], 'eod', pos.stop, pos.target, pos.risk, pos.setup);
    }
    return { trades, exits, both, stats: stats(trades, end - start, q) };
  }

  function stats(trades, nBars, q) {
    const n = trades.length; if (!n) return { trades: 0, winRate: 0, avgNetR: 0, avgGrossR: 0, costR: 0, profitFactor: 0, maxDrawdown: 0, sharpe: 0, cagr: 0 };
    let sum = 0, sum2 = 0, g = 0, gl = 0, w = 0, gs = 0, eq = 1, pk = 1, mdd = 0;
    for (const t of trades) {
      sum += t.netR; sum2 += t.netR * t.netR; gs += t.grossR;
      if (t.netR > 0) { w++; g += t.netR; } else gl -= t.netR;
      eq *= 1 + q.risk * t.netR; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1);
    }
    const mean = sum / n, sd = n > 1 ? Math.sqrt(Math.max(0, (sum2 - n * mean * mean) / (n - 1))) : 0;
    const years = Math.max(nBars / q.barsPerYear, 1e-9);
    return { trades: n, winRate: w / n, avgNetR: mean, avgGrossR: gs / n, costR: (gs - sum) / n,
      profitFactor: gl > 0 ? g / gl : null, maxDrawdown: mdd, sharpe: sd > 0 ? mean / sd * Math.sqrt(n / years) : 0,
      cagr: eq > 0 ? Math.pow(eq, 1 / years) - 1 : -1, tradesPerYear: n / years };
  }

  /* Same realism ladder as py/stratlab.py STRESS, for the fallback (single dataset). */
  const STRESS = [
    ['baseline', {}], ['both-hit = booked loss', { bothHit: 'loss' }], ['spread x2', { spreadMult: 2 }],
    ['spread x3', { spreadMult: 3 }], ['friction 2 bp', { frictionBp: 2 }],
    ['flat swap 0.5 bp/day', { swapMode: 'flat', flatSwapBp: 0.5 }],
    ['pessimistic combo', { bothHit: 'loss', spreadMult: 2, frictionBp: 2 }],
  ];
  function stress(d, params, start, end) {
    return STRESS.map(([name, over]) => {
      const r = run(d, Object.assign({}, params, over), start, end);
      return { name, stats: r.stats, bothHit: r.both };
    });
  }

  /* CSV text -> bars (date/time,open,high,low,close). Works for D1/H4/H1. */
  function parseCsv(text, symbol) {
    const lines = text.trim().split(/\r?\n/), head = lines[0].split(',').map(s => s.trim().toLowerCase());
    const di = ['date', 'time', 'datetime'].map(k => head.indexOf(k)).find(x => x >= 0);
    const ix = ['open', 'high', 'low', 'close'].map(k => head.indexOf(k));
    if (di === undefined || ix.some(x => x < 0)) throw new Error('CSV needs date/time, open, high, low, close');
    const time = [], open = [], high = [], low = [], close = [];
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(','); if (c.length < 5) continue;
      let s = c[di].trim(); if (s.length === 10) s += 'T00:00:00Z'; else if (!/[zZ+]/.test(s.slice(10))) s = s.replace(' ', 'T') + 'Z';
      const ms = Date.parse(s), v = ix.map(j => +c[j]);
      if (!isFinite(ms) || v.some(x => !isFinite(x))) continue;
      time.push(ms / 1000); open.push(v[0]); high.push(v[1]); low.push(v[2]); close.push(v[3]);
    }
    if (time.length < 100) throw new Error('too few valid bars');
    const sym = (symbol || 'PAIR').toUpperCase();
    return { symbol: sym, point: sym.indexOf('JPY') >= 0 ? 0.001 : 0.00001, time, open, high, low, close, n: time.length };
  }
  /* Merge Sunday (UTC) bars into the next bar, same as py merge_sunday. */
  function mergeSunday(b) {
    const keep = [], o = b.open.slice(), h = b.high.slice(), l = b.low.slice();
    for (let i = 0; i < b.time.length; i++) {
      const wd = (Math.floor(b.time[i] / 86400) + 3) % 7;
      if (wd === 6 && i + 1 < b.time.length && b.time[i + 1] - b.time[i] <= 172800) {
        o[i + 1] = o[i]; h[i + 1] = Math.max(h[i + 1], h[i]); l[i + 1] = Math.min(l[i + 1], l[i]);
      } else keep.push(i);
    }
    const pick = a => keep.map(i => a[i]);
    return Object.assign({}, b, { time: pick(b.time), open: pick(o), high: pick(h), low: pick(l), close: pick(b.close), n: keep.length });
  }
  root.StratEngine = { TF, DEFAULTS, SETUP_NAMES, TYPE_NAMES, classify, htfBias, prepare, run, stats, stress, parseCsv, mergeSunday, norm };
})(typeof window !== 'undefined' ? window : globalThis);
