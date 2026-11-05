// Multi-pair D1 portfolio for the frozen Strat rule.
// Runs the per-pair backtest, then combines overlapping trades with a
// portfolio risk budget and daily mark-to-market.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadBars } from './data.js';
import { reportProgress } from './progress.js';

const ROOT = join(import.meta.dir, '..');
const RESULTS = join(ROOT, 'results');

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) { options[key] = true; continue; }
        options[key] = value;
        i++;
    }
    return options;
}

function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function variance(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function dateIndexMap(dates) {
    const map = new Map();
    dates.forEach((date, index) => map.set(date, index));
    return map;
}

function alignCloses(bars, dates) {
    const map = new Map();
    for (let i = 0; i < bars.time.length; i++) {
        const date = new Date(bars.time[i] * 1000).toISOString().slice(0, 10);
        map.set(date, bars.close[i]);
    }
    const values = new Array(dates.length).fill(NaN);
    let last = NaN;
    for (let i = 0; i < dates.length; i++) {
        const value = map.get(dates[i]);
        if (Number.isFinite(value)) last = value;
        values[i] = last;
    }
    return values;
}

function portfolioMetrics(dailyReturns, dates, options) {
    const n = dailyReturns.length;
    if (n === 0) return { cagr: 0, vol: 0, sharpe: 0, maxDD: 0 };
    let equity = 1;
    let peak = 1;
    let maxDD = 0;
    for (const r of dailyReturns) {
        equity *= 1 + r;
        peak = Math.max(peak, equity);
        maxDD = Math.min(maxDD, equity / peak - 1);
    }
    const m = mean(dailyReturns);
    const sd = Math.sqrt(variance(dailyReturns));
    const years = n / 252;
    return {
        cagr: equity > 0 ? Math.pow(equity, 1 / years) - 1 : -1,
        vol: sd * Math.sqrt(252),
        sharpe: sd > 0 ? (m / sd) * Math.sqrt(252) : 0,
        maxDD,
        totalReturn: equity - 1
    };
}

function blockBootstrap(monthly, block = 6, draws = 5000) {
    const values = monthly.map(row => row.value);
    const T = values.length;
    if (T < 12) return null;
    let state = 123456789;
    const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const sharpes = [];
    const means = [];
    for (let d = 0; d < draws; d++) {
        const sample = [];
        while (sample.length < T) {
            const start = Math.floor(rand() * T);
            for (let i = 0; i < block && sample.length < T; i++) sample.push(values[(start + i) % T]);
        }
        const m = mean(sample);
        const s = Math.sqrt(variance(sample));
        sharpes.push(s > 0 ? (m / s) * Math.sqrt(12) : 0);
        means.push(m);
    }
    sharpes.sort((a, b) => a - b);
    means.sort((a, b) => a - b);
    const q = (array, p) => array[Math.min(array.length - 1, Math.floor(p * (array.length - 1)))];
    return { sharpe05: q(sharpes, 0.05), sharpe50: q(sharpes, 0.5), sharpe95: q(sharpes, 0.95), mean05: q(means, 0.05), mean95: q(means, 0.95) };
}

const args = parseArgs(process.argv.slice(2));
const pairs = String(args.pairs ?? 'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP,EURJPY,GBPJPY,EURCHF,EURAUD,EURCAD,AUDJPY,CADJPY,CHFJPY')
    .split(',').map(value => value.trim().toUpperCase());
const startDate = String(args.start ?? '2008-01-01');
const endDate = String(args.end ?? '2026-10-30');
const riskPerTrade = Number(args['risk-per-trade'] ?? 0.0025);
const maxOpenRisk = Number(args['max-open-risk'] ?? 0.02);
const maxPositions = Number(args['max-positions'] ?? 8);
const tag = String(args.tag ?? 'baseline');
const dataDir = String(args['data-dir'] ?? join(ROOT, 'data'));
const template = String(args.template ?? 'Y_{pair}_D1.json');
const symbolCsv = args['symbol-csv'] === true;
const spreadPoints = String(args['spread-points'] ?? 10);
const pointArg = args.point !== undefined ? String(args.point) : null;
const variantArgs = [];
for (const key of ['htf', 'target', 'entry', 'setups']) {
    if (args[key] !== undefined) variantArgs.push(`--${key}`, String(args[key]));
}

const pairTrades = new Map();
const pairBars = new Map();
const allDates = new Set();
const progressTotal = pairs.length + 100;
let progressDone = 0;
reportProgress(0, progressTotal, 'portfolio');

for (const pair of pairs) {
    const label = `${args.tag === undefined ? 'port' : tag}_${pair}`;
    const dataFile = join(dataDir, template.replace('{pair}', pair));
    const csvArgs = symbolCsv || dataFile.toLowerCase().endsWith('.csv')
        ? ['--symbol', pair, '--spread-points', spreadPoints, '--point', pointArg ?? (pair.toUpperCase().includes('JPY') ? '0.001' : '0.00001')]
        : [];
    const command = [
        'bun', 'run', 'src/backtest.js',
        '--data', dataFile,
        ...csvArgs,
        '--tf', 'D1',
        '--start-date', startDate,
        '--end-date', endDate,
        '--label', label,
        '--swap-mode', 'rates',
        ...variantArgs
    ];
    const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
        console.error(`${pair} failed: ${result.stderr.toString().split('\n')[0]}`);
        reportProgress(++progressDone, progressTotal, `backtest ${pair}`);
        continue;
    }
    const output = JSON.parse(readFileSync(join(RESULTS, `${label}.json`), 'utf8'));
    pairTrades.set(pair, output.trades);
    const bars = await loadBars(dataFile, {
        symbol: pair,
        spread: Number(spreadPoints),
        point: Number(pointArg ?? (pair.toUpperCase().includes('JPY') ? 0.001 : 0.00001))
    });
    pairBars.set(pair, bars);
    for (let i = 0; i < bars.time.length; i++) {
        const date = new Date(bars.time[i] * 1000).toISOString().slice(0, 10);
        if (date >= startDate && date <= endDate) allDates.add(date);
    }
    reportProgress(++progressDone, progressTotal, `backtest ${pair}`);
}

const dates = [...allDates].sort();
const dateIndex = dateIndexMap(dates);
const closes = {};
for (const [pair, bars] of pairBars) closes[pair] = alignCloses(bars, dates);

const entriesByDate = new Map();
const exitsByDate = new Map();
for (const [pair, trades] of pairTrades) {
    for (const trade of trades) {
        if (!dateIndex.has(trade.entryDate) || !dateIndex.has(trade.exitDate)) continue;
        if (!entriesByDate.has(trade.entryDate)) entriesByDate.set(trade.entryDate, []);
        entriesByDate.get(trade.entryDate).push({ ...trade, pair });
        if (!exitsByDate.has(trade.exitDate)) exitsByDate.set(trade.exitDate, []);
        exitsByDate.get(trade.exitDate).push({ ...trade, pair });
    }
}

let realized = 0;
let openRisk = 0;
const positions = [];
const totalUnrealized = () => positions.reduce((sum, position) => sum + position.unrealized, 0);
const dailyReturns = [];
const equityCurve = [];
const pairPnl = new Map();
const pairTradesCount = new Map();
const openCounts = [];
let maxConcurrentRisk = 0;
let maxConcurrentPositions = 0;
let maxOpenRiskRatio = 0;
let totalTrades = 0;

const progressEvery = Math.max(1, Math.floor(dates.length / 100));
for (let d = 0; d < dates.length; d++) {
    const date = dates[d];

    // Exits: realize the cumulative unrealized PnL plus the final leg.
    const exiting = exitsByDate.get(date) ?? [];
    for (const trade of exiting) {
        const index = positions.findIndex(position => position.pair === trade.pair && position.entryIndex === trade.entryIndex);
        if (index === -1) continue;
        const position = positions[index];
        position.unrealized += position.direction * position.size * (trade.exit - position.mark);
        realized += position.unrealized;
        realized -= 0.5 * position.costAmount;
        pairPnl.set(position.pair, (pairPnl.get(position.pair) ?? 0) + position.riskAmount * trade.netR);
        openRisk -= position.riskAmount;
        positions.splice(index, 1);
        totalTrades++;
    }

    // Mark remaining positions to the close (accumulate, do not reset).
    for (const position of positions) {
        const close = closes[position.pair][d];
        if (!Number.isFinite(close)) continue;
        position.unrealized += position.direction * position.size * (close - position.mark);
        position.mark = close;
    }

    // Entries (after exits and marking)
    const entries = (entriesByDate.get(date) ?? []).sort((a, b) => a.pair.localeCompare(b.pair));
    const newPositions = [];
    for (const trade of entries) {
        if (positions.length >= maxPositions) break;
        const currentEquity = 1 + realized + totalUnrealized();
        const remainingRisk = Math.max(0, maxOpenRisk * currentEquity - openRisk);
        const riskAmount = Math.min(riskPerTrade * currentEquity, remainingRisk);
        if (riskAmount <= 0.2 * riskPerTrade * currentEquity) continue;
        const size = riskAmount / trade.risk;
        const newPosition = {
            pair: trade.pair,
            direction: trade.direction,
            entryIndex: trade.entryIndex,
            entry: trade.entry,
            mark: trade.entry,
            size,
            riskAmount,
            costAmount: trade.costR * riskAmount,
            unrealized: 0,
            exitDate: trade.exitDate
        };
        positions.push(newPosition);
        newPositions.push(newPosition);
        openRisk += riskAmount;
        realized -= 0.5 * (trade.costR * riskAmount);
        pairTradesCount.set(trade.pair, (pairTradesCount.get(trade.pair) ?? 0) + 1);
    }

    // Mark new positions from entry to the close of the entry day.
    for (const position of newPositions) {
        const close = closes[position.pair][d];
        if (Number.isFinite(close)) {
            position.unrealized += position.direction * position.size * (close - position.mark);
            position.mark = close;
        }
    }

    const equity = 1 + realized + totalUnrealized();
    if (equity > 0) maxOpenRiskRatio = Math.max(maxOpenRiskRatio, openRisk / equity);
    equityCurve.push(equity);
    dailyReturns.push(d === 0 ? 0 : equity / equityCurve[d - 1] - 1);
    openCounts.push(positions.length);
    maxConcurrentRisk = Math.max(maxConcurrentRisk, openRisk);
    maxConcurrentPositions = Math.max(maxConcurrentPositions, positions.length);
    if ((d + 1) % progressEvery === 0 || d + 1 === dates.length) {
        const dailyProgress = Math.floor(((d + 1) / dates.length) * 100);
        reportProgress(pairs.length + dailyProgress, progressTotal, 'mark-to-market');
    }
}
reportProgress(progressTotal, progressTotal, 'portfolio complete');

const metrics = portfolioMetrics(dailyReturns, dates, {});
const monthly = new Map();
for (let i = 0; i < dates.length; i++) {
    const month = dates[i].slice(0, 7);
    if (!monthly.has(month)) monthly.set(month, []);
    monthly.get(month).push(dailyReturns[i]);
}
const monthlyReturns = [...monthly.entries()].map(([month, values]) => {
    let value = 1;
    for (const r of values) value *= 1 + r;
    return { month, value: value - 1 };
});
const boot = blockBootstrap(monthlyReturns);
const exposure = openCounts.filter(count => count > 0).length / openCounts.length;

console.log(`D1 portfolio: ${pairs.length} pairs, ${startDate} .. ${endDate}`);
console.log(`Risk/trade ${(riskPerTrade * 100).toFixed(2)}%, max open risk ${(maxOpenRisk * 100).toFixed(1)}%, max positions ${maxPositions}`);
console.log(`Trades ${totalTrades}, CAGR ${(metrics.cagr * 100).toFixed(2)}%, vol ${(metrics.vol * 100).toFixed(2)}%, Sharpe ${metrics.sharpe.toFixed(2)}, maxDD ${(metrics.maxDD * 100).toFixed(2)}%`);
console.log(`Exposure ${(exposure * 100).toFixed(1)}%, avg open ${mean(openCounts).toFixed(2)}, max open ${maxConcurrentPositions}, max open risk ${(maxOpenRiskRatio * 100).toFixed(2)}% of equity`);
if (boot) {
    console.log(`Monthly bootstrap: Sharpe 5-95% [${boot.sharpe05.toFixed(2)}, ${boot.sharpe95.toFixed(2)}], mean 5-95% [${(boot.mean05 * 100).toFixed(3)}%, ${(boot.mean95 * 100).toFixed(3)}%]`);
}
console.log('\nPer-pair contribution (netR * risk amount):');
for (const pair of pairs) {
    const pnl = pairPnl.get(pair) ?? 0;
    const count = pairTradesCount.get(pair) ?? 0;
    console.log(`  ${pair.padEnd(8)} trades ${String(count).padStart(4)} contribution ${(pnl * 100).toFixed(2)}%`);
}

const foldBounds = [
    { name: '2014-2016', from: '2014-01-01', to: '2016-12-31' },
    { name: '2017-2019', from: '2017-01-01', to: '2019-12-31' },
    { name: '2020-2022', from: '2020-01-01', to: '2022-12-31' },
    { name: '2023-2026', from: '2023-01-01', to: '2026-12-31' }
];
console.log('\nDate-fold portfolio slices:');
for (const fold of foldBounds) {
    const values = [];
    for (let i = 0; i < dates.length; i++) {
        if (dates[i] >= fold.from && dates[i] <= fold.to) values.push(dailyReturns[i]);
    }
    if (values.length === 0) continue;
    const slice = portfolioMetrics(values, dates, {});
    console.log(`  ${fold.name.padEnd(9)} days ${String(values.length).padStart(4)} CAGR ${(slice.cagr * 100).toFixed(2)}% Sharpe ${slice.sharpe.toFixed(2)} maxDD ${(slice.maxDD * 100).toFixed(2)}%`);
}

await Bun.write(join(RESULTS, `portfolio_${tag}.json`), JSON.stringify({
    pairs, startDate, endDate, riskPerTrade, maxOpenRisk, maxPositions,
    metrics, exposure, averageOpen: mean(openCounts), maxConcurrentRisk, maxOpenRiskRatio, maxConcurrentPositions,
    monthlyReturns, bootstrap: boot,
    pairPnl: Object.fromEntries(pairPnl),
    pairTrades: Object.fromEntries(pairTradesCount)
}, null, 2));
console.log(`\nWrote results/portfolio_${tag}.json`);
