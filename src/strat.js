// The Strat candle classification, setup labels, and HTF continuity.

export function classifyCandles(bars) {
    const types = new Array(bars.n);
    types[0] = null;
    for (let i = 1; i < bars.n; i++) {
        const high = bars.high[i];
        const low = bars.low[i];
        const prevHigh = bars.high[i - 1];
        const prevLow = bars.low[i - 1];

        if (high > prevHigh && low < prevLow) types[i] = '3';
        else if (high > prevHigh) types[i] = '2U';
        else if (low < prevLow) types[i] = '2D';
        else types[i] = '1';
    }
    return types;
}

/**
 * Setup bar s is the completed bar whose high/low is broken on the next bar.
 * The label describes the two-bar context.
 */
export function setupAt(types, bars, s) {
    if (s < 1) return null;
    const type = types[s];
    const prev = types[s - 1];
    let name = null;

    if (type === '1') {
        if (prev === '2U' || prev === '2D') name = '2-1';
        else if (prev === '3') name = '3-1';
        else name = '1-1';
    } else if (type === '2U' || type === '2D') {
        if (prev === '1') name = '1-2';
        else if (prev === '3') name = '3-2';
        else if (prev === '2U' || prev === '2D') name = '2-2';
    } else if (type === '3') {
        name = '3';
    }

    if (!name) return null;
    return {
        name,
        setupType: type,
        prevType: prev,
        triggerHigh: bars.high[s],
        triggerLow: bars.low[s],
        stopLong: bars.low[s],
        stopShort: bars.high[s]
    };
}

function directionOf(open, close) {
    if (!Number.isFinite(open) || !Number.isFinite(close)) return 0;
    return close > open ? 1 : close < open ? -1 : 0;
}

export function htfBias(bars, s, blocks, calendar = false) {
    if (calendar && Array.isArray(bars.time) && bars.time[s] > 1e9) {
        const date = new Date(bars.time[s] * 1000).toISOString().slice(0, 10);
        const day = new Date(`${date}T00:00:00Z`).getUTCDay();
        const monday = new Date(`${date}T00:00:00Z`);
        monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
        const weekStart = monday.toISOString().slice(0, 10);
        const month = date.slice(0, 7);

        let weekIndex = s;
        while (weekIndex > 0) {
            const previous = new Date(bars.time[weekIndex - 1] * 1000).toISOString().slice(0, 10);
            if (previous < weekStart) break;
            weekIndex--;
        }
        let monthIndex = s;
        while (monthIndex > 0) {
            const previous = new Date(bars.time[monthIndex - 1] * 1000).toISOString().slice(0, 10);
            if (previous.slice(0, 7) !== month) break;
            monthIndex--;
        }
        return [directionOf(bars.open[weekIndex], bars.close[s]), directionOf(bars.open[monthIndex], bars.close[s])];
    }

    return blocks.map(block => {
        const start = Math.floor(s / block) * block;
        return directionOf(bars.open[start], bars.close[s]);
    });
}

export function htfAllows(bias, direction, mode) {
    if (mode === 'all' || mode === 'none') return true;
    const [fast, slow] = bias;
    if (mode === 'continuity') {
        return direction > 0 ? (fast === 1 && slow === 1) : (fast === -1 && slow === -1);
    }
    if (mode === 'reversal') {
        return direction > 0 ? (fast === -1 && slow === -1) : (fast === 1 && slow === 1);
    }
    throw new Error(`Unknown HTF mode "${mode}"`);
}

export function structuralTarget(bars, s, direction, entry, risk, lookback) {
    let target = direction > 0 ? -Infinity : Infinity;
    const from = Math.max(0, s - lookback);
    for (let i = from; i < s; i++) {
        if (direction > 0) target = Math.max(target, bars.high[i]);
        else target = Math.min(target, bars.low[i]);
    }
    const usable = direction > 0 ? target > entry + 0.5 * risk : target < entry - 0.5 * risk;
    if (!Number.isFinite(target) || !usable) {
        return entry + direction * 2 * risk;
    }
    return target;
}
