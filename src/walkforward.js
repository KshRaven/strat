// Date-fold walk-forward evaluation of the frozen Strat D1 rule.
// Each fold is evaluated independently on Yahoo D1 data with rate-based swap.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tradeBootstrap } from './stats.js';
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

function metrics(trades) {
    if (trades.length === 0) {
        return { trades: 0, winRate: 0, avgNetR: 0, pf: 0, sharpe: 0, maxDD: 0, pairsPositive: 0 };
    }
    const sorted = [...trades].sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate)));
    let equity = 1;
    let peak = 1;
    let maxDD = 0;
    let gains = 0;
    let losses = 0;
    let wins = 0;
    for (const trade of sorted) {
        equity *= 1 + 0.01 * trade.netR;
        peak = Math.max(peak, equity);
        maxDD = Math.min(maxDD, equity / peak - 1);
        if (trade.netR > 0) { wins++; gains += trade.netR; }
        else losses += Math.abs(trade.netR);
    }
    const values = trades.map(trade => trade.netR);
    const sd = Math.sqrt(variance(values));
    const byPair = new Map();
    for (const trade of trades) {
        const key = trade.pair;
        if (!byPair.has(key)) byPair.set(key, []);
        byPair.get(key).push(trade.netR);
    }
    const pairsPositive = [...byPair.values()].filter(values => mean(values) > 0).length;
    return {
        trades: trades.length,
        winRate: wins / trades.length,
        avgNetR: mean(values),
        pf: losses > 0 ? gains / losses : (gains > 0 ? Infinity : 0),
        sharpe: sd > 0 ? (mean(values) / sd) * Math.sqrt(trades.length) : 0,
        maxDD,
        pairsPositive,
        pairs: byPair.size
    };
}

function foldBounds(start, end, folds) {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    const span = endMs - startMs;
    const bounds = [];
    for (let i = 0; i < folds; i++) {
        const from = new Date(startMs + Math.round((span * i) / folds)).toISOString().slice(0, 10);
        const to = new Date(startMs + Math.round((span * (i + 1)) / folds) - 86400000).toISOString().slice(0, 10);
        bounds.push({ from, to });
    }
    return bounds;
}

const args = parseArgs(process.argv.slice(2));
const pairs = String(args.pairs ?? 'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP')
    .split(',').map(value => value.trim().toUpperCase());
const folds = Math.max(1, Number(args.folds ?? 4));
const start = String(args.start ?? '2014-01-01');
const end = String(args.end ?? '2026-10-30');
const bounds = foldBounds(start, end, folds);
const dataDir = String(args['data-dir'] ?? join(ROOT, 'data'));
const template = String(args.template ?? 'Y_{pair}_D1.json');
const csvSymbol = args['symbol-csv'] === true;
const spreadPoints = String(args['spread-points'] ?? 10);
const pointArg = args.point !== undefined ? String(args.point) : null;
const customLabel = args.label !== undefined;
const label = String(args.label ?? 'wf').replace(/[^a-zA-Z0-9_-]/g, '_');
const summaryFile = customLabel ? `${label}_summary.json` : 'walkforward_summary.json';

const allTrades = [];
const foldSummaries = [];
const progressTotal = pairs.length * folds;
let progressDone = 0;
reportProgress(0, progressTotal, 'walk-forward');
console.log(`Walk-forward: ${pairs.length} pairs, ${folds} date folds, ${start} .. ${end}`);
console.log('Costs: spread + 0.5bp commission + 0.5bp slippage/side + rate carry (0.2bp/day swap spread)\n');

for (let fold = 0; fold < folds; fold++) {
    const { from, to } = bounds[fold];
    const foldTrades = [];
    for (const pair of pairs) {
        const runLabel = `${label}_${pair}_${fold + 1}`;
        const dataFile = join(dataDir, template.replace('{pair}', pair));
        const csvArgs = csvSymbol || dataFile.toLowerCase().endsWith('.csv')
            ? ['--symbol', pair, '--spread-points', spreadPoints, '--point', pointArg ?? (pair.toUpperCase().includes('JPY') ? '0.001' : '0.00001')]
            : [];
        const command = [
            'bun', 'run', 'src/backtest.js',
            '--data', dataFile,
            ...csvArgs,
            '--tf', 'D1',
            '--start-date', from,
            '--end-date', to,
            '--label', runLabel,
            '--swap-mode', 'rates'
        ];
        const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
        if (result.exitCode !== 0) {
            console.error(`  ${pair} fold ${fold + 1} failed: ${result.stderr.toString().split('\n')[0]}`);
            continue;
        }
        try {
            const output = JSON.parse(readFileSync(join(RESULTS, `${runLabel}.json`), 'utf8'));
            for (const trade of output.trades) foldTrades.push({ ...trade, pair });
        } catch (error) {
            console.error(`  ${pair} fold ${fold + 1} result read failed: ${error.message}`);
        }
        reportProgress(++progressDone, progressTotal, `fold ${fold + 1}/${folds} ${pair}`);
    }
    const stats = metrics(foldTrades);
    const boot = tradeBootstrap(foldTrades);
    allTrades.push(...foldTrades);
    foldSummaries.push({ from, to, stats, bootstrap: boot });
    console.log(`Fold ${fold + 1} ${from}..${to}: trades ${stats.trades}, win ${(stats.winRate * 100).toFixed(1)}%, ` +
        `net ${stats.avgNetR.toFixed(3)}R, PF ${Number.isFinite(stats.pf) ? stats.pf.toFixed(2) : 'inf'}, ` +
        `Sharpe ${stats.sharpe.toFixed(2)}, maxDD ${(stats.maxDD * 100).toFixed(1)}%, pairs+ ${stats.pairsPositive}/${stats.pairs}` +
        (boot ? `, boot mean [${boot.mean05.toFixed(3)}, ${boot.mean95.toFixed(3)}]` : ''));
}

const overall = metrics(allTrades);
const boot = tradeBootstrap(allTrades);
console.log(`\nOverall: trades ${overall.trades}, win ${(overall.winRate * 100).toFixed(1)}%, ` +
    `net ${overall.avgNetR.toFixed(3)}R, PF ${Number.isFinite(overall.pf) ? overall.pf.toFixed(2) : 'inf'}, ` +
    `Sharpe ${overall.sharpe.toFixed(2)}, maxDD ${(overall.maxDD * 100).toFixed(1)}%`);
if (boot) {
    console.log(`Trade bootstrap (5000): mean netR 5-95% [${boot.mean05.toFixed(3)}, ${boot.mean95.toFixed(3)}], ` +
        `PF [${Number.isFinite(boot.pf05) ? boot.pf05.toFixed(2) : 'inf'}, ${Number.isFinite(boot.pf95) ? boot.pf95.toFixed(2) : 'inf'}], ` +
        `Sharpe [${boot.sharpe05.toFixed(2)}, ${boot.sharpe95.toFixed(2)}]`);
}
console.log('Note: this aggregates independent pair trades with 1% risk each; it is not a portfolio simulator.');

await Bun.write(join(RESULTS, summaryFile), JSON.stringify({
    pairs, folds, start, end, bounds,
    folds: foldSummaries,
    overall
}, null, 2));
