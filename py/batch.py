"""Batch run for GitHub Actions / phones: writes results/lab/<TF>.json and results/lab/index.json.
   python py/batch.py --tf D1,H4,H1 [--start 2014-01-01] [--end 2026-10-31] [--cfg my.json]
index.html reads these files when no local backend is running."""
import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stratlab as lab  # noqa: E402
from server import clean  # noqa: E402

DEFAULT_GRID = {'axes': [{'param': 'lookback', 'values': [10, 20, 40]},
                         {'param': 'htf', 'values': ['continuity', 'all', 'reversal']},
                         {'param': 'both_hit', 'values': ['skip', 'loss']}]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tf', default='D1')
    ap.add_argument('--start', default='2014-01-01')
    ap.add_argument('--end', default=dt.date.today().isoformat())
    ap.add_argument('--out', default=os.path.join(lab.ROOT, 'results', 'lab'))
    ap.add_argument('--cfg', help='JSON file merged over the default config')
    ap.add_argument('--pair', default='EURUSD', help='single-pair pair for backtest/robustness views')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    extra = json.load(open(a.cfg)) if a.cfg else {}
    done = []
    for tf in [x.strip().upper() for x in a.tf.split(',') if x.strip()]:
        if not lab.available_pairs(tf):
            print(f'{tf}: no data in {lab.DATA_DIRS[tf]}, skipped')
            continue
        cfg = {'tf': tf, 'start': a.start, 'end': a.end, 'pairs': None, 'folds': 4, 'draws': 2000,
               'grid': DEFAULT_GRID, 'params': {}, 'portfolio': {}}
        cfg.update(extra)
        # single-pair views use the first pair; pooled views use all
        res = {}
        for kind in ('stress', 'walkforward', 'portfolio', 'portfolio_robustness'):
            try:
                res[kind] = lab.run(kind, cfg)
                print(f'{tf} {kind} ok')
            except Exception as e:
                res[kind] = {'kind': kind, 'error': str(e)}
                print(f'{tf} {kind} FAILED {e}')
        single = dict(cfg, pairs=[a.pair])
        for kind in ('backtest', 'robustness'):
            try:
                res[kind] = lab.run(kind, single)
            except Exception as e:
                res[kind] = {'kind': kind, 'error': str(e)}
        try:
            res['grid'] = lab.run('grid', dict(cfg, folds=1))
        except Exception as e:
            res['grid'] = {'kind': 'grid', 'error': str(e)}
        res['meta'] = lab.meta()
        res['generated'] = dt.datetime.utcnow().isoformat() + 'Z'
        with open(os.path.join(a.out, f'{tf}.json'), 'w') as f:
            json.dump(clean(res), f)
        done.append(tf)
    with open(os.path.join(a.out, 'index.json'), 'w') as f:
        json.dump({'tfs': done, 'generated': dt.datetime.utcnow().isoformat() + 'Z'}, f)


if __name__ == '__main__':
    main()
