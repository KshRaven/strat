"""Backend version of the browser benchmark (src/browser/benchmark.js).

For every scenario (a set of data-generator values x a set of cost/risk values) it runs the 12 rule
variants (HTF filter x target x entry) on all pairs with the Numba kernel, combines the trades in the
shared portfolio simulator (stratlab._portfolio_sim) and averages the results.

Scenarios are split into tasks and spread over a process pool, so thousands of scenarios are practical
(the browser worker is limited to ~12). Jobs run in the background; the server exposes start / status /
cancel (see server.py). Only running sums are kept, so memory stays flat however many scenarios run.

Cost keys that change the trades (spread, commission, slippage) form a "trade combo"; the portfolio keys
(riskPct, maxOpenRiskPct, maxPositions) only change position sizing, so the trades of a trade combo are
computed once and re-used for every portfolio combo.
"""
import itertools
import logging
import math
import os
import threading
import time
import traceback
import uuid
from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED

import numpy as np

import stratcore as sc
import stratlab as lab

log = logging.getLogger('strat')

VARIANTS = [(h, t, e) for h in ('continuity', 'reversal', 'all') for t in ('structural', '2r')
            for e in ('intrabar', 'close')]
TRADE_KEYS = [('spread', 10.0), ('commissionBp', 0.5), ('slippageBp', 0.5)]
PORT_KEYS = [('riskPct', 0.25), ('maxOpenRiskPct', 2.0), ('maxPositions', 8)]
GEN_KEYS = [('seed', 1), ('dailyVolPct', 0.5), ('driftPctYear', 0), ('momentum', 0), ('volClustering', 0.8),
            ('correlation', 0.3)]
BASE_PRICE = {'EURUSD': 1.1, 'GBPUSD': 1.3, 'AUDUSD': 0.75, 'NZDUSD': 0.7, 'EURGBP': 0.85, 'EURCHF': 1.05,
              'USDCHF': 0.95, 'USDCAD': 1.3, 'USDJPY': 110, 'EURJPY': 130, 'GBPJPY': 150, 'AUDJPY': 80,
              'CADJPY': 85, 'CHFJPY': 115, 'EURAUD': 1.5, 'EURCAD': 1.45}
NM = 10  # metric slots, see METRICS
METRICS = ['trades', 'win', 'avgR', 'cagr', 'vol', 'maxDD', 'sharpe', 'avgOpen', 'maxOpen', 'maxOpenRisk']
MAX_SCENARIOS = int(os.environ.get('STRAT_BENCH_MAX', 200000))
CHUNK = 64  # portfolio combos per task


# ---- data ---------------------------------------------------------------------------------------
def _pair_data(symbol, t, o, h, l, c):
    d = lab.PairData()
    d.symbol, d.tf = symbol, 'D1'
    d.t, d.o, d.h, d.l, d.c = (np.ascontiguousarray(x) for x in (t, o, h, l, c))
    d.levels = list(sc.TF_DEFAULTS['D1']['levels'])
    d.typ = sc.classify(d.h, d.l)
    d.bias = sc.htf_bias(d.o, d.c, d.t, d.levels, 0.0)
    d.carry = np.full(len(d.t), np.nan)
    d.point = 0.001 if 'JPY' in symbol else 0.00001
    return d


def make_sample(pairs, start, end, seed=1, dailyVolPct=0.5, driftPctYear=0.0, momentum=0.0,
                volClustering=0.8, correlation=0.3, **_):
    """Synthetic daily FX bars (same model as src/browser/sample.js; different random stream)."""
    rng = np.random.default_rng(int(seed))
    days = np.arange(lab.date_ts(start), lab.date_ts(end) + 1, 86400, dtype=np.int64)
    days = days[((days // 86400 + 3) % 7) < 5]
    n = len(days)
    if n < 50:
        raise ValueError('Sample date range is too short')
    vol, drift = dailyVolPct / 100.0, driftPctYear / 100.0 / 252.0
    vc, corr, mom = volClustering, correlation, momentum
    common = rng.standard_normal(n)
    out = []
    for sym in pairs:
        gv, gi, gg = rng.standard_normal(n), rng.standard_normal(n), rng.standard_normal(n)
        r1, r2, r3 = rng.random(n), rng.random(n), rng.random(n)
        o, h, l, c = np.empty(n), np.empty(n), np.empty(n), np.empty(n)
        px, prev, v = BASE_PRICE.get(sym, 1.0), 0.0, 1.0
        sq_c, sq_i = math.sqrt(corr), math.sqrt(1 - corr)
        for i in range(n):
            v = vc * v + (1 - vc) + 0.35 * (1 - vc) * abs(gv[i])
            ret = drift + mom * prev + vol * v * (sq_c * common[i] + sq_i * gi[i])
            oo = px * (1 + 0.1 * vol * gg[i])
            cc = oo * (1 + ret)
            rg = vol * v * (0.4 + 0.8 * r1[i])
            o[i], c[i] = oo, cc
            h[i] = max(oo, cc) * (1 + rg * r2[i])
            l[i] = min(oo, cc) * (1 - rg * r3[i])
            prev, px = ret, cc
        out.append(_pair_data(sym, days, o, h, l, c))
    return out


def _from_payload(data):
    out = []
    for sym, b in data.items():
        t = np.asarray(b['time'], np.int64)
        arr = [np.asarray(b[k], float) for k in ('open', 'high', 'low', 'close')]
        order = np.argsort(t, kind='stable')
        out.append(_pair_data(sym.upper(), t[order], *[a[order] for a in arr]))
    return out


def _env(ds, start, end):
    t0, t1 = lab.date_ts(start), lab.date_ts(end) + 86399
    timeline = np.unique(np.concatenate([d.t[(d.t >= t0) & (d.t <= t1)] for d in ds]))
    if len(timeline) < 5:
        raise ValueError('No pair has data inside the chosen dates')
    closes = {}
    for d in ds:
        idx = np.searchsorted(d.t, timeline, side='right') - 1
        closes[d.symbol] = np.where(idx >= 0, d.c[np.clip(idx, 0, None)], np.nan).tolist()
    return timeline, closes


class State:
    """Everything a worker needs; built once per process."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.start, self.end = cfg['start'], cfg['end']
        self.source = cfg.get('source', 'project')
        self.cache = {}
        self.base = None
        if self.source == 'project':
            have = lab.available_pairs('D1')
            want = [p.upper() for p in (cfg.get('pairs') or have)]
            use = [p for p in want if p in have]
            if not use:
                raise RuntimeError('No D1 data in data/broker for the selected pairs. Sync data first.')
            self.base = lab.pair_set({'tf': 'D1', 'pairs': use})
        elif self.source == 'data':
            self.base = _from_payload(cfg['data'])
        elif self.source != 'sample':
            raise ValueError(f'unknown source {self.source}')
        if self.base is not None:
            self.base_env = _env(self.base, self.start, self.end)

    def pairs(self):
        if self.base is not None:
            return [d.symbol for d in self.base]
        return [p.strip().upper() for p in (self.cfg.get('samplePairs') or 'EURUSD,GBPUSD,USDJPY,AUDUSD').split(',')
                if p.strip()]

    def dataset(self, gen):
        if self.base is not None:
            return (self.base,) + self.base_env
        key = tuple(sorted(gen.items()))
        if key not in self.cache:
            if len(self.cache) >= 2:
                self.cache.pop(next(iter(self.cache)))
            ds = make_sample(self.pairs(), self.cfg.get('sampleStart', '2008-01-01'), self.end, **gen)
            self.cache[key] = (ds,) + _env(ds, self.start, self.end)
        return self.cache[key]


# ---- one task -----------------------------------------------------------------------------------
def _light_trades(d, rows, timeline):
    if len(rows) == 0:
        return []
    ei, xi = rows[:, 0].astype(np.int64), rows[:, 1].astype(np.int64)
    ek, xk = np.searchsorted(timeline, d.t[ei]), np.searchsorted(timeline, d.t[xi])
    out = []
    for r, a, e, x in zip(rows.tolist(), ei.tolist(), ek.tolist(), xk.tolist()):
        out.append({'pair': d.symbol, 'entryIndex': a, 'direction': int(r[2]), 'entry': r[4], 'exit': r[5],
                    'risk': r[8], 'netR': r[10], 'costR': r[9] - r[10], 'ek': e, 'xk': x})
    return out


def _new_agg():
    return {'curve': None, 'n': 0, 'sums': np.zeros(NM), 'pf_sum': 0.0, 'pf_n': 0, 'sharpes': []}


def _agg_add(a, curve, m, pf):
    if a['curve'] is None:
        a['curve'] = curve.copy()
    else:
        L = min(len(a['curve']), len(curve))
        a['curve'] = a['curve'][:L] + curve[:L]
    a['n'] += 1
    a['sums'] += m
    a['sharpes'].append(float(m[6]))
    if pf is not None and math.isfinite(pf):
        a['pf_sum'] += pf
        a['pf_n'] += 1


def agg_merge(a, b):
    if b is None:
        return a
    if a is None:
        return b
    if a['curve'] is not None and b['curve'] is not None:
        L = min(len(a['curve']), len(b['curve']))
        a['curve'] = a['curve'][:L] + b['curve'][:L]
    a['n'] += b['n']
    a['sums'] += b['sums']
    a['pf_sum'] += b['pf_sum']
    a['pf_n'] += b['pf_n']
    a['sharpes'] += b['sharpes']
    return a


def run_task(state, gen, tcost, pcombos):
    ds, timeline, closes = state.dataset(gen)
    start, end = state.start, state.end
    ppy = float(sc.TF_DEFAULTS['D1']['bars_per_year'])
    out = []
    for htf, target, entry in VARIANTS:
        params = {'htf': htf, 'target': target, 'entry': entry, 'spread_points': tcost['spread'],
                  'friction_bp': tcost['commissionBp'] + tcost['slippageBp'], 'both_hit': 'skip'}
        c2 = {'tf': 'D1', 'start': start, 'end': end, 'params': params}
        P = lab.build_params(c2)
        trades = []
        for d in ds:
            rows, *_ = lab.run_pair(d, c2, P)
            trades += _light_trades(d, rows, timeline)
        if not trades:
            out.append(None)
            continue
        net = np.array([t['netR'] for t in trades])
        gw, gl = net[net > 0].sum(), -net[net <= 0].sum()
        pf = float(gw / gl) if gl > 0 else None
        pooled = (len(net), float((net > 0).mean()), float(net.mean()))
        agg = _new_agg()
        for pc in pcombos:
            sim = lab._portfolio_sim(timeline, closes, trades, pc['riskPct'] / 100.0,
                                     pc['maxOpenRiskPct'] / 100.0, int(pc['maxPositions']))
            eq = np.maximum(sim['eqs'], 1e-9)
            ret = np.r_[0.0, eq[1:] / eq[:-1] - 1] if len(eq) > 1 else np.zeros(1)
            pm = lab._port_metrics(ret, ppy)
            m = np.array([pooled[0], pooled[1], pooled[2], pm['cagr'], pm['vol'], pm['maxDD'], pm['sharpe'],
                          float(sim['n_open'].mean()), float(sim['n_open'].max()), sim['max_open_ratio']])
            _agg_add(agg, sim['eqs'], m, pf)
        out.append(agg)
    return {'n': len(pcombos), 'v': out}


# ---- worker process plumbing --------------------------------------------------------------------
_STATE = None


def _init_worker(cfg):
    global _STATE
    _STATE = State(cfg)


def _worker_task(args):
    t0 = time.time()
    r = run_task(_STATE, *args)
    r['sec'] = time.time() - t0
    return r


# ---- grid expansion -----------------------------------------------------------------------------
def _axes(src, keys):
    src = src or {}
    return {k: [float(x) for x in (src.get(k) or [dflt])] for k, dflt in keys}


def _expand(axes):
    names = list(axes)
    return [dict(zip(names, v)) for v in itertools.product(*[axes[n] for n in names])]


def plan(cfg):
    gen_ax = _axes(cfg.get('genAxes'), GEN_KEYS) if cfg.get('source') == 'sample' else {}
    tr_ax = _axes(cfg.get('costAxes'), TRADE_KEYS)
    pt_ax = _axes(cfg.get('costAxes'), PORT_KEYS)
    gens = _expand(gen_ax) or [{}]
    tcombos, pcombos = _expand(tr_ax), _expand(pt_ax)
    total = len(gens) * len(tcombos) * len(pcombos)
    if total == 0:
        raise ValueError('Enter valid scenario values before running the benchmark.')
    if total > MAX_SCENARIOS:
        raise ValueError(f'{total} scenarios is over the backend limit of {MAX_SCENARIOS} '
                         f'(set STRAT_BENCH_MAX to raise it).')
    chunks = [pcombos[i:i + CHUNK] for i in range(0, len(pcombos), CHUNK)]
    tasks = [(g, tc, ch) for g in gens for tc in tcombos for ch in chunks]
    return tasks, total


def _finalize(aggs, total, extra):
    rows = []
    for vi, (htf, target, entry) in enumerate(VARIANTS):
        a = aggs[vi]
        row = {'htf': htf, 'target': target, 'entry': entry, 'label': f'{htf} · {target} · {entry}'}
        if a is None or a['n'] == 0 or a['curve'] is None:
            row.update(trades=0, win=0, avgR=0, pf=None, cagr=0, vol=0, maxDD=0, sharpe=0, avgOpen=0,
                       maxOpen=0, maxOpenRisk=0, curve=[1.0, 1.0], scenarios=0)
            rows.append(row)
            continue
        mean = a['sums'] / a['n']
        curve = a['curve'] / a['n']
        if len(curve) > 2500:
            curve = curve[np.linspace(0, len(curve) - 1, 2500).astype(int)]
        sh = np.array(a['sharpes'])
        row.update({k: float(mean[i]) for i, k in enumerate(METRICS)})
        row['trades'] = int(round(mean[0]))
        row['pf'] = a['pf_sum'] / a['pf_n'] if a['pf_n'] else None
        row.update(curve=curve.tolist(), scenarios=a['n'], sharpeMin=float(sh.min()), sharpeMax=float(sh.max()),
                   sharpeP05=float(np.quantile(sh, .05)), sharpeP50=float(np.quantile(sh, .5)),
                   sharpeP95=float(np.quantile(sh, .95)))
        rows.append(row)
    return {'kind': 'benchmark', 'scenarios': total, 'variants': rows, **extra}


# ---- jobs ---------------------------------------------------------------------------------------
JOBS = {}
_JOBS_LOCK = threading.Lock()


class Job:
    def __init__(self, cfg):
        self.id = uuid.uuid4().hex[:8]
        self.cfg = cfg
        self.state = 'queued'
        self.done = 0
        self.total = 0
        self.started = time.time()
        self.finished = None
        self.result = None
        self.error = None
        self.trace = None
        self.workers = 0
        self.cancel_ev = threading.Event()

    def status(self, with_result=True):
        end = self.finished or time.time()
        s = {'id': self.id, 'state': self.state, 'done': self.done, 'total': self.total,
             'elapsed': end - self.started, 'workers': self.workers, 'error': self.error}
        if self.trace:
            s['trace'] = self.trace
        if with_result and self.state == 'done':
            s['result'] = self.result
        return s


def start(cfg):
    cfg = dict(cfg or {})
    cfg.setdefault('start', '2014-01-01')
    cfg.setdefault('end', time.strftime('%Y-%m-%d'))
    tasks, total = plan(cfg)  # validates and raises before a job exists
    job = Job(cfg)
    job.total = total
    with _JOBS_LOCK:
        for k in [k for k, j in JOBS.items() if j.finished and time.time() - j.finished > 3600]:
            del JOBS[k]
        JOBS[job.id] = job
    threading.Thread(target=_run_job, args=(job, tasks), daemon=True, name=f'bench-{job.id}').start()
    log.info('[bench %s] queued: %d scenarios x %d variants, %d tasks, source=%s, %s to %s', job.id, total,
             len(VARIANTS), len(tasks), cfg.get('source'), cfg['start'], cfg['end'])
    return job.id


def get(job_id):
    return JOBS.get(job_id)


def cancel(job_id):
    j = JOBS.get(job_id)
    if j and not j.finished:
        j.cancel_ev.set()
        log.info('[bench %s] cancel requested', job_id)
    return bool(j)


def _run_job(job, tasks):
    cfg = job.cfg
    t0 = time.time()
    job.state = 'running'
    aggs = [None] * len(VARIANTS)
    last_log = 0.0
    try:
        want = int(cfg.get('workers') or 0) or (os.cpu_count() or 1)
        workers = max(1, min(want, len(tasks)))
        job.workers = workers
        log.info('[bench %s] running on %d process%s', job.id, workers, '' if workers == 1 else 'es')

        def absorb(r):
            nonlocal last_log
            for vi, a in enumerate(r['v']):
                aggs[vi] = agg_merge(aggs[vi], a)
            job.done += r['n']
            now = time.time()
            if now - last_log > 2.0 or job.done >= job.total:
                last_log = now
                rate = job.done / max(now - t0, 1e-9)
                eta = (job.total - job.done) / rate if rate > 0 else 0
                log.info('[bench %s] %d/%d scenarios (%.0f%%)  %.1f/s  eta %.0fs', job.id, job.done, job.total,
                         100.0 * job.done / job.total, rate, eta)

        if workers == 1:
            st = State(cfg)
            for task in tasks:
                if job.cancel_ev.is_set():
                    break
                absorb(run_task(st, *task))
        else:
            with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker, initargs=(cfg,)) as ex:
                pending = set()
                it = iter(tasks)
                # keep the queue short so a cancel takes effect quickly
                def refill():
                    while len(pending) < workers * 2 and not job.cancel_ev.is_set():
                        t = next(it, None)
                        if t is None:
                            return
                        pending.add(ex.submit(_worker_task, t))
                refill()
                while pending:
                    done_set, _ = wait(pending, timeout=0.5, return_when=FIRST_COMPLETED)
                    for f in done_set:
                        pending.discard(f)
                        absorb(f.result())  # raises the worker's exception, caught below
                    if job.cancel_ev.is_set():
                        for f in pending:
                            f.cancel()
                        ex.shutdown(wait=False, cancel_futures=True)
                        break
                    refill()
        if job.cancel_ev.is_set():
            job.state = 'cancelled'
            log.info('[bench %s] cancelled after %d/%d scenarios', job.id, job.done, job.total)
        else:
            if all(a is None for a in aggs):
                raise RuntimeError('No trades were produced. Check the dates and the pairs.')
            sec = time.time() - t0
            pairs = State(cfg).pairs()
            job.result = _finalize(aggs, job.total, {'seconds': sec, 'workers': workers, 'pairs': pairs,
                                                     'start': cfg['start'], 'end': cfg['end'],
                                                     'source': cfg.get('source', 'project')})
            job.state = 'done'
            log.info('[bench %s] done: %d scenarios in %.1fs (%.1f/s)', job.id, job.total, sec, job.total / max(sec, 1e-9))
    except BaseException as e:  # noqa: BLE001 - report everything to the UI and the console
        job.state = 'error'
        job.error = f'{type(e).__name__}: {e}'
        job.trace = traceback.format_exc()
        log.error('[bench %s] FAILED: %s\n%s', job.id, job.error, job.trace)
    finally:
        job.finished = time.time()
