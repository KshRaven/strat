// Browser-safe counterpart of src/carry.js (the original needs Bun/node APIs).
// Rule logic is imported from ../strat.js and ../stats.js unchanged.

export const RATE_SERIES = {
    USD: 'IR3TIB01USM156N', EUR: 'IR3TIB01EZM156N', GBP: 'IR3TIB01GBM156N', JPY: 'IR3TIB01JPM156N',
    AUD: 'IR3TIB01AUM156N', CAD: 'IR3TIB01CAM156N', CHF: 'IR3TIB01CHM156N', NZD: 'IR3TIB01NZM156N'
};

// ---- carry.js from already-loaded rate series: { USD: {dates, values}, ... } ----
export function makeCarry(symbol, series) {
    const clean = String(symbol ?? '').toUpperCase().replace(/^Y_/, '').replace(/[^A-Z]/g, '');
    if (clean.length < 6) return null;
    const base = series[clean.slice(0, 3)], quote = series[clean.slice(3, 6)];
    if (!base || !quote) return null;
    const rate = (s, d) => {
        const cutoff = `${d.slice(0, 7)}-01`;
        let lo = 0, hi = s.dates.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (s.dates[mid] < cutoff) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return best >= 0 ? s.values[best] / 100 : null;
    };
    return {
        carryAnnual(d) {
            const b = rate(base, d), q = rate(quote, d);
            return b === null || q === null ? null : b - q;
        }
    };
}

