# The Strat backtester

A backtest harness for a mechanical subset of **The Strat**, a price-action
trading framework created by Rob Smith. It labels every candle as a **1**, **2U**,
**2D** or **3**, finds the common combos (2-1-2, 3-1-2, 1-2-2, 2-2, 3-2), optionally
filters them with a **higher-timeframe continuity** check, and simulates breakout
trades with structural stops and targets, including spread, commission, slippage
and swap costs.

The target is a **multi-pair D1 (daily) portfolio**, not a single EURUSD model. The
repo contains per-pair backtests, date-based walk-forward validation, trade
bootstrap, deflated Sharpe, and a portfolio engine with daily mark-to-market.

> **Status: research prototype. Not validated for live trading.** The strict
> pre-registered gate is a narrow NO-GO (portfolio monthly DSR 0.930 vs 0.95).
> The full-history check passes (0.992), but it was run after the near miss and
> is not a pristine confirmation. Do not risk real capital. Nothing here is
> financial advice.

## Contents

1. [Pick your way to run it](#pick-your-way-to-run-it)
2. [The Strat explained from zero](#the-strat-explained-from-zero)
3. [Quick start on a PC (Bun)](#quick-start-on-a-pc-bun)
4. [Live data](#live-data)
5. [TL;DR results](#tldr) and [info cards](#info-cards)
6. [Results, decision, caveats](#results)
7. [Commands and flags](#commands)
8. [File layout](#file-layout)

## Pick your way to run it

| You are on... | Use | What you get |
|---|---|---|
| **A PC with Bun** | `bun start` (or double-click `start.bat` on Windows) | Control workspace at `http://localhost:3000`: install, fetch live data, run every analysis, read results. Full engine (walk-forward, deflated Sharpe, portfolio). |
| **A PC, terminal fan** | `bun run preset all` | The same analyses from the command line, no flags to type. |
| **A phone or tablet** | `index.html` / `run.html` hosted with GitHub Pages | Everything runs in the browser, no install. Edit files with the GitHub mobile app or github.dev. |
| **Phone + fresh data** | Select CSV files in `index.html` / `run.html` | Broker data is not stored in the repo; fetch it locally on a PC, then provide the CSV files. |

All of these use the same rule code (`src/strat.js`, `src/stats.js`), so results agree.
`run.html` is a small standalone port of the rules with no module loading, handy as a
fallback when you only have a phone and pasted CSV text.

## The Strat explained from zero

You do not need to know trading jargon to follow this. Everything below is what the
code actually does, in plain words.

### 1. A candle in one paragraph

Each daily candle (bar) has four prices: **Open, High, Low, Close**. The Strat mostly
ignores the open and close when labelling candles. It only cares about **how this
candle's high and low compare with the previous candle's high and low**.

### 2. The four candle numbers

Compare today's candle with yesterday's:

| Label | Name | What happened | In code |
|---|---|---|---|
| **1** | Inside bar | Today stayed *inside* yesterday's range. No new high, no new low. Price is pausing or compressing. | `high <= prev.high` and `low >= prev.low` |
| **2U** | Two up | Today pushed *above* yesterday's high but not below its low. Buyers took control of that side. | `high > prev.high` and `low >= prev.low` |
| **2D** | Two down | Today pushed *below* yesterday's low but not above its high. Sellers took control of that side. | `high <= prev.high` and `low < prev.low` |
| **3** | Outside bar | Today broke *both* yesterday's high and low. A wide, volatile bar that engulfs the previous range. | `high > prev.high` and `low < prev.low` |

```
 prev bar      1 (inside)    2U            2D            3 (outside)
   |            |             |  <- new high                | <- new high
  [ ]          [ ]           [ ]            [ ]           [ ]
   |            |                           |  <- new low   | <- new low
```

Why it matters: a **1** means the market has not decided, and the next bar will
usually break one side of it. The Strat trades that breakout.

### 3. Setups (the combos)

A **setup** is the two-candle context just before a possible breakout. The last
completed candle is the **setup bar**. Its high is the **long trigger** and its low is
the **short trigger**. The names below list the bars in order, so `2-1` means "a 2 then
a 1", and the trade comes on the bar *after*.

| Setup | Bars | Plain meaning | Classic Strat name |
|---|---|---|---|
| **2-1** | a 2U/2D, then an inside bar | A directional move, then a pause. Break of the pause gives a **2-1-2**. | 2-1-2 |
| **3-1** | an outside bar, then an inside bar | A volatile bar, then a pause inside it. | 3-1-2 |
| **1-2** | an inside bar, then a 2U/2D | The pause just broke one side; trade the next break. | 1-2-2 |
| **2-2** | a 2U/2D, then another 2U/2D | Two directional bars in a row. See *continuation vs reversal* below. | 2-2 |
| **3-2** | an outside bar, then a 2U/2D | Volatile bar, then it picked a side. | 3-2 |

Default set: `2-1, 3-1, 1-2, 2-2, 3-2`. The code can also label `1-1`, `3` and `2`
setups, but they are off by default and not part of the validated rule.

**Continuation vs reversal (the other kind of "reversal").** A **2-2 continuation** is
2U followed by 2U (or 2D then 2D): the trend keeps going. A **2-2 reversal** is 2D
followed by 2U (or 2U then 2D): the market failed to keep going and turned. In this
repo the 2-2 setup trades *either* outcome, whichever side breaks; it does not
separate them. Do not confuse this with the HTF `reversal` mode below, which is a
filter, not a candle pattern.

### 4. How a trade is entered, stopped and targeted

On the bar **after** the setup bar:

1. **Trigger.** If price trades above the setup bar's **high**, go **long**. If it
   trades below the setup bar's **low**, go **short**. If it does *both* in one
   candle, the trade is **skipped**, because daily data cannot tell which came first.
2. **Entry price.** `intrabar` (default): you are filled at the trigger, or at the
   open if price gapped past it. `close`: you only enter if the bar *closes*
   beyond the trigger, and you are filled at the close.
3. **Stop.** The opposite side of the setup bar (long: setup low; short: setup
   high). The distance from entry to stop is **1R**, the unit of risk.
4. **Target.** `structural` (default): the highest high (long) or lowest low (short)
   of the previous 20 bars, since that is where price has recently turned. If that
   level is closer than 0.5R it is not worth it, so the target becomes **2R**
   (twice the risk). `2r`: always 2R.
5. **Exit.** Whichever comes first: stop, target, or a time exit after 10 daily bars.
   If stop and target are both hit on one bar, the stop wins (pessimistic).

**Worked example (long, 2-1 setup).** Yesterday was a 2U, so the setup bar today is an
inside bar with high 1.1050 and low 1.1010.

- Next bar trades up through 1.1050, so we buy at **1.1050**.
- Stop = 1.1010, so **1R = 0.0040** (40 pips).
- 20-bar swing high is 1.1150, which is 100 pips = 2.5R away, so the target is **1.1150**.
- Target hit: gross **+2.5R**. Stopped out: gross **-1R**. Costs then shave a fraction
  of an R off either result. Sized at 0.25% risk per trade, a full stop-out costs
  about 0.25% of the account.

### 5. Higher-timeframe continuity (the HTF filter)

Candles come in layers. A daily candle sits inside a **weekly** candle, which sits
inside a **monthly** candle. The Strat idea of **full timeframe continuity (FTC)** is
that trades work better when the bigger candles agree with your direction.

Here, each bigger candle is coloured **green** if its close so far is above its
open, **red** if below. For D1 trading the two bigger candles are the **current week**
and **current month**, measured at the setup bar's close. The filter modes are:

| Mode | Long allowed when | Short allowed when | Idea |
|---|---|---|---|
| `continuity` (default) | week **and** month are green | week **and** month are red | Trade *with* the bigger trend. |
| `reversal` | week **and** month are red | week **and** month are green | Trade *against* the bigger trend (fade it). |
| `all` | always | always | No filter. |

If the week and month disagree (one green, one red) or one is flat, `continuity` and
`reversal` both skip the trade. Interesting finding in this repo: on EURUSD,
removing the filter (`all`) and even `reversal` did *better* than `continuity`, so
the filter is not what carries the edge here. The portfolio uses the default
`continuity` rule because that is what was frozen before testing.

### 6. Why "frozen" and "walk-forward" matter

If you tweak settings until a backtest looks great, you have fitted noise. This repo
**freezes** the rule before judging it, tests it on consecutive date blocks
(**walk-forward folds**), and applies a **deflated Sharpe ratio** (DSR) that
penalises you for how many variants you tried. A DSR of 0.95 or more means "likely
real even after counting my attempts". The 2014-2026 portfolio scored 0.930, just
short, so the honest conclusion is *paper trade it, do not fund it*.

### 7. Quick glossary for the rest of this page

| Term | Plain meaning |
|---|---|
| **R** | One unit of risk: entry-to-stop distance. "+2R" means you made twice what you risked. |
| **Net R** | R after all trading costs. Averaged per trade, it is the expectancy. |
| **Profit factor (PF)** | Money won divided by money lost. Above 1 is profitable. |
| **Drawdown (MaxDD)** | Biggest fall from an equity peak. -13% means a 13% dip at the worst point. |
| **Sharpe** | Return per unit of volatility. Around 1 is decent; very high numbers deserve suspicion. |
| **CAGR** | Compound yearly growth rate. |
| **Spread / commission / slippage** | The three per-trade costs: bid-ask gap, broker fee, and worse-than-expected fills. |
| **Swap / carry** | Overnight interest paid or earned for holding a currency pair. |
| **In-sample / out-of-sample** | Data used to design the rule vs data it never saw. Only the second proves anything. |

The longer tables in [Info cards](#info-cards) cover every other abbreviation.

## TL;DR

| Item | Result |
|---|---|
| Rule | Mechanical Strat, D1, frozen |
| Timeframes | H1/H4 fail after costs; D1 is the only viable timeframe |
| Broker-feed walk-forward | 4/4 folds positive, +0.148R, PF 1.29 |
| Portfolio 2014-2026 | CAGR 14.46%, Sharpe 1.38, maxDD -13.24%, DSR 0.930 **FAIL** |
| Portfolio 2008-2026 | CAGR 15.20%, Sharpe 1.44, maxDD -13.24%, DSR 0.992 **PASS** |
| Decision | No live capital; paper trading is the only justified next step |

## Info cards

### Command cards

> **BACKTEST**  `bun run backtest --tf D1`
>
> Runs the frozen mechanical Strat rule on one pair/timeframe. Simulates
> breakout entries, stops, targets, costs, and swap with one position per pair.
>
> **Reads:** `data/*.json`, `data/broker/*.csv`, `data/rates/*.json`  
> **Writes:** `results/<label>.json`, `results/<label>_trades.csv`  
> **Use when:** Testing one pair, one timeframe, or a pre-specified variant.  
> **Key flags:** `--data`, `--tf`, `--setups`, `--htf`, `--entry`, `--target`

> **WALK-FORWARD**  `bun run walkforward ...`
>
> Splits the date range into contiguous folds, runs the frozen rule on each
> pair and fold, and aggregates the out-of-sample trades. No parameters are
> fitted per fold; this is stability testing, not optimization.
>
> **Reads:** CSV/JSON files from `--data-dir`  
> **Writes:** `results/wf_<PAIR>_<fold>.json`, `results/walkforward_summary.json`  
> **Use when:** You need period-by-period evidence instead of one full-sample
> number, or you need to see whether one regime carries the result.

> **SWEEP**  `bun run sweep`
>
> Runs the D1 backtest across every D1 file and prints one comparison table.
> Variants can be selected with `--variants default,all,reversal,2r,close`.
>
> **Reads:** `data/*_D1.json`  
> **Writes:** nothing by default (it uses `--no-save`)  
> **Use when:** Screening pairs or variants before a full walk-forward.

> **ROBUSTNESS**  `bun run robustness --data ... --tf D1`
>
> Runs the five pre-specified variants on one pair, computes trade-level
> bootstrap confidence intervals, and computes monthly deflated Sharpe using
> the variants as multiple-testing trials.
>
> **Writes:** `results/rb_*.json`, `results/robustness_summary.json`  
> **Use when:** You want to know whether one pair's result survives
> multiple-testing correction. This is per-pair, not portfolio-level.

> **PORTFOLIO**  `bun run portfolio --data-dir data/broker ...`
>
> Runs the frozen strategy on all pairs, combines overlapping trades under a
> fixed risk budget, and marks the book to market daily.
>
> **Settings:** 0.25% risk/trade, max 2% open risk, max 8 positions  
> **Writes:** `results/portfolio_<tag>.json`  
> **Use when:** Evaluating the actual target: a multi-pair D1 portfolio.

> **PORTFOLIO ROBUSTNESS**  `bun run portfolio-robustness ...`
>
> Runs the portfolio engine for the five pre-specified variants and computes
> portfolio-level monthly deflated Sharpe using those variants as trials.
>
> **Writes:** `results/portfolio_pf_*.json`, `results/portfolio_robustness.json`  
> **Use when:** Applying the multiple-testing gate to the portfolio, not to a
> single pair.

### Metric cards: returns and risk

| Abbrev. | Full name | Meaning |
|---|---|---|
| `R` | Risk unit | Price distance from entry to the initial stop. 1R = that distance. |
| `Gross R` | Gross risk multiple | Directional price PnL divided by initial risk, before costs. |
| `Net R` | Net risk multiple | Gross R after spread, commission, slippage, carry, and swap. |
| `Cost R` | Cost in R | `Gross R - Net R`; average cost drag per trade. |
| `Expectancy` | Expected net R | Mean `Net R` per trade. Positive is the basic edge test. |
| `Win rate` | Winning trade rate | Fraction of trades with positive net PnL. |
| `Hit rate` | Positive-period rate | Fraction of months (or trades) with positive returns. |
| `PF` | Profit factor | Gross winning PnL divided by gross losing PnL. Above 1 is profitable. |
| `PnL` | Profit and loss | Account-currency change, realized plus unrealized. |
| `Total return` | Cumulative return | Compounded equity change over the test window. |
| `Ann.` | Annualized | Scaled to a one-year basis (252 trading days). |
| `MTM` | Mark-to-market | Revaluing open positions at each daily close. |
| `CAGR` | Compound annual growth rate | Annualized compounded return. |
| `Vol` | Annualized volatility | Standard deviation of returns times sqrt(252). |
| `Sharpe` | Sharpe ratio | Annualized mean return divided by annualized volatility. |
| `MaxDD` | Maximum drawdown | Worst peak-to-trough decline of the equity curve. |
| `Turnover` | Annual turnover | Sum of absolute position-weight changes per year. |
| `Exposure` | Time in market | Fraction of days with at least one open position. |
| `Trades/yr` | Trade frequency | Number of trades per year. |
| `Avg bars held` | Holding period | Mean bars from entry to exit. |
| `Boot 5-95%` | Bootstrap interval | 5th to 95th percentile from resampling trades or months. |
| `CI` | Confidence interval | Range containing the estimate at a stated confidence. |
| `DSR` | Deflated Sharpe ratio | Probability that the Sharpe is real after accounting for trials. |
| `Trade Sharpe` | Per-trade Sharpe | Mean `Net R` / std of `Net R`, scaled by sqrt(trades). |
| `Monthly Sharpe` | Monthly Sharpe | Mean / std of monthly returns, scaled by sqrt(12) when annualized. |
| `N` | Number of trials | Variants/hypotheses used in the DSR correction. |
| `T` | Observations | Number of trades or months used in a statistic. |
| `IS` | In-sample | Data seen while designing the rule. |
| `OOS` | Out-of-sample | Data not used while designing the rule. |
| `Fold` | Walk-forward block | One contiguous out-of-sample date block. |

### Metric cards: strategy and data terms

| Term | Meaning |
|---|---|
| `D1 / H4 / H1` | Daily, 4-hour, 1-hour bars. Only D1 survives costs here. |
| `OHLC` | Open, High, Low, Close of a bar. |
| `1` | Inside bar: high <= prior high and low >= prior low. |
| `2U` | Up directional bar: breaks prior high, not prior low. |
| `2D` | Down directional bar: breaks prior low, not prior high. |
| `3` | Outside bar: breaks both prior high and prior low. |
| `2-1`, `3-1`, `1-2`, `2-2`, `3-2` | Two-bar context labels used to select breakout setups. |
| `HTF` | Higher timeframe. H1 uses H4/D1; H4 uses D1/W1; D1 uses W1/M1. |
| `FTC` | Full timeframe continuity: all referenced timeframes same color. |
| `Continuity` | Trade only in the direction of both HTF candles. |
| `Reversal` | Trade against both HTF candles. |
| `All` | Ignore the HTF filter. |
| `Trigger` | The setup bar high (long) or low (short) that the next bar must break. |
| `Stop` | Opposite side of the setup bar. |
| `Structural target` | Prior 20-bar swing high/low; falls back to 2R if too close. |
| `2R target` | Fixed target at entry +/- 2 times the initial risk. |
| `Intrabar entry` | Fill when the trigger is touched, at the trigger or the open on a gap. |
| `Close entry` | Fill at the close of the trigger bar only if it closes beyond the trigger. |
| `Spread` | Bid/ask cost from the data file, half at entry and half at exit. |
| `Commission` | Broker fee per side, default 0.5 bp. |
| `Slippage` | Execution slippage per side, default 0.5 bp. |
| `Swap / financing` | Overnight rate-differential carry plus a 0.2 bp/day swap spread. |
| `Risk/trade` | Fraction of equity risked to the stop, default 1% single-pair / 0.25% portfolio. |
| `Max open risk` | Cap on the sum of open position risk, default 2% of equity. |
| `Max positions` | Cap on simultaneous open pairs, default 8. |
| `Broker feed` | The exact bars your broker would trade; here approximated by Dukascopy D1. |
| `Frozen rule` | No parameter changes after seeing results. |

## Quick start on a PC (Bun)

Requirements: [Bun](https://bun.sh) (Windows, macOS or Linux). No other tools.

### Easiest: the control panel

```bash
bun install
bun start
```

On Windows you can instead double-click **`start.bat`**: it checks for Bun, runs
`bun install` the first time, opens your browser, and starts the panel. From the
panel at `http://localhost:3000` click **Install dependencies**, **Fetch latest data
(live)**, then any analysis button, or **Run everything**.

### Terminal: presets (no long flags, works in PowerShell, cmd and bash)

```bash
bun install
bun run preset update       # download / refresh data from Dukascopy
bun run preset walkforward  # 4-fold walk-forward, 16 pairs
bun run preset portfolio    # 16-pair portfolio, daily mark-to-market
bun run preset portfolio-robustness   # variants + deflated Sharpe
bun run preset all          # update + the three analyses above, in order
bun run preset              # list every preset
```

Presets use the frozen settings, with the end date set to **today** so results grow
as live data arrives. Add flags after the name to override, e.g.
`bun run preset portfolio --start 2018-01-01`.

### Terminal: the raw commands

The presets just call these. On Windows put each command on **one line** (the `\`
continuation used in bash does not work in PowerShell or cmd).

```bash
bun run fetch-broker --update
bun run backtest --data data/broker/EURUSD.csv --tf D1 --symbol EURUSD --spread-points 10
bun run walkforward --data-dir data/broker --template "{pair}.csv" --symbol-csv --pairs EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP,EURJPY,GBPJPY,EURCHF,EURAUD,EURCAD,AUDJPY,CADJPY,CHFJPY --folds 4 --start 2014-01-01 --end 2026-10-29
bun run portfolio --data-dir data/broker --template "{pair}.csv" --symbol-csv --pairs EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP,EURJPY,GBPJPY,EURCHF,EURAUD,EURCAD,AUDJPY,CADJPY,CHFJPY --start 2014-01-01 --end 2026-10-29 --risk-per-trade 0.0025 --max-open-risk 0.02 --max-positions 8
bun run portfolio-robustness --data-dir data/broker --template "{pair}.csv" --start 2014-01-01 --end 2026-10-29 --risk-per-trade 0.0025 --max-open-risk 0.02 --max-positions 8
```

Replace `--end` with today's date to include new bars.

### Browser only (no Bun)

- With the panel running, open `http://localhost:3000/benchmark` and press **Load data from project folder**.
- On a phone or any host without Bun, publish the repo with GitHub Pages and open `index.html`
  (or `run.html` for the standalone version), then pick CSV files.

## Live data

Data comes from Dukascopy (daily bid candles, 16 pairs, history from 2008) through
`dukascopy-node`. Nothing is bundled; you fetch it.

| How | Command / action | Behaviour |
|---|---|---|
| PC panel | **Fetch latest data (live)** | Runs `fetch-broker --update`. |
| PC terminal | `bun run update-data` or `bun run preset update` | Requests only bars after the last one in each CSV (3 days of overlap to repair the newest bar) and keeps history. |
| PC, from scratch | `bun run fetch-broker --force` | Redownloads everything (several minutes). |
| Custom range | `bun run fetch-broker --pairs EURUSD,GBPUSD --from 2015-01-01 --to 2026-11-04` | `--to` defaults to tomorrow, so it is always live. |
| GitHub Actions | **Fetch Dukascopy data**, *Run workflow* | Runs on a temporary runner and does not commit CSVs; tick *full* to redownload all history. |

The newest bar is the **latest completed daily candle**. If you run it during the
trading day, the final row may be a partial candle; re-run after the daily close
(21:00 UTC-ish) before trusting a signal on it.

## What the strategy is

The Strat is a discretionary framework. The exact mechanical rules implemented
here are documented in `STRATEGY.md`. Summary:

- Candle types: `1` inside, `2U` up, `2D` down, `3` outside, high/low based.
- Setups: `2-1`, `3-1`, `1-2`, `2-2`, `3-2`.
- Trigger: next bar breaks the setup bar high/low.
- Stop: opposite side of the setup bar.
- Target: prior 20-bar swing (structural) or fixed 2R.
- HTF filter: two higher timeframes in `continuity`, `reversal`, or `all` mode.
- One position per pair; 1% risk per trade in single-pair mode.

## What is implemented

- Candle classification, combos, HTF continuity.
- Intrabar or close entry; structural or 2R target.
- Spread + commission + slippage + rate-based carry/swap.
- Date-based walk-forward folds.
- Per-pair trade bootstrap.
- Monthly deflated Sharpe using the five pre-registered variants as trials.
- Multi-pair portfolio with:
  - 0.25% risk per trade by default
  - max 2% total open risk
  - max 8 concurrent positions
  - daily mark-to-market
  - per-pair contribution reporting
  - date-fold portfolio slices.
- MySQL-free, dependency-light: Bun + plain JS, plus `dukascopy-node` for data.

## Data

- `data/broker/<PAIR>.csv`: Dukascopy D1 broker-style feed, downloaded with
  `bun run fetch-broker` / `--update` (2008 to today, 16 pairs).
- `data/Y_<PAIR>_D1.json`: Yahoo daily pairs (older research).
- `data/EURUSD_H1/H4/D1.json`: Dukascopy intraday/daily files (older research).
- `data/rates/*.json`: 3-month interbank rates for carry/swap.

CSV format expected by the loader:

```csv
date,open,high,low,close
2024-01-02,1.10432,1.10651,1.10318,1.10577
```

Any broker export can be used with:

```bash
bun run backtest --data mybroker.csv --tf D1 --symbol EURUSD \
  --spread-points 10 --point 0.00001
```

## Costs and financing

- Spread: from the data file, half applied at entry and half at exit.
- Commission: 0.5 bp per side (default).
- Slippage: 0.5 bp per side (default).
- Swap/financing:
  - Rate-based carry when timestamps are valid: base 3m rate minus quote 3m
    rate, previous month, plus 0.2 bp/day swap spread.
  - Flat 0.2 bp/day fallback when dates are unavailable.
- Single-pair backtests use 1% risk per trade. The portfolio uses 0.25% risk per
  trade with a 2% total open-risk cap.

## Results

### Timeframes, EURUSD (spread + commission + slippage + swap)

| TF | Trades | Win% | Avg net R | PF | CAGR | MaxDD | Sharpe |
|---|---|---|---|---|---|---|---|
| H1 | 8,848 | 39.7 | -0.15 | 0.80 | -57.2% | -100.0% | -2.20 |
| H4 | 2,661 | 42.5 | -0.01 | 0.98 | -3.5% | -67.7% | -0.11 |
| D1 | 511 | 49.3 | +0.16 | 1.33 | +4.0% | -17.0% | 0.59 |

H1 and H4 do not survive costs. D1 is the only credible timeframe in this
mechanical version.

### D1 variants, EURUSD Dukascopy

| Variant | Trades | Avg net R | PF | CAGR | MaxDD | Sharpe |
|---|---|---|---|---|---|---|
| Default (continuity) | 511 | +0.16 | 1.33 | +4.0% | -17.0% | 0.59 |
| HTF all | 695 | +0.43 | 1.82 | +14.5% | -9.5% | 0.85 |
| HTF reversal | 362 | +0.66 | 2.04 | +11.2% | -16.9% | 0.66 |
| Target 2R | 496 | +0.20 | 1.40 | +4.8% | -14.5% | 0.71 |
| Entry at close | 338 | +0.02 | 1.04 | +0.2% | -19.7% | 0.07 |
| Default, second half | 256 | +0.21 | 1.46 | +5.3% | -11.4% | 0.83 |

Removing the HTF filter improved EURUSD D1, which contradicts the idea that
mechanical HTF continuity adds value here. The edge is mostly the breakout
pattern plus structural target, not the filter.

### D1 cross-pair, default rules (Yahoo, after swap)

Across 17 D1 files (Dukascopy EURUSD plus 16 Yahoo pairs):

- 15/17 pairs positive full-sample; 14/17 positive in the second half.
- Average net R about +0.10; median Sharpe about 0.36 full and 0.29 second half.
- EURGBP is negative; EURCHF is roughly flat.

### Data-vendor sensitivity

- Dukascopy EURUSD D1: +0.16R, Sharpe 0.59 (default).
- Yahoo EURUSD D1: +0.05R, Sharpe 0.17 (default).

Daily candle boundaries, vendor, and history coverage change the results. The
broker-feed section below uses a Dukascopy export; your exact broker still needs
to be checked with the CSV loader.

## Broker-feed walk-forward (Dukascopy D1)

16 pairs, frozen D1 default rule, 2014-2026:

| Fold | Dates | Trades | Avg net R | PF | Pairs positive | Bootstrap mean 5-95% |
|---|---|---|---|---|---|---|
| 1 | 2014-01-01..2017-03-16 | 1,617 | +0.133 | 1.26 | 13/16 | [+0.074, +0.189] |
| 2 | 2017-03-17..2020-05-30 | 1,688 | +0.125 | 1.23 | 15/16 | [+0.061, +0.191] |
| 3 | 2020-05-31..2023-08-14 | 1,729 | +0.151 | 1.30 | 14/16 | [+0.097, +0.207] |
| 4 | 2023-08-15..2026-10-29 | 1,694 | +0.182 | 1.35 | 15/16 | [+0.122, +0.245] |

Overall: 6,728 trades, +0.148R, PF 1.29. Trade bootstrap mean netR 5-95%
[+0.118, +0.178], PF [1.23, 1.35]. All four folds are positive.

Per-pair monthly deflated Sharpe on the broker feed (5 variants as trials):

| Pair | Monthly DSR | Result |
|---|---|---|
| EURUSD | 0.983 | PASS |
| GBPUSD | 0.052 | FAIL |
| USDJPY | 0.403 | FAIL |

The walk-forward breadth passes; individual pair significance is mixed, so the
portfolio is the relevant object.

## Portfolio: 16 D1 pairs

Settings: 0.25% risk per trade, maximum 2% open risk, maximum 8 concurrent
positions, one position per pair, daily mark-to-market.

### 2014-2026 (pre-registered window)

| Metric | Value |
|---|---|
| CAGR | +14.46% |
| Volatility | 10.14% |
| Sharpe | 1.38 |
| Max drawdown | -13.24% |
| Exposure | 99.7% |
| Avg open positions | 6.07 |
| Max open risk | 2.02% of equity |
| Monthly bootstrap Sharpe 5-95% | [1.25, 2.14] |
| Monthly DSR (5 variants) | **0.930 -> FAIL** (needs >= 0.95) |

Date-fold portfolio slices (2014 run): CAGR 11.30% / 11.90% / 16.17% / 17.71%,
Sharpe 1.20 / 1.11 / 1.43 / 1.72, maxDD -10.24% / -10.09% / -10.22% / -13.24%.

### Full broker history: 2008-2026 (post-hoc robustness)

| Metric | Value |
|---|---|
| CAGR | +15.20% |
| Volatility | 10.19% |
| Sharpe | 1.44 |
| Max drawdown | -13.24% |
| Monthly bootstrap Sharpe 5-95% | [1.36, 2.01] |
| Monthly DSR | **0.992 -> PASS** |

The full-history run was executed after observing the 2014-2026 near miss, so it
is a robustness check, not a pristine pre-registered test.

## Decision

The strict pre-registered gate fails by 0.02: 2014-2026 portfolio monthly DSR is
0.930 against a 0.95 threshold. Per the rule, **do not go live.**

The evidence is strong enough to justify a **prospective paper-trading test** on
forward data with the frozen rule and portfolio settings. It does not justify
live capital. Do not tune parameters to push DSR over the line.

## Commands

| Command | Purpose |
|---|---|
| `bun start` | Open the local control panel (`start.bat` on Windows) |
| `bun run preset <name>` | Run a frozen preset: `update`, `walkforward`, `portfolio`, `portfolio-robustness`, `all` |
| `bun run fetch-broker` | Download Dukascopy D1 feed (`--update` adds only new bars, `--force` redownloads) |
| `bun run backtest --data ... --tf D1` | Single-pair backtest |
| `bun run sweep` | D1 cross-pair table |
| `bun run walkforward ...` | Date-based walk-forward |
| `bun run robustness --data ...` | Trade bootstrap + per-pair monthly DSR |
| `bun run portfolio ...` | Multi-pair portfolio simulation |
| `bun run portfolio-robustness ...` | Portfolio variants + monthly DSR |

Common backtest flags:

| Flag | Meaning |
|---|---|
| `--data` | JSON or CSV bars |
| `--tf` | H1, H4, D1 |
| `--setups` | Comma list of setups |
| `--htf` | continuity, reversal, all |
| `--entry` | intrabar, close |
| `--target` | structural, 2r |
| `--blocks` | HTF block sizes, e.g. `4,24` |
| `--max-hold` | Time exit in bars |
| `--lookback` | Structural target lookback |
| `--risk` | Risk fraction per trade |
| `--commission-bp`, `--slippage-bp` | Per-side costs |
| `--swap-mode` | rates, flat, none |
| `--swap-spread-bp`, `--flat-swap-bp` | Swap/financing cost |
| `--start-date`, `--end-date` | Date slice |
| `--start`, `--end` | Fractional slice |
| `--symbol`, `--spread-points`, `--point` | CSV metadata |
| `--label` | Result tag |

Portfolio flags:

| Flag | Meaning |
|---|---|
| `--data-dir`, `--template`, `--symbol-csv` | Source files |
| `--pairs` | Comma list of pairs |
| `--risk-per-trade` | Fraction of equity risked per trade (default 0.0025) |
| `--max-open-risk` | Total open risk cap (default 0.02) |
| `--max-positions` | Concurrent position cap (default 8) |
| `--tag` | Portfolio result tag |

## Caveats

- The rule is a mechanical interpretation of a discretionary framework: no PMG
  management, partials, trailing, news/session filters.
- H1/H4 fail after costs. Do not revive them without a new pre-registration.
- The broker feed is a Dukascopy export, not the user's broker.
- HTF uses calendar weeks/months when timestamps exist; otherwise fixed blocks.
- No correlation/currency-exposure cap, vol targeting, bid/ask, market impact,
  or live execution layer.
- Deflated Sharpe uses five variants as trials; the trial set is small.
- The full-history pass is post-hoc; the pre-registered window fails.
- No pristine holdout remains on this dataset. Forward data is the clean test.

## Next steps

1. Paper trade the frozen portfolio on forward data; no parameter changes.
2. Validate on your exact broker D1 feed via the CSV loader.
3. Recompute the monthly DSR prospectively after enough forward months.
4. Only if both pass, consider live capital.
5. Portfolio improvements (currency exposure, correlation, vol targeting) are
   new hypotheses and need their own validation.

## File layout

```
launcher.js              # local control workspace server (bun start)
workspace.html           # local control workspace
start.bat                # Windows double-click starter
index.html               # browser benchmark (12 rule variants) using src/*.js
run.html                 # standalone browser port, no modules, phone friendly
.github/workflows/fetch-data.yml  # GitHub Actions data refresh
src/preset.js            # one-command presets (update, walkforward, portfolio, all)
src/fetchBroker.js       # Dukascopy D1 feed download (live, --update)
src/data.js              # JSON/CSV bar loader
src/carry.js             # lagged rate/carry lookup
src/strat.js             # candle types, setups, HTF, targets
src/stats.js             # metrics, bootstrap, deflated Sharpe
src/backtest.js          # single-pair backtest engine
src/sweep.js             # D1 cross-pair sweep
src/walkforward.js       # date-fold walk-forward
src/robustness.js        # per-pair bootstrap/DSR
src/portfolio.js         # multi-pair portfolio engine
src/portfolioRobustness.js # portfolio variants + monthly DSR
src/browser/             # browser-safe copies of the loaders plus benchmark code
STRATEGY.md              # exact mechanical rules
data/                    # broker and rates inputs
results/                 # outputs (gitignored)
```

See `STRATEGY.md` before changing any rule. The rule is frozen for the current
validation cycle.
