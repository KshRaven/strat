// Browser-safe counterpart of src/backtest.js (the original needs Bun/node APIs).
// Rule logic is imported from ../strat.js and ../stats.js unchanged.

import { classifyCandles, setupAt, htfBias, htfAllows, structuralTarget } from '../strat.js';
import { summarize } from '../stats.js';

const dateOf = (bars, i) => new Date(bars.time[i] * 1000).toISOString().slice(0, 10);

function checkExit(p, bars, j, maxHold, isEntryBar) {
    const o = bars.open[j], h = bars.high[j], l = bars.low[j], c = bars.close[j], stop = p.stopRaw, target = p.targetRaw;
    if (p.direction > 0) {
        if (!isEntryBar && o <= stop) return { price: o, reason: 'stop' };
        if (l <= stop) return { price: stop, reason: 'stop' };
        if (!isEntryBar && o >= target) return { price: o, reason: 'target' };
        if (h >= target) return { price: target, reason: 'target' };
    } else {
        if (!isEntryBar && o >= stop) return { price: o, reason: 'stop' };
        if (h >= stop) return { price: stop, reason: 'stop' };
        if (!isEntryBar && o <= target) return { price: o, reason: 'target' };
        if (l <= target) return { price: target, reason: 'target' };
    }
    if (j - p.entryIndex + 1 >= maxHold) return { price: c, reason: 'time' };
    return null;
}

// ---- backtest.js main loop (D1 defaults) ----
export function runBacktest(bars, o = {}, carry = null) {
    const setups = new Set((o.setups ?? '2-1,3-1,1-2,2-2,3-2').split(',').map(s => s.trim()));
    const htfMode = o.htf ?? 'continuity', entryMode = o.entry ?? 'intrabar', targetMode = o.target ?? 'structural';
    const blocks = o.blocks ?? [5, 21], maxHold = o.maxHold ?? 10, lookback = o.lookback ?? 20;
    const riskFraction = o.risk ?? 0.01, barsPerYear = 252, barsPerDay = 1;
    const commissionBp = o.commissionBp ?? 0.5, slippageBp = o.slippageBp ?? 0.5;
    const friction = (commissionBp + slippageBp) / 10000;
    const swapMode = o.swapMode ?? 'rates', swapSpreadBp = o.swapSpreadBp ?? 0.2, flatSwapBp = o.flatSwapBp ?? 0.2;

    const types = classifyCandles(bars);
    const rateContext = swapMode === 'rates' ? carry : null;
    const useCalendar = true;

    let start = 2, end = bars.n;
    const sec = v => Math.floor(new Date(`${v}T00:00:00Z`).getTime() / 1000);
    if (o.startDate) start = Math.max(start, bars.time.findIndex(t => t >= sec(o.startDate)) === -1 ? bars.n : bars.time.findIndex(t => t >= sec(o.startDate)));
    if (o.endDate) { const t = sec(o.endDate); let k = 0; while (k < bars.n && bars.time[k] <= t) k++; end = Math.min(end, k); }
    if (end <= start + 2) throw new Error('Empty backtest window');

    const trades = []; let position = null;
    const close = (exitPrice, reason, exitIndex) => {
        const d = position.direction, barsHeld = exitIndex - position.entryIndex + 1, daysHeld = barsHeld / barsPerDay;
        const exitCost = bars.spreadPrice / 2 + exitPrice * friction;
        const exitNet = d > 0 ? exitPrice - exitCost : exitPrice + exitCost;
        const grossPrice = d * (exitPrice - position.entryRaw);
        const useRate = swapMode !== 'none' && rateContext !== null && position.carryAnnual !== null;
        const carryPrice = useRate ? d * position.entryRaw * position.carryAnnual * barsHeld / barsPerYear : 0;
        const swapBp = swapMode === 'none' ? 0 : (useRate ? swapSpreadBp : flatSwapBp);
        const swapPrice = swapMode === 'none' ? 0 : position.entryRaw * (swapBp / 10000) * daysHeld;
        const netPrice = d * (exitNet - position.entryNet) + carryPrice - swapPrice;
        const grossR = grossPrice / position.risk, netR = netPrice / position.risk;
        trades.push({
            setup: position.setup, direction: d, entryIndex: position.entryIndex, exitIndex,
            entryDate: dateOf(bars, position.entryIndex), exitDate: dateOf(bars, exitIndex),
            entry: position.entryRaw, exit: exitPrice, stop: position.stopRaw, target: position.targetRaw,
            risk: position.risk, grossR, netR, costR: grossR - netR, carryR: carryPrice / position.risk,
            swapR: swapPrice / position.risk, barsHeld, reason, htf: position.htf
        });
    };

    for (let i = start; i < end; i++) {
        if (position) {
            const ex = checkExit(position, bars, i, maxHold, false);
            if (ex) { close(ex.price, ex.reason, i); position = null; }
            continue;
        }
        const s = i - 1;
        if (s < 2) continue;
        const setup = setupAt(types, bars, s);
        if (!setup || !setups.has(setup.name)) continue;
        const bias = htfBias(bars, s, blocks, useCalendar);
        const longHit = bars.high[i] >= setup.triggerHigh, shortHit = bars.low[i] <= setup.triggerLow;
        if (longHit && shortHit) continue;
        const direction = longHit ? 1 : shortHit ? -1 : 0;
        if (!direction) continue;
        if (!htfAllows(bias, direction, htfMode)) continue;
        let entryRaw;
        if (entryMode === 'close') {
            const beyond = direction > 0 ? bars.close[i] > setup.triggerHigh : bars.close[i] < setup.triggerLow;
            if (!beyond) continue;
            entryRaw = bars.close[i];
        } else entryRaw = direction > 0 ? Math.max(bars.open[i], setup.triggerHigh) : Math.min(bars.open[i], setup.triggerLow);
        const stopRaw = direction > 0 ? setup.stopLong : setup.stopShort;
        const risk = Math.abs(entryRaw - stopRaw);
        if (!(risk > 0) || !Number.isFinite(risk)) continue;
        const entryCost = bars.spreadPrice / 2 + entryRaw * friction;
        const entryNet = direction > 0 ? entryRaw + entryCost : entryRaw - entryCost;
        const targetRaw = targetMode === '2r' ? entryRaw + direction * 2 * risk : structuralTarget(bars, s, direction, entryRaw, risk, lookback);
        const carryAnnual = rateContext ? rateContext.carryAnnual(dateOf(bars, i)) : null;
        position = { setup: setup.name, direction, entryIndex: i, entryRaw, entryNet, stopRaw, targetRaw, risk, htf: bias, carryAnnual };
    }
    if (position) { const last = end - 1; close(bars.close[last], 'eod', last); position = null; }
    return { trades, stats: summarize(trades, Math.max(1, end - start), barsPerYear, riskFraction), ratesUsed: Boolean(rateContext) };
}

