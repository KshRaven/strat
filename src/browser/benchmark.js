// Runs every rule variant on the same data and costs so they can be compared side by side,
// and expands "from / to / step" ranges into a grid of scenarios.

import { runBacktest } from './backtest.js';
import { runPortfolio } from './portfolio.js';
import { makeCarry } from './carry.js';
export { generateSample } from './sample.js';

export const VARIANTS = [];
for (const htf of ['continuity', 'reversal', 'all'])
    for (const target of ['structural', '2r'])
        for (const entry of ['intrabar', 'close'])
            VARIANTS.push({ htf, target, entry, label: `${htf} · ${target} · ${entry}` });

// rangeValues(0.2, 0.8, 0.2) -> [0.2, 0.4, 0.6, 0.8]. A missing step or to <= from gives a single value.
export function rangeValues(from, to, step, cap = 12) {
    if (!Number.isFinite(from)) return [];
    if (!(to > from) || !(step > 0)) return [from];
    const out = [];
    for (let v = from, k = 0; v <= to + step * 1e-9 && out.length < cap; k++, v = from + k * step)
        out.push(Number(v.toFixed(8)));
    return out;
}

// { a: [1, 2], b: [5] } -> [{a:1,b:5}, {a:2,b:5}]
export function expandGrid(ranges) {
    let grid = [{}];
    for (const [key, values] of Object.entries(ranges))
        grid = grid.flatMap(g => values.map(v => ({ ...g, [key]: v })));
    return grid;
}

// One scenario = one set of costs/risk limits on one data set. Returns a row per rule variant.
export function runScenario(barsByPair, p, ctx) {
    const pairs = Object.keys(barsByPair);
    const rows = []; let dates = null;
    for (const v of VARIANTS) {
        const pt = new Map(), pb = new Map(), pooled = [];
        for (const pair of pairs) {
            const base = barsByPair[pair];
            const bars = { ...base, spreadPrice: p.spread * base.point };
            try {
                const r = runBacktest(bars, {
                    htf: v.htf, target: v.target, entry: v.entry, startDate: ctx.startDate, endDate: ctx.endDate,
                    commissionBp: p.commissionBp, slippageBp: p.slippageBp
                }, makeCarry(pair, ctx.rates ?? {}));
                pt.set(pair, r.trades); pb.set(pair, bars); pooled.push(...r.trades);
            } catch { /* pair has no bars in the date window */ }
        }
        if (!pt.size) throw new Error('No pair has data inside the chosen dates');
        const pf = runPortfolio(pt, pb, {
            startDate: ctx.startDate, endDate: ctx.endDate, riskPerTrade: p.riskPct / 100,
            maxOpenRisk: p.maxOpenRiskPct / 100, maxPositions: p.maxPositions
        });
        const wins = pooled.filter(t => t.netR > 0), gw = wins.reduce((a, t) => a + t.netR, 0);
        const gl = -pooled.filter(t => t.netR <= 0).reduce((a, t) => a + t.netR, 0);
        dates = pf.dates;
        rows.push({
            ...v, curve: pf.curve, trades: pooled.length,
            win: pooled.length ? wins.length / pooled.length : 0,
            avgR: pooled.length ? pooled.reduce((a, t) => a + t.netR, 0) / pooled.length : 0,
            pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), ...pf.metrics
        });
    }
    return { rows, dates };
}
