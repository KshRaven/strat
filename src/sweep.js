// Runs the Strat backtest across a set of D1 files and variants.
// Prints a compact table; does not save per-run JSON.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { reportProgress } from './progress.js';

const ROOT = join(import.meta.dir, '..');
const DATA = join(ROOT, 'data');

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

function value(output, label) {
    for (const line of output.split('\n')) {
        if (line.startsWith(label)) return line.slice(label.length).trim();
    }
    return '-';
}

const args = parseArgs(process.argv.slice(2));
const variants = String(args.variants ?? 'default,all').split(',').map(v => v.trim());
const files = args.files
    ? String(args.files).split(',')
    : readdirSync(DATA).filter(name => /(_D1\.json)$/i.test(name)).sort();
const label = String(args.label ?? `sweep_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
const runs = [];

console.log('file                 variant  trades  win%   grossR  netR    PF     CAGR%   maxDD%  Sharpe');
const progressTotal = files.length * variants.length;
let progressDone = 0;
reportProgress(0, progressTotal, 'sweep');
for (const file of files) {
    for (const variant of variants) {
        const range = [];
        if (args.start !== undefined) range.push('--start', String(args.start));
        if (args.end !== undefined) range.push('--end', String(args.end));
        const extra = variant === 'all' ? ['--htf', 'all']
            : variant === '2r' ? ['--target', '2r']
            : variant === 'close' ? ['--entry', 'close']
            : variant === 'reversal' ? ['--htf', 'reversal']
            : [];
        const command = ['bun', 'run', 'src/backtest.js', '--data', `data/${file}`, '--tf', 'D1', '--no-save', ...range, ...extra];
        const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
        if (result.exitCode !== 0) {
            console.log(`${file.padEnd(20)} ${variant.padEnd(8)} FAILED`);
            runs.push({ file, variant, error: 'Backtest failed' });
            reportProgress(++progressDone, progressTotal, `${file} ${variant}`);
            continue;
        }
        const output = result.stdout.toString();
        const trades = value(output, 'Trades').split(',')[0].replace('Trades ', '').trim();
        const win = value(output, 'Trades').match(/win ([\d.]+)%/)?.[1] ?? '-';
        const gross = value(output, 'Avg gross').match(/^(-?[\d.]+)R/)?.[1] ?? '-';
        const net = value(output, 'Avg gross').match(/avg net (-?[\d.]+)R/i)?.[1] ?? '-';
        const pf = value(output, 'Avg gross').match(/PF ([\d.]+|inf)/i)?.[1] ?? '-';
        const cagr = value(output, 'CAGR').match(/^(-?[\d.]+)%/)?.[1] ?? '-';
        const dd = value(output, 'CAGR').match(/maxDD (-?[\d.]+)%/)?.[1] ?? '-';
        const sharpe = value(output, 'CAGR').match(/Sharpe (-?[\d.]+)/)?.[1] ?? '-';
        console.log(
            `${file.replace(/_D1\.json$/, '').padEnd(20)} ${variant.padEnd(8)} ` +
            `${trades.padStart(6)} ${win.padStart(6)} ${gross.padStart(7)} ${net.padStart(7)} ` +
            `${pf.padStart(6)} ${cagr.padStart(8)} ${dd.padStart(8)} ${sharpe.padStart(7)}`
        );
        runs.push({
            file, variant, trades: Number(trades), winRate: Number(win) / 100,
            grossR: Number(gross), netR: Number(net), profitFactor: pf === 'inf' ? Infinity : Number(pf),
            cagr: Number(cagr) / 100, maxDrawdown: Number(dd) / 100, sharpe: Number(sharpe)
        });
        reportProgress(++progressDone, progressTotal, `${file} ${variant}`);
    }
}
await Bun.write(join(ROOT, 'results', `${label}.json`), JSON.stringify({ type: 'sweep', runs, files, variants }, null, 2));
