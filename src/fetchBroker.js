// Downloads a broker-style D1 feed from Dukascopy into data/broker/<PAIR>.csv.
// Dukascopy timestamps are Unix milliseconds, so date-based walk-forward works.

import { getHistoricalRates } from 'dukascopy-node';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { reportProgress } from './progress.js';

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'data', 'broker');
const DEFAULT_PAIRS = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP',
    'EURJPY', 'GBPJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'AUDJPY', 'CADJPY', 'CHFJPY'
];

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        if (key === 'force') { options.force = true; continue; }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) { options[key] = true; continue; }
        options[key] = value;
        i++;
    }
    return options;
}

const args = parseArgs(process.argv.slice(2));
const pairs = String(args.pairs ?? DEFAULT_PAIRS.join(',')).split(',').map(value => value.trim().toUpperCase());
const from = new Date(String(args.from ?? '2008-01-01'));
// Live by default: the end date is tomorrow (UTC), so every run pulls up to the latest completed bar.
const tomorrow = new Date(Date.now() + 86400000);
const to = new Date(String(args.to ?? tomorrow.toISOString().slice(0, 10)));
// --update: only download from the last bar already on disk (fast daily refresh, keeps history)
const update = Boolean(args.update);

await mkdir(OUT, { recursive: true });

reportProgress(0, pairs.length, 'data sync');
for (const [pairIndex, pair] of pairs.entries()) {
    reportProgress(pairIndex, pairs.length, `fetching ${pair}`);
    const path = join(OUT, `${pair}.csv`);
    if (existsSync(path) && !args.force && !update) {
        console.log(`${pair.padEnd(7)} exists (use --update for new bars, --force to redownload)`);
        reportProgress(pairIndex + 1, pairs.length, `data ${pair}`);
        continue;
    }
    try {
        // Existing rows are kept when updating; only the tail is re-requested (3 days back to heal the last bar)
        const existing = new Map();
        let start = from;
        if (update && existsSync(path)) {
            const old = (await Bun.file(path).text()).trim().split(/\r?\n/).slice(1);
            for (const line of old) {
                const c = line.split(',');
                if (c.length >= 5) existing.set(c[0], { open: c[1], high: c[2], low: c[3], close: c[4] });
            }
            const last = [...existing.keys()].sort().pop();
            if (last) start = new Date(Date.parse(`${last}T00:00:00Z`) - 3 * 86400000);
        }
        const data = await getHistoricalRates({
            instrument: pair.toLowerCase(),
            dates: { from: start, to },
            timeframe: 'd1',
            format: 'json',
            priceType: 'bid'
        });
        const byDate = new Map(existing);
        for (const bar of data) {
            const date = new Date(bar.timestamp).toISOString().slice(0, 10);
            byDate.set(date, { open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        }
        const rows = ['date,open,high,low,close'];
        for (const [date, bar] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            rows.push([date, bar.open, bar.high, bar.low, bar.close].join(','));
        }
        await Bun.write(path, rows.join('\n') + '\n');
        console.log(`${pair.padEnd(7)} ${String(rows.length - 1).padStart(5)} bars ${rows[1].slice(0, 10)} .. ${rows[rows.length - 1].slice(0, 10)}`);
    } catch (error) {
        console.error(`${pair.padEnd(7)} FAILED: ${error.message}`);
    }
    reportProgress(pairIndex + 1, pairs.length, `data ${pair}`);
    await Bun.sleep(250);
}
