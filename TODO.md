# TODO

Pending items from writing DETAILED.md. Nothing was run or tested; all
statements in DETAILED.md come from reading the source in `src/`, and the
numeric examples were worked by hand.

## Verify on your machine

- [ ] Run one trade through the checklist in DETAILED.md 6.1 against a real
      `results/*_trades.csv` row.
- [ ] Re-run the cost example in DETAILED.md 3.6 with
      `bun run backtest ... --swap-mode none` and `--swap-mode flat` to confirm
      the spread/commission/slippage-only cost is about 0.08R on a 40-pip stop.
- [ ] Check the section links in the DETAILED.md contents render on your
      host (GitHub anchors).

## Repo inconsistencies found while reading

- [ ] `data/rates/` is not in the zip I received. Without it, `backtest.js`
      prints "Rate carry unavailable" and uses the flat 0.2 bp/day swap with no
      carry. README and STRATEGY.md describe rate-based carry as the default.
      Confirm the folder exists in your working copy and is committed or fetched.
- [ ] `STRATEGY.md` lists a `2` setup (any bar after a `2`). `setupAt` in
      `src/strat.js` never produces it. Remove it from the doc or implement it.
- [ ] README says the time exit is "after 10 daily bars". The code counts the
      entry bar as bar 1, so the exit is at the close of entry bar + 9.
      Reword the README line (DETAILED.md 3.4 has the exact version).
- [ ] The header comment in `src/walkforward.js` mentions Yahoo D1 and
      is stale; the preset runs on the broker CSVs.
- [ ] `portfolio.js` prints date-fold slices for fixed years
      (2014-2016, 2017-2019, 2020-2022, 2023-2026) regardless of
      `--start` / `--end`.

## Docs

- [ ] Link `DETAILED.md` from the README contents and file layout list.
- [ ] Decide whether the browser page (`index.html`, `src/browser/`)
      needs its own short section; it was left out on
      purpose.

## Possible model checks (not changes)

- [ ] Measure how much the uncredited entry-bar target and the skipped
      both-triggers days matter, for example by counting them in a trades run.
- [ ] Test sensitivity to a wider spread than the fixed 1 pip.
## Strat lab (Python backend, JS fallback, GUI) - nothing here was run

- [ ] `pip install -r requirements.txt`, then `python py/server.py` and open `http://127.0.0.1:8765/`.
      First run compiles the numba kernels (cached in `py/__pycache__`).
- [ ] Compare one pair/period: JS engine (index.html Summary) vs `py/stratlab.py` backtest. They should match
      trade for trade when swap mode is flat (the JS engine has no rate table, so no carry).
- [ ] Check `python py/stratlab.py`-level shapes once: `lab.run('stress', cfg)`, `lab.run('all', cfg)`.
- [ ] H1/H4: `bun run fetch-h1`, `python py/resample.py`, then run the H1 and H4 stress ladders. Confirm
      the HTF day shift (default 2h) is the rollover you want, and that max-hold defaults (H4 12, H1 24) are what you mean.
- [ ] `fetch-data.yml` / `lab.yml` were written without running them; check the `git add` lines and permissions.
- [ ] Not implemented: crediting a target touched on the entry bar; spread that varies by hour; ask-side triggers for
      short stops / long entries (bid-only data); margin and leverage in the portfolio.
- [ ] Replay shows a single pair from the JS engine; add the portfolio view to the replay if wanted.
- [ ] Browser fallback has no grid / walk-forward / portfolio; those need the backend or the workflow JSON.

## Merged page + backend benchmark (index.html, py/benchmark.py) - not run against real Numba

- [ ] Run `start.bat`, open `http://127.0.0.1:8765/`: Benchmark tab should pick "Python backend" by itself. Try a 50-scenario
      sweep, then a few thousand, and watch the per-job lines in the console (rate, ETA).
- [ ] `grid_stats` was changed to decode the combination index with a running stride (fixes "Overwrite of parallel loop
      index"). Compare one small grid against the previous results if you have any saved.
- [ ] Backend benchmark uses calendar week/month HTF bias; the browser benchmark uses rolling 5/21-bar blocks. Decide if
      the browser engine should be switched to calendar bars so both agree.
- [ ] Backend sample data uses numpy's RNG, so the same seed does not give the same bars as the browser sample.
- [ ] Rate files loaded with the "Rate files for carry" picker are only used by the browser engine; the backend reads `data/rates`.
- [ ] Data sync (Sync Dukascopy) still needs the Bun launcher on port 3000; the Python server answers 501 for it.
- [ ] Memory/CPU: workers default to all cores (`workers` in the job config, `STRAT_BENCH_MAX` for the scenario limit).
