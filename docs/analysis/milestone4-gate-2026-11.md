# Milestone 4 gate re-run — 2026-11, Tier 1 fees, post look-ahead fixes

Tier 1: 0.40% maker + 0.80% taker + 0.1% spread/slippage = **1.3% round trip** — applied to every actual fill in both variants below (previously the simulated fill always used broker/paper.js's own hardcoded defaults regardless of config; the look-ahead fix commit added the additive wiring that makes this override possible).

Run after fixing two look-ahead bugs in src/broker/paper.js / src/backtest/run.js / src/scheduler/cycle.js (trailing-stop same-candle sequencing; the entry bar's own hourly candles leaking into the very first post-entry exit check). Windows end 2026-11-24.

Gate criterion (CLAUDE.md / docs/v2-design.md): a setup passes if it has 30+ trades and positive expectancy (R) after fees.

**Two variants, because the pre-trade fee-viability gate (atrPct >= roundTripFeePct × feeViabilityMultiple) and the fee actually charged on a fill are separate config fields:**

- **Tier-1-consistent**: the gate ALSO uses the 1.3% Tier 1 round trip (so it only admits candidates whose typical 4h move is >= 5.2%) — fully consistent with "re-run under Tier 1", but a much stricter admission bar than production uses today.
- **Production gate**: the gate stays at production's current 0.65% round trip (admits candidates whose move is >= 2.6%, exactly what the live system would consider today) — only the fill itself is charged at the real Tier 1 rate. This answers "what would the system actually do today, correctly, at real Tier 1 cost."

## Tier-1-consistent gate (strict admission)

### Last 6 months (from 2026-05-24)

Total trades across all setups: 0. Final balance: £1000.00 (started £1000).

| Row | Trades | Win rate | Net %/trade | Expectancy R | Gate (30+, R>0) |
|---|---|---|---|---|---|
| trend_breakout | 0 | n/a | n/a | n/a | n/a (0 trades) |
| trend_pullback | 0 | n/a | n/a | n/a | n/a (0 trades) |
| range_reversion | 0 | n/a | n/a | n/a | n/a (0 trades) |
| oversold_bounce | 0 | n/a | n/a | n/a | n/a (0 trades) |
| ALL | 0 | n/a | n/a | n/a | n/a (0 trades) |

| Benchmark | Return % | Max drawdown % | Trades |
|---|---|---|---|
| BTC buy-and-hold | -21.50% | 31.17% | 1 |
| BTC 200-day EMA rule | 2.78% | 14.68% | 2 |

### Last 2 years (from 2024-11-24)

Total trades across all setups: 7. Final balance: £1006.07 (started £1000).

| Row | Trades | Win rate | Net %/trade | Expectancy R | Gate (30+, R>0) |
|---|---|---|---|---|---|
| trend_breakout | 0 | n/a | n/a | n/a | n/a (0 trades) |
| trend_pullback | 1 | 100% | 15.29% | 1.95R | FAIL |
| range_reversion | 6 | 33% | -0.40% | -0.11R | FAIL |
| oversold_bounce | 0 | n/a | n/a | n/a | n/a (0 trades) |
| ALL | 7 | 43% | 1.84% | 0.18R | FAIL |

| Benchmark | Return % | Max drawdown % | Trades |
|---|---|---|---|
| BTC buy-and-hold | -42.49% | 52.16% | 1 |
| BTC 200-day EMA rule | -19.17% | 32.31% | 15 |

### Last 4 years (from 2022-11-24)

Total trades across all setups: 14. Final balance: £1059.74 (started £1000).

| Row | Trades | Win rate | Net %/trade | Expectancy R | Gate (30+, R>0) |
|---|---|---|---|---|---|
| trend_breakout | 1 | 0% | -12.43% | -1.13R | FAIL |
| trend_pullback | 6 | 100% | 18.08% | 2.15R | FAIL |
| range_reversion | 7 | 43% | 0.92% | 0.02R | FAIL |
| oversold_bounce | 0 | n/a | n/a | n/a | n/a (0 trades) |
| ALL | 14 | 64% | 7.32% | 0.85R | FAIL |

| Benchmark | Return % | Max drawdown % | Trades |
|---|---|---|---|
| BTC buy-and-hold | 231.46% | 52.16% | 1 |
| BTC 200-day EMA rule | 47.25% | 50.10% | 44 |

## Production gate, Tier 1 fills

### Last 6 months (from 2026-05-24)

Total trades across all setups: 10. Final balance: £969.35 (started £1000).

| Row | Trades | Win rate | Net %/trade | Expectancy R | Gate (30+, R>0) |
|---|---|---|---|---|---|
| trend_breakout | 1 | 0% | -5.29% | -1.01R | FAIL |
| trend_pullback | 8 | 13% | -3.90% | -0.69R | FAIL |
| range_reversion | 0 | n/a | n/a | n/a | n/a (0 trades) |
| oversold_bounce | 1 | 100% | 2.52% | 0.70R | FAIL |
| ALL | 10 | 20% | -3.40% | -0.58R | FAIL |

| Benchmark | Return % | Max drawdown % | Trades |
|---|---|---|---|
| BTC buy-and-hold | -21.50% | 31.17% | 1 |
| BTC 200-day EMA rule | 2.78% | 14.68% | 2 |

### Last 2 years (from 2024-11-24)

Total trades across all setups: 21. Final balance: £907.87 (started £1000).

| Row | Trades | Win rate | Net %/trade | Expectancy R | Gate (30+, R>0) |
|---|---|---|---|---|---|
| trend_breakout | 2 | 0% | -8.89% | -1.19R | FAIL |
| trend_pullback | 8 | 25% | -2.20% | -0.47R | FAIL |
| range_reversion | 11 | 0% | -7.17% | -1.18R | FAIL |
| oversold_bounce | 0 | n/a | n/a | n/a | n/a (0 trades) |
| ALL | 21 | 10% | -5.44% | -0.91R | FAIL |

| Benchmark | Return % | Max drawdown % | Trades |
|---|---|---|---|
| BTC buy-and-hold | -42.49% | 52.16% | 1 |
| BTC 200-day EMA rule | -19.17% | 32.31% | 15 |

### Last 4 years (from 2022-11-24)

Total trades across all setups: 105. Final balance: £935.23 (started £1000).

| Row | Trades | Win rate | Net %/trade | Expectancy R | Gate (30+, R>0) |
|---|---|---|---|---|---|
| trend_breakout | 21 | 33% | -1.68% | -0.20R | FAIL |
| trend_pullback | 42 | 31% | -0.07% | -0.06R | FAIL |
| range_reversion | 34 | 44% | 0.06% | -0.07R | FAIL |
| oversold_bounce | 8 | 0% | -2.65% | -0.88R | FAIL |
| ALL | 105 | 33% | -0.55% | -0.15R | FAIL |

| Benchmark | Return % | Max drawdown % | Trades |
|---|---|---|---|
| BTC buy-and-hold | 231.46% | 52.16% | 1 |
| BTC 200-day EMA rule | 47.25% | 50.10% | 44 |

## Summary

**Tier-1-consistent gate:**

- **Last 6 months**: no setup passes; no trades: trend_breakout, trend_pullback, range_reversion, oversold_bounce.
- **Last 2 years**: no setup passes; failing: trend_pullback, range_reversion; no trades: trend_breakout, oversold_bounce.
- **Last 4 years**: no setup passes; failing: trend_breakout, trend_pullback, range_reversion; no trades: oversold_bounce.

**Production gate, Tier 1 fills:**

- **Last 6 months**: no setup passes; failing: trend_breakout, trend_pullback, oversold_bounce; no trades: range_reversion.
- **Last 2 years**: no setup passes; failing: trend_breakout, trend_pullback, range_reversion; no trades: oversold_bounce.
- **Last 4 years**: no setup passes; failing: trend_breakout, trend_pullback, range_reversion, oversold_bounce.

Full per-row data: `docs/analysis/data/milestone4-gate-tier1-consistent.csv`, `milestone4-gate-production-gate.csv`.
