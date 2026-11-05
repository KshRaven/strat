// Monthly deflated Sharpe for the portfolio, using the pre-specified
// strategy variants as multiple-testing trials.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { deflatedSharpeSeries, shSeries } from './stats.js';
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

const args = parseArgs(process.argv.slice(2));
const variants = String(args.variants ?? 'default,all,reversal,2r,close').split(',').map(v => v.trim());
const dataDir = String(args['data-dir'] ?? 'data/broker');
const template = String(args.template ?? '{pair}.csv');
const pairs = String(args.pairs ?? 'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP,EURJPY,GBPJPY,EURCHF,EURAUD,EURCAD,AUDJPY,CADJPY,CHFJPY');
const start = String(args.start ?? '2014-01-01');
const end = String(args.end ?? '2026-10-29');
const risk = String(args['risk-per-trade'] ?? '0.0025');
const maxRisk = String(args['max-open-risk'] ?? '0.02');
const maxPositions = String(args['max-positions'] ?? '8');
const label = String(args.label ?? 'pf').replace(/[^a-zA-Z0-9_-]/g, '_');
const summaryFile = label === 'pf' ? 'portfolio_robustness.json' : `${label}_robustness.json`;

const extra = {
    default: [],
    all: ['--htf', 'all'],
    reversal: ['--htf', 'reversal'],
    '2r': ['--target', '2r'],
    close: ['--entry', 'close']
};

const monthly = {};
let progressDone = 0;
reportProgress(0, variants.length, 'portfolio robustness');
for (const variant of variants) {
    const tag = `${label}_${variant}`;
    const command = [
        'bun', 'run', 'src/portfolio.js',
        '--data-dir', dataDir,
        '--template', template,
        '--symbol-csv',
        '--pairs', pairs,
        '--start', start,
        '--end', end,
        '--risk-per-trade', risk,
        '--max-open-risk', maxRisk,
        '--max-positions', maxPositions,
        '--tag', tag,
        ...(extra[variant] ?? [])
    ];
    const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
        console.error(`${variant} failed: ${result.stderr.toString().split('\n')[0]}`);
        reportProgress(++progressDone, variants.length, variant);
        continue;
    }
    const output = JSON.parse(readFileSync(join(RESULTS, `portfolio_${tag}.json`), 'utf8'));
    monthly[variant] = output.monthlyReturns.map(row => row.value);
    console.log(`${variant.padEnd(9)} CAGR ${(output.metrics.cagr * 100).toFixed(2)}% Sharpe ${output.metrics.sharpe.toFixed(2)} maxDD ${(output.metrics.maxDD * 100).toFixed(2)}%`);
    reportProgress(++progressDone, variants.length, variant);
}

if (!monthly.default) {
    console.error('Default portfolio missing');
    process.exit(1);
}

const trialSharpes = Object.values(monthly).map(shSeries);
const dsr = deflatedSharpeSeries(monthly.default, trialSharpes);
console.log(`\nMonthly Sharpe ${dsr.sr.toFixed(3)}, expected max under null ${dsr.sr0.toFixed(3)}, N=${dsr.N}, T=${dsr.T}`);
console.log(`Deflated Sharpe (monthly): ${dsr.dsr.toFixed(3)}`);
console.log(`Verdict: ${dsr.dsr >= 0.95 ? 'PASS (0.95)' : 'FAIL (needs >= 0.95)'}`);

await Bun.write(join(RESULTS, summaryFile), JSON.stringify({
    variants, start, end, risk, maxRisk, maxPositions, trialSharpes, dsr
}, null, 2));
