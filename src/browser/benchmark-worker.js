import { generateSample, runScenario } from "./benchmark.js";

self.onmessage = ({ data }) => {
  const { gen, cost, ctx, useSample, pairs, loaded } = data;
  const cache = new Map();
  const rows = [];

  try {
    for (const gp of gen) for (const cp of cost) {
      let bars = loaded;
      if (useSample) {
        const key = JSON.stringify(gp);
        if (!cache.has(key)) {
          cache.set(key, generateSample({ pairs, startDate: "2008-01-01", endDate: ctx.endDate, ...gp }));
        }
        bars = cache.get(key);
      }

      rows.push(runScenario(bars, { ...gp, ...cp }, ctx).rows);
      self.postMessage({ type: "progress", completed: rows.length });
    }
    self.postMessage({ type: "complete", rows });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
