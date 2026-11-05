// Browser-safe counterpart of src/data.js (the original needs Bun/node APIs).
// Rule logic is imported from ../strat.js and ../stats.js unchanged.

// ---- data.js (loadBars + loadCsv) from text instead of a file path ----
export function parseCsv(text, { symbol, spread = 10, point = null } = {}) {
    const lines = text.trim().split(/\r?\n/);
    const header = lines[0].split(',').map(v => v.trim().toLowerCase());
    const index = {};
    for (const key of ['date', 'time', 'datetime', 'open', 'high', 'low', 'close']) {
        const at = header.indexOf(key);
        if (at !== -1) index[key] = at;
    }
    const di = index.date ?? index.time ?? index.datetime;
    if (di === undefined || ['open', 'high', 'low', 'close'].some(k => index[k] === undefined)) {
        throw new Error('CSV needs a header row with: date/time, open, high, low, close');
    }
    const time = [], open = [], high = [], low = [], close = [];
    for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const c = line.split(',');
        const parsed = Date.parse(c[di]);
        if (!Number.isFinite(parsed)) continue;
        const o = Number(c[index.open]), h = Number(c[index.high]), l = Number(c[index.low]), cl = Number(c[index.close]);
        if (![o, h, l, cl].every(Number.isFinite)) continue;
        time.push(Math.floor(parsed / 1000)); open.push(o); high.push(h); low.push(l); close.push(cl);
    }
    if (time.length < 100) throw new Error('CSV has too few valid bars');
    const sym = String(symbol).toUpperCase();
    const pt = point ?? (sym.includes('JPY') ? 0.001 : 0.00001);
    return { symbol: sym, spread, point: pt, time, open, high, low, close, n: close.length, timeframe: 'D1', spreadPrice: spread * pt };
}

