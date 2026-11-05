"""Local backend for the Strat lab.  python py/server.py [--port 8765]

Serves the static site (index.html, web/, data/...) and a small JSON API:
  GET  /api/lab/meta           engine info + which pairs exist per timeframe
  POST /api/lab/run            {"kind": "backtest|grid|walkforward|robustness|portfolio|
                                         portfolio_robustness|stress|all", "cfg": {...}}
  POST /api/lab/job            {"kind": "benchmark", "cfg": {...}} -> {"id": ...}   (background, multi-process)
  GET  /api/lab/job?id=ID      progress, and the result when done
  POST /api/lab/job/cancel     {"id": ...}
  GET  /api/rates, GET /api/benchmarks, POST /api/benchmark/save   (same as the Bun launcher)
index.html detects the API with /api/lab/meta; if it is missing it falls back to results/lab/*.json
(GitHub workflow output) and then to the in-browser JS engine (web/engine.js).
Console output: every request and job is logged with timings; --quiet shows warnings and errors only.
"""
import argparse
import json
import logging
import math
import os
import re
import sys
import threading
import time
import traceback
from urllib.parse import urlparse, parse_qs
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stratlab as lab  # noqa: E402
import benchmark as bench  # noqa: E402

log = logging.getLogger('strat')

LOCK = threading.Lock()  # one numba job at a time; prange already uses every core


def clean(x):
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if hasattr(x, 'tolist'):
        return clean(x.tolist())
    if isinstance(x, float):
        return x if math.isfinite(x) else None
    return x


def _short(cfg):
    """One-line summary of a request config for the console."""
    if not isinstance(cfg, dict):
        return ''
    keep = {k: cfg[k] for k in ('tf', 'pairs', 'start', 'end', 'folds', 'source') if k in cfg}
    if isinstance(keep.get('pairs'), list) and len(keep['pairs']) > 4:
        keep['pairs'] = f"{len(keep['pairs'])} pairs"
    ax = (cfg.get('grid') or {}).get('axes')
    if ax:
        keep['axes'] = [a.get('param') for a in ax]
    return json.dumps(keep, default=str)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=lab.ROOT, **k)

    def log_message(self, fmt, *args):
        line = fmt % args
        if '/api/lab/job?' in line and ' 200 ' in line:  # polling: too noisy
            return
        log.debug('%s %s', self.address_string(), line)

    def _json(self, code, obj):
        body = json.dumps(clean(obj)).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(n) or b'{}')

    def _fail(self, code, e, what):
        tb = traceback.format_exc()
        log.error('%s FAILED: %s: %s\n%s', what, type(e).__name__, e, tb)
        return self._json(code, {'error': f'{type(e).__name__}: {e}', 'trace': tb[-3000:]})

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in (('Access-Control-Allow-Origin', '*'), ('Access-Control-Allow-Headers', 'content-type'),
                     ('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')):
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/api/lab/meta':
            try:
                m = lab.meta()
                m.update(cpus=os.cpu_count() or 1, benchmark_max=bench.MAX_SCENARIOS, benchmark=True)
                return self._json(200, m)
            except Exception as e:
                return self._fail(500, e, 'GET /api/lab/meta')
        if u.path == '/api/lab/job':
            j = bench.get((parse_qs(u.query).get('id') or [''])[0])
            if not j:
                return self._json(404, {'error': 'unknown job (the server may have restarted)'})
            return self._json(200, j.status())
        if u.path == '/api/rates':
            d = os.path.join(lab.ROOT, 'data', 'rates')
            names = sorted(f[:-5] for f in os.listdir(d) if f.endswith('.json')) if os.path.isdir(d) else []
            return self._json(200, names)
        if u.path == '/api/benchmarks':
            d = os.path.join(lab.ROOT, 'results')
            out = []
            for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                if f.startswith('benchmark_config_') and f.endswith('.json'):
                    try:
                        with open(os.path.join(d, f)) as fh:
                            j = json.load(fh)
                        out.append({'file': f, 'name': j.get('name'), 'createdAt': j.get('createdAt'), 'config': j.get('config')})
                    except Exception:
                        out.append({'file': f, 'name': f, 'createdAt': None, 'config': None})
            return self._json(200, out)
        if u.path == '/lab.html':  # the lab used to be a separate page
            self.send_response(302)
            self.send_header('Location', '/index.html')
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == '/api/lab/run':
                req = self._body()
                kind, cfg = req.get('kind', 'backtest'), req.get('cfg', {}) or {}
                log.info('RUN %s %s', kind, _short(cfg))
                t0 = time.time()
                with LOCK:
                    waited = time.time() - t0
                    res = lab.run(kind, cfg)
                log.info('RUN %s ok in %.2fs%s', kind, time.time() - t0, f' (waited {waited:.1f}s for another job)' if waited > 0.5 else '')
                return self._json(200, res)
            if path == '/api/lab/job':
                req = self._body()
                if req.get('kind', 'benchmark') != 'benchmark':
                    return self._json(400, {'error': 'only kind "benchmark" runs as a job'})
                return self._json(200, {'id': bench.start(req.get('cfg') or {})})
            if path == '/api/lab/job/cancel':
                return self._json(200, {'ok': bench.cancel(self._body().get('id', ''))})
            if path == '/api/benchmark/save':
                req = self._body()
                slug = re.sub(r'^-+|-+$', '', re.sub(r'[^a-z0-9_-]+', '-', str(req.get('name') or '').strip().lower()))[:48]
                if not slug or not isinstance(req.get('config'), dict):
                    return self._json(400, {'error': 'A name and benchmark configuration are required.'})
                os.makedirs(os.path.join(lab.ROOT, 'results'), exist_ok=True)
                fn = f'benchmark_config_{slug}.json'
                with open(os.path.join(lab.ROOT, 'results', fn), 'w') as fh:
                    json.dump({'type': 'benchmark-config', 'name': slug, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
                               'config': req['config'], 'summary': req.get('summary')}, fh, indent=2)
                log.info('saved benchmark setup %s', fn)
                return self._json(200, {'file': fn, 'name': slug})
            if path == '/api/run':
                return self._json(501, {'error': 'Data sync needs the Bun launcher (bun start, then open http://localhost:3000/benchmark). '
                                                 'This Python server only runs analyses.'})
            return self._json(404, {'error': 'not found'})
        except Exception as e:
            return self._fail(400, e, f'POST {path}')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1', help='use 0.0.0.0 to open it from a phone on the same Wi-Fi')
    ap.add_argument('--quiet', action='store_true', help='only warnings and errors in the console')
    a = ap.parse_args()
    logging.basicConfig(level=logging.WARNING if a.quiet else logging.DEBUG, format='%(asctime)s %(levelname)-5s %(message)s',
                        datefmt='%H:%M:%S')
    threading.Thread(target=_warm, daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    try:
        import numba
        log.warning('Strat on http://%s:%d/   numba %s, %d threads, %d CPUs   (Ctrl+C to stop)', a.host, a.port,
                    numba.__version__, numba.get_num_threads(), os.cpu_count() or 1)
    except Exception as e:
        log.warning('Strat on http://%s:%d/   numba NOT available (%s)', a.host, a.port, e)
    srv.serve_forever()


def _warm():
    """Compile the numba kernels once (cached on disk afterwards) so the first click is not slow."""
    t0 = time.time()
    try:
        for tf in ('D1', 'H4', 'H1'):
            ps = lab.available_pairs(tf)
            if ps:
                lab.run('backtest', {'tf': tf, 'pairs': [ps[0]], 'start': '2020-01-01', 'end': '2020-06-30'})
                log.warning('numba kernels ready (%s warm-up %.1fs)', tf, time.time() - t0)
                break
        else:
            log.warning('no data in data/broker*: kernels compile on the first run')
    except Exception:
        log.error('warm-up failed:\n%s', traceback.format_exc())


if __name__ == '__main__':
    main()
