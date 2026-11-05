"""Numba kernels for the Strat backtest.

Mirrors the rules in src/backtest.js / src/strat.js and STRATEGY.md, for any
timeframe (D1, H4, H1). Signals use bars up to s = i - 1 only; bar i's own
high/low is used only to test whether the resting order was reached.

Layout notes
- All prices are float64 arrays. Bar index i is the same in every array.
- typ[i]: 0 none, 1 inside, 2 two-up, 3 two-down, 4 outside.
- bias[k, i]: sign(close[i] - open of the level-k candle containing bar i), int8.
- carry[i]: annual carry (base rate - quote rate, previous-month rates), NaN if unknown.
"""
import numpy as np
from numba import njit, prange

# ---- parameter vector indexes -------------------------------------------------
P_LOOKBACK, P_MAXHOLD, P_RISK, P_SPREAD_MULT, P_FRICTION_BP, P_SWAP_MODE = 0, 1, 2, 3, 4, 5
P_SWAP_SPREAD_BP, P_FLAT_SWAP_BP, P_HTF_MODE, P_ENTRY, P_TARGET, P_BOTHHIT = 6, 7, 8, 9, 10, 11
P_SETUP_MASK, P_BARS_PER_YEAR, P_BARS_PER_DAY, P_MIN_TARGET_R, P_RR = 12, 13, 14, 15, 16
NPAR = 17

# accumulator indexes (running statistics, one row per run)
A_N, A_WINS, A_GROSS, A_NET, A_NET2, A_GP, A_GL, A_BARS, A_LONGS, A_EQ, A_PEAK, A_MDD, A_BOTH, A_BOTHLOSS = range(14)
NACC = 16

# exit reason codes
R_STOP, R_TARGET, R_TIME, R_EOD, R_BOTH = 0, 1, 2, 3, 4
REASONS = ['stop', 'target', 'time', 'eod', 'bothhit']

# setup ids
SETUP_NAMES = {1: '2-1', 2: '3-1', 3: '1-2', 4: '2-2', 5: '3-2', 6: '1-1', 7: '3'}
SETUP_IDS = {v: k for k, v in SETUP_NAMES.items()}
DEFAULT_SETUPS = ['2-1', '3-1', '1-2', '2-2', '3-2']

TF_DEFAULTS = {
    'D1': dict(max_hold=10, bars_per_year=252.0, bars_per_day=1.0, levels=['W', 'M']),
    'H4': dict(max_hold=12, bars_per_year=1512.0, bars_per_day=6.0, levels=['D', 'W', 'M']),
    'H1': dict(max_hold=24, bars_per_year=6048.0, bars_per_day=24.0, levels=['D', 'W', 'M']),
}
HTF_MODES = {'all': 0, 'none': 0, 'continuity': 1, 'reversal': 2}
ENTRY_MODES = {'intrabar': 0, 'close': 1}
TARGET_MODES = {'structural': 0, '2r': 1}
BOTH_MODES = {'skip': 0, 'loss': 1}
SWAP_MODES = {'none': 0, 'rates': 1, 'flat': 2}


# ---- data preparation (plain numpy) -------------------------------------------
def classify(h, l):
    n = len(h)
    t = np.zeros(n, np.int8)
    if n > 1:
        hh = h[1:] > h[:-1]
        ll = l[1:] < l[:-1]
        t[1:] = np.where(hh & ll, 4, np.where(hh, 2, np.where(ll, 3, 1)))
    return t


def period_ids(t, level, shift_h=0.0):
    ts = t + int(shift_h * 3600)
    if level == 'H1':
        return ts // 3600
    if level == 'H4':
        return ts // 14400
    if level == 'D':
        return ts // 86400
    if level == 'W':
        return (ts // 86400 + 3) // 7  # weeks start Monday (1970-01-01 was a Thursday)
    if level == 'M':
        return ts.astype('datetime64[s]').astype('datetime64[M]').astype(np.int64)
    raise ValueError(f'unknown level {level}')


def period_start_index(ids):
    n = len(ids)
    change = np.empty(n, bool)
    change[0] = True
    change[1:] = ids[1:] != ids[:-1]
    starts = np.flatnonzero(change)
    return starts[np.cumsum(change) - 1]


def htf_bias(o, c, t, levels, shift_h=0.0):
    out = np.zeros((len(levels), len(t)), np.int8)
    for k, lv in enumerate(levels):
        st = period_start_index(period_ids(t, lv, shift_h))
        out[k] = np.sign(c - o[st]).astype(np.int8)
    return out


def setup_mask(names):
    m = 0
    for nm in names:
        m |= 1 << SETUP_IDS[nm]
    return m


# ---- kernels ------------------------------------------------------------------
@njit(cache=True, nogil=True)
def _setup_id(ts, tp):
    if ts == 1:
        if tp == 2 or tp == 3:
            return 1
        if tp == 4:
            return 2
        if tp == 1:
            return 6
        return 0
    if ts == 2 or ts == 3:
        if tp == 1:
            return 3
        if tp == 4:
            return 5
        if tp == 2 or tp == 3:
            return 4
        return 0
    if ts == 4:
        return 7
    return 0


@njit(cache=True, nogil=True)
def _htf_ok(bias, s, direction, mode):
    if mode == 0:
        return True
    want = direction if mode == 1 else -direction
    for k in range(bias.shape[0]):
        if bias[k, s] != want:
            return False
    return True


@njit(cache=True, nogil=True)
def _close_trade(direction, e_idx, x_idx, entry_raw, entry_net, exit_price, reason, stop, target,
                 risk, carry_a, setup, sp, P, store, out, acc, exits, count):
    friction = P[P_FRICTION_BP] / 10000.0
    bars_held = x_idx - e_idx + 1
    days_held = bars_held / P[P_BARS_PER_DAY]
    exit_cost = sp / 2.0 + exit_price * friction
    exit_net = exit_price - exit_cost if direction > 0 else exit_price + exit_cost
    gross_price = direction * (exit_price - entry_raw)
    mode = int(P[P_SWAP_MODE])
    use_rate = (mode == 1) and (not np.isnan(carry_a))
    carry_price = 0.0
    if use_rate:
        carry_price = direction * entry_raw * carry_a * bars_held / P[P_BARS_PER_YEAR]
    swap_price = 0.0
    if mode == 1:
        bp = P[P_SWAP_SPREAD_BP] if use_rate else P[P_FLAT_SWAP_BP]
        swap_price = entry_raw * (bp / 10000.0) * days_held
    elif mode == 2:
        swap_price = entry_raw * (P[P_FLAT_SWAP_BP] / 10000.0) * days_held
    net_price = direction * (exit_net - entry_net) + carry_price - swap_price
    gross_r = gross_price / risk
    net_r = net_price / risk

    acc[A_N] += 1.0
    if net_r > 0:
        acc[A_WINS] += 1.0
        acc[A_GP] += net_r
    else:
        acc[A_GL] += -net_r
    acc[A_GROSS] += gross_r
    acc[A_NET] += net_r
    acc[A_NET2] += net_r * net_r
    acc[A_BARS] += bars_held
    if direction > 0:
        acc[A_LONGS] += 1.0
    eq = acc[A_EQ] * (1.0 + P[P_RISK] * net_r)
    acc[A_EQ] = eq
    if eq > acc[A_PEAK]:
        acc[A_PEAK] = eq
    dd = eq / acc[A_PEAK] - 1.0
    if dd < acc[A_MDD]:
        acc[A_MDD] = dd
    exits[reason] += 1
    if store:
        out[count, 0] = e_idx
        out[count, 1] = x_idx
        out[count, 2] = direction
        out[count, 3] = setup
        out[count, 4] = entry_raw
        out[count, 5] = exit_price
        out[count, 6] = stop
        out[count, 7] = target
        out[count, 8] = risk
        out[count, 9] = gross_r
        out[count, 10] = net_r
        out[count, 11] = carry_price / risk
        out[count, 12] = swap_price / risk
        out[count, 13] = bars_held
        out[count, 14] = reason
    return count + 1


@njit(cache=True, nogil=True)
def _bt(o, h, l, c, typ, bias, carry, spread_price, start, end, P, store, out, acc, exits):
    lookback = int(P[P_LOOKBACK])
    maxhold = int(P[P_MAXHOLD])
    mask = int(P[P_SETUP_MASK])
    htf_mode = int(P[P_HTF_MODE])
    entry_mode = int(P[P_ENTRY])
    target_mode = int(P[P_TARGET])
    both_mode = int(P[P_BOTHHIT])
    friction = P[P_FRICTION_BP] / 10000.0
    sp = spread_price * P[P_SPREAD_MULT]

    count = 0
    in_pos = False
    direction = 0
    e_idx = 0
    entry_raw = 0.0
    entry_net = 0.0
    stop = 0.0
    target = 0.0
    risk = 1.0
    carry_a = np.nan
    setup = 0

    for i in range(start, end):
        if in_pos:
            ex_price = 0.0
            reason = -1
            op = o[i]
            if direction > 0:
                if op <= stop:
                    ex_price = op
                    reason = R_STOP
                elif l[i] <= stop:
                    ex_price = stop
                    reason = R_STOP
                elif op >= target:
                    ex_price = op
                    reason = R_TARGET
                elif h[i] >= target:
                    ex_price = target
                    reason = R_TARGET
            else:
                if op >= stop:
                    ex_price = op
                    reason = R_STOP
                elif h[i] >= stop:
                    ex_price = stop
                    reason = R_STOP
                elif op <= target:
                    ex_price = op
                    reason = R_TARGET
                elif l[i] <= target:
                    ex_price = target
                    reason = R_TARGET
            if reason < 0 and (i - e_idx + 1) >= maxhold:
                ex_price = c[i]
                reason = R_TIME
            if reason >= 0:
                count = _close_trade(direction, e_idx, i, entry_raw, entry_net, ex_price, reason, stop,
                                     target, risk, carry_a, setup, sp, P, store, out, acc, exits, count)
                in_pos = False
            continue

        s = i - 1
        if s < 2:
            continue
        sid = _setup_id(typ[s], typ[s - 1])
        if sid == 0 or ((mask >> sid) & 1) == 0:
            continue
        th = h[s]
        tl = l[s]
        long_hit = h[i] >= th
        short_hit = l[i] <= tl

        if long_hit and short_hit:
            acc[A_BOTH] += 1.0
            if both_mode == 0:
                continue
            # pessimistic bound: the side that fills first is stopped out by the other trigger
            d = 0
            if htf_mode == 0:
                d = 1
            elif _htf_ok(bias, s, 1, htf_mode):
                d = 1
            elif _htf_ok(bias, s, -1, htf_mode):
                d = -1
            if d == 0:
                continue
            if entry_mode == 1:
                if d > 0 and not (c[i] > th):
                    continue
                if d < 0 and not (c[i] < tl):
                    continue
                er = c[i]
            else:
                er = max(o[i], th) if d > 0 else min(o[i], tl)
            stp = tl if d > 0 else th
            rk = abs(er - stp)
            if not (rk > 0):
                continue
            ecost = sp / 2.0 + er * friction
            en = er + ecost if d > 0 else er - ecost
            acc[A_BOTHLOSS] += 1.0
            count = _close_trade(d, i, i, er, en, stp, R_BOTH, stp, np.nan, rk, carry[i], sid, sp, P,
                                 store, out, acc, exits, count)
            continue

        if long_hit:
            dcand = 1
        elif short_hit:
            dcand = -1
        else:
            continue
        if not _htf_ok(bias, s, dcand, htf_mode):
            continue

        if entry_mode == 1:
            if dcand > 0:
                if not (c[i] > th):
                    continue
            else:
                if not (c[i] < tl):
                    continue
            er = c[i]
        else:
            er = max(o[i], th) if dcand > 0 else min(o[i], tl)
        stp = tl if dcand > 0 else th
        rk = abs(er - stp)
        if not (rk > 0):
            continue
        ecost = sp / 2.0 + er * friction
        en = er + ecost if dcand > 0 else er - ecost

        if target_mode == 1:
            tg = er + dcand * P[P_RR] * rk
        else:
            tgv = -np.inf if dcand > 0 else np.inf
            frm = max(0, s - lookback)
            for j in range(frm, s):
                if dcand > 0:
                    if h[j] > tgv:
                        tgv = h[j]
                else:
                    if l[j] < tgv:
                        tgv = l[j]
            if dcand > 0:
                usable = tgv > er + P[P_MIN_TARGET_R] * rk
            else:
                usable = tgv < er - P[P_MIN_TARGET_R] * rk
            if (not np.isfinite(tgv)) or (not usable):
                tg = er + dcand * P[P_RR] * rk
            else:
                tg = tgv

        in_pos = True
        direction = dcand
        e_idx = i
        entry_raw = er
        entry_net = en
        stop = stp
        target = tg
        risk = rk
        carry_a = carry[i]
        setup = sid

    if in_pos:
        last = end - 1
        count = _close_trade(direction, e_idx, last, entry_raw, entry_net, c[last], R_EOD, stop, target,
                             risk, carry_a, setup, sp, P, store, out, acc, exits, count)
    return count


@njit(cache=True, nogil=True)
def backtest_trades(o, h, l, c, typ, bias, carry, spread_price, start, end, P):
    """One run that returns every trade (rows: see _close_trade), the accumulator and exit counts."""
    cap = max(1, end - start + 2)
    out = np.empty((cap, 15))
    acc = np.zeros(NACC)
    acc[A_EQ] = 1.0
    acc[A_PEAK] = 1.0
    exits = np.zeros(5, np.int64)
    n = _bt(o, h, l, c, typ, bias, carry, spread_price, start, end, P, True, out, acc, exits)
    return out[:n], acc, exits


@njit(parallel=True, cache=True)
def grid_stats(o, h, l, c, typ, bias, carry, offs, lens, spreads, win_s, win_e, base_P,
               ax_param, ax_vals, ax_len, n_pair, n_fold):
    """Flattened grid: pair x fold x axis0 x axis1 x ... processed with prange.

    Combination k decodes with the first index fastest:
        k -> (pair, fold, a0, a1, ...)   (numpy order='F')
    Returns per-combination accumulators and exit counts; trades are not stored.
    """
    n_ax = ax_len.shape[0]
    total = n_pair * n_fold
    for a in range(n_ax):
        total *= ax_len[a]
    res = np.zeros((total, NACC))
    ex = np.zeros((total, 5), np.int64)
    for k in prange(total):
        # Decode k with a running stride instead of mutating a copy of k: numba rejects any
        # assignment to (an alias of) the prange loop index ("Overwrite of parallel loop index").
        ip = k % n_pair
        stride = n_pair
        jf = (k // stride) % n_fold
        stride = stride * n_fold
        P = base_P.copy()
        for a in range(n_ax):
            m = ax_len[a]
            P[ax_param[a]] = ax_vals[a, (k // stride) % m]
            stride = stride * m
        b = offs[ip]
        n = lens[ip]
        acc = np.zeros(NACC)
        acc[A_EQ] = 1.0
        acc[A_PEAK] = 1.0
        exits = np.zeros(5, np.int64)
        out = np.empty((1, 15))
        _bt(o[b:b + n], h[b:b + n], l[b:b + n], c[b:b + n], typ[b:b + n], bias[:, b:b + n],
            carry[b:b + n], spreads[ip], win_s[ip, jf], win_e[ip, jf], P, False, out, acc, exits)
        res[k, :] = acc
        ex[k, :] = exits
    return res, ex
