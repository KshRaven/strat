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
- [ ] Decide whether the browser pages (`index.html`, `run.html`,
      `src/browser/`) need their own short section; they were left out on
      purpose.

## Possible model checks (not changes)

- [ ] Measure how much the uncredited entry-bar target and the skipped
      both-triggers days matter, for example by counting them in a trades run.
- [ ] Test sensitivity to a wider spread than the fixed 1 pip.