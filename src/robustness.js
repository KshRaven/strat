// Trade bootstrap and deflated Sharpe for the frozen default rule,
// using the pre-specified variants as the multiple-testing trials.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tradeBootstrap, deflatedSharpe, deflatedSharpeSeries, monthlyFromTrades, shSeries } from './stats.js';
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

function sd(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function tradeSharpe(trades) {
    const values = trades.map(trade => trade.netR);
    const s = sd(values);
    return s > 0 ? (mean(values) / s) * Math.sqrt(values.length) : 0;
}

const args = parseArgs(process.argv.slice(2));
const data = String(args.data ?? 'data/Y_EURUSD_D1.json');
const tf = String(args.tf ?? 'D1');
const variants = String(args.variants ?? 'default,all,reversal,2r,close').split(',').map(v => v.trim());
const startDate = String(args['start-date'] ?? '');
const endDate = String(args['end-date'] ?? '');
const setups = String(args.setups ?? '2-1,3-1,1-2,2-2,3-2');
const commissionBp = String(args['commission-bp'] ?? '0.5');
const slippageBp = String(args['slippage-bp'] ?? '0.5');
const labelBase = String(args.label ?? 'rb').replace(/[^a-zA-Z0-9_-]/g, '_');
const summaryFile = labelBase === 'rb' ? 'robustness_summary.json' : `${labelBase}_summary.json`;

const extra = {
    default: [],
    all: ['--htf', 'all'],
    reversal: ['--htf', 'reversal'],
    '2r': ['--target', '2r'],
    close: ['--entry', 'close']
};

const csvSymbol = String(args.symbol ?? data.split(/[\\\\/]/).pop().replace(/\.[^.]+$/, '').replace(/^Y_/, '').slice(0, 6));
const pointArg = args.point !== undefined ? String(args.point) : (csvSymbol.toUpperCase().includes('JPY') ? '0.001' : '0.00001');
const csvArgs = data.toLowerCase().endsWith('.csv')
    ? ['--symbol', csvSymbol, '--spread-points', String(args['spread-points'] ?? 10), '--point', pointArg]
    : [];
const runs = {};
let progressDone = 0;
reportProgress(0, variants.length, 'robustness');
for (const variant of variants) {
    const label = `${labelBase}_${variant}`;
    const command = ['bun', 'run', 'src/backtest.js', '--data', data, ...csvArgs, '--tf', tf, '--label', label,
        '--setups', setups, '--commission-bp', commissionBp, '--slippage-bp', slippageBp,
        ...(startDate ? ['--start-date', startDate] : []), ...(endDate ? ['--end-date', endDate] : []), ...(extra[variant] ?? [])];
    const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
        console.error(`${variant} failed: ${result.stderr.toString().split('\n')[0]}`);
        reportProgress(++progressDone, variants.length, variant);
        continue;
    }
    runs[variant] = JSON.parse(readFileSync(join(RESULTS, `${label}.json`), 'utf8')).trades;
    reportProgress(++progressDone, variants.length, variant);
}

if (!runs.default) {
    console.error('Default run missing');
    process.exit(1);
}

const trialSharpes = Object.values(runs).map(tradeSharpe);
const boot = tradeBootstrap(runs.default);
const dsr = deflatedSharpe(runs.default, trialSharpes);

console.log(`Robustness: ${data}`);
console.log(`Trades: ${runs.default.length}, variants used as trials: ${Object.keys(runs).join(', ')}`);
if (boot) {
    console.log(`Trade bootstrap (5000): mean netR 5-95% [${boot.mean05.toFixed(3)}, ${boot.mean95.toFixed(3)}], ` +
        `PF [${Number.isFinite(boot.pf05) ? boot.pf05.toFixed(2) : 'inf'}, ${Number.isFinite(boot.pf95) ? boot.pf95.toFixed(2) : 'inf'}], ` +
        `Sharpe [${boot.sharpe05.toFixed(2)}, ${boot.sharpe95.toFixed(2)}]`);
}
const monthlyRuns = Object.fromEntries(Object.entries(runs).map(([key, trades]) => [key, monthlyFromTrades(trades)]));
const useMonthly = Object.values(monthlyRuns).every(values => values !== null && values.length >= 24);
let monthlyDsr = null;

if (useMonthly) {
    const trialMonthly = Object.values(monthlyRuns).map(shSeries);
    monthlyDsr = deflatedSharpeSeries(monthlyRuns.default, trialMonthly);
    console.log(`Monthly Sharpe ${monthlyDsr.sr.toFixed(3)}, expected max under null ${monthlyDsr.sr0.toFixed(3)}, N=${monthlyDsr.N}, T=${monthlyDsr.T}`);
    console.log(`Deflated Sharpe (monthly) probability: ${monthlyDsr.dsr.toFixed(3)}`);
    console.log(`Verdict (monthly DSR): ${monthlyDsr.dsr >= 0.95 ? 'PASS (0.95)' : 'FAIL (needs >= 0.95)'}`);
} else {
    console.log('Monthly dates unavailable; using trade-level DSR fallback.');
    console.log(`Trade Sharpe ${dsr.sr.toFixed(3)}, expected max under null ${dsr.sr0.toFixed(3)}, N=${dsr.N}, T=${dsr.T}`);
    console.log(`Deflated Sharpe (trade) probability: ${dsr.dsr.toFixed(3)}`);
    console.log(`Verdict (trade DSR): ${dsr.dsr >= 0.95 ? 'PASS (0.95)' : 'FAIL (needs >= 0.95)'}`);
}

await Bun.write(join(RESULTS, summaryFile), JSON.stringify({
    data, tf, variants, trialSharpes, bootstrap: boot, tradeDsr: dsr, monthlyDsr,
    startDate: startDate || null, endDate: endDate || null
}, null, 2));
