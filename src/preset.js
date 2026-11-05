// One-command presets so Windows users never have to type the long flag lists
// (no shell quoting or "\" line continuations involved).
//
//   bun run preset            -> list presets
//   bun run preset update     -> refresh data to the latest bar
//   bun run preset all        -> update data, then run every analysis below in order
//   bun run preset portfolio  -> a single step
//
// Extra flags are appended, e.g.:  bun run preset portfolio --start 2018-01-01
// Dates default to "today", so the window grows with live data. The start date and
// every rule setting stay at the frozen values documented in README.md / STRATEGY.md.

import { join } from 'node:path';

const PAIRS = 'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP,EURJPY,GBPJPY,EURCHF,EURAUD,EURCAD,AUDJPY,CADJPY,CHFJPY';
const today = new Date().toISOString().slice(0, 10);
const FILES = ['--data-dir', 'data/broker', '--template', '{pair}.csv'];
const WINDOW = ['--start', '2014-01-01', '--end', today];
const BOOK = ['--risk-per-trade', '0.0025', '--max-open-risk', '0.02', '--max-positions', '8'];

export const PRESETS = {
    update: { about: 'Download new daily bars for all 16 pairs (keeps old history)', script: 'fetch-broker', args: ['--update'] },
    refetch: { about: 'Redownload ALL history from scratch (slow)', script: 'fetch-broker', args: ['--force'] },
    backtest: { about: 'Single-pair D1 backtest on EURUSD (needs the update step first)', script: 'backtest', args: ['--data', 'data/broker/EURUSD.csv', '--tf', 'D1', '--symbol', 'EURUSD', '--spread-points', '10', '--point', '0.00001'] },
    walkforward: { about: '4-fold walk-forward on the 16-pair broker feed', script: 'walkforward', args: [...FILES, '--symbol-csv', '--pairs', PAIRS, '--folds', '4', ...WINDOW] },
    portfolio: { about: '16-pair portfolio with daily mark-to-market', script: 'portfolio', args: [...FILES, '--symbol-csv', '--pairs', PAIRS, ...WINDOW, ...BOOK] },
    'portfolio-robustness': { about: 'Portfolio variants + monthly deflated Sharpe', script: 'portfolio-robustness', args: [...FILES, ...WINDOW, ...BOOK] },
};
export const ALL_ORDER = ['update', 'walkforward', 'portfolio', 'portfolio-robustness'];

async function run(name, extra) {
    const p = PRESETS[name];
    const cmd = [process.execPath, 'run', p.script, ...p.args, ...extra];
    console.log(`\n=== ${name}: ${p.about}\n$ bun ${cmd.slice(1).join(' ')}\n`);
    const proc = Bun.spawn(cmd, { cwd: join(import.meta.dir, '..'), stdout: 'inherit', stderr: 'inherit' });
    return proc.exited;
}

// Only runs when called directly (the launcher imports PRESETS without triggering this)
if (import.meta.main) {
    const [name, ...extra] = process.argv.slice(2);
    if (!name || (name !== 'all' && !PRESETS[name])) {
        console.log('Presets:\n');
        for (const [k, v] of Object.entries(PRESETS)) console.log(`  ${k.padEnd(22)} ${v.about}`);
        console.log(`  ${'all'.padEnd(22)} ${ALL_ORDER.join(' -> ')}\n\nUsage: bun run preset <name> [extra flags]`);
        process.exit(name ? 1 : 0);
    }
    const steps = name === 'all' ? ALL_ORDER : [name];
    for (const step of steps) {
        const code = await run(step, name === 'all' ? [] : extra);
        if (code !== 0) { console.error(`\n"${step}" exited with code ${code}; stopping.`); process.exit(code); }
    }
    console.log('\nDone. Results are in the results/ folder.');
}
