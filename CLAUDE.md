# Crypto Dashboard + Freqtrade — Full System

Two systemd services on a Raspberry Pi. **Cryptodash** (Node.js) fetches market data, computes indicators, generates Claude AI signals, and serves a web dashboard. **Freqtrade** (Python) reads those signals and executes trades on Kraken.

```
┌─────────────────────────────────────────────────────────┐
│                    Raspberry Pi                          │
│  ┌──────────────────────┐   signals.json  ┌──────────┐  │
│  │  crypto-dashboard    │ ──────────────► │freqtrade │  │
│  │  Node.js  :3000      │                 │Python    │  │
│  │  (watchlist, signals,│                 │:8080/:8081│ │
│  │   scanner, backtest) │                 │(dry-run) │  │
│  └──────────────────────┘                 └──────────┘  │
│           │ SQLite (candles)                    │        │
│           │ Binance API (USDT)          Kraken API (GBP) │
└─────────────────────────────────────────────────────────┘
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime (cryptodash) | Node.js (v20) |
| Web framework | Express |
| Database | SQLite via `better-sqlite3` (synchronous) |
| Scheduling | `node-cron` |
| Frontend | Vanilla JS + HTML (`public/index.html`) |
| AI signals | Anthropic API (`claude-haiku-4-5-20251001`) |
| Runtime (Freqtrade) | Python, virtualenv at `/home/gallus23/freqtrade/.venv` |
| Freqtrade version | 2026.5.1 |

---

## Environment Variables (cryptodash)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API for signal generation |
| `PORT` | No | 3000 | HTTP server port |
| `DB_PATH` | No | `data/crypto.db` | Override SQLite path |
| `FREQTRADE_USERNAME` | No | `cryptodash` | MR FT API username |
| `FREQTRADE_PASSWORD` | No | `Swagger23!` | MR FT API password |
| `FREQTRADE_TREND_USERNAME` | No | same | TF FT API username |
| `FREQTRADE_TREND_PASSWORD` | No | same | TF FT API password |

Git repo: `https://github.com/gallus23-coder/cryptodash`

---

## Systemd Services

```bash
sudo systemctl restart crypto-dashboard && journalctl -u crypto-dashboard -f
sudo systemctl restart freqtrade && journalctl -u freqtrade -f
sudo systemctl restart freqtrade-trend && journalctl -u freqtrade-trend -f
journalctl -u crypto-dashboard -u freqtrade -u freqtrade-trend -f
```

| Service | Strategy | Port |
|---------|----------|------|
| `crypto-dashboard.service` | Node.js dashboard | 3000 |
| `freqtrade.service` | Mean Reversion | 8080 |
| `freqtrade-trend.service` | Trend Following | 8081 |

---

## Project File Structure

```
crypto-dashboard/
├── server.js               — Express app, cron jobs, all API routes
├── db.js                   — SQLite schema, candle CRUD, RSI, signal_history
├── binance.js              — Binance API: fetchTicker, backfillCandles, fetchNewCandles
├── coingecko.js            — CoinGecko: fetchMetadata, refreshMarketCaps
├── indicators.js           — Pure indicator math: EMA, MACD, Bollinger, StochRSI, VolumeRatio, ATR
├── feargreed.js            — Alternative.me Fear & Greed API
├── scanner.js              — Opportunity scanner: Tier 0 / Tier C detection, scoring
├── backtest.js             — Backtesting: incremental indicators, signal scoring, simulation
├── lib/freqtradeClient.js  — Authenticated FT API clients (meanReversionClient / trendClient, 30s cache)
├── CryptodashStrategy.py   — MR strategy copy (canonical: /home/gallus23/freqtrade/user_data/strategies/)
├── CryptodashTrendStrategy.py — TF strategy copy (canonical same dir)
├── public/index.html       — Full frontend (single file)
└── data/
    ├── crypto.db           — SQLite: candles, coin_meta, signal_history, derivatives_history
    ├── watchlist.json      — Persisted watchlist (CoinGecko IDs)
    ├── signals.json        — Anthropic signal cache (READ by Freqtrade)
    ├── indicators.json     — Indicator cache per coin (includes priceGBP)
    ├── rsi.json            — RSI cache
    ├── feargreed.json      — Fear & Greed (refreshed hourly)
    ├── fxrate.json         — GBP/USD rate cache (refreshed hourly)
    ├── kraken_pairs.json   — Kraken GBP pairs cache (24h)
    ├── scanner.json        — Scanner results (last 24 scans)
    └── backtest.json       — Latest backtest results
```

Freqtrade paths:
- MR config: `/home/gallus23/freqtrade/user_data/config.json`
- TF config: `/home/gallus23/freqtrade/user_data/config_trend.json`
- MR log: `/home/gallus23/freqtrade/user_data/logs/freqtrade.log`
- TF log: `/home/gallus23/freqtrade/user_data/logs/freqtrade_trend.log`

---

## Database Schema

### `candles`

```sql
CREATE TABLE candles (
  coin_id  TEXT NOT NULL, interval TEXT NOT NULL,
  time INTEGER NOT NULL,  -- Unix ms (candle open time)
  open REAL, high REAL, low REAL, close REAL,
  volume REAL NOT NULL,   -- base asset volume (k[5] from Binance kline, NOT k[7]/quote)
  UNIQUE (coin_id, interval, time)
);
```

Intervals stored: `1h` (90d) and `1m` (7d). Aggregated (5m/15m/4h/1d) computed on-the-fly.

**Volume note**: always `k[5]` (base asset). `k[7]` (USDT quote volume) must NOT be used.

### `signal_history`

```sql
CREATE TABLE signal_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin_id TEXT NOT NULL, timestamp TEXT NOT NULL,  -- ISO 8601 UTC
  signal TEXT NOT NULL,  -- strong_buy / buy / hold / sell / strong_sell
  market_phase TEXT,     -- 'bull' or 'bear'
  rsi REAL, macd_hist REAL, volume_ratio REAL,
  price_usd REAL, price_gbp REAL,
  derivatives_context TEXT, summary TEXT
);
CREATE INDEX idx_sighist_cit ON signal_history(coin_id, timestamp DESC);
```

Append-only. Logged on **every** `updateSignals()` write cycle (~15 min per coin), whether or not the Anthropic API was called (cache-hit cycles reuse signal/summary fields with a fresh timestamp). This is required for `confirmed_strong_sell()` to have data density. `db.insertSignalHistory(row)`.

### `derivatives_history`

```sql
CREATE TABLE derivatives_history (
  coin_id TEXT NOT NULL, time INTEGER NOT NULL,
  funding_rate REAL, open_interest REAL,  -- Binance USDT-M perp
  UNIQUE(coin_id, time)
);
```

Populated every 15 min. Pruned to 7 days at midnight. Only coins with USDT-M perp contracts.

### `coin_meta`

```sql
CREATE TABLE coin_meta (
  id TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL,
  image TEXT NOT NULL, market_cap REAL,
  meta_fetched_at INTEGER NOT NULL, market_cap_updated_at INTEGER NOT NULL
);
```

---

## Data Sources

**Binance** (public, no key): `https://api.binance.com`
- Live prices: `GET /api/v3/ticker/24hr?symbol=BTCUSDT`
- OHLCV: `GET /api/v3/klines?symbol=BTCUSDT&interval=1h&limit=N`

**Binance Futures** (public): `https://fapi.binance.com`
- Funding rate: `GET /fapi/v1/premiumIndex?symbol=BTCUSDT` → `lastFundingRate`
- Open interest: `GET /fapi/v1/openInterest?symbol=BTCUSDT`

**CoinGecko** (free tier): metadata + market caps. Rate-limited ~1 req/sec; 1.2s delay.

**Alternative.me**: `GET https://api.alternative.me/fng/?limit=1` → Fear & Greed value 0–100.

**Anthropic API**: `claude-haiku-4-5-20251001`, 800 tokens (watchlist), 200 (scanner).

---

## Coin Identity

Watchlist stores CoinGecko IDs (`bitcoin`, `avalanche-2`). Binance symbols resolved via `SYMBOL_MAP` in `binance.js`, fallback: `cgSymbol + USDT`. Stored in `coin_meta.symbol`.

---

## Technical Indicators (`indicators.js`)

Pure math, no I/O, arrays oldest-first.

| Indicator | Function | Settings |
|-----------|----------|----------|
| EMA | `calcEMA(values, period)` | Any period; seeded from SMA |
| MACD | `calcMACD(closes)` | 12/26/9; EMA26 starts at `i >= 26` |
| Bollinger | `calcBollingerBands(closes)` | 20-period, population variance (÷20) |
| StochRSI | `calcStochRSI(closes)` | 14/14/3/3 |
| Volume Ratio | `calcVolumeRatio(volumes)` | current ÷ avg(last 20) |
| ATR | `calcATR(candles, 14)` | avg(high−low) over 14 |

**Completed-candle rule (CRITICAL)**: All indicator calculations use the last **completed** candle, not the currently-forming one. Fetch N+1 candles, call `.slice(0, -1)` before any calculation. Applies in `updateIndicators`, `updateRSI`, and `scanner.js buildCandidate`. Violating this skews volumeRatio significantly.

`scanner.js` implements `calcRSI14` and `calcEMAAligned` (series-level, for crossover detection) locally.

---

## Data Flow

### Cron schedule

| Schedule | Runs |
|----------|------|
| `* * * * *` | `checkAlerts()` + `update1mCandles()` |
| `*/15 * * * *` | `updateCandles()` → `updateRSI()` → `updateIndicators()` → `updateSignals()` |
| `0 * * * *` | `updateFearGreed()` |
| `5 * * * *` | `updateScanner()` |
| `0 0 * * *` | `refreshAllMarketCaps()` + `pruneCandles('1m', 7d)` + `pruneDerivatives(7d)` |

### 15-min chain

1. `updateCandles()` — fetch new 1h candles from Binance
2. `updateRSI()` — recalculate RSI-14 → `rsi.json`
3. `updateIndicators()` — MACD, Bollinger, EMA50/200, StochRSI, volume ratio, ATR-14, GBP/USD rate, Binance Futures funding+OI → `indicators.json` (includes `priceGBP`)
4. `updateSignals()` — per coin: fetch live ticker; check `_lastSignalCandle` Map against latest closed 1h candle timestamp. **Cache hit**: skip Anthropic call, update `updatedAt`, still write `signal_history` row. **Cache miss** (new candle): call Claude, cache result. Writes `signals.json` atomically. Cuts API calls from ~576/day to ~96/day.

`signals.json` is the **signal bridge** — Freqtrade reads it on every 1h candle close.

### Startup sequence

```
initDb() → seedAndBackfill() [CoinGecko meta + 90d/7d backfill]
  +2s → checkAlerts()
  +4s → updateCandles() → updateRSI() → updateIndicators() → updateSignals()
  +6s → updateFearGreed()
  +10s → updateScanner()
```

---

## Candle Aggregation

`/api/candles/:coinId?interval=` — fixed depth windows:

| Interval | Source | Depth |
|----------|--------|-------|
| `1m` | Native SQLite | 24h |
| `5m` / `15m` | Aggregated from `1m` | 7d |
| `1h` | Native SQLite | 90d |
| `4h` / `1d` | Aggregated from `1h` | 90d |

---

## Claude Signal Generation

### Watchlist signals (`updateSignals`)

System prompt built by `buildSignalSystem(btcPhase)`. Phase from `indCache['bitcoin'].emaAbovePrice`.

**Phase-adaptive strategy parameters:**

| Parameter | Bear (BTC < EMA200) | Bull (BTC > EMA200) |
|-----------|---------------------|---------------------|
| RSI range | 34–49 | 32–53 |
| StochRSI %K | < 17 | < 39 |
| Volume ratio | ≥ 1.7× | ≥ 1.8× |
| EMA50 distance | ≤ 6.2% | ≤ 1.2% |
| Stop loss | 5% | 7% |
| Take profit | 15% | 20% |
| Time stop | 89h | 67h |

Signal scale: `strong_buy` (all 6 met) → `buy` (5/6) → `hold` → `sell` → `strong_sell`

**Returns extended JSON** stored in `signals.json`:
```json
{
  "signal": "strong_buy",
  "summary": "...",
  "entryQuality": { "allCriteriaMet": true, "marginalCriteria": [], "failingCriteria": [] },
  "riskAssessment": { "stopLossRisk": "low", "takeProfitReachable": true, "timeStopRisk": "medium", ... },
  "newsImpact": "none",
  "newsNote": null,
  "derivativesContext": "...",
  "updatedAt": "2026-07-28T12:00:00.000Z"
}
```

If `entryQuality`/`riskAssessment` absent (old cache or parse failure) → stored as `null`; UI degrades gracefully; Freqtrade won't enter (allCriteriaMet treated as false).

`derivativesContext` is qualitative only — NOT a hard entry gate. Displayed separately in explain panel.

**IMPORTANT — keep in sync with Freqtrade:** `WATCHLIST_SIGNAL_SYSTEM` in `server.js` must match `CryptodashStrategy.py` entry criteria and `config.json` parameters.

### Scanner signal (`updateScanner`)

Called once per scan for the winner only. Returns `{ signal, summary }`. Not read by Freqtrade.

---

## Freqtrade Integration

### Instances

| Instance | Strategy | Port | Config | Service |
|----------|----------|------|--------|---------|
| Mean Reversion | `CryptodashStrategy` | 8080 | `config.json` | `freqtrade.service` |
| Trend Following | `CryptodashTrendStrategy` | 8081 | `config_trend.json` | `freqtrade-trend.service` |

Both credentials: username `cryptodash` / password `Swagger23!`

### Pair → CoinGecko ID mapping (both strategies)

| Freqtrade pair | signals.json key |
|----------------|------------------|
| BTC/GBP | `bitcoin` |
| ETH/GBP | `ethereum` |
| SOL/GBP | `solana` |
| XRP/GBP | `ripple` |
| ADA/GBP | `cardano` |
| BNB/GBP | `binancecoin` |
| LINK/GBP | `chainlink` |

### Mean Reversion (`config.json`)

| Parameter | Value |
|-----------|-------|
| `stoploss` | `-0.07` (compromise; bear 5%, bull 7%) |
| `minimal_roi` | `{"0": 0.20}` (bull; bear 15% via signal reversal) |
| `max_open_trades` | `2` |
| `stake_amount` | `200` (£200) |
| `dry_run_wallet` | `1000` |

**MR entry** (all must be true):
1. Signal `"strong_buy"` + `entryQuality.allCriteriaMet === true`
2. Signal age < 20 min (`MAX_SIGNAL_AGE_MINUTES = 20`)
3. Phase via `get_market_phase(dataframe)` → `get_phase_params(phase)`
4. Belt-and-braces dataframe: `close > ema200`, RSI in range, StochRSI < threshold, volume_ratio ≥ threshold, ema50_dist_pct ≤ threshold, `macd > 0 AND macd_hist > 0`, `volume > 0`

Entry tag: `cryptodash_bull_strong_buy` or `cryptodash_bear_strong_buy`

**MR exits:**

| Reason | Mechanism |
|--------|-----------|
| `stoploss` | Freqtrade built-in, -7% |
| `roi` | Freqtrade built-in, +20% |
| `time_stop_67h` / `time_stop_89h` | `custom_exit`: bull/bear phase > 67h/89h |
| `signal_reversal` | `custom_exit`: signal becomes `sell` or `strong_sell` |

Phase for exit always read from `trade.enter_tag`, not re-evaluated.

### Trend Following (`config_trend.json`)

| Parameter | Value |
|-----------|-------|
| `stoploss` | `-0.05` (static; custom_stoploss overrides above 5% profit) |
| `trailing_stop` | `false` (MUST remain false — `use_custom_stoploss = True` handles trailing) |
| `minimal_roi` | `{"240": 0.03, "480": 0.02, "720": 0.015, "960": 0.008}` (fallback only) |
| `use_custom_roi` | `True` — adaptive via `custom_roi()` |
| `use_custom_stoploss` | `True` — trailing via `custom_stoploss()` |
| `max_open_trades` | `2` |
| `stake_amount` | `200` (£200) |
| `dry_run_wallet` | `1000` |
| `api_server.listen_port` | `8081` |

**TF entry** (all must be true):
1. Signal is NOT `sell`/`strong_sell` + age < 20 min (`hold`/`buy`/`strong_buy` all qualify; does NOT require `allCriteriaMet`)
2. `close > ema200` AND `close > ema50`
3. `rsi >= 45 AND rsi <= 70`
4. `macd > 0 AND macd_hist > 0`
5. `volume_ratio >= 1.2`

Entry tag: `cryptodash_trend_entry`

**TF exits:**

| Reason | Mechanism |
|--------|-----------|
| `stoploss` | -5% (static floor; custom_stoploss takes over above 5% profit) |
| `roi` | `custom_roi()`: adaptive by phase; no exit before 240 min |
| `trend_time_stop_16h` | `custom_exit`: trade open > 16h |
| `trend_signal_reversal` | `custom_exit`: `confirmed_strong_sell()` returns True |

**Trailing stop (`custom_stoploss`)**: Below 5% profit → fixed -5% unchanged. Above 5% → trails behind `trade.max_rate`:

| Phase | ≥ 5% profit | ≥ 8% profit (bear) / ≥ 10% (bull) | ≥ 12% profit (bear) / ≥ 15% (bull) |
|-------|------------|-------------------------------------|--------------------------------------|
| Bull | -4% | -3% | -2% |
| Bear | -3% | -2.5% | -2% |

**CRITICAL**: `trailing_stop = False` in BOTH strategy class and `config_trend.json`. Never enable both `trailing_stop` and `use_custom_stoploss`.

**Signal reversal confirmation (`confirmed_strong_sell`)**: Reads `signal_history` table (read-only SQLite, `sqlite3` stdlib). Returns `True` only when the last `MIN_CONFIRMATION_READS` (2) rows for that coin are ALL `signal == 'strong_sell'` — **row-count based, not time-window based**. (A prior time-window version using a 10-min window became unsatisfiable after API caching reduced write cadence; fixed by switching to row-count.) Fail-safe: any DB error → logs warning, returns `False`. Never exits on uncertainty.

**Adaptive ROI (`custom_roi`)**: Returns `None` before 240 min (no exit in first 4h). `custom_exit` also enforces 240 min minimum hold independently.

Bear ROI (BTC < EMA200): 240m→3%, 480m→2%, 720m→1.5%, 900m→0.8% (fits 16h time stop)
Bull ROI (BTC > EMA200): 240m→8%, 480m→5%, 720m→3%, 960m→1.5%, 1440m→0.8%

Phase detected from BTC's `summary` field in `signals.json`. Bear targets calibrated from 13 live dry-run trades (Jun–Jul 2026): max peak gain 3.98%, median ~0.85%, fee round-trip ~0.8%.

### Strategy Comparison

| | Mean Reversion | Trend Following |
|---|---|---|
| Signal required | `strong_buy` + `allCriteriaMet` | Any non-sell |
| Price vs EMA200 | Above | Above |
| Price vs EMA50 | Within 6.2% (bear) / 1.2% (bull) | Above |
| RSI | 34–49 / 32–53 | 45–70 |
| MACD | Positive | Positive + histogram |
| StochRSI | < 17 / < 39 | Not checked |
| Volume | ≥ 1.7× / ≥ 1.8× | ≥ 1.2× |
| Stop loss | -7% static | -5% static; trailing above 5% profit |
| Take profit | 20% (bull) / 15% (bear) | adaptive `custom_roi` |
| Time stop | 89h / 67h | 16h |
| Minimum hold | None | 240 min |
| Signal reversal | sell or strong_sell | confirmed_strong_sell (last 2 rows) |
| Phase adaptive | Entry + exit params | ROI + trailing tiers only |

### Freqtrade Useful Commands

```bash
cd /home/gallus23/freqtrade && source .venv/bin/activate
freqtrade list-strategies --userdir user_data
freqtrade show-trades --config user_data/config.json
freqtrade show-trades --config user_data/config_trend.json
```

---

## Parameters That Must Stay in Sync

Drift between cryptodash and Freqtrade will cause signal evaluation vs. trade execution mismatch.

| Parameter | cryptodash | Freqtrade |
|-----------|-----------|-----------|
| Phase detection | `buildSignalSystem(btcPhase)` in `server.js` | `get_market_phase()` in `CryptodashStrategy.py` |
| Bear SL 5% / Bull SL 7% | `buildSignalSystem()` | `get_phase_params()` in `CryptodashStrategy.py` |
| Bear TP 15% / Bull TP 20% | `buildSignalSystem()` | `minimal_roi` in `config.json` |
| Bear time stop 89h / Bull 67h | `buildSignalSystem()` | `get_phase_params().time_stop` |
| Signal freshness 20 min | (signals refresh every 15 min) | `MAX_SIGNAL_AGE_MINUTES = 20` in both strategies |
| Bear/bull entry criteria | `buildSignalSystem()` | `get_phase_params()` in `populate_entry_trend` |

---

## Currency Mismatch — Critical Gotcha

**cryptodash indicators are in USD. Freqtrade trades in GBP.**

All OHLCV candles, RSI, MACD, prices in `crypto.db`/`indicators.json`/`signals.json` are USD (Binance USDT pairs). Freqtrade `open_rate`/`close_rate`/`current_rate` are GBP (Kraken).

Never compare cryptodash's raw USD price directly against Freqtrade GBP prices — it produces a ~27–30% apparent discrepancy that is just the exchange rate. Use:
- Freqtrade's `current_rate` from `GET /api/v1/status` (always GBP)
- `priceGBP` field in `indicators.json` (converted via `fetchFxRate` / `data/fxrate.json`)

FX rate source: `api.frankfurter.app/latest?from=USD&to=GBP` (primary), `open.er-api.com/v6/latest/USD` (fallback). `gbpUsdRate` is GBP per USD (< 1.0, ~0.78). `priceGBP = price_usd × gbpUsdRate`. For display/analysis only — not used in trading decisions.

---

## Known Issues / Trade Learnings

**Sideways/choppy market**: Signal stays `hold` for the time stop window with no clean exit path. Time stop reduced to 16h (Aug 2026) to cut losses faster — previously 48h was causing 8 of 9 trades to close at −£4-6 each. Consider adding a hold-duration check to TF entry (avoid entering if signal has been hold for >Xh).

**trend_signal_reversal blips (fixed Jul 2026)**: Pre-fix, single-read `strong_sell` blips (hold → strong_sell → hold) caused exits at losses. Root cause confirmed: 3 of 6 reversal losses were blips. Fixed via `confirmed_strong_sell()` row-count check. The original time-window (10 min) version became unsatisfiable after API caching reduced write cadence from ~15min to ~1h per coin; that caused one large avoidable loss (SOL, −4.73%/−£9.51 on a genuine sustained strong_sell that couldn't trigger). Fixed by switching to row-count (last 2 rows regardless of timing) — caching writes signal_history every cycle for this reason.

---

## Opportunity Scanner (`scanner.js`)

Runs hourly at :05. Scans top 100 USDT pairs by 24h volume, excluding watchlist coins. Pre-filtered to coins with Kraken GBP pairs (cached 24h in `kraken_pairs.json`).

**Tier 0 — New Riser** (all must be true): price below EMA200 for ≥30 of last 35 candles; crossed above EMA200 within last 5 candles; RSI crossed above 50 from below within last 5; crossover candle volume ≥ 2× avg; MACD crossed above zero within last 5; rel strength vs BTC > 0.

**Tier C — Dip in Uptrend** (all must be true): price > EMA200; RSI 34–49; MACD > 0; price within 5% of EMA50; rel strength vs BTC ≥ −1%.

Selection: Tier 0 winners preferred; Tier C used if no Tier 0.

**Scoring (0–100)**:
- Tier 0: recency of crossover (25) + volume conviction (25) + MACD histogram (25) + rel strength (25)
- Tier C: RSI proximity to 30 (40) + EMA50 proximity (30) + MACD magnitude (30)

### Auto-add / Auto-remove

**Auto-add**: winner added to `watchlist.json` + both `config.json` and `config_trend.json` → `ftReloadBoth()` → desktop notification. Two writes: immediate (before Claude call) and final (with signal). Skipped if pair in `_manualCoins`.

**Auto-remove** (at scan start): remove if no open FT trade AND (`addedAt` ≥ 24h OR signal = `strong_sell`). Removes from watchlist + both configs. Skipped if pair in `_manualCoins`.

**Manual coin protection**: `initManualCoins()` at startup reads both config whitelists → `_manualCoins` Set. BTC/ETH/SOL etc. never auto-removed.

`autoAdded` schema: `{ coinId, symbol, krakenPair, addedAt, tier, score }`. `krakenPair` null if config write failed. Old schema compat: reads `entry.krakenPair ?? entry.ftPair`.

FT API auth via `lib/freqtradeClient.js`. JWT tokens cached, auto-refreshed on 401.

---

## Backtesting (`backtest.js`)

Pure computation, no I/O. Incremental indicator classes for O(n) computation with no lookahead bias.

Signal scoring: RSI, MACD, Bollinger, EMA200, StochRSI, volume ratio → raw 0–9 score → `strong_buy` (≥8) / `buy` (≥6) / `hold` / `sell` / `strong_sell`. Guards: 2-candle confirmation + BTC above EMA200 + 4h cooldown for buy signals.

Simulation: BUY=5% of pot, STRONG_BUY=8%; max 50% per coin; 0.26% fees each side; position held for `bestWindow` hours. Benchmark: equal-weight buy-and-hold.

`runBacktest(db, { coins, days, forwardWindows }, onProgress)` — `coins` must be non-empty array.

---

## Frontend (`public/index.html`)

Single HTML file, no build step, vanilla JS. Inter font, light theme (`#F9FAFB` bg, `#111827` header). Chart.js 4 via CDN (trade drill-down only).

**Tabs**: Watchlist, Opportunities, Backtest, Portfolio, Status.

**Watchlist**: 4-row-per-coin structure (coin data, signal badge + MR/TF badges, gauge row, expandable explain panel). Strategy Alignment section shows `entryQuality`/`riskAssessment` from signals. `loadSignals()` does targeted in-place DOM updates every 30s — no collapse of open panels.

**Portfolio**: Side-by-side MR/TF panels. Trade drill-down: click any trade row (open or closed) → Chart.js line chart of `price_gbp` from `signal_history`, colour-coded by signal. Open trades show live current_rate + unrealized P&L. `renderTradeDetail()` branches on `trade.is_open`. Calls `GET /api/trade-signal-path/:bot/:tradeId` once per panel (`data-loaded` gate). Chart instances tracked in `_tradeCharts` Map, destroyed on re-render.

**Status**: Services, data freshness, connectivity, resources, recent errors. Polls `/api/status` every 30s.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/market` | Live market data (price, change, sparkline) |
| GET | `/api/candles/:coinId?interval=` | OHLCV candles |
| GET | `/api/rsi` | RSI cache |
| GET | `/api/signals` | Signal cache |
| GET | `/api/indicators` | Indicators cache per coin |
| GET | `/api/feargreed` | Fear & Greed index |
| GET | `/api/scanner` | Scanner result + 24-scan history |
| POST | `/api/scanner/run` | Trigger immediate scan |
| POST | `/api/backtest` | Start async backtest; returns `{ jobId }` |
| GET | `/api/backtest/status` | Job state (idle/running/done/error) |
| GET | `/api/backtest/results` | Latest results from `backtest.json` |
| GET | `/api/watchlist` | Current watchlist |
| POST | `/api/watchlist` | Add coin `{ coin: "bitcoin" }` |
| DELETE | `/api/watchlist/:coin` | Remove coin |
| GET | `/api/alerts` | All alerts |
| POST | `/api/alerts` | Create alert |
| DELETE | `/api/alerts/:id` | Delete alert |
| PATCH | `/api/alerts/:id/reset` | Re-arm triggered alert |
| GET | `/api/freqtrade/portfolio` | MR: profit, trades, balance |
| GET | `/api/freqtrade/positions` | MR open trades |
| GET | `/api/freqtrade/trades` | MR recent 20 trades |
| GET | `/api/freqtrade/profit` | MR profit summary |
| GET | `/api/freqtrade/health` | MR liveness |
| GET | `/api/freqtrade/trend/portfolio` | TF: profit, trades, balance |
| GET | `/api/freqtrade/trend/positions` | TF open trades |
| GET | `/api/freqtrade/trend/trades` | TF recent 20 trades |
| GET | `/api/freqtrade/trend/profit` | TF profit summary |
| GET | `/api/freqtrade/trend/health` | TF liveness |
| GET | `/api/freqtrade/combined` | Both instances merged |
| GET | `/api/signal-history/:coinId?from=&to=` | Signal history rows (ISO 8601 range, optional). Returns array ordered ascending. |
| GET | `/api/trade-signal-path/:bot/:tradeId` | Trade + signal path. `bot` = `mr` or `trend`. Returns `{ trade, signalPath }`. `signalPath` empty if no history for that window. |
| GET | `/api/status` | System health (15s server-side cache) |

---

## Dev Workflow

```bash
# cryptodash changes
sudo systemctl restart crypto-dashboard && journalctl -u crypto-dashboard -f

# MR strategy changes
cp crypto-dashboard/CryptodashStrategy.py freqtrade/user_data/strategies/
sudo systemctl restart freqtrade && journalctl -u freqtrade -f

# TF strategy changes
cp crypto-dashboard/CryptodashTrendStrategy.py freqtrade/user_data/strategies/
sudo systemctl restart freqtrade-trend && journalctl -u freqtrade-trend -f

# Inspect DB
node -e "const db=require('./db');db.initDb();console.log(db.getAllMeta())"

# Run tests
node --test test/

# Verify strategy loads
cd /home/gallus23/freqtrade && source .venv/bin/activate
freqtrade list-strategies --userdir user_data
```

## Going Live

Set `"dry_run": false` + Kraken API key/secret in `config.json`, restart `freqtrade`. Do not go live until: backtest win rate satisfactory, ≥30 days paper, API key scoped to trade-only (no withdrawal).

---

## Hyperopt Results

**Bear (Jun 2026, 357 days, 500 epochs, SharpeHyperOptLoss):** 22 trades, 81.8% win rate, +4.11% profit vs −38.99% market. Applied: RSI 34–49, StochRSI < 17, vol > 1.7×, EMA50 dist < 6.2%, TP 15%, time stop 89h, SL 5% (hyperopt suggested 30% — rejected, insufficient sample).

**Bull (Jun–Nov 2024, 144 days):** Applied: RSI 32–53, StochRSI < 39, vol > 1.8×, EMA50 dist < 1.2%, TP 20%, time stop 67h, SL 7%.

Phase detected from BTC 200 EMA at signal generation (server.js) and at entry/exit (strategy). Phase NOT re-evaluated on exit — `custom_exit` reads `trade.enter_tag`. Class-level `stoploss = -0.07` is a compromise (Freqtrade requires single static value). Bear 15% TP enforced via signal reversal, not lower ROI.

Next hyperopt: after 6 months live data or sustained market phase change.

---

## Conventions

- Frontend: single HTML file unless unmanageable
- All API routes under `/api/`
- No ORM — `better-sqlite3` hand-written prepared statements
- Watchlist IDs always CoinGecko IDs (lowercase)
- Live price/volume always from Binance (USDT pairs)
- Freqtrade trades GBP on Kraken — different exchange, different currency
- Volume stored as base asset `k[5]`, never `k[7]` (quote/USDT)
- `signals.json` is the contract between cryptodash and Freqtrade — schema changes require updating both sides
- **Atomic writes**: all shared-state JSON files (`signals.json`, `indicators.json`, `rsi.json`, `feargreed.json`, `scanner.json`, `backtest.json`, FT config files) use `writeJson()` in `server.js` — writes to `<file>.tmp` then `fs.renameSync`. Never use `fs.writeFileSync()` directly for these files.
- **`populate_entry_trend` pattern — CRITICAL**: Always zero `dataframe['enter_long'] = 0` and `dataframe['enter_tag'] = ''` as the **first two lines**, before any logic. Entry signal must ONLY be set on the last candle: `if entry_conditions.iloc[-1]:` → `dataframe.loc[dataframe.index[-1], 'enter_long'] = 1`. Never use `.loc[entry_conditions, col]` — this marks ALL historical rows where conditions were ever met, causing Freqtrade to act on stale signals. Bug confirmed Jul 2026: caused ≥2 bad entries (SOL Jul 3, ETH Jul 4) despite logs showing "no entry" 2 seconds before trade placed.
