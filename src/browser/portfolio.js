// Browser-safe counterpart of src/portfolio.js (the original needs Bun/node APIs).
// Rule logic is imported from ../strat.js and ../stats.js unchanged.

// ---- portfolio.js daily mark-to-market combiner ----
export function runPortfolio(pairTrades, pairBars, o = {}) {
    const startDate = o.startDate ?? '2008-01-01', endDate = o.endDate ?? '2026-10-30';
    const riskPerTrade = o.riskPerTrade ?? 0.0025, maxOpenRisk = o.maxOpenRisk ?? 0.02, maxPositions = o.maxPositions ?? 8;
    const allDates = new Set();
    for (const bars of pairBars.values())
        for (const t of bars.time) { const d = new Date(t * 1000).toISOString().slice(0, 10); if (d >= startDate && d <= endDate) allDates.add(d); }
    const dates = [...allDates].sort(), dateIndex = new Map(dates.map((d, i) => [d, i]));
    const closes = {};
    for (const [pair, bars] of pairBars) {
        const m = new Map(); bars.time.forEach((t, i) => m.set(new Date(t * 1000).toISOString().slice(0, 10), bars.close[i]));
        let last = NaN; closes[pair] = dates.map(d => { const v = m.get(d); if (Number.isFinite(v)) last = v; return last; });
    }
    const entries = new Map(), exits = new Map();
    for (const [pair, trades] of pairTrades) for (const t of trades) {
        if (!dateIndex.has(t.entryDate) || !dateIndex.has(t.exitDate)) continue;
        if (!entries.has(t.entryDate)) entries.set(t.entryDate, []);
        entries.get(t.entryDate).push({ ...t, pair });
        if (!exits.has(t.exitDate)) exits.set(t.exitDate, []);
        exits.get(t.exitDate).push({ ...t, pair });
    }
    let realized = 0, openRisk = 0, maxPosSeen = 0, maxRiskRatio = 0, openSum = 0;
    const positions = [], curve = [], daily = [], pairPnl = new Map();
    const unreal = () => positions.reduce((s, p) => s + p.unrealized, 0);
    for (let d = 0; d < dates.length; d++) {
        for (const t of exits.get(dates[d]) ?? []) {
            const ix = positions.findIndex(p => p.pair === t.pair && p.entryIndex === t.entryIndex);
            if (ix === -1) continue;
            const p = positions[ix];
            p.unrealized += p.direction * p.size * (t.exit - p.mark);
            realized += p.unrealized; realized -= 0.5 * p.costAmount;
            pairPnl.set(p.pair, (pairPnl.get(p.pair) ?? 0) + p.riskAmount * t.netR);
            openRisk -= p.riskAmount; positions.splice(ix, 1);
        }
        for (const p of positions) {
            const c = closes[p.pair][d];
            if (!Number.isFinite(c)) continue;
            p.unrealized += p.direction * p.size * (c - p.mark); p.mark = c;
        }
        const fresh = [];
        for (const t of (entries.get(dates[d]) ?? []).sort((a, b) => a.pair.localeCompare(b.pair))) {
            if (positions.length >= maxPositions) break;
            const eq = 1 + realized + unreal();
            const riskAmount = Math.min(riskPerTrade * eq, Math.max(0, maxOpenRisk * eq - openRisk));
            if (riskAmount <= 0.2 * riskPerTrade * eq) continue;
            const p = { pair: t.pair, direction: t.direction, entryIndex: t.entryIndex, mark: t.entry, size: riskAmount / t.risk,
                riskAmount, costAmount: t.costR * riskAmount, unrealized: 0 };
            positions.push(p); fresh.push(p); openRisk += riskAmount; realized -= 0.5 * p.costAmount;
        }
        for (const p of fresh) {
            const c = closes[p.pair][d];
            if (Number.isFinite(c)) { p.unrealized += p.direction * p.size * (c - p.mark); p.mark = c; }
        }
        const eq = 1 + realized + unreal();
        if (eq > 0) maxRiskRatio = Math.max(maxRiskRatio, openRisk / eq);
        curve.push(eq); daily.push(d === 0 ? 0 : eq / curve[d - 1] - 1);
        maxPosSeen = Math.max(maxPosSeen, positions.length); openSum += positions.length;
    }
    const n = daily.length, mean = daily.reduce((a, b) => a + b, 0) / (n || 1);
    const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    let peak = 1, maxDD = 0; for (const e of curve) { peak = Math.max(peak, e); maxDD = Math.min(maxDD, e / peak - 1); }
    const end = curve[n - 1] ?? 1, years = n / 252;
    return {
        dates, curve, pairPnl: Object.fromEntries(pairPnl),
        metrics: { cagr: end > 0 && years > 0 ? end ** (1 / years) - 1 : -1, vol: sd * Math.sqrt(252), sharpe: sd > 0 ? mean / sd * Math.sqrt(252) : 0,
            maxDD, avgOpen: openSum / (n || 1), maxOpen: maxPosSeen, maxOpenRisk: maxRiskRatio }
    };
}

