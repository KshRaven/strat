export function summarize(trades, totalBars, barsPerYear, riskFraction) {
    const n = trades.length;
    if (n === 0) {
        return {
            trades: 0, winRate: 0, avgGrossR: 0, avgNetR: 0, costR: 0,
            profitFactor: 0, cagr: 0, maxDrawdown: 0, sharpe: 0,
            tradesPerYear: 0, exposure: 0, avgBarsHeld: 0,
            longs: 0, shorts: 0, exits: {}
        };
    }

    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;
    let grossSum = 0;
    let netSum = 0;
    let wins = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let barsHeld = 0;
    let longs = 0;
    const exits = {};

    for (const trade of trades) {
        equity *= 1 + riskFraction * trade.netR;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);

        grossSum += trade.grossR;
        netSum += trade.netR;
        barsHeld += trade.barsHeld;
        if (trade.netR > 0) {
            wins++;
            grossProfit += trade.netR;
        } else {
            grossLoss += Math.abs(trade.netR);
        }
        if (trade.direction > 0) longs++;
        exits[trade.reason] = (exits[trade.reason] ?? 0) + 1;
    }

    const years = totalBars / barsPerYear;
    const mean = netSum / n;
    const variance = n > 1
        ? trades.reduce((sum, trade) => sum + (trade.netR - mean) ** 2, 0) / (n - 1)
        : 0;
    const sd = Math.sqrt(variance);
    const tradesPerYear = years > 0 ? n / years : 0;

    return {
        trades: n,
        winRate: wins / n,
        avgGrossR: grossSum / n,
        avgNetR: mean,
        costR: (grossSum - netSum) / n,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
        cagr: equity > 0 && years > 0 ? Math.pow(equity, 1 / years) - 1 : -1,
        maxDrawdown,
        sharpe: sd > 0 ? (mean / sd) * Math.sqrt(tradesPerYear) : 0,
        tradesPerYear,
        exposure: barsHeld / totalBars,
        avgBarsHeld: barsHeld / n,
        longs,
        shorts: n - longs,
        exits
    };
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
}

function normCdf(x) {
    return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function invNorm(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const plow = 0.02425;
    const phigh = 1 - plow;
    if (p < plow) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > phigh) {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function tradeBootstrap(trades, { draws = 5000, seed = 24681357 } = {}) {
    const values = trades.map(trade => trade.netR);
    const n = values.length;
    if (n < 20) return null;
    const rand = mulberry32(seed);
    const means = [];
    const pfs = [];
    const sharpes = [];

    for (let d = 0; d < draws; d++) {
        const sample = [];
        let gains = 0;
        let losses = 0;
        for (let i = 0; i < n; i++) {
            const value = values[Math.floor(rand() * n)];
            sample.push(value);
            if (value > 0) gains += value;
            else losses += Math.abs(value);
        }
        const m = mean(sample);
        const sd = Math.sqrt(variance(sample));
        means.push(m);
        pfs.push(losses > 0 ? gains / losses : (gains > 0 ? Infinity : 0));
        sharpes.push(sd > 0 ? (m / sd) * Math.sqrt(n) : 0);
    }

    means.sort((a, b) => a - b);
    pfs.sort((a, b) => a - b);
    sharpes.sort((a, b) => a - b);
    const q = (array, p) => array[Math.min(array.length - 1, Math.floor(p * (array.length - 1)))];
    return {
        mean05: q(means, 0.05), mean50: q(means, 0.5), mean95: q(means, 0.95),
        pf05: q(pfs, 0.05), pf50: q(pfs, 0.5), pf95: q(pfs, 0.95),
        sharpe05: q(sharpes, 0.05), sharpe50: q(sharpes, 0.5), sharpe95: q(sharpes, 0.95)
    };
}

export function deflatedSharpe(targetTrades, trialTradeSharpes) {
    const values = targetTrades.map(trade => trade.netR);
    const T = values.length;
    if (T < 20 || trialTradeSharpes.length < 2) return { dsr: 0, sr: 0, sr0: 0 };
    const m = mean(values);
    const sd = Math.sqrt(variance(values));
    const sr = sd > 0 ? m / sd : 0;
    const trialVar = variance(trialTradeSharpes);
    const N = trialTradeSharpes.length;
    const gamma = 0.5772156649015329;
    const sr0 = Math.sqrt(trialVar) * ((1 - gamma) * invNorm(1 - 1 / N) + gamma * invNorm(1 - 1 / (N * Math.E)));
    const skew = sd > 0 ? mean(values.map(x => ((x - m) / sd) ** 3)) : 0;
    const kurt = sd > 0 ? mean(values.map(x => ((x - m) / sd) ** 4)) : 3;
    const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
    const dsr = normCdf(((sr - sr0) * Math.sqrt(T - 1)) / denom);
    return { dsr, sr, sr0, T, N };
}

export function deflatedSharpeSeries(values, trialSharpes) {
    const T = values.length;
    if (T < 24 || trialSharpes.length < 2) return { dsr: 0, sr: 0, sr0: 0, T, N: trialSharpes.length };
    const m = mean(values);
    const s = Math.sqrt(variance(values));
    const sr = s > 0 ? m / s : 0;
    const trialVar = variance(trialSharpes);
    const N = trialSharpes.length;
    const gamma = 0.5772156649015329;
    const sr0 = Math.sqrt(trialVar) * ((1 - gamma) * invNorm(1 - 1 / N) + gamma * invNorm(1 - 1 / (N * Math.E)));
    const skew = s > 0 ? mean(values.map(x => ((x - m) / s) ** 3)) : 0;
    const kurt = s > 0 ? mean(values.map(x => ((x - m) / s) ** 4)) : 3;
    const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
    return { dsr: normCdf(((sr - sr0) * Math.sqrt(T - 1)) / denom), sr, sr0, T, N };
}

export function monthlyFromTrades(trades) {
    const buckets = new Map();
    for (const trade of trades) {
        const key = String(trade.exitDate).slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(key)) return null;
        buckets.set(key, (buckets.get(key) ?? 0) + 0.01 * trade.netR);
    }
    return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, value]) => value);
}

export function shSeries(values) {
    const s = Math.sqrt(variance(values));
    return s > 0 ? mean(values) / s : 0;
}
