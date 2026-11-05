// launcher.js — local control panel for strat-backtest (Windows / macOS / Linux)
// Run from the repo root:  bun start   (or double-click start.bat on Windows)
// Then open http://localhost:3000
//
// - "/"          control workspace (workspace.html): install, fetch live data, run any command, read results
// - "/benchmark" the in-browser benchmark page (index.html) with ./data/broker served live
// - Listens on 127.0.0.1 only, because it can start processes on your machine.
import { join, basename, resolve, sep } from "path";
import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { PRESETS, ALL_ORDER } from "./src/preset.js";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT) || 3000;
const SUPPORTED_PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP",
  "EURJPY", "GBPJPY", "EURCHF", "EURAUD", "EURCAD", "AUDJPY", "CADJPY", "CHFJPY",
];
const SCRIPTS = new Set([
  "fetch-broker", "backtest", "sweep", "walkforward",
  "robustness", "portfolio", "portfolio-robustness",
]);
// Folders the browser pages may read (module imports, CSV data, rates). Nothing else is served.
const STATIC_DIRS = ["src", "data/broker", "data/rates", "results"];
const STATIC_FILES = new Set(["index.html", "run.html", "workspace.html"]);

let current = null; // one job at a time

// Split an args string into an array (quotes respected, no shell involved)
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function listDir(dir, exts) {
  const p = join(ROOT, dir);
  if (!existsSync(p)) return [];
  return readdirSync(p)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => ({ name: f, size: statSync(join(p, f)).size, mtime: statSync(join(p, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

// Newest bar date in a broker CSV (last line), so the panel can show how fresh the data is
function lastBar(pair) {
  try {
    const f = join(ROOT, "data", "broker", pair + ".csv");
    if (!existsSync(f)) return null;
    const lines = readFileSync(f, "utf8").trim().split(/\r?\n/);
    return lines[lines.length - 1].split(",")[0];
  } catch { return null; }
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function thinSeries(points, limit = 600) {
  if (points.length <= limit) return points;
  const step = (points.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => points[Math.round(index * step)]);
}

function backtestCurves(output) {
  const equity = [];
  const drawdown = [];
  const riskFraction = output.config?.riskFraction ?? 0.01;
  let value = 1;
  let peak = 1;
  for (const trade of output.trades ?? []) {
    value *= 1 + riskFraction * trade.netR;
    peak = Math.max(peak, value);
    equity.push({ date: trade.exitDate, value });
    drawdown.push({ date: trade.exitDate, value: value / peak - 1 });
  }
  return { equityCurve: thinSeries(equity), drawdownCurve: thinSeries(drawdown) };
}

function resultSummary(file, output) {
  if (output.type === "benchmark-config") return {
    file, type: "benchmark-config", title: output.name, config: output.config, summary: output.summary, createdAt: output.createdAt
  };
  if (output.stats) return {
    file, type: "backtest", title: `Backtest · ${output.data?.split(/[\\/]/).pop() || output.timeframe}`,
    config: output.config, metrics: output.stats, meta: { timeframe: output.timeframe, bars: output.bars, data: output.data },
    ...backtestCurves(output), trades: output.trades?.slice(-100) ?? []
  };
  if (output.overall) return {
    file, type: "walkforward", title: "Walk-forward", metrics: output.overall,
    meta: { pairs: output.pairs, start: output.start, end: output.end }, folds: output.folds
  };
  if (output.metrics) return {
    file, type: "portfolio", title: "Portfolio", metrics: output.metrics,
    meta: { pairs: output.pairs, start: output.startDate, end: output.endDate, exposure: output.exposure },
    pairPnl: output.pairPnl, bootstrap: output.bootstrap
  };
  if (output.dsr) return {
    file, type: "portfolio-robustness", title: "Portfolio robustness", metrics: output.dsr,
    meta: { variants: output.variants, start: output.start, end: output.end, verdict: output.dsr.dsr >= 0.95 ? "PASS" : "FAIL" }
  };
  if (output.monthlyDsr || output.tradeDsr) return {
    file, type: "robustness", title: "Robustness", metrics: output.monthlyDsr ?? output.tradeDsr,
    meta: { data: output.data, timeframe: output.tf, variants: output.variants, bootstrap: output.bootstrap, verdict: (output.monthlyDsr ?? output.tradeDsr)?.dsr >= 0.95 ? "PASS" : "FAIL" }
  };
  if (output.runs) return { file, type: "sweep", title: "Parameter sweep", runs: output.runs, meta: output.meta };
  return { file, type: "result", title: file, metrics: output };
}

// Serve a file only if it sits inside one of the allowed folders (blocks ../ tricks)
function staticFile(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!rel) return null;
  const abs = resolve(ROOT, rel);
  const okFile = STATIC_FILES.has(rel);
  const okDir = STATIC_DIRS.some((d) => abs.startsWith(resolve(ROOT, d) + sep));
  if (!okFile && !okDir) return null;
  if (!abs.startsWith(ROOT)) return null;
  return Bun.file(abs);
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") return new Response(Bun.file(join(ROOT, "workspace.html")));
    if (url.pathname === "/benchmark") return new Response(Bun.file(join(ROOT, "index.html")));

    if (url.pathname === "/api/status") {
      const brokerFiles = listDir("data/broker", [".csv"]);
      const newest = brokerFiles.length ? lastBar("EURUSD") : null;
      return json({
        busy: !!current,
        installed: existsSync(join(ROOT, "node_modules")),
        brokerFiles: brokerFiles.length,
        pairFiles: [...new Set([...SUPPORTED_PAIRS, ...brokerFiles.map((file) => file.name.replace(/\.csv$/i, ""))])],
        latestBar: newest,
        results: listDir("results", [".json", ".csv"]).length,
        presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.about])),
        allOrder: ALL_ORDER,
      });
    }

    if (url.pathname === "/api/rates") {
      return json(listDir("data/rates", [".json"]).map((file) => file.name.replace(/\.json$/i, "")));
    }

    if (url.pathname === "/api/benchmarks" && req.method === "GET") {
      const files = listDir("results", [".json"]).filter((file) => file.name.startsWith("benchmark_config_"));
      return json(await Promise.all(files.map(async (file) => {
        try {
          const output = JSON.parse(await Bun.file(join(ROOT, "results", file.name)).text());
          return { file: file.name, name: output.name, createdAt: output.createdAt, config: output.config };
        } catch { return { file: file.name, name: file.name, createdAt: null, config: null }; }
      })));
    }

    if (url.pathname === "/api/benchmark/save" && req.method === "POST") {
      const { name, config, summary } = await req.json();
      const slug = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
      if (!slug || !config || typeof config !== "object") return json({ error: "A name and benchmark configuration are required." }, 400);
      const file = `benchmark_config_${slug}.json`;
      const path = join(ROOT, "results", file);
      await Bun.write(path, JSON.stringify({ type: "benchmark-config", name: slug, createdAt: new Date().toISOString(), config, summary }, null, 2));
      return json({ file, name: slug });
    }

    if (url.pathname === "/api/result-summary") {
      const file = basename(url.searchParams.get("file") ?? "");
      if (!file.endsWith(".json")) return json({ error: "Choose a JSON result file." }, 400);
      const path = join(ROOT, "results", file);
      if (!existsSync(path)) return json({ error: "Result not found." }, 404);
      try { return json(resultSummary(file, JSON.parse(await Bun.file(path).text()))); }
      catch { return json({ error: "Could not read the result JSON." }, 422); }
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      if (current) return json({ error: "A job is already running." }, 409);
      const { script, args } = await req.json();
      let cmd;
      if (script === "install") cmd = [process.execPath, "install"];
      else if (script === "preset") {
        // args = "<preset name>" or "all"
        const name = String(args || "").trim();
        if (name !== "all" && !PRESETS[name]) return json({ error: "Unknown preset." }, 400);
        cmd = [process.execPath, "run", "src/preset.js", name];
      } else if (SCRIPTS.has(script)) cmd = [process.execPath, "run", script, ...splitArgs(args || "")];
      else return json({ error: "Unknown script." }, 400);

      const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, STRAT_GUI_PROGRESS: "1" }, stdout: "pipe", stderr: "pipe" });
      current = proc;
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(ctrl) {
          let stderr = "";
          const pump = async (r, captureError = false) => {
            const decoder = new TextDecoder();
            for await (const ch of r) {
              if (captureError) stderr = (stderr + decoder.decode(ch, { stream: true })).slice(-6000);
              ctrl.enqueue(ch);
            }
          };
          await Promise.all([pump(proc.stdout), pump(proc.stderr, true)]);
          const code = await proc.exited;
          current = null;
          if (code !== 0 && stderr.trim()) {
            const message = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("at ")).at(-1);
            if (message) ctrl.enqueue(enc.encode(`\n@@error ${message}\n`));
          }
          ctrl.enqueue(enc.encode(`\n[finished, exit code ${code}]\n`));
          ctrl.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      if (current) current.kill();
      return json({ ok: true });
    }

    if (url.pathname === "/api/results") return json(listDir("results", [".json", ".csv"]));

    if (url.pathname.startsWith("/api/results/")) {
      const f = Bun.file(join(ROOT, "results", basename(decodeURIComponent(url.pathname))));
      if (!(await f.exists())) return json({ error: "Not found." }, 404);
      const text = await f.text();
      return new Response(text.length > 300000 ? text.slice(0, 300000) + "\n… truncated" : text, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Static files for the browser pages (index.html imports ./src/browser/*.js and reads ./data/broker/*.csv)
    const file = staticFile(url.pathname);
    if (file && (await file.exists())) return new Response(file, { headers: { "cache-control": "no-cache" } });

    return new Response("Not found", { status: 404 });
  },
});

console.log(`strat-backtest launcher running at http://localhost:${PORT}`);
