# The Strat backtester: detailed explanation

The README is the overview. This file explains how each part of the core
engine works, in the order the data flows through it:

1. [Data and the bar model](#1-data-and-the-bar-model)
2. [Getting signals from bars](#2-getting-signals-from-bars)
3. [The single-pair backtest](#3-the-single-pair-backtest)
4. [The portfolio engine](#4-the-portfolio-engine)
5. [Validation: walk-forward, sweeps, bootstrap, deflated Sharpe](#5-validation)
6. [Reading the numbers](#6-reading-the-numbers)
7. [Simplifications and known biases](#7-simplifications-and-known-biases)

It covers the engine in `src/` only (`data.js`, `strat.js`, `backtest.js`,
`carry.js`, `stats.js`, `portfolio.js`, `walkforward.js`, `sweep.js`,
`robustness.js`, `portfolioRobustness.js`, `fetchBroker.js`). The web pages are
only a front end for these scripts and are not described here.

Rules and numbers here match the code. If this file and the code ever
disagree, the code wins; `STRATEGY.md` is the short rule sheet.

---

## 1. Data and the bar model

### 1.1 What the engine sees

A **bar** (candle) summarizes one period of trading with four prices: Open,
High, Low, Close. This project trades **daily bars (D1)**, so one bar is one
day.

A data file is just a table of bars:

```csv
date,open,high,low,close
2024-01-02,1.10432,1.10651,1.10318,1.10577
2024-01-03,1.10577,1.10890,1.10401,1.10810
```

`data.js` reads this into parallel arrays. Bar number `i` is the same index in
every array:

| Array | Holds |
|---|---|
| `time[i]` | the bar's date as a Unix timestamp (seconds) |
| `open[i]`, `high[i]`, `low[i]`, `close[i]` | the four prices |

Everything else in the engine is arithmetic on those arrays, looking at bar `i`
and earlier or later bars by index.

The spread is not in the file. It is a constant: `--spread-points` times
`--point`. The scripts use 10 points, with a point of `0.00001` (or `0.001` for
JPY pairs), which is 1 pip either way. Pair files are tagged with their symbol
so the right pip size and the right interest rates are used.

The data comes from Dukascopy **bid** prices. The date on each bar is the UTC
date of its timestamp, and the day boundary is Dukascopy's. A different broker
cuts the day at a different hour, so its highs and lows (and therefore which
bars count as inside or outside) can differ slightly. That is why the README
asks you to re-check on your own broker's export.

### 1.2 There are no ticks

A **tick** is a single price update. A real day contains thousands.

The engine uses none. The only prices that exist are the four per bar:
open, high, low, close. There is no sampling, no random path inside the bar,
and no interpolation between the four values.

The consequence is that the engine knows *what* range a bar covered but not
*in what order* the prices happened. Whether the high came before the low is
unknowable from a bar. Every place where order matters is settled by a fixed
rule (listed in [1.5](#15-how-ambiguity-inside-a-bar-is-resolved)), not by
guessing a path.

### 1.3 One decision point per bar: what is known when

Think of bar `i` as a timeline:

```
 close of bar i-1                                          close of bar i
       |-- open of bar i ------------------------------------------|
       |        price wanders; high and low are set               |
       |   (final H, L, C are unknown until the bar ends)          |
```

At the **open** of bar `i`, only bars up to `i-1` are finished. For bar `i`
itself, High, Low and Close are all still equal to the Open: nothing has
happened yet.

The backtest respects that in a specific way. It never feeds bar `i`'s own
high, low or close into any signal that bar `i` trades on. In the code, the
bar being traded is `i` and the bar the signal comes from (the **setup bar**)
is `s = i - 1`:

| Question | Uses | Bar `i` data used? |
|---|---|---|
| What type is the setup bar (1, 2U, 2D, 3)? | bars `s` and `s-1` | No |
| Which setup is it (2-1, 3-1, ...)? | types of `s` and `s-1` | No |
| Where are the trigger and stop? | `high[s]`, `low[s]` | No |
| Is the higher timeframe up or down? | opens and closes up to `s` | No |
| Where is the structural target? | highs/lows of bars `s-20` to `s-1` | No |
| **Did the trade trigger on bar `i`?** | `high[i]`, `low[i]` | **Yes** |
| Fill price | trigger level, or `open[i]` on a gap | `open[i]` only |
| Exit checks on later bars | high/low/open/close of those bars | Yes, they are in the past by then |

So the picture is: at the close of bar `s` the engine computes everything and
"places" two resting orders, a buy stop at `high[s]` and a sell stop at
`low[s]`. Bar `i`'s high and low are then used for one purpose only, to answer
"did the market reach an order that was already waiting".

That is the answer to the "current bar" concern. The engine does not need to
pretend bar `i` has H = L = C = Open at its start, because bar `i`'s own range
is never used to produce a signal. The mistake it avoids is classifying bar `i`
with its final high and low and then trading at its open, which would be using
the future.

The one place a bar's close takes part in a decision is `--entry close` (an
alternative variant, not the default). There the engine waits until bar `i`
has finished, checks that `close[i]` is beyond the trigger, and fills at
`close[i]`. The decision and the fill both happen at that close, so nothing
from after it is used.

### 1.4 How often trades can happen

- **One position per pair at a time.** While a trade is open on a pair, no new
  setup on that pair is looked at.
- **At most one entry check per bar.** The engine looks for an entry once per
  bar, and only if it was flat when the bar began.
- **At most one exit check per bar** for an open position.
- **No same-bar re-entry.** If a trade exits on bar `i`, the loop moves on
  without looking for an entry on bar `i`. The earliest next entry is bar
  `i+1`, with bar `i` as its setup bar.
- **No pyramiding, no partial exits, no reversal in place.** A trade is opened
  whole and closed whole.

In the portfolio, each pair follows its own one-position rule, so up to 16
trades can be open together, subject to the portfolio caps in
[section 4](#4-the-portfolio-engine).

### 1.5 How ambiguity inside a bar is resolved

Because only four prices exist per bar, these conventions stand in for the
unknown order of events:

| Situation | What the engine does | Why |
|---|---|---|
| Bar `i` touches both the buy trigger and the sell trigger | Trade skipped | Cannot tell which came first |
| A gap: bar opens beyond the trigger | Filled at the **open**, not the trigger | You cannot get a better price than where the market opened |
| Stop and target both inside one bar's range (not the entry bar) | **Stop wins** | Pessimistic: assume the worse thing came first |
| A later bar opens beyond the stop | Exit at the **open** (slippage past the stop is included) | A stop order fills at the next available price |
| A later bar opens beyond the target | Exit at the **open** (a favourable gap) | Same logic, in your favour |
| Time limit reached without stop or target | Exit at that bar's **close** | Clean, known price |
| Window ends with a trade still open | Closed at the last bar's close, reason `eod` | The data stops |
| Target would be touched on the **entry bar** | **Not credited**; trade is managed from the next bar | The order of "trigger then target" is unknown |

On the last row, an intrabar entry bar is never checked for an exit. This is
safe for the stop: the stop sits at the opposite trigger level, and touching it
on the same bar would have been the "both triggers hit" case that is skipped
already. So on an entered bar the stop cannot have been hit. Only the target is
left uncredited on that bar, which slightly understates results.

All of the rules above are about price **levels** compared with the bar's high
and low. Spread and other costs are charged separately on the fills; see
[3.6](#36-costs-spread-commission-slippage-swap).

---

## 2. Getting signals from bars

### 2.1 Comparison with indicator-style signals

Most indicators take a **window** of the last `n` bars, run a formula over it,
and output a number. A signal is then a rule on that number.

**Simple moving average (SMA) crossover.** Window of `n` closes, average them.
With closes `10, 11, 12, 13, 14`:

```
SMA3 at the last bar = (12 + 13 + 14) / 3 = 13      (window of 3)
SMA5 at the last bar = (10 + 11 + 12 + 13 + 14) / 5 = 12   (window of 5)
```

Signal: "buy when the fast SMA moves from below the slow SMA to above it."
Compare the two numbers on the previous bar and on this bar; if the order
flipped, that is the cross.

**RSI(n)** works the same way: take the last `n` closes, average the up-moves
and the down-moves, and turn their ratio into a 0-100 number
(`100 - 100 / (1 + avgUp / avgDown)`). Signal: "buy when it crosses back above
30."

**The Strat does the same kind of thing with a very small window.** The window
is **two bars**: the setup bar and the bar before it. The "formula" is not an
average, it is a comparison of highs and lows, and the output is a label
instead of a number:

| | SMA crossover | RSI | The Strat |
|---|---|---|---|
| Window | `n` closes | `n` closes | 2 bars (high and low only) |
| Calculation | average | up/down ratio | is this high above the last high? is this low below the last low? |
| Output | a number | a number | a label: `1`, `2U`, `2D`, `3` |
| Signal | fast crosses slow | crosses a level | a pair of labels (a *setup*) plus a break of the setup bar's high or low |

The rest of this section builds the signal in that order: label each bar,
label the setup from two labels, then wait for a breakout.

### 2.2 Labelling a bar (`classifyCandles`)

For every bar `i` from 1 onward, compare it with bar `i-1`:

```
if  high[i] > high[i-1]  and  low[i] < low[i-1]   ->  '3'   (outside)
elif high[i] > high[i-1]                          ->  '2U'  (up)
elif low[i]  < low[i-1]                           ->  '2D'  (down)
else                                              ->  '1'   (inside)
```

Bar 0 has no previous bar, so it gets no label.

Open and close are not used. Comparisons are strict: a high exactly equal to
the previous high is **not** a new high. So a bar whose high equals the old
high and whose low is higher is a `1`.

**Worked example.** Four bars (prices shortened):

| Bar | High | Low | vs previous bar | Label |
|---|---|---|---|---|
| 1 | 1.1050 | 1.1000 | (first bar, no label) | - |
| 2 | 1.1080 | 1.1010 | high above 1.1050; low 1.1010 is not below 1.1000 | `2U` |
| 3 | 1.1060 | 1.1020 | high not above 1.1080; low not below 1.1010 | `1` |
| 4 | 1.1100 | 1.1030 | high above 1.1060; low 1.1030 is not below 1.1020 | `2U` |

### 2.3 Labelling a setup (`setupAt`)

A **setup** is the label of the last finished bar (the setup bar, `s`)
together with the label of the bar before it. `setupAt` turns that pair into a
name:

| Setup bar `s` | Bar `s-1` | Setup name |
|---|---|---|
| `1` | `2U` or `2D` | `2-1` |
| `1` | `3` | `3-1` |
| `1` | `1` | `1-1` (off by default) |
| `2U` or `2D` | `1` | `1-2` |
| `2U` or `2D` | `3` | `3-2` |
| `2U` or `2D` | `2U` or `2D` | `2-2` |
| `3` | anything | `3` (off by default) |

Only `2-1, 3-1, 1-2, 2-2, 3-2` are traded. Any other name, or a bar with no
usable previous label, produces no trade.

`setupAt` also records the levels the trade will use:

- `triggerHigh = high[s]`: break above this to go long.
- `triggerLow = low[s]`: break below this to go short.
- stop for a long = `low[s]`, stop for a short = `high[s]`.

In the worked example, bar 3 is a `1` after a `2U`, so the setup is **2-1**.
Its trigger high is 1.1060, trigger low is 1.1020. Because the engine has to
look at the previous label, the first bars of a file are skipped: the
backtest needs `s >= 2`.

The setup name does **not** decide the direction. A `2-1` after a `2U` can
still break down, and the engine takes whichever side breaks. Direction comes
from the breakout, described next.

### 2.4 The breakout test on the next bar

On bar `i = s + 1`, with the setup's levels fixed:

```
longHit  = high[i] >= triggerHigh
shortHit = low[i]  <= triggerLow
```

| `longHit` | `shortHit` | Result |
|---|---|---|
| true | false | long candidate |
| false | true | short candidate |
| true | true | **skipped** (cannot tell which came first) |
| false | false | no trade, the market stayed inside the setup bar |

The trigger test uses `>=` and `<=`, so merely touching the level counts,
while the labelling in 2.2 needs a strict break. That small difference is
intentional: a resting stop order fills when price reaches its level.

A candidate then has to pass the higher-timeframe filter before it becomes a
trade.

In the worked example, bar 4's high is 1.1100, which is at least 1.1060, and
its low 1.1030 is above 1.1020. So it is a long candidate. If bar 4 opened at
1.1055, the fill is at the trigger, **1.1060**. If it had opened at 1.1075
(a gap above the trigger), the fill would be at the open, **1.1075**, because
that is where the market actually was.

### 2.5 The higher-timeframe filter (`htfBias`, `htfAllows`)

The filter asks: is the current week up or down so far, and is the current
month up or down so far? It is computed from information up to and including
the setup bar's close, never beyond.

**Colour of a higher-timeframe candle** = compare that candle's open with the
latest close (the setup bar's close):

- close above open: green, value `+1`
- close below open: red, value `-1`
- equal: flat, value `0`

**Calendar mode** (used for D1 whenever the file has valid dates, which the
broker CSVs do):

1. Find the Monday of the setup bar's week. Walk back from `s` to the first
   bar on or after that Monday. Its **open** is the week's open.
2. Find the first bar of the setup bar's calendar month. Its **open** is the
   month's open.
3. Compare each of those opens with `close[s]`.

Example: the setup bar is a Wednesday closing at 1.1040. Monday's open was
1.1000, so the week is green. The month opened on the 1st at 1.0950, so the
month is green. Both green.

This is the **week-to-date** and **month-to-date** candle, not last week's
finished candle. If the setup bar is itself the first bar of its week, the
"week" candle is just that one bar, so its colour is the setup bar's own
open-to-close colour.

**Fixed-block mode** is the fallback when there are no usable dates: the week
is 5 consecutive bars and the month is 21 bars, counted from the start of the
array (`floor(s / block) * block`). It is an approximation and does not line
up with real weeks or holidays.

**Modes** (`--htf`):

| Mode | Long allowed if | Short allowed if |
|---|---|---|
| `continuity` (default) | week `+1` and month `+1` | week `-1` and month `-1` |
| `reversal` | week `-1` and month `-1` | week `+1` and month `+1` |
| `all` (or `none`) | always | always |

If the week and month disagree, or either is flat, `continuity` and `reversal`
both reject the trade. Rejected setups are simply not traded; the engine then
looks at the next bar.

### 2.6 Target and risk size (`structuralTarget`)

Once a candidate passes the filter, the entry price is fixed (2.4), and:

```
stop   = low[s]  (long)   or  high[s]  (short)
risk R = |entry - stop|        (a price distance; 1R)
```

The target for `--target structural` (default):

1. Look at the 20 bars **before the setup bar**: bars `s-20` to `s-1`. The
   setup bar itself is not included.
2. Long: the highest high in that window. Short: the lowest low.
3. If that level is more than `0.5R` beyond the entry in the trade direction,
   use it as the target.
4. Otherwise (too close, or not beyond the entry at all) use
   `entry +/- 2R` instead.

`--target 2r` skips steps 1-3 and always uses `entry +/- 2R`.

Continuing the example: entry 1.1060, stop 1.1020, so `R = 0.0040`. If the
highest high of the prior 20 bars is 1.1150, that is 0.0090 above entry
(2.25R) and clears the 0.5R test, so the target is 1.1150. If it were 1.1070,
only 0.0010 (0.25R) above entry, the target would become
`1.1060 + 2 x 0.0040 = 1.1140`.

There is no cap on how far a structural target can be. The only limit on how
long the trade can wait for it is the 10-bar time exit.

If `R` comes out as zero or not finite, the trade is skipped.

---

## 3. The single-pair backtest

`src/backtest.js` replays one pair's bars from start to finish, one bar at a
time, and records the trades the rule would have taken. It is a loop over
bar indexes, not a tick or event simulator. The "trades" are simulated: no
orders exist, the engine just applies the rules from section 2 and the
conventions from 1.5 to the numbers in the file.

### 3.1 Choosing the window

The loop runs from index `start` to `end`:

- By default `start` is bar 2 (the first bar that can have a two-bar setup
  behind it) and `end` is the last bar.
- `--start-date` / `--end-date` move these to the first bar on or after the
  start date and the last bar on or before the end date.
- `--start` / `--end` do the same using fractions of the file (0.5 = halfway).

Bars **before** `start` are still loaded and still used as history. If the
window begins on 2014-01-01, the setup bar for the first trade can be the last
bar of 2013, and the 20-bar target window and the week/month colours can look
back before the window. What cannot happen is a trade entered before `start`.

### 3.2 The loop, in order

For each bar `i` in the window:

```
1. If a position is open:
       check whether bar i exits it (3.4)
       if it exits: record the trade, position = none
       go to the next bar          <- no entry check on this bar either way
2. Otherwise (flat):
       s = i - 1                   (the setup bar)
       label the setup at s        (2.3); skip if none or not in the allowed set
       compute week/month colours at s (2.5)
       test bar i for a trigger hit (2.4); skip if none or both
       apply the HTF filter; skip if rejected
       work out the entry price (3.3)
       compute stop, risk R, target (2.6); skip if R is 0
       open the position (it is first managed on bar i+1)
```

After the loop, a position still open is closed at the last bar's close with
reason `eod`.

Two things follow from step 1:

- A trade that exits on bar `i` blocks any entry on bar `i`.
- A trade that is entered on bar `i` is not exit-checked on bar `i`
  (1.5), so its first possible exit is bar `i+1`.

### 3.3 Entry price and entry-side costs

| `--entry` | Fill price |
|---|---|
| `intrabar` (default) | Long: `max(open[i], triggerHigh)`. Short: `min(open[i], triggerLow)`. |
| `close` | Only if `close[i]` is beyond the trigger (above `triggerHigh` for a long, below `triggerLow` for a short). Fill at `close[i]`. Otherwise no trade. |

The raw fill price (`entryRaw`) sets the stop distance and the target. A
separate "cost-adjusted" price (`entryNet`) is also stored; it is used only in
the profit calculation (3.5 and 3.6).

### 3.4 How an open trade exits (`checkExit`)

For each bar after the entry bar, in this order. The first rule that matches
decides the exit; a long is shown, a short is the mirror image.

| Order | Test | Exit price | Reason |
|---|---|---|---|
| 1 | `open <= stop` (gapped through the stop) | `open` | stop |
| 2 | `low <= stop` | `stop` | stop |
| 3 | `open >= target` (gapped through the target) | `open` | target |
| 4 | `high >= target` | `target` | target |
| 5 | bars held has reached the limit | `close` | time |

Stop is tested before target in every case, which is the "stop wins if both
are in range" rule.

**Bars held** counts the entry bar as bar 1. With the default limit of 10, a
trade entered on bar `i` that has not hit stop or target is closed at the
close of bar `i+9`. (The first exit check is on bar `i+1`, where bars held is
2.) The time exit is only reached if that same bar did not touch the stop or
target.

### 3.5 Turning a trade into R

Everything is measured in units of **R**, the entry-to-stop distance
(`risk`). This makes trades on different pairs and at different price levels
comparable.

```
grossPrice = direction * (exit - entryRaw)           direction is +1 long, -1 short
grossR     = grossPrice / risk                       before any costs

netPrice   = direction * (exitNet - entryNet)        fills including spread/commission/slippage
             + carryPrice                            interest earned or paid
             - swapPrice                             broker financing fee
netR       = netPrice / risk
costR      = grossR - netR                           total drag (can be negative if carry paid you)
```

A stop-out is about `-1R` gross, a target at 2.5R away is about `+2.5R`
gross. The net numbers are a bit lower, by the costs below.

### 3.6 Costs: spread, commission, slippage, swap

Costs are applied to the **fills**, not to the stop, target and trigger
levels. Those levels are compared directly with the bid-based high and low of
the file.

**Spread, commission, slippage** (per side, entry and exit each):

```
sideCost = spreadPrice / 2  +  price * (commission + slippage)
```

- `spreadPrice` is the constant from 1.1 (1 pip by default). Half is paid on
  entry and half on exit, so a round trip pays one full spread.
- Commission and slippage default to 0.5 basis points each (1 bp =
  0.01% of price), so 1 bp per side combined.
- A long pays more on entry (`entryNet = entryRaw + sideCost`) and receives
  less on exit (`exitNet = exit - sideCost`). A short is the reverse.

**Carry** (rate difference) and **swap** (broker fee), over the bars held:

```
carryAnnual = (base currency 3-month rate) - (quote currency 3-month rate)
carryPrice  = direction * entryRaw * carryAnnual * barsHeld / 252
swapPrice   = entryRaw * 0.2bp * barsHeld          (D1: one bar = one day)
```

- Carry: a long on a pair earns the base rate and pays the quote rate, so it
  gains when `carryAnnual` is positive and loses when negative; a short is the
  opposite. The rates are the previous month's 3-month interbank rates (the
  last value dated before the first of the entry month), held fixed for the
  whole trade. This lag avoids using a rate that was not published yet.
- Swap: a fixed 0.2 bp per day charge that is **always a cost**, in either
  direction.
- Time is counted in bars held divided by 252 trading days. Weekends and the
  usual triple-swap day are not modelled separately.
- If the rate files in `data/rates/` are missing or the pair is not covered,
  the run prints "Rate carry unavailable" and falls back to the flat 0.2
  bp/day swap with no carry.

**Worked example** (illustrative rates). A long on EURUSD: entry 1.1060,
stop 1.1020 (`R = 0.0040`), exit at target 1.1150 after 4 bars. Spread is
1 pip (0.0001). Assume EUR 3.0% and USD 4.5%, so `carryAnnual = -1.5%`.

| Item | Price units | In R |
|---|---|---|
| Gross profit (1.1150 - 1.1060) | +0.0090 | +2.25 |
| Entry cost: 0.00005 + 1.1060 x 0.0001 | -0.00016 | |
| Exit cost: 0.00005 + 1.1150 x 0.0001 | -0.00016 | |
| Spread + commission + slippage total | -0.00032 | -0.08 |
| Carry: 1.1060 x (-0.015) x 4/252 | -0.00026 | -0.07 |
| Swap: 1.1060 x 0.00002 x 4 | -0.00009 | -0.02 |
| **Net** | **+0.0083** | **about +2.08** |

So `grossR = 2.25`, `netR` is about `2.08`, `costR` about `0.17`.

### 3.7 What the summary statistics mean (`stats.js` `summarize`)

After the loop, the trade list is summarized:

| Statistic | How it is computed |
|---|---|
| Trades, long/short | counts |
| Win rate | share of trades with `netR > 0` |
| Avg gross R, avg net R | simple mean over trades. Avg net R is the **expectancy**: what one average trade is worth in R |
| Cost R | `(sum of grossR - sum of netR) / trades` |
| Profit factor | sum of winning `netR` / sum of losing `netR` (absolute) |
| Equity curve | start at 1; for each trade in order, `equity *= 1 + risk% * netR` (risk% is `--risk`, default 1%) |
| CAGR | `equity ^ (1 / years) - 1`, `years = bars in window / 252` |
| Max drawdown | worst `equity / running peak - 1` along that curve |
| Sharpe | `mean(netR) / sd(netR) * sqrt(trades per year)`; a per-trade Sharpe, not one built from daily returns |
| Trades/yr | trades divided by years |
| Exposure | total bars held / bars in window |
| Avg bars held, exits | mean holding time, and counts of `stop`, `target`, `time`, `eod` |

The single-pair equity curve takes trades one after another at fixed risk. It
does not mark open trades to market, so its drawdown is trade-by-trade.
Daily marking is done by the portfolio engine in section 4.

### 3.8 Outputs

Unless `--no-save` is passed, the run writes `results/<label>.json` (config,
stats, every trade) and `results/<label>_trades.csv` (one row per trade:
indexes, dates, setup, direction, entry, exit, stop, target, risk, grossR,
netR, costR, carryR, swapR, bars held, exit reason, week/month colours).
Reading the trades CSV is the quickest way to verify a single trade by hand
against the price file.

---

## 4. The portfolio engine

A **portfolio** here means one account trading many pairs at the same time,
sharing one pool of money and one risk budget. `src/portfolio.js` builds it.

Why it exists: each pair on its own has only a few hundred trades and a noisy
result. Trading 16 pairs together gives more trades and a smoother curve, but
trades overlap, so you cannot just add the per-pair equity curves. Something
has to decide how big each trade is, how many can be open at once, and what
the account was worth on each day. That is this engine.

### 4.1 Step A: generate every pair's trades

For each pair the script runs `backtest.js` (section 3) on the chosen date
window with the frozen rule, then reads back that pair's trade list.

Each pair's list is produced **on its own**, before any portfolio limit is
applied. The portfolio never changes *which* trades the rule generates, only
which of them are taken and how large they are. If the portfolio rejects a
trade, the pair's later trades are not re-planned around it.

### 4.2 Step B: the daily loop

The engine builds a calendar of every date that appears in any pair's file
within the window. For each pair, the close on a date with no bar is carried
forward from the last known close.

The account starts at equity `1` (100%) and each day runs these steps in
order:

| Step | What happens |
|---|---|
| 1. Exits | Trades whose exit date is today are closed. Their open profit is brought up to the exit price (which can be intraday, such as the stop level) and added to realized profit, and half of the trade's cost is charged. |
| 2. Mark to market | Every trade still open is revalued at today's close. Profit moves from "not yet counted" to "unrealized". |
| 3. Entries | Trades whose entry date is today are considered, one at a time, against the limits in 4.4. |
| 4. Mark new trades | Newly opened trades are valued from their entry price to today's close. |
| 5. Equity | `equity = 1 + realized + unrealized`. The day's return is `equity today / equity yesterday - 1`. |

Exits come before entries, so a slot freed today can be reused today.

**Mark-to-market (MTM)** means open trades are revalued at the end of each
day at the market price, even though they have not been closed. Without this,
a drawdown inside a trade would be invisible until it ended.

### 4.3 Sizing a trade

For each new trade:

```
riskAmount = min( riskPerTrade * currentEquity,  maxOpenRisk * currentEquity - openRisk )
size       = riskAmount / R            (R = the trade's price distance entry to stop)
```

Defaults: `riskPerTrade = 0.25%`, `maxOpenRisk = 2%`.

Because size is "risk divided by stop distance", the profit of a trade is
always:

```
profit = size * price move = riskAmount * (price move / R) = riskAmount * (R-multiple)
```

So a full stop-out loses exactly `riskAmount` (0.25% of equity at that time),
and a +2R trade gains `2 x riskAmount`, whatever the pair or price level. No
currency conversion is needed for JPY, CHF or other quote currencies. Since
`riskAmount` uses **current** equity, position sizes grow and shrink with the
account (compounding).

### 4.4 The limits

| Limit | Default | Behaviour |
|---|---|---|
| Max concurrent positions | 8 | When 8 are open, the rest of today's entries are dropped |
| Max total open risk | 2% of equity | `riskAmount` is reduced to fit the room left under the cap |
| Minimum useful size | 20% of the normal risk | If the room left is 20% or less of a normal trade, the trade is dropped instead of being taken tiny |
| One position per pair | built into `backtest.js` | See 1.4 |

`openRisk` is the sum of each open trade's `riskAmount` as it was when the
trade opened. It does not shrink as a trade moves into profit.

With the defaults, 8 positions at 0.25% is exactly 2%, so the two caps
mostly coincide. They separate only because the 2% limit scales with current
equity while open-risk amounts were fixed at entry.

**Priority when several pairs signal on the same day:** entries are processed
in **alphabetical order of pair name** (AUDJPY first). When a limit is reached,
later pairs lose out. This is a simple tie-break, not a ranking of which
setup is better.

There is no limit by currency. EURUSD long, EURJPY long and EURGBP long are
three separate positions that are all, in effect, long EUR. Only the
position and risk caps contain that.

### 4.5 How costs and carry enter the portfolio

Each trade's total cost from `backtest.js` (`costR`, which already includes
spread, commission, slippage, carry and swap) is converted to account terms:
`costAmount = costR * riskAmount`. Half is charged on the entry day and half
on the exit day.

So carry and swap are booked in two halves at the ends of the trade, not
accrued a little each day. The effect on the total is the same; the effect on
the day-to-day equity path is slightly smoothed.

### 4.6 Portfolio metrics

From the list of daily returns:

| Metric | Calculation |
|---|---|
| CAGR | `final equity ^ (252 / days) - 1` |
| Volatility | standard deviation of daily returns x `sqrt(252)` |
| Sharpe | mean daily return / standard deviation x `sqrt(252)`. No risk-free rate is subtracted. |
| Max drawdown | worst `equity / running peak - 1` on the daily equity curve |
| Exposure | share of days with at least one open position (near 100% with 16 pairs) |
| Average / max open | mean and highest number of simultaneous positions |
| Max open risk | highest `openRisk / equity` seen on any day |

**Monthly returns:** daily returns inside each calendar month are compounded
into one number per month. These monthly numbers feed the bootstrap and the
deflated Sharpe in section 5.

**Block bootstrap on months:** the engine builds 5,000 alternative histories
by drawing blocks of 6 consecutive months (wrapping around at the end) until
it has as many months as the real run, and records each alternative's
annualized monthly Sharpe (`mean / sd x sqrt(12)`). The 5th and 95th
percentiles are printed as a plausible range. Blocks (not single months) keep
streaks of good or bad months together. The random generator is seeded, so
the same data gives the same range every time.

**Per-pair contribution:** for each pair, the sum of `riskAmount x netR` of
the trades actually taken, shown as a percent of starting equity. Useful for
seeing whether one pair carries the result.

**Date-fold slices:** CAGR, Sharpe and max drawdown are also printed for four
fixed calendar blocks (2014-2016, 2017-2019, 2020-2022, 2023-2026), skipping
any block with no days in the run. The blocks are written into the code and do
not follow `--start` / `--end`.

### 4.7 Output

`results/portfolio_<tag>.json` holds the settings, metrics, exposure figures,
monthly returns, bootstrap range, and per-pair profit and trade counts.

---

## 5. Validation

Validation is about one question: is the profit in the backtest likely to be
real, or did it come from luck and from tuning the rule to past data?

### 5.1 The problem these tools address

- **Overfitting.** If you try many settings and keep the best-looking one, you
  have mostly found the setting that happened to fit the past noise. It will
  not repeat.
- **Multiple testing.** Even with no tuning, if you look at 5 variants and
  report the best, the best of 5 looks better than a typical one by chance
  alone. Like flipping several coins and showing only the one that landed
  heads five times.
- **In-sample vs out-of-sample.** In-sample data is what you looked at while
  designing the rule. Out-of-sample data is data the rule never influenced.
  Only out-of-sample results are evidence.

The defence used here is to **freeze** the rule (entry, stop, target, filter,
costs, sizing) before judging it, and then apply the tests below without
changing it. Any change after seeing results counts as a new variant and has
to be counted as a trial.

### 5.2 Walk-forward (`walkforward.js`)

**The textbook idea.** Optimize the rule on a block of history (the training
window), test it unchanged on the block right after it (the test window),
then slide both windows forward and repeat. Joining all the test windows gives
a result built only from data the optimizer never saw.

**What this project does.** There are no parameters to optimize, so there is
nothing to train. Instead the date range is cut into equal-length **folds**
(default 4) and the frozen rule is run on each fold separately. It is a
**stability test**: does the same rule earn money in every era, or does one
good stretch carry the total?

How a fold is built:

1. Take the overall `--start` to `--end` span and divide it into `--folds`
   equal spans of calendar time. For 2014-01-01 to 2026-10-29 in 4 folds, the
   first is 2014-01-01 to 2017-03-16, and so on.
2. For each pair and fold, run `backtest.js` with those dates. A trade still
   open at the end of a fold is closed at that bar's close.
3. Pool the trades of all pairs in the fold.

What is reported per fold: trades, win rate, average net R, profit factor,
Sharpe, max drawdown, how many pairs had a positive average, and a trade
bootstrap range (5.4). Then the same for all folds pooled.

Two things to know:

- The pooled equity curve here treats every trade as an independent 1%-risk
  bet, ordered by exit date. It is **not** the portfolio simulation, which is
  in section 4.
- The folds are not truly unseen. The rule was designed by someone who had
  already looked at this history, so passing all folds is encouraging but
  not a clean test. Only data that arrives after the rule was frozen is clean.

### 5.3 Sweep (`sweep.js`)

In general, a **parameter sweep** means running the same test over many
settings (or many instruments) and comparing the results in one table.

Here, `bun run sweep` runs the single-pair backtest for every
`data/*_D1.json` file and for each chosen variant (`default` and `all` unless
told otherwise), reads the printed numbers, and prints one comparison table.
It does not save per-run files by default.

It is a **screening** tool for a quick look across pairs. It is not a
significance test. Picking the best row of a sweep is exactly the overfitting
described in 5.1, which is why the later tests count variants as trials.
(It looks at the `data/` folder's older research files; the broker CSVs are
handled by the walk-forward and portfolio commands.)

### 5.4 Robustness and the trade bootstrap (`robustness.js`)

**Robustness** means: does the result survive when you change small things
or look at it another way, instead of depending on one lucky setting or one
lucky stretch of time?

For one pair, `robustness.js` runs these five pre-specified variants:

| Variant | What changes from the default |
|---|---|
| `default` | continuity filter, structural target, intrabar entry |
| `all` | no higher-timeframe filter |
| `reversal` | trade against the higher timeframe instead of with it |
| `2r` | fixed 2R target instead of structural |
| `close` | enter at the close of the trigger bar instead of intrabar |

These five are the "trials" used in 5.5.

**Trade bootstrap.** Take the default run's list of net R values, one per
trade, and re-draw a new list of the same size by picking trades at random
**with replacement** (a trade can appear twice, another not at all). Compute
the average net R, profit factor and Sharpe of that fake history. Repeat 5,000
times and report the 5th and 95th percentiles.

Reading it: the range shows how much the average could move just from which
trades happened to occur. If the 5th percentile of the average is still above
zero, the positive average is unlikely to be down to a handful of lucky
trades. The method treats trades as independent, so it understates risk when
trades cluster in time. The random generator is seeded, so reruns match.

### 5.5 Deflated Sharpe ratio (DSR) (`stats.js`)

**Sharpe ratio.** Average return divided by the variability of returns. Higher
means more return per unit of ups and downs.

**The idea of deflating.** You tested N variants. Even if none had any real
edge, the best of N would show a positive-looking Sharpe. The DSR asks:
*what is the probability that this strategy's Sharpe is genuinely above the
best Sharpe you would expect from luck alone among N tries?* The output is a
probability between 0 and 1. This project requires **0.95 or more**.

How it is computed (`deflatedSharpeSeries`):

1. Build a **monthly return series** for the default variant and for each of
   the other variants (for a single pair: each month's sum of
   `1% x netR` over trades that exited that month).
2. Compute each variant's monthly Sharpe: `mean / standard deviation` of its
   months, not annualized.
3. **Luck benchmark** `SR0`: scale the spread of those N Sharpes by a factor
   from the statistics of the maximum of N random draws:
   `SR0 = sd(trial Sharpes) x [ (1 - g) x z(1 - 1/N) + g x z(1 - 1/(N e)) ]`,
   where `z` is the inverse of the normal distribution function, `g` is
   0.5772 (Euler-Mascheroni constant) and `e` is 2.718.
4. Take the default variant's monthly Sharpe `SR`, its number of months `T`,
   and the skewness and kurtosis of its months (how lopsided and how
   fat-tailed they are), then:

   ```
   DSR = Phi( (SR - SR0) x sqrt(T - 1) / sqrt(1 - skew x SR + (kurt - 1)/4 x SR^2) )
   ```

   where `Phi` is the normal cumulative distribution (a value to a
   probability).

How to read it:

- A higher default Sharpe, more months, or more tightly clustered trial
  Sharpes push the DSR up.
- More trials, or trials that differ a lot from each other, raise the luck
  benchmark and push it down.
- With fewer than 24 months the monthly version is not used; the code falls
  back to a trade-level version with the same structure.
- Here `N = 5`, a small trial set made of related variants. The penalty is
  therefore mild, and the README says the same.

### 5.6 Portfolio robustness (`portfolioRobustness.js`)

This repeats 5.5 for the portfolio, which is the real object being judged.

1. Run the full portfolio (section 4) once for each of the five variants.
2. Take each run's **monthly portfolio returns** (compounded from daily
   marked-to-market returns), not the simple trade-sum used per pair.
3. Compute each variant's monthly Sharpe and the luck benchmark as above.
4. Compute the DSR of the default portfolio against those five trials.

Printed result: monthly Sharpe, `SR0`, `N`, `T`, DSR, and a PASS or FAIL
against 0.95.

### 5.7 Pre-registration and what the results mean

The test window (2014-2026), the five variants and the 0.95 threshold were
written down **before** the portfolio result was looked at. That is
**pre-registration**: it stops the goalposts from moving afterwards.

- The pre-registered 2014-2026 run scored 0.930, which is below 0.95, so it is
  a **fail**.
- The 2008-2026 run scored 0.992, which passes, but it was chosen after seeing
  the near miss, so it is a robustness check, not a clean confirmation.
- No clean holdout is left on this data. The only clean test now is data from
  after the rule was frozen, which is why the README says to paper trade
  forward and recompute the DSR on that.

### 5.8 Which command answers which question

| Question | Command |
|---|---|
| Does one pair make money under the rule? | `backtest` |
| Which pairs and variants look promising, roughly? | `sweep` |
| Is the result stable across eras? | `walkforward` |
| Could one pair's average be luck from the trade sample? | `robustness` (trade bootstrap) |
| Does one pair pass after counting the variants tried? | `robustness` (monthly DSR) |
| What does the combined account look like, day by day? | `portfolio` |
| Does the combined account pass after counting the variants tried? | `portfolio-robustness` |

---

## 6. Reading the numbers

### 6.1 Checking one trade by hand

Open `results/<label>_trades.csv` and pick any row. To confirm the engine did
what this document says:

1. Take `entryDate`. The setup bar is the bar **before** it in the price file.
2. Label the setup bar and the bar before it (2.2, 2.3). It should match the
   `setup` column.
3. The setup bar's high and low should equal the trigger levels. `stop` should
   be the opposite one, and `risk` should be `|entry - stop|`.
4. On `entryDate`, the high (long) or low (short) should reach the trigger.
   `entry` is the trigger, or that day's open if it gapped past it.
5. Walk the following bars. The exit should be the first bar that reaches the
   stop or target (stop first), or the bar where bars held reaches 10.
6. `grossR = direction x (exit - entry) / risk`. `netR` is that minus the costs
   in 3.6.

### 6.2 Win rate is not the edge

Expectancy is what one average trade is worth in R:

```
expectancy = win rate x average win - loss rate x average loss      (all in R)
```

Illustration (made-up round numbers): winning 45% of the time with an average
win of 2.2R and an average loss of 1.0R gives
`0.45 x 2.2 - 0.55 x 1.0 = +0.44R`. A system can win under half its trades
and still be profitable, or win most trades and lose money, depending on the
size of wins against losses. This is why the tables lead with average net R
and profit factor, not win rate.

Expectancy times trades per year gives yearly R. Multiply by the risk per
trade (1% single-pair, 0.25% portfolio) to get a rough yearly return before
compounding and overlap.

### 6.3 How the headline numbers relate

| Number | What it tells you | Watch for |
|---|---|---|
| Avg net R | edge per trade after costs | below roughly 0.05R, costs or noise can erase it |
| Profit factor | total won / total lost | close to 1 means thin margin |
| CAGR | yearly growth | depends on the risk setting you chose, not only on the rule |
| Volatility | typical yearly swing | sets how rough the ride feels |
| Sharpe | CAGR-like return per unit of volatility | very high values deserve suspicion; 1 to 1.5 is already good |
| Max drawdown | worst fall from a peak | the real test of whether you would stick with it |
| Monthly bootstrap range | how much Sharpe could differ with other luck | a wide range means a weaker conclusion |
| DSR | chance the Sharpe is real after counting trials | needs 0.95 here |

CAGR and drawdown move together when you change the risk per trade (doubling
the risk roughly doubles both). Sharpe and DSR do not change with risk size,
which is why the pass/fail gate uses them.

---

## 7. Simplifications and known biases

Things the engine does not model, or models roughly. Each one can push real
results away from the backtest.

**Price path and fills**

- Only four prices per bar; no ticks. Same-bar order is decided by the rules
  in 1.5, not by data.
- Days where both triggers are touched are skipped. These are large-range
  days, so a type of day is systematically missing.
- A target touched on the entry bar is not credited (slightly pessimistic).
- Triggers, stops and targets are compared with **bid** highs and lows. A real
  buy stop fires on the ask, which is the bid plus the spread. The spread is
  charged as a cost instead of shifting the trigger.
- The spread is a fixed 1 pip for every pair and every year. Real spreads are
  wider on crosses, in 2008-style stress, and around rollover and news.
- Entry on a gap uses the open, so `R` can be larger than the setup bar's
  range, which the engine accepts.
- Stop and target fills are at the exact level (or the open on a gap). In fast
  markets, real stop fills can be worse.

**Time and data**

- The daily candle boundary is the data vendor's. Your broker's may differ.
- Calendar week and month open use the first bar present in the file on or
  after Monday or the 1st; holidays are not specially handled.
- The last row in a live file may be a partial day. Do not trust a signal on
  it until the day has closed.

**Costs**

- Carry uses previous-month 3-month interbank rates held for the whole trade,
  scaled by bars held / 252. Broker swap tables, weekend and triple-swap days
  are not modelled. If the rate files are missing, there is only a flat 0.2
  bp/day charge and no carry.
- In the portfolio, cost (including carry and swap) is booked in two halves,
  at entry and at exit.

**Portfolio**

- Entries are prioritized alphabetically by pair when limits bind.
- There is no cap by currency or correlation, so several positions can be the
  same bet.
- A pair's trades are generated before portfolio limits; rejected trades do
  not let that pair take a different trade.
- Sizes use equity at entry. There is no volatility targeting.

**Statistics**

- The trade bootstrap treats trades as independent. Real trades cluster.
- The DSR counts only five related variants, so the correction is mild.
- The walk-forward folds were not truly unseen (5.2), and the full-history
  pass was run after the pre-registered window failed (5.7).
- The single-pair equity curve and the walk-forward pooled curve do not
  account for overlap or daily marking; only the portfolio does.