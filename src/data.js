import { basename } from 'node:path';

export async function loadBars(path, options = {}) {
    const data = path.toLowerCase().endsWith('.csv')
        ? await loadCsv(path, options)
        : await Bun.file(path).json();
    const n = data.close.length;
    for (const key of ['open', 'high', 'low', 'close']) {
        if (!Array.isArray(data[key]) || data[key].length !== n) {
            throw new Error(`Invalid ${key} array in ${path}`);
        }
    }
    return {
        ...data,
        path,
        n,
        symbol: data.symbol ?? basename(path).replace(/\.[^.]+$/, ''),
        timeframe: inferTimeframe(path),
        spreadPrice: (data.spread ?? 0) * (data.point ?? 0.00001)
    };
}

async function loadCsv(path, { symbol = null, spread = 0, point = 0.00001 } = {}) {
    const text = await Bun.file(path).text();
    const lines = text.trim().split(/\r?\n/);
    const header = lines[0].split(',').map(value => value.trim().toLowerCase());
    const index = {};
    for (const key of ['date', 'time', 'datetime', 'open', 'high', 'low', 'close']) {
        const at = header.indexOf(key);
        if (at !== -1) index[key] = at;
    }
    const dateIndex = index.date ?? index.time ?? index.datetime;
    if (dateIndex === undefined || ['open', 'high', 'low', 'close'].some(key => index[key] === undefined)) {
        throw new Error('CSV needs columns: date/time, open, high, low, close');
    }

    const time = [];
    const open = [];
    const high = [];
    const low = [];
    const close = [];
    for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cells = line.split(',');
        const parsed = Date.parse(cells[dateIndex]);
        if (!Number.isFinite(parsed)) continue;
        const o = Number(cells[index.open]);
        const h = Number(cells[index.high]);
        const l = Number(cells[index.low]);
        const c = Number(cells[index.close]);
        if (![o, h, l, c].every(Number.isFinite)) continue;
        time.push(Math.floor(parsed / 1000));
        open.push(o);
        high.push(h);
        low.push(l);
        close.push(c);
    }
    if (time.length < 100) throw new Error('CSV has too few valid bars');
    return { symbol, spread, point, time, open, high, low, close, volume: time.map(() => 0) };
}

export function inferTimeframe(path) {
    if (/_H1\.json$/i.test(path)) return 'H1';
    if (/_H4\.json$/i.test(path)) return 'H4';
    if (/_D1\.json$/i.test(path)) return 'D1';
    return 'D1';
}

export function timeframeDefaults(timeframe) {
    if (timeframe === 'H1') return { blocks: [4, 24], maxHold: 24, barsPerYear: 6048 };
    if (timeframe === 'H4') return { blocks: [6, 30], maxHold: 12, barsPerYear: 1512 };
    return { blocks: [5, 21], maxHold: 10, barsPerYear: 252 };
}
