"""High-level analyses on top of stratcore: data loading, single backtest, grid sweep,
walk-forward, robustness (bootstrap + deflated Sharpe), portfolio.

Everything returns plain JSON-serializable dicts so the same shape can be produced by the
in-browser fallback engine (web/engine.js) and by the GitHub-workflow batch run.
"""
import csv
import datetime as dt
import json
import math
import os
import time
from statistics import NormalDist

import numpy as np

import stratcore as sc

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ALL_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP',
             'EURJPY', 'GBPJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'AUDJPY', 'CADJPY', 'CHFJPY']
RATE_SERIES = {'USD': 'IR3TIB01USM156N', 'EUR': 'IR3TIB01EZM156N', 'GBP': 'IR3TIB01GBM156N',
               'JPY': 'IR3TIB01JPM156N', 'AUD': 'IR3TIB01AUM156N', 'CAD': 'IR3TIB01CADM156N'.replace('CADM', 'CAM'),
               'CHF': 'IR3TIB01CHM156N', 'NZD': 'IR3TIB01NZM156N'}
VARIANTS = {'default': {}, 'all': {'htf': 'all'}, 'reversal': {'htf': 'reversal'},
            '2r': {'target': '2r'}, 'close': {'entry': 'close'}}
DATA_DIRS = {'D1': 'data/broker', 'H4': 'data/broker_h4', 'H1': 'data/broker_h1'}

_cache = {}


def jnum(x):
    """JSON-safe number."""
    if x is None:
        return None
    x = float(x)
    return x if math.isfinite(x) else None


# ---- loading ------------------------------------------------------------------
def _read_csv(path):
    with open(path, newline='') as f:
        rows = list(csv.reader(f))
    head = [x.strip().lower() for x in rows[0]]
    di = next(head.index(k) for k in ('date', 'time', 'datetime') if k in head)
    oi, hi, li, ci = (head.index(k) for k in ('open', 'high', 'low', 'close'))
    ts, v = [], []
    for r in rows[1:]:
        try:
            s = r[di].strip().rstrip('Z').replace(' ', 'T')
            q = [float(r[oi]), float(r[hi]), float(r[li]), float(r[ci])]
            ts.append(s)
            v.append(q)
        except (ValueError, IndexError):
            continue
    t = np.array(ts, dtype='datetime64[s]').astype(np.int64)
    a = np.array(v, dtype=float)
    order = np.argsort(t, kind='stable')
    return t[order], a[order, 0], a[order, 1], a[order, 2], a[order, 3]


def merge_sunday(t, o, h, l, c):
    """Fold each Sunday bar (UTC) into the following bar so no stub weekend bar remains."""
    wd = (t // 86400 + 3) % 7
    idx = np.flatnonzero(wd == 6)
    drop = []
    for i in idx:
        if i + 1 < len(t) and t[i + 1] - t[i] <= 2 * 86400:
            o[i + 1] = o[i]
            h[i + 1] = max(h[i + 1], h[i])
            l[i + 1] = min(l[i + 1], l[i])
            drop.append(i)
    keep = np.ones(len(t), bool)
    keep[drop] = False
    return t[keep], o[keep], h[keep], l[keep], c[keep]


def _ny_offset_hours(t):
    years = t.astype('datetime64[s]').astype('datetime64[Y]').astype(np.int64) + 1970
    uy = np.unique(years)
    s_ts, e_ts = np.zeros(len(uy)), np.zeros(len(uy))
    for k, y in enumerate(uy):
        d = dt.date(int(y), 3, 1)
        d = d + dt.timedelta(days=(6 - d.weekday()) % 7 + 7)  # second Sunday of March
        s_ts[k] = dt.datetime(d.year, d.month, d.day, 7, tzinfo=dt.timezone.utc).timestamp()
        d2 = dt.date(int(y), 11, 1)
        d2 = d2 + dt.timedelta(days=(6 - d2.weekday()) % 7)  # first Sunday of November
        e_ts[k] = dt.datetime(d2.year, d2.month, d2.day, 6, tzinfo=dt.timezone.utc).timestamp()
    yi = np.searchsorted(uy, years)
    return np.where((t >= s_ts[yi]) & (t < e_ts[yi]), -4, -5)


def aggregate_daily_ny(t, o, h, l, c):
    """Build daily bars that roll over at 17:00 New York time (the usual FX daily close) from H1 bars.
    The Sunday evening session lands in Monday's bar, so no stub Sunday bar exists."""
    local = t + _ny_offset_hours(t) * 3600
    day = (local + 7 * 3600) // 86400
    starts = np.r_[0, np.flatnonzero(day[1:] != day[:-1]) + 1]
    ends = np.r_[starts[1:] - 1, len(t) - 1]
    return (day[starts] * 86400, o[starts], np.maximum.reduceat(h, starts),
            np.minimum.reduceat(l, starts), c[ends])


def load_rates():
    key = 'rates'
    if key in _cache:
        return _cache[key]
    out = {}
    for ccy, name in RATE_SERIES.items():
        p = os.path.join(ROOT, 'data', 'rates', name + '.json')
        if os.path.exists(p):
            with open(p) as f:
                j = json.load(f)
            out[ccy] = (np.array(j['dates'], dtype='datetime64[D]'), np.array(j['values'], dtype=float) / 100.0)
    _cache[key] = out
    return out


def carry_array(symbol, t):
    rates = load_rates()
    base, quote = symbol[:3], symbol[3:6]
    if base not in rates or quote not in rates:
        return np.full(len(t), np.nan)
    month_start = t.astype('datetime64[s]').astype('datetime64[M]').astype('datetime64[D]')

    def rate(ccy):
        d, v = rates[ccy]
        idx = np.searchsorted(d, month_start, side='left') - 1
        return np.where(idx >= 0, v[np.clip(idx, 0, None)], np.nan)

    return rate(base) - rate(quote)


class PairData:
    pass


def load_pair(pair, tf='D1', sunday='keep', day_mode='utc', levels=None, day_shift_h=0.0, data_dir=None):
    """Load one pair and precompute labels, HTF bias and carry. Cached per argument set."""
    levels = tuple(levels or sc.TF_DEFAULTS[tf]['levels'])
    key = (pair, tf, sunday, day_mode, levels, day_shift_h, data_dir)
    if key in _cache:
        return _cache[key]
    if tf == 'D1' and day_mode == 'ny':
        src = os.path.join(ROOT, data_dir or DATA_DIRS['H1'], pair + '.csv')
        t, o, h, l, c = aggregate_daily_ny(*_read_csv(src))
    else:
        src = os.path.join(ROOT, data_dir or DATA_DIRS[tf], pair + '.csv')
        t, o, h, l, c = _read_csv(src)
        if tf == 'D1' and sunday == 'merge':
            t, o, h, l, c = merge_sunday(t, o, h, l, c)
    d = PairData()
    d.symbol, d.tf = pair, tf
    d.t, d.o, d.h, d.l, d.c = t, o, h, l, c
    d.typ = sc.classify(h, l)
    d.bias = htf_bias_cached(o, c, t, levels, day_shift_h)
    d.carry = carry_array(pair, t)
    point = 0.001 if 'JPY' in pair else 0.00001
    d.point = point
    d.levels = list(levels)
    _cache[key] = d
    return d


def htf_bias_cached(o, c, t, levels, shift):
    return sc.htf_bias(o, c, t, list(levels), shift)


def available_pairs(tf='D1'):
    p = os.path.join(ROOT, DATA_DIRS[tf])
    if not os.path.isdir(p):
        return []
    return [x for x in ALL_PAIRS if os.path.exists(os.path.join(p, x + '.csv'))]


# ---- configuration ------------------------------------------------------------
def build_params(cfg):
    """cfg['params'] -> numpy parameter vector (+ helpers)."""
    tf = cfg.get('tf', 'D1')
    d = sc.TF_DEFAULTS[tf]
    p = cfg.get('params', {}) or {}
    P = np.zeros(sc.NPAR)
    P[sc.P_LOOKBACK] = p.get('lookback', 20)
    P[sc.P_MAXHOLD] = p.get('max_hold', d['max_hold'])
    P[sc.P_RISK] = p.get('risk', 0.01)
    P[sc.P_SPREAD_MULT] = p.get('spread_mult', 1.0)
    P[sc.P_FRICTION_BP] = p.get('friction_bp', p.get('commission_bp', 0.5) + p.get('slippage_bp', 0.5))
    P[sc.P_SWAP_MODE] = sc.SWAP_MODES[p.get('swap_mode', 'rates')]
    P[sc.P_SWAP_SPREAD_BP] = p.get('swap_spread_bp', 0.2)
    P[sc.P_FLAT_SWAP_BP] = p.get('flat_swap_bp', 0.2)
    P[sc.P_HTF_MODE] = sc.HTF_MODES[p.get('htf', 'continuity')]
    P[sc.P_ENTRY] = sc.ENTRY_MODES[p.get('entry', 'intrabar')]
    P[sc.P_TARGET] = sc.TARGET_MODES[p.get('target', 'structural')]
    P[sc.P_BOTHHIT] = sc.BOTH_MODES[p.get('both_hit', 'skip')]
    P[sc.P_SETUP_MASK] = sc.setup_mask(p.get('setups', sc.DEFAULT_SETUPS))
    P[sc.P_BARS_PER_YEAR] = p.get('bars_per_year', d['bars_per_year'])
    P[sc.P_BARS_PER_DAY] = p.get('bars_per_day', d['bars_per_day'])
    P[sc.P_MIN_TARGET_R] = p.get('min_target_r', 0.5)
    P[sc.P_RR] = p.get('rr', 2.0)
    return P


AXIS_INDEX = {'lookback': sc.P_LOOKBACK, 'max_hold': sc.P_MAXHOLD, 'risk': sc.P_RISK,
              'spread_mult': sc.P_SPREAD_MULT, 'friction_bp': sc.P_FRICTION_BP,
              'swap_spread_bp': sc.P_SWAP_SPREAD_BP, 'htf': sc.P_HTF_MODE, 'entry': sc.P_ENTRY,
              'target': sc.P_TARGET, 'both_hit': sc.P_BOTHHIT, 'rr': sc.P_RR,
              'min_target_r': sc.P_MIN_TARGET_R}
AXIS_MAPS = {'htf': sc.HTF_MODES, 'entry': sc.ENTRY_MODES, 'target': sc.TARGET_MODES, 'both_hit': sc.BOTH_MODES}


def date_ts(s):
    return int(np.datetime64(s, 's').astype(np.int64))


def window(t, start, end):
    s = 2 if not start else max(2, int(np.searchsorted(t, date_ts(start), 'left')))
    e = len(t) if not end else int(np.searchsorted(t, date_ts(end) + 86399, 'right'))
    return s, e


def pair_set(cfg):
    tf = cfg.get('tf', 'D1')
    pairs = cfg.get('pairs') or available_pairs(tf)
    out = []
    for p in pairs:
        out.append(load_pair(p, tf, cfg.get('sunday', 'keep'), cfg.get('day_mode', 'utc'),
                             cfg.get('htf_levels'), cfg.get('day_shift_hours', 0.0), cfg.get('data_dir')))
    if not out:
        raise RuntimeError(f'No data found for {tf}. Fetch it first (see README).')
    return out


def spread_price(d, cfg):
    return (cfg.get('params', {}).get('spread_points', 10)) * d.point


# ---- stats helpers ------------------------------------------------------------
def acc_stats(a, ex, n_bars, bars_per_year):
    n = a[sc.A_N]
    names = sc.REASONS
    base = {'trades': int(n), 'exits': {names[i]: int(ex[i]) for i in range(5)},
            'bothHitSkippedOrBooked': int(a[sc.A_BOTH]), 'bothHitBooked': int(a[sc.A_BOTHLOSS])}
    if n == 0:
        base.update(winRate=0, avgGrossR=0, avgNetR=0, costR=0, profitFactor=0, cagr=0, maxDrawdown=0,
                    sharpe=0, tradesPerYear=0, exposure=0, avgBarsHeld=0, longs=0, shorts=0)
        return base
    mean = a[sc.A_NET] / n
    var = (a[sc.A_NET2] - n * mean * mean) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(max(var, 0.0))
    years = max(n_bars / bars_per_year, 1e-9)
    tpy = n / years
    eq = a[sc.A_EQ]
    base.update(
        winRate=a[sc.A_WINS] / n, avgGrossR=a[sc.A_GROSS] / n, avgNetR=mean,
        costR=(a[sc.A_GROSS] - a[sc.A_NET]) / n,
        profitFactor=jnum(a[sc.A_GP] / a[sc.A_GL]) if a[sc.A_GL] > 0 else (None if a[sc.A_GP] > 0 else 0),
        cagr=(eq ** (1 / years) - 1) if eq > 0 else -1, maxDrawdown=a[sc.A_MDD],
        sharpe=(mean / sd * math.sqrt(tpy)) if sd > 0 else 0, tradesPerYear=tpy,
        exposure=a[sc.A_BARS] / max(n_bars, 1), avgBarsHeld=a[sc.A_BARS] / n,
        longs=int(a[sc.A_LONGS]), shorts=int(n - a[sc.A_LONGS]))
    return {k: (jnum(v) if isinstance(v, (float, np.floating)) else v) for k, v in base.items()}


def trades_to_list(d, rows, pair=None):
    out = []
    for r in rows:
        ei, xi = int(r[0]), int(r[1])
        gross, net = r[9], r[10]
        out.append({
            'pair': pair or d.symbol, 'entryIndex': ei, 'exitIndex': xi,
            'entryTime': int(d.t[ei]), 'exitTime': int(d.t[xi]),
            'entryDate': str(np.datetime64(int(d.t[ei]), 's'))[:16].replace('T', ' ') if d.tf != 'D1' else str(np.datetime64(int(d.t[ei]), 's'))[:10],
            'exitDate': str(np.datetime64(int(d.t[xi]), 's'))[:16].replace('T', ' ') if d.tf != 'D1' else str(np.datetime64(int(d.t[xi]), 's'))[:10],
            'direction': int(r[2]), 'setup': sc.SETUP_NAMES.get(int(r[3]), '?'),
            'entry': r[4], 'exit': r[5], 'stop': r[6], 'target': jnum(r[7]), 'risk': r[8],
            'grossR': gross, 'netR': net, 'costR': gross - net, 'carryR': r[11], 'swapR': r[12],
            'barsHeld': int(r[13]), 'reason': sc.REASONS[int(r[14])],
        })
    return out


def run_pair(d, cfg, P, start=None, end=None):
    s, e = window(d.t, start if start is not None else cfg.get('start'), end if end is not None else cfg.get('end'))
    if e <= s + 2:
        return np.zeros((0, 15)), np.zeros(sc.NACC), np.zeros(5, np.int64), s, e
    rows, acc, ex = sc.backtest_trades(d.o, d.h, d.l, d.c, d.typ, d.bias, d.carry, spread_price(d, cfg), s, e, P)
    return rows, acc, ex, s, e


# ---- statistics (bootstrap, deflated Sharpe) ------------------------------------
def _q(arr, p):
    arr = np.sort(arr)
    return float(arr[min(len(arr) - 1, int(p * (len(arr) - 1)))])


def trade_bootstrap(values, draws=5000, seed=24681357):
    v = np.asarray(values, float)
    n = len(v)
    if n < 20:
        return None
    rng = np.random.default_rng(seed)
    means, pfs, shs = [], [], []
    done = 0
    while done < draws:
        m = min(250, draws - done)
        s = v[rng.integers(0, n, (m, n))]
        means.append(s.mean(1))
        g = np.where(s > 0, s, 0).sum(1)
        ls = np.where(s <= 0, -s, 0).sum(1)
        pfs.append(np.where(ls > 0, g / np.where(ls > 0, ls, 1), np.inf))
        sd = s.std(1, ddof=1)
        shs.append(np.where(sd > 0, s.mean(1) / np.where(sd > 0, sd, 1) * math.sqrt(n), 0))
        done += m
    means, pfs, shs = np.concatenate(means), np.concatenate(pfs), np.concatenate(shs)
    return {'mean05': _q(means, .05), 'mean50': _q(means, .5), 'mean95': _q(means, .95),
            'pf05': jnum(_q(pfs, .05)), 'pf50': jnum(_q(pfs, .5)), 'pf95': jnum(_q(pfs, .95)),
            'sharpe05': _q(shs, .05), 'sharpe50': _q(shs, .5), 'sharpe95': _q(shs, .95),
            'hist': np.histogram(means, bins=30)[0].tolist(),
            'histEdges': np.histogram(means, bins=30)[1].tolist()}


def monthly_from_trades(trades):
    b = {}
    for tr in trades:
        k = tr['exitDate'][:7]
        b[k] = b.get(k, 0.0) + 0.01 * tr['netR']
    return [b[k] for k in sorted(b)], sorted(b)


def sharpe_series(v):
    v = np.asarray(v, float)
    if len(v) < 2:
        return 0.0
    s = v.std(ddof=1)
    return float(v.mean() / s) if s > 0 else 0.0


def deflated_sharpe_series(values, trial_sharpes):
    v = np.asarray(values, float)
    T, N = len(v), len(trial_sharpes)
    if T < 24 or N < 2:
        return {'dsr': 0.0, 'sr': 0.0, 'sr0': 0.0, 'T': T, 'N': N}
    m, s = v.mean(), v.std(ddof=1)
    sr = m / s if s > 0 else 0.0
    nd = NormalDist()
    g = 0.5772156649015329
    sr0 = float(np.std(trial_sharpes, ddof=1)) * ((1 - g) * nd.inv_cdf(1 - 1 / N) + g * nd.inv_cdf(1 - 1 / (N * math.e)))
    z = (v - m) / s if s > 0 else np.zeros(T)
    skew, kurt = float((z ** 3).mean()), float((z ** 4).mean()) if s > 0 else 3.0
    denom = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr))
    return {'dsr': nd.cdf((sr - sr0) * math.sqrt(T - 1) / denom), 'sr': sr, 'sr0': sr0, 'T': T, 'N': N,
            'skew': skew, 'kurt': kurt}


def summarize_trades(trades, n_bars_total, bars_per_year, risk=0.01):
    """Pooled summary for a list of trade dicts (for walk-forward folds etc.)."""
    n = len(trades)
    if n == 0:
        return {'trades': 0, 'winRate': 0, 'avgNetR': 0, 'avgGrossR': 0, 'profitFactor': 0, 'sharpe': 0,
                'maxDrawdown': 0, 'pairsPositive': 0, 'pairs': 0}
    tr = sorted(trades, key=lambda x: (x['exitTime'], x['entryTime']))
    v = np.array([x['netR'] for x in tr])
    eq = np.cumprod(1 + risk * v)
    peak = np.maximum.accumulate(np.r_[1.0, eq])[1:]
    mdd = float((eq / peak - 1).min())
    g, ls = v[v > 0].sum(), -v[v <= 0].sum()
    bp = {}
    for x in trades:
        bp.setdefault(x['pair'], []).append(x['netR'])
    sd = v.std(ddof=1) if n > 1 else 0
    return {'trades': n, 'winRate': float((v > 0).mean()), 'avgNetR': float(v.mean()),
            'avgGrossR': float(np.mean([x['grossR'] for x in trades])),
            'profitFactor': jnum(g / ls) if ls > 0 else None,
            'sharpe': float(v.mean() / sd * math.sqrt(n)) if sd > 0 else 0.0, 'maxDrawdown': mdd,
            'pairsPositive': sum(1 for a in bp.values() if np.mean(a) > 0), 'pairs': len(bp)}


# ---- analyses ----------------------------------------------------------------
def meta():
    try:
        import numba
        nb = numba.__version__
        threads = numba.get_num_threads()
    except Exception:
        nb, threads = None, 0
    return {'ok': True, 'engine': 'python-numba', 'numba': nb, 'threads': threads,
            'pairs': {tf: available_pairs(tf) for tf in DATA_DIRS},
            'rates': sorted(load_rates().keys()), 'cpus': os.cpu_count() or 1, 'time': time.time()}


def run_backtest(cfg):
    """Single-pair backtest with all trades, equity curve and the labelled bars for charts."""
    pair = (cfg.get('pairs') or ['EURUSD'])[0]
    c1 = dict(cfg, pairs=[pair])
    d = pair_set(c1)[0]
    P = build_params(cfg)
    rows, acc, ex, s, e = run_pair(d, cfg, P)
    st = acc_stats(acc, ex, e - s, P[sc.P_BARS_PER_YEAR])
    trades = trades_to_list(d, rows)
    eq, cur = [], 1.0
    for tr in trades:
        cur *= 1 + P[sc.P_RISK] * tr['netR']
        eq.append([tr['exitTime'], cur])
    return {'kind': 'backtest', 'pair': pair, 'tf': d.tf, 'bars': e - s, 'stats': st, 'trades': trades,
            'equity': eq, 'levels': d.levels, 'config': cfg}


def run_grid(cfg):
    """Flattened parallel grid over pairs x folds x any parameter axes."""
    t0 = time.time()
    ds = pair_set(cfg)
    P = build_params(cfg)
    axes = (cfg.get('grid') or {}).get('axes', [])
    folds = int(cfg.get('folds', 1))
    # data pack
    lens = np.array([len(d.t) for d in ds], np.int64)
    offs = np.r_[0, np.cumsum(lens)[:-1]].astype(np.int64)
    cat = lambda name: np.ascontiguousarray(np.concatenate([getattr(d, name) for d in ds]))
    o, h, l, c, typ, carry = cat('o'), cat('h'), cat('l'), cat('c'), cat('typ'), cat('carry')
    bias = np.ascontiguousarray(np.concatenate([d.bias for d in ds], axis=1))
    spreads = np.array([spread_price(d, cfg) for d in ds])
    bounds = fold_bounds(cfg.get('start') or '2014-01-01', cfg.get('end') or dt.date.today().isoformat(), folds)
    win_s = np.zeros((len(ds), folds), np.int64)
    win_e = np.zeros((len(ds), folds), np.int64)
    for i, d in enumerate(ds):
        for f, (a, b) in enumerate(bounds):
            win_s[i, f], win_e[i, f] = window(d.t, a, b)
            if win_e[i, f] <= win_s[i, f] + 2:
                win_e[i, f] = win_s[i, f] + 2
    ax_param = np.array([AXIS_INDEX[a['param']] for a in axes] or [0], np.int64)
    n_ax = len(axes)
    width = max([len(a['values']) for a in axes] or [1])
    ax_vals = np.zeros((max(n_ax, 1), width))
    ax_len = np.ones(max(n_ax, 1), np.int64)
    labels = []
    for k, a in enumerate(axes):
        m = AXIS_MAPS.get(a['param'])
        vals = [m[v] if (m and isinstance(v, str)) else float(v) for v in a['values']]
        ax_vals[k, :len(vals)] = vals
        ax_len[k] = len(vals)
        labels.append(a['values'])
    if n_ax == 0:
        ax_len = np.ones(1, np.int64)
        ax_param = np.array([sc.P_LOOKBACK], np.int64)
        ax_vals = np.array([[P[sc.P_LOOKBACK]]])
    n_pair = len(ds)
    shape = (n_pair, folds) + tuple(int(x) for x in ax_len[:max(n_ax, 1)])
    total = int(np.prod(shape))
    if total > int(cfg.get('max_combos', 5_000_000)):
        raise ValueError(f'Grid has {total} combinations; limit is {cfg.get("max_combos", 5_000_000)}.')
    res, ex = sc.grid_stats(o, h, l, c, typ, bias, carry, offs, lens, spreads, win_s, win_e, P,
                            ax_param, ax_vals, ax_len, n_pair, folds)
    res = res.reshape(shape, order='F') if False else res
    # decode combination index k (first index fastest)
    idx = np.array(np.unravel_index(np.arange(total), shape, order='F'))  # (dims, total)
    bpy = P[sc.P_BARS_PER_YEAR]
    nb = np.array([[win_e[i, f] - win_s[i, f] for f in range(folds)] for i in range(n_pair)])
    combos = {}
    for k in range(total):
        key = tuple(int(x) for x in idx[1:, k])  # fold + axes (pairs pooled)
        ip, f = int(idx[0, k]), int(idx[1, k])
        g = combos.setdefault(key, {'acc': np.zeros(sc.NACC), 'ex': np.zeros(5, np.int64), 'bars': 0, 'pairsPos': 0, 'pairs': 0, 'per': []})
        a = res[k]
        g['acc'] += a
        g['acc'][sc.A_EQ] = 1.0
        g['acc'][sc.A_PEAK] = 1.0
        g['ex'] += ex[k]
        g['bars'] += nb[ip, f]
        if a[sc.A_N] > 0:
            g['pairs'] += 1
            if a[sc.A_NET] > 0:
                g['pairsPos'] += 1
        if cfg.get('by_pair'):
            g['per'].append({'pair': ds[ip].symbol, **acc_stats(a, ex[k], nb[ip, f], bpy)})
    rows = []
    for key, g in combos.items():
        a = g['acc']
        n = a[sc.A_N]
        mean = a[sc.A_NET] / n if n else 0
        var = (a[sc.A_NET2] - n * mean * mean) / (n - 1) if n > 1 else 0
        sd = math.sqrt(max(var, 0))
        row = {'fold': key[0], 'axes': {axes[j]['param']: axes[j]['values'][key[1 + j]] for j in range(n_ax)},
               'trades': int(n), 'avgNetR': jnum(mean), 'avgGrossR': jnum(a[sc.A_GROSS] / n if n else 0),
               'winRate': jnum(a[sc.A_WINS] / n if n else 0),
               'profitFactor': jnum(a[sc.A_GP] / a[sc.A_GL]) if a[sc.A_GL] > 0 else None,
               'sharpe': jnum(mean / sd * math.sqrt(n)) if sd > 0 else 0, 'pairsPositive': g['pairsPos'],
               'pairs': g['pairs'], 'bothHit': int(a[sc.A_BOTH])}
        if n_pair == 1:
            row.update(cagr=acc_stats(a, g['ex'], g['bars'], bpy)['cagr'], maxDrawdown=jnum(a[sc.A_MDD]))
        if cfg.get('by_pair'):
            row['byPair'] = g['per']
        rows.append(row)
    return {'kind': 'grid', 'tf': cfg.get('tf', 'D1'), 'pairs': [d.symbol for d in ds], 'folds': folds,
            'bounds': bounds, 'axes': [{'param': a['param'], 'values': a['values']} for a in axes],
            'combinations': total, 'rows': rows, 'seconds': time.time() - t0, 'config': cfg}


def fold_bounds(start, end, folds):
    s, e = date_ts(start), date_ts(end)
    span = e - s
    out = []
    for i in range(folds):
        a = s + round(span * i / folds)
        b = s + round(span * (i + 1) / folds) - 86400
        out.append((str(np.datetime64(a, 's'))[:10], str(np.datetime64(b, 's'))[:10]))
    return out


def run_walkforward(cfg):
    ds = pair_set(cfg)
    P = build_params(cfg)
    folds = int(cfg.get('folds', 4))
    bounds = fold_bounds(cfg.get('start') or '2014-01-01', cfg.get('end') or dt.date.today().isoformat(), folds)
    out, allt, curve = [], [], []
    bpy = P[sc.P_BARS_PER_YEAR]
    for f, (a, b) in enumerate(bounds):
        ft = []
        for d in ds:
            rows, acc, ex, s, e = run_pair(d, cfg, P, a, b)
            ft += trades_to_list(d, rows)
        st = summarize_trades(ft, 0, bpy, P[sc.P_RISK])
        boot = trade_bootstrap([x['netR'] for x in ft], draws=int(cfg.get('draws', 3000)))
        out.append({'from': a, 'to': b, 'stats': st, 'bootstrap': boot})
        allt += ft
    overall = summarize_trades(allt, 0, bpy, P[sc.P_RISK])
    boot = trade_bootstrap([x['netR'] for x in allt], draws=int(cfg.get('draws', 3000)))
    by_pair = {}
    for x in allt:
        by_pair.setdefault(x['pair'], []).append(x['netR'])
    return {'kind': 'walkforward', 'folds': out, 'overall': overall, 'bootstrap': boot,
            'byPair': {k: {'trades': len(v), 'avgNetR': float(np.mean(v))} for k, v in by_pair.items()},
            'note': 'Fixed rule on equal date folds; pooled trades at fixed risk, not a portfolio.', 'config': cfg}


def run_robustness(cfg):
    pair = (cfg.get('pairs') or ['EURUSD'])[0]
    d = pair_set(dict(cfg, pairs=[pair]))[0]
    runs, sh, msh = {}, {}, {}
    for name, over in VARIANTS.items():
        c2 = dict(cfg, params=dict(cfg.get('params', {}), **over))
        P = build_params(c2)
        rows, acc, ex, s, e = run_pair(d, c2, P)
        runs[name] = trades_to_list(d, rows)
        v = np.array([t['netR'] for t in runs[name]])
        sh[name] = float(v.mean() / v.std(ddof=1) * math.sqrt(len(v))) if len(v) > 2 and v.std() > 0 else 0.0
        mv, _ = monthly_from_trades(runs[name])
        msh[name] = mv
    default = runs['default']
    boot = trade_bootstrap([t['netR'] for t in default])
    ok = all(len(v) >= 24 for v in msh.values())
    dsr = deflated_sharpe_series(msh['default'], [sharpe_series(v) for v in msh.values()]) if ok else None
    return {'kind': 'robustness', 'pair': pair, 'variants': {
        k: summarize_trades(v, 0, 252, 0.01) for k, v in runs.items()},
        'tradeSharpes': sh, 'bootstrap': boot, 'monthlyDsr': dsr, 'config': cfg}


def _portfolio_core(cfg, variant_params=None):
    ds = pair_set(cfg)
    c2 = dict(cfg, params=dict(cfg.get('params', {}), **(variant_params or {})))
    P = build_params(c2)
    pc = cfg.get('portfolio', {}) or {}
    rpt, mor, mpos = pc.get('risk_per_trade', 0.0025), pc.get('max_open_risk', 0.02), int(pc.get('max_positions', 8))
    start = cfg.get('start') or '2014-01-01'
    end = cfg.get('end') or dt.date.today().isoformat()
    t0, t1 = date_ts(start), date_ts(end) + 86399
    parts = [d.t[(d.t >= t0) & (d.t <= t1)] for d in ds]
    timeline = np.unique(np.concatenate(parts))
    K = len(timeline)
    closes = {}
    trades_all = []
    for d in ds:
        idx = np.searchsorted(d.t, timeline, side='right') - 1
        closes[d.symbol] = np.where(idx >= 0, d.c[np.clip(idx, 0, None)], np.nan)
        rows, acc, ex, s, e = run_pair(d, c2, P, start, end)
        for tr in trades_to_list(d, rows):
            tr['ek'] = int(np.searchsorted(timeline, tr['entryTime']))
            tr['xk'] = int(np.searchsorted(timeline, tr['exitTime']))
            trades_all.append(tr)
    sim = _portfolio_sim(timeline, closes, trades_all, rpt, mor, mpos)
    return dict(ds=ds, P=P, timeline=timeline, eqs=sim['eqs'], n_open=sim['n_open'], pair_pnl=sim['pair_pnl'],
                pair_cnt=sim['pair_cnt'], max_open_ratio=sim['max_open_ratio'], taken=sim['taken'],
                all_trades=trades_all, bpy=P[sc.P_BARS_PER_YEAR], start=start, end=end,
                pc=dict(risk_per_trade=rpt, max_open_risk=mor, max_positions=mpos))


def _portfolio_sim(timeline, closes, trades_all, rpt, mor, mpos):
    """Bar-by-bar mark-to-market portfolio. trades_all: dicts from trades_to_list plus 'ek'/'xk'
    (entry/exit index on `timeline`). closes: {pair: close per timeline bar}. Shared with benchmark.py."""
    K = len(timeline)
    ent, exi = {}, {}
    for tr in trades_all:
        ent.setdefault(tr['ek'], []).append(tr)
        if tr['xk'] != tr['ek']:
            exi.setdefault(tr['xk'], []).append(tr)
    realized, open_risk = 0.0, 0.0
    pos = []
    eqs = np.zeros(K)
    n_open = np.zeros(K)
    pair_pnl, pair_cnt = {}, {}
    max_open_ratio = 0.0
    taken = []
    for k in range(K):
        for tr in exi.get(k, []):
            j = next((q for q, p in enumerate(pos) if p['pair'] == tr['pair'] and p['ei'] == tr['entryIndex']), -1)
            if j < 0:
                continue
            p = pos.pop(j)
            p['unreal'] += p['dir'] * p['size'] * (tr['exit'] - p['mark'])
            realized += p['unreal'] - 0.5 * p['cost']
            pair_pnl[p['pair']] = pair_pnl.get(p['pair'], 0.0) + p['risk_amt'] * tr['netR']
            open_risk -= p['risk_amt']
        for p in pos:
            cl = closes[p['pair']][k]
            if math.isfinite(cl):
                p['unreal'] += p['dir'] * p['size'] * (cl - p['mark'])
                p['mark'] = cl
        new = []
        for tr in sorted(ent.get(k, []), key=lambda x: x['pair']):
            if len(pos) >= mpos:
                break
            eq = 1 + realized + sum(p['unreal'] for p in pos)
            remaining = max(0.0, mor * eq - open_risk)
            ra = min(rpt * eq, remaining)
            if ra <= 0.2 * rpt * eq:
                continue
            p = {'pair': tr['pair'], 'dir': tr['direction'], 'ei': tr['entryIndex'], 'mark': tr['entry'],
                 'size': ra / tr['risk'], 'risk_amt': ra, 'cost': tr['costR'] * ra, 'unreal': 0.0}
            realized -= 0.5 * p['cost']
            pair_cnt[tr['pair']] = pair_cnt.get(tr['pair'], 0) + 1
            taken.append(tr)
            if tr['xk'] == k:  # entered and exited inside the same bar
                realized += p['dir'] * p['size'] * (tr['exit'] - tr['entry']) - 0.5 * p['cost']
                pair_pnl[p['pair']] = pair_pnl.get(p['pair'], 0.0) + ra * tr['netR']
                continue
            pos.append(p)
            new.append(p)
            open_risk += ra
        for p in new:
            cl = closes[p['pair']][k]
            if math.isfinite(cl):
                p['unreal'] += p['dir'] * p['size'] * (cl - p['mark'])
                p['mark'] = cl
        eq = 1 + realized + sum(p['unreal'] for p in pos)
        eqs[k] = eq
        n_open[k] = len(pos)
        if eq > 0:
            max_open_ratio = max(max_open_ratio, open_risk / eq)
    return dict(eqs=eqs, n_open=n_open, pair_pnl=pair_pnl, pair_cnt=pair_cnt,
                max_open_ratio=max_open_ratio, taken=taken)




def _port_metrics(r, ppy):
    n = len(r)
    if n == 0:
        return {'cagr': 0, 'vol': 0, 'sharpe': 0, 'maxDD': 0}
    eq = np.cumprod(1 + r)
    peak = np.maximum.accumulate(eq)
    sd = r.std(ddof=1) if n > 1 else 0
    years = n / ppy
    return {'cagr': float(eq[-1] ** (1 / years) - 1) if eq[-1] > 0 else -1, 'vol': float(sd * math.sqrt(ppy)),
            'sharpe': float(r.mean() / sd * math.sqrt(ppy)) if sd > 0 else 0.0,
            'maxDD': float((eq / peak - 1).min()), 'totalReturn': float(eq[-1] - 1)}


def _block_bootstrap(m, block=6, draws=5000, seed=123456789):
    T = len(m)
    if T < 12:
        return None
    rng = np.random.default_rng(seed)
    nblk = -(-T // block)
    starts = rng.integers(0, T, (draws, nblk))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]) % T
    s = m[idx.reshape(draws, -1)[:, :T]]
    sd = s.std(1, ddof=1)
    sh = np.where(sd > 0, s.mean(1) / np.where(sd > 0, sd, 1) * math.sqrt(12), 0)
    mu = s.mean(1)
    return {'sharpe05': _q(sh, .05), 'sharpe50': _q(sh, .5), 'sharpe95': _q(sh, .95),
            'mean05': _q(mu, .05), 'mean95': _q(mu, .95)}


def run_portfolio(cfg, variant_params=None, full=True):
    pr = _portfolio_core(cfg, variant_params)
    eqs, timeline = pr['eqs'], pr['timeline']
    K = len(eqs)
    ret = np.r_[0.0, eqs[1:] / eqs[:-1] - 1] if K else np.zeros(0)
    ppy = pr['bpy']
    m = _port_metrics(ret, ppy)
    months = timeline.astype('datetime64[s]').astype('datetime64[M]').astype(str)
    mk, mv = [], []
    for u in dict.fromkeys(months):
        sel = ret[months == u]
        mk.append(u)
        mv.append(float(np.prod(1 + sel) - 1))
    mv_a = np.array(mv)
    boot = _block_bootstrap(mv_a)
    expo = float((pr['n_open'] > 0).mean()) if K else 0
    peak = np.maximum.accumulate(eqs) if K else eqs
    step = max(1, K // 1500)
    cut = lambda a: [jnum(x) for x in a[::step]]
    # calendar blocks of 3 years from the window start (last block extends to the end)
    y0 = int(pr['start'][:4])
    blocks = []
    years_all = timeline.astype('datetime64[s]').astype('datetime64[Y]').astype(int) + 1970
    for b0 in range(y0, int(years_all.max()) + 1 if K else y0, 3):
        sel = (years_all >= b0) & (years_all <= (b0 + 2 if b0 + 5 <= years_all.max() else years_all.max()))
        if sel.sum() > 2:
            blocks.append({'name': f'{b0}-{int(years_all[sel].max())}', 'days': int(sel.sum()), **_port_metrics(ret[sel], ppy)})
            if b0 + 5 > years_all.max():
                break
    pnl = {p: jnum(v * 100) for p, v in pr['pair_pnl'].items()}
    out = {'kind': 'portfolio', 'tf': cfg.get('tf', 'D1'), 'pairs': [d.symbol for d in pr['ds']], 'start': pr['start'],
           'end': pr['end'], 'settings': pr['pc'], 'metrics': m, 'exposure': expo, 'averageOpen': float(pr['n_open'].mean()) if K else 0,
           'maxConcurrentPositions': int(pr['n_open'].max()) if K else 0, 'maxOpenRiskRatio': pr['max_open_ratio'],
           'trades': len(pr['taken']), 'monthly': [{'month': a, 'value': b} for a, b in zip(mk, mv)],
           'bootstrap': boot, 'pairPnlPct': pnl, 'pairTrades': pr['pair_cnt'], 'blocks': blocks,
           'monthlySharpe': sharpe_series(mv_a)}
    if full:
        out['curve'] = {'t': [int(x) for x in timeline[::step]], 'equity': cut(eqs), 'drawdown': cut(eqs / peak - 1),
                        'open': [int(x) for x in pr['n_open'][::step]]}
    out['_monthly_raw'] = mv
    return out


def run_portfolio_robustness(cfg):
    runs = {}
    for name, over in VARIANTS.items():
        r = run_portfolio(cfg, over, full=False)
        runs[name] = r
    trial = [sharpe_series(r['_monthly_raw']) for r in runs.values()]
    dsr = deflated_sharpe_series(runs['default']['_monthly_raw'], trial)
    for r in runs.values():
        r.pop('_monthly_raw', None)
    return {'kind': 'portfolio_robustness', 'variants': {k: {'metrics': v['metrics'], 'monthlySharpe': v['monthlySharpe'],
            'trades': v['trades']} for k, v in runs.items()}, 'trialSharpes': trial, 'dsr': dsr, 'config': cfg}


STRESS = [
    ('baseline', {}, {}),
    ('both-hit = booked loss', {'both_hit': 'loss'}, {}),
    ('merge Sunday bar', {}, {'sunday': 'merge'}),
    ('spread x2', {'spread_mult': 2.0}, {}),
    ('spread x3', {'spread_mult': 3.0}, {}),
    ('friction 2 bp', {'friction_bp': 2.0}, {}),
    ('NY 17:00 daily bars', {}, {'day_mode': 'ny'}),
    ('flat swap 0.5 bp/day', {'swap_mode': 'flat', 'flat_swap_bp': 0.5}, {}),
    ('pessimistic combo', {'both_hit': 'loss', 'spread_mult': 2.0, 'friction_bp': 2.0}, {'sunday': 'merge'}),
]


def run_stress(cfg):
    """Realism ladder: the same rule re-run with one pessimistic assumption at a time, then all together.
    Pooled over the selected pairs at fixed risk (not a portfolio)."""
    out = []
    for name, over, cover in STRESS:
        c2 = dict(cfg, **cover)
        c2['params'] = dict(cfg.get('params', {}) or {}, **over)
        if c2.get('tf', 'D1') != 'D1' and ('sunday' in cover or 'day_mode' in cover):
            out.append({'name': name, 'skipped': 'daily-bar option, only applies to D1'})
            continue
        try:
            ds = pair_set(c2)
            P = build_params(c2)
            allt, both, bars = [], 0, 0
            for d in ds:
                rows, acc, ex, s, e = run_pair(d, c2, P)
                allt += trades_to_list(d, rows)
                both += int(acc[sc.A_BOTH])
                bars += e - s
            st = summarize_trades(allt, bars, P[sc.P_BARS_PER_YEAR], P[sc.P_RISK])
            st['costR'] = jnum(st['avgGrossR'] - st['avgNetR'])
            st['bothHit'] = both
            st['stopped'] = sum(1 for t in allt if t['reason'] in ('stop', 'bothhit'))
            out.append({'name': name, 'stats': st})
        except Exception as ex:  # e.g. H1 data missing for the NY-day option
            out.append({'name': name, 'skipped': str(ex)})
    by_setup = {}
    try:
        c2 = dict(cfg)
        ds = pair_set(c2)
        P = build_params(c2)
        for d in ds:
            rows, *_ = run_pair(d, c2, P)
            for t in trades_to_list(d, rows):
                by_setup.setdefault(t['setup'], []).append(t['netR'])
        by_setup = {k: {'trades': len(v), 'avgNetR': float(np.mean(v)), 'winRate': float(np.mean(np.array(v) > 0))}
                    for k, v in by_setup.items()}
    except Exception:
        by_setup = {}
    return {'kind': 'stress', 'tf': cfg.get('tf', 'D1'), 'scenarios': out, 'bySetup': by_setup, 'config': cfg}


KINDS = {'backtest': run_backtest, 'grid': run_grid, 'walkforward': run_walkforward,
         'robustness': run_robustness, 'portfolio': lambda c: {k: v for k, v in run_portfolio(c).items() if k != '_monthly_raw'},
         'portfolio_robustness': run_portfolio_robustness, 'stress': run_stress}


def run(kind, cfg):
    if kind == 'meta':
        return meta()
    if kind == 'all':
        res = {}
        for k in ('backtest', 'stress', 'walkforward', 'robustness', 'portfolio', 'portfolio_robustness'):
            try:
                res[k] = KINDS[k](cfg)
            except Exception as ex:  # keep going so one failure does not lose the others
                res[k] = {'kind': k, 'error': str(ex)}
        ax = (cfg.get('grid') or {}).get('axes')
        if ax:
            res['grid'] = run_grid(cfg)
        res['meta'] = meta()
        return res
    return KINDS[kind](cfg)
