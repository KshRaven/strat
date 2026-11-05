// Synthetic daily FX data for when no feed is available. Results on it are not evidence of an edge.

const BASE_PRICE = { EURUSD: 1.1, GBPUSD: 1.3, AUDUSD: 0.75, NZDUSD: 0.7, EURGBP: 0.85, EURCHF: 1.05, USDCHF: 0.95,
    USDCAD: 1.3, USDJPY: 110, EURJPY: 130, GBPJPY: 150, AUDJPY: 80, CADJPY: 85, CHFJPY: 115, EURAUD: 1.5, EURCAD: 1.45 };

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * generateSample({ pairs, startDate, endDate, seed, dailyVolPct, driftPctYear,
 *                  momentum, volClustering, correlation, spread })
 * Returns { PAIR: bars } in the same shape parseCsv produces.
 *  - dailyVolPct: average daily move, % (FX is roughly 0.5)
 *  - driftPctYear: yearly drift, %
 *  - momentum: day-to-day return autocorrelation, -0.3..0.3 (0 = pure random walk)
 *  - volClustering: 0..0.95, how much volatility persists (0 = constant)
 *  - correlation: 0..0.9, share of each day's move common to all pairs
 */
export function generateSample(o = {}) {
    const pairs = (o.pairs ?? 'EURUSD,GBPUSD,USDJPY').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const t0 = Date.parse(`${o.startDate ?? '2014-01-01'}T00:00:00Z`), t1 = Date.parse(`${o.endDate ?? '2026-10-29'}T00:00:00Z`);
    if (!(t1 > t0)) throw new Error('End date must be after start date');
    const vol = (o.dailyVolPct ?? 0.5) / 100, drift = (o.driftPctYear ?? 0) / 100 / 252;
    const mom = o.momentum ?? 0, vc = o.volClustering ?? 0.8, corr = o.correlation ?? 0.3, spread = o.spread ?? 10;
    const rand = rng(o.seed ?? 1);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

    const days = [];
    for (let t = t0; t <= t1; t += 864e5) { const d = new Date(t).getUTCDay(); if (d > 0 && d < 6) days.push(t); }
    const common = days.map(() => gauss()); // shared shock gives cross-pair correlation
    const out = {};
    for (const pair of pairs) {
        const point = pair.includes('JPY') ? 0.001 : 0.00001;
        let px = BASE_PRICE[pair] ?? 1, prevRet = 0, v = 1;
        const time = [], open = [], high = [], low = [], close = [];
        days.forEach((t, i) => {
            v = vc * v + (1 - vc) * 1 + 0.35 * (1 - vc) * Math.abs(gauss()); // vol multiplier
            const shock = Math.sqrt(corr) * common[i] + Math.sqrt(1 - corr) * gauss();
            const ret = drift + mom * prevRet + vol * v * shock;
            const o_ = px * (1 + 0.1 * vol * gauss()); // small overnight gap
            const c_ = o_ * (1 + ret);
            const range = vol * v * (0.4 + 0.8 * rand());
            time.push(t / 1000); open.push(o_); close.push(c_);
            high.push(Math.max(o_, c_) * (1 + range * rand()));
            low.push(Math.min(o_, c_) * (1 - range * rand()));
            prevRet = ret; px = c_;
        });
        out[pair] = { symbol: pair, spread, point, time, open, high, low, close, n: close.length, timeframe: 'D1', spreadPrice: spread * point };
    }
    return out;
}
