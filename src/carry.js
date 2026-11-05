// Rate-based carry/financing for the Strat backtester.
// 3-month interbank rates are lagged by the previous month.

import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const RATE_DIR = join(ROOT, 'data', 'rates');

export const RATE_SERIES = {
    USD: 'IR3TIB01USM156N',
    EUR: 'IR3TIB01EZM156N',
    GBP: 'IR3TIB01GBM156N',
    JPY: 'IR3TIB01JPM156N',
    AUD: 'IR3TIB01AUM156N',
    CAD: 'IR3TIB01CAM156N',
    CHF: 'IR3TIB01CHM156N',
    NZD: 'IR3TIB01NZM156N'
};

function latestBefore(dates, values, cutoff) {
    let low = 0;
    let high = dates.length - 1;
    let best = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (dates[mid] < cutoff) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return best >= 0 ? values[best] : null;
}

export async function loadRateContext(symbol) {
    const clean = String(symbol ?? '').toUpperCase().replace(/^Y_/, '').replace(/[^A-Z]/g, '');
    if (clean.length < 6) return null;
    const base = clean.slice(0, 3);
    const quote = clean.slice(3, 6);
    if (!RATE_SERIES[base] || !RATE_SERIES[quote]) return null;

    const load = async currency => {
        try {
            return await Bun.file(join(RATE_DIR, `${RATE_SERIES[currency]}.json`)).json();
        } catch {
            return null;
        }
    };

    const baseSeries = await load(base);
    const quoteSeries = await load(quote);
    if (!baseSeries || !quoteSeries) return null;

    function rate(series, dateStr) {
        // Previous month only: latest observation before the first of this month.
        const cutoff = `${dateStr.slice(0, 7)}-01`;
        const value = latestBefore(series.dates, series.values, cutoff);
        return value === null ? null : value / 100;
    }

    return {
        base,
        quote,
        carryAnnual(dateStr) {
            const b = rate(baseSeries, dateStr);
            const q = rate(quoteSeries, dateStr);
            if (b === null || q === null) return null;
            return b - q;
        }
    };
}
