import { join } from 'node:path';
import { loadBars, timeframeDefaults } from './data.js';
import { classifyCandles, setupAt, htfBias, htfAllows, structuralTarget } from './strat.js';
import { summarize } from './stats.js';
import { loadRateContext } from './carry.js';
import { reportProgress } from './progress.js';

const ROOT = join(import.meta.dir, '..');
const RESULTS = join(ROOT, 'results');

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        if (key === 'no-save') { options[key] = true; continue; }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) { options[key] = true; continue; }
        options[key] = value;
        i++;
    }
    return options;
}

function checkExit(position, bars, j, config, isEntryBar) {
    const direction = position.direction;
    const open = bars.open[j];
    const high = bars.high[j];
    const low = bars.low[j];
    const close = bars.close[j];
    const stop = position.stopRaw;
    const target = position.targetRaw;

    if (direction > 0) {
        if (!isEntryBar && open <= stop) return { price: open, reason: 'stop' };
        if (low <= stop) return { price: stop, reason: 'stop' };
        if (!isEntryBar && open >= target) return { price: open, reason: 'target' };
        if (high >= target) return { price: target, reason: 'target' };
    } else {
        if (!isEntryBar && open >= stop) return { price: open, reason: 'stop' };
        if (high >= stop) return { price: stop, reason: 'stop' };
        if (!isEntryBar && open <= target) return { price: open, reason: 'target' };
        if (low <= target) return { price: target, reason: 'target' };
    }

    const barsHeld = j - position.entryIndex + 1;
    if (barsHeld >= config.maxHold) return { price: close, reason: 'time' };
    return null;
}

function dateOf(bars, index) {
    if (Array.isArray(bars.time) && Number.isFinite(bars.time[index]) && bars.time[index] > 315532800) {
        return new Date(bars.time[index] * 1000).toISOString().slice(0, 10);
    }
    return String(index);
}

function format(value, digits = 2) {
    if (value === Infinity) return 'inf';
    if (!Number.isFinite(value)) return 'n/a';
    return value.toFixed(digits);
}

const args = parseArgs(process.argv.slice(2));
const requestedTf = args.tf ? String(args.tf).toUpperCase() : null;
const dataPath = String(args.data ?? join(ROOT, 'data', requestedTf ? `EURUSD_${requestedTf}.json` : 'EURUSD_H1.json'));
const bars = await loadBars(dataPath, {
    symbol: args.symbol ?? null,
    spread: Number(args['spread-points'] ?? 0),
    point: Number(args.point ?? 0.00001)
});
const tf = String(requestedTf ?? bars.timeframe).toUpperCase();
const defaults = timeframeDefaults(tf);

const setups = new Set(String(args.setups ?? '2-1,3-1,1-2,2-2,3-2').split(',').map(value => value.trim()));
const htfMode = String(args.htf ?? 'continuity').toLowerCase();
const entryMode = String(args.entry ?? 'intrabar').toLowerCase();
const targetMode = String(args.target ?? 'structural').toLowerCase();
const blocks = args.blocks
    ? String(args.blocks).split(',').map(Number)
    : defaults.blocks;
const maxHold = Number(args['max-hold'] ?? defaults.maxHold);
const lookback = Number(args.lookback ?? 20);
const riskFraction = Number(args.risk ?? 0.01);
const commissionBp = Number(args['commission-bp'] ?? 0.5);
const slippageBp = Number(args['slippage-bp'] ?? 0.5);
const frictionBp = Number(args['friction-bp'] ?? (commissionBp + slippageBp));
const barsPerYear = Number(args['bars-per-year'] ?? defaults.barsPerYear);
const fractionStart = Number(args.start ?? 0);
const fractionEnd = Number(args.end ?? 1);
const swapMode = String(args['swap-mode'] ?? 'rates').toLowerCase();
const swapSpreadBp = Number(args['swap-spread-bp'] ?? 0.2);
const flatSwapBp = Number(args['flat-swap-bp'] ?? 0.2);
const barsPerDay = tf === 'H1' ? 24 : tf === 'H4' ? 6 : 1;

const friction = frictionBp / 10000;
const types = classifyCandles(bars);
const timeValid = Array.isArray(bars.time) && bars.time.length > 0 && bars.time[2] > 315532800;
const useCalendar = tf === 'D1' && timeValid;
let rateContext = swapMode === 'rates' ? await loadRateContext(bars.symbol) : null;
const ratesUsable = Boolean(rateContext && timeValid);
if (swapMode === 'rates' && !ratesUsable) {
    console.log('Rate carry unavailable for this feed; using flat swap cost.');
    rateContext = null;
}

let start = Math.max(2, Math.floor(bars.n * fractionStart));
let end = Math.min(bars.n, Math.floor(bars.n * fractionEnd));
if (args['start-date'] || args['end-date']) {
    if (!timeValid) throw new Error('Date filters require valid Unix timestamps in the data');
    const seconds = value => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
    const findFirst = target => {
        let low = 0;
        let high = bars.n;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (bars.time[mid] < target) low = mid + 1;
            else high = mid;
        }
        return low;
    };
    const findLast = target => {
        let low = 0;
        let high = bars.n;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (bars.time[mid] <= target) low = mid + 1;
            else high = mid;
        }
        return low;
    };
    if (args['start-date']) start = Math.max(start, findFirst(seconds(args['start-date'])));
    if (args['end-date']) end = Math.min(end, findLast(seconds(args['end-date'])));
}
if (end <= start + 2) throw new Error('Empty backtest window');

const trades = [];
let position = null;
const progressTotal = Math.max(0, end - start);
const progressEvery = Math.max(1, Math.floor(progressTotal / 100));
reportProgress(0, progressTotal, 'backtest');

function closeTrade(exitPrice, reason, exitIndex) {
    const direction = position.direction;
    const barsHeld = exitIndex - position.entryIndex + 1;
    const daysHeld = barsHeld / barsPerDay;
    const exitCost = bars.spreadPrice / 2 + exitPrice * friction;
    const exitNet = direction > 0 ? exitPrice - exitCost : exitPrice + exitCost;

    const grossPrice = direction * (exitPrice - position.entryRaw);
    const useRateCarry = swapMode !== 'none' && rateContext !== null && position.carryAnnual !== null;
    const carryPrice = useRateCarry
        ? direction * position.entryRaw * position.carryAnnual * barsHeld / barsPerYear
        : 0;
    const swapBp = swapMode === 'none' ? 0 : (useRateCarry ? swapSpreadBp : flatSwapBp);
    const swapPrice = swapMode === 'none' ? 0 : position.entryRaw * (swapBp / 10000) * daysHeld;

    const netPrice = direction * (exitNet - position.entryNet) + carryPrice - swapPrice;
    const grossR = grossPrice / position.risk;
    const netR = netPrice / position.risk;

    trades.push({
        setup: position.setup,
        direction,
        entryIndex: position.entryIndex,
        exitIndex,
        entryDate: dateOf(bars, position.entryIndex),
        exitDate: dateOf(bars, exitIndex),
        entry: position.entryRaw,
        exit: exitPrice,
        stop: position.stopRaw,
        target: position.targetRaw,
        risk: position.risk,
        grossR,
        netR,
        costR: grossR - netR,
        carryR: carryPrice / position.risk,
        swapR: swapPrice / position.risk,
        barsHeld,
        reason,
        htf: position.htf
    });
}

for (let i = start; i < end; i++) {
    if ((i - start) % progressEvery === 0) reportProgress(i - start, progressTotal, 'backtest');
    if (position) {
        const exit = checkExit(position, bars, i, { maxHold }, false);
        if (exit) {
            closeTrade(exit.price, exit.reason, i);
            position = null;
        }
        continue;
    }

    const s = i - 1;
    if (s < 2) continue;
    const setup = setupAt(types, bars, s);
    if (!setup || !setups.has(setup.name)) continue;

    const bias = htfBias(bars, s, blocks, useCalendar);
    const longHit = bars.high[i] >= setup.triggerHigh;
    const shortHit = bars.low[i] <= setup.triggerLow;
    if (longHit && shortHit) continue; // ambiguous intrabar path

    const direction = longHit ? 1 : shortHit ? -1 : 0;
    if (!direction) continue;
    if (!htfAllows(bias, direction, htfMode)) continue;

    let entryRaw;
    if (entryMode === 'close') {
        const beyond = direction > 0 ? bars.close[i] > setup.triggerHigh : bars.close[i] < setup.triggerLow;
        if (!beyond) continue;
        entryRaw = bars.close[i];
    } else {
        entryRaw = direction > 0 ? Math.max(bars.open[i], setup.triggerHigh) : Math.min(bars.open[i], setup.triggerLow);
    }

    const stopRaw = direction > 0 ? setup.stopLong : setup.stopShort;
    const risk = Math.abs(entryRaw - stopRaw);
    if (!(risk > 0) || !Number.isFinite(risk)) continue;

    const entryCost = bars.spreadPrice / 2 + entryRaw * friction;
    const entryNet = direction > 0 ? entryRaw + entryCost : entryRaw - entryCost;
    const targetRaw = targetMode === '2r'
        ? entryRaw + direction * 2 * risk
        : structuralTarget(bars, s, direction, entryRaw, risk, lookback);

    const carryAnnual = ratesUsable ? rateContext.carryAnnual(dateOf(bars, i)) : null;
    position = {
        setup: setup.name,
        direction,
        entryIndex: i,
        entryRaw,
        entryNet,
        stopRaw,
        targetRaw,
        risk,
        htf: bias,
        carryAnnual
    };

    // Intrabar entries are managed from the next bar. We cannot know whether
    // the entry bar's target print happened before or after the trigger.
}
reportProgress(progressTotal, progressTotal, 'backtest');

if (position) {
    const last = end - 1;
    closeTrade(bars.close[last], 'eod', last);
    position = null;
}

const stats = summarize(trades, Math.max(1, end - start), barsPerYear, riskFraction);

console.log(`The Strat mechanical backtest`);
console.log(`Data: ${dataPath}`);
console.log(`TF: ${tf}, bars: ${bars.n}, blocks: ${blocks.join('/')}, maxHold: ${maxHold}`);
console.log(`Setups: ${[...setups].join(',')}, HTF: ${htfMode}, entry: ${entryMode}, target: ${targetMode}`);
console.log(`Spread: ${(bars.spreadPrice * 1e4).toFixed(2)}bps price, commission: ${commissionBp}bps, slippage: ${slippageBp}bps/side`);
console.log(`Swap: ${swapMode}${swapMode === 'rates' && !ratesUsable ? ' (rates unavailable, flat fallback)' : ''}, spread: ${swapSpreadBp}bps/day, flat: ${flatSwapBp}bps/day, risk: ${(riskFraction * 100).toFixed(1)}%\n`);
console.log(`Trades ${stats.trades}, win ${format(stats.winRate * 100, 1)}%, long/short ${stats.longs}/${stats.shorts}`);
console.log(`Avg gross ${format(stats.avgGrossR, 2)}R, avg net ${format(stats.avgNetR, 2)}R, cost ${format(stats.costR, 2)}R, PF ${format(stats.profitFactor)}`);
console.log(`CAGR ${format(stats.cagr * 100, 1)}%, maxDD ${format(stats.maxDrawdown * 100, 1)}%, Sharpe ${format(stats.sharpe)}, trades/yr ${format(stats.tradesPerYear, 1)}`);
console.log(`Exposure ${format(stats.exposure * 100, 1)}%, avg bars held ${format(stats.avgBarsHeld, 1)}, exits ${JSON.stringify(stats.exits)}`);

const label = String(args.label ?? `${bars.symbol}_${tf}_${htfMode}_${entryMode}_${targetMode}`);
if (!args['no-save']) {
    const output = {
        data: dataPath,
        timeframe: tf,
        bars: bars.n,
        config: { setups: [...setups], htfMode, entryMode, targetMode, blocks, maxHold, lookback, riskFraction, commissionBp, slippageBp, frictionBp, swapMode, swapSpreadBp, flatSwapBp, barsPerYear },
        stats,
        trades
    };
    await Bun.write(join(RESULTS, `${label}.json`), JSON.stringify(output, null, 2));

    const header = 'entryIndex,exitIndex,entryDate,exitDate,setup,direction,entry,exit,stop,target,risk,grossR,netR,costR,carryR,swapR,barsHeld,reason,htf';
    const rows = trades.map(trade => [
        trade.entryIndex, trade.exitIndex, trade.entryDate, trade.exitDate, trade.setup,
        trade.direction, trade.entry, trade.exit, trade.stop, trade.target, trade.risk,
        trade.grossR, trade.netR, trade.costR, trade.carryR, trade.swapR, trade.barsHeld, trade.reason, trade.htf.join('/')
    ].join(','));
    await Bun.write(join(RESULTS, `${label}_trades.csv`), [header, ...rows].join('\n'));
    console.log(`\nWrote results/${label}.json and _trades.csv`);
}
