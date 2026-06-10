# Crypto Dashboard + Freqtrade — Full System

Two systemd services running on a Raspberry Pi. **Cryptodash** (Node.js) fetches market data, computes indicators, generates Claude AI signals, and serves a web dashboard. **Freqtrade** (Python) reads those signals and executes trades on Kraken.

```
┌─────────────────────────────────────────────────────────┐
│                    Raspberry Pi                          │
│                                                         │
│  ┌──────────────────────┐   signals.json  ┌──────────┐  │
│  │  crypto-dashboard    │ ──────────────► │freqtrade │  │
│  │  Node.js  :3000      │                 │Python    │  │
│  │  (watchlist, signals,│                 │:8080     │  │
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
| Frontend | Vanilla JS + HTML (single file: `public/index.html`) |
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

---

## Git Repository

`https://github.com/gallus23-coder/cryptodash`

---

## Systemd Services

### crypto-dashboard.service

Node.js process serving the dashboard on port 3000.

```bash
sudo systemctl restart crypto-dashboard
journalctl -u crypto-dashboard -f
```

### freqtrade.service

Python Freqtrade process on port 8080. Configured to start **after** `crypto-dashboard.service` (depends on `signals.json` being present).

```bash
sudo systemctl restart freqtrade
journalctl -u freqtrade -f
```

### Combined log tail

```bash
journalctl -u crypto-dashboard -u freqtrade -f
```

---

## Project File Structure

```
crypto-dashboard/
├── server.js               — Express app, cron jobs, startup logic, all API routes
├── db.js                   — SQLite schema, candle CRUD, RSI calculation, prune
├── binance.js              — Binance API: fetchTicker, backfillCandles, fetchNewCandles
├── coingecko.js            — CoinGecko API: fetchMetadata (one-time), refreshMarketCaps
├── indicators.js           — Pure indicator math: EMA, MACD, Bollinger, StochRSI, VolumeRatio, ATR
├── feargreed.js            — Alternative.me Fear & Greed API: fetchFearGreed
├── scanner.js              — Opportunity scanner: Tier 0 / Tier C detection, scoring
├── backtest.js             — Backtesting: incremental indicators, signal scoring, simulation
├── CryptodashStrategy.py   — Copy of Freqtrade strategy (canonical: /home/gallus23/freqtrade/user_data/strategies/)
├── public/
│   └── index.html          — Full frontend (single file: Watchlist/Opportunities/Backtest/Portfolio tabs)
├── data/
│   ├── crypto.db           — SQLite: candles + coin_meta
│   ├── watchlist.json      — Persisted watchlist (CoinGecko IDs)
│   ├── alerts.json         — Price alerts
│   ├── triggered.json      — Auto-created: fired alert IDs
│   ├── rsi.json            — RSI cache (refreshed every 15 min)
│   ├── signals.json        — Anthropic signal cache per watchlist coin (READ by Freqtrade)
│   ├── indicators.json     — Technical indicators cache per watchlist coin
│   ├── feargreed.json      — Fear & Greed index (refreshed hourly)
│   ├── scanner.json        — Opportunity scanner results (last 24 scans)
│   └── backtest.json       — Latest backtest results (written on each run)
└── test/
    ├── db.test.js
    ├── binance.test.js
    ├── indicators.test.js
    └── feargreed.test.js

/home/gallus23/freqtrade/
├── .venv/                              — Python virtualenv
├── user_data/
│   ├── config.json                     — Freqtrade config (exchange, pairs, risk params)
│   └── strategies/
│       └── CryptodashStrategy.py       — Canonical strategy file
```

---

## Database Schema

### `candles`

```sql
CREATE TABLE candles (
  coin_id  TEXT    NOT NULL,
  interval TEXT    NOT NULL,   -- '1h' or '1m'
  time     INTEGER NOT NULL,   -- Unix ms timestamp (candle open time)
  open     REAL    NOT NULL,
  high     REAL    NOT NULL,
  low      REAL    NOT NULL,
  close    REAL    NOT NULL,
  volume   REAL    NOT NULL,   -- base asset volume (k[5] from Binance kline, NOT quote/USDT)
  UNIQUE (coin_id, interval, time)
);
CREATE INDEX idx_candles_cit ON candles(coin_id, interval, time DESC);
```

Intervals stored: `1h` (90 days depth) and `1m` (7 days depth). Aggregated intervals (5m, 15m, 4h, 1d) computed on-the-fly.

**Volume note**: stored as base asset volume (BTC, ETH, etc.) from Binance kline index `k[5]`. `k[7]` (USDT quote volume) must NOT be used — it was a bug that was fixed.

### `coin_meta`

```sql
CREATE TABLE coin_meta (
  id                    TEXT PRIMARY KEY,   -- CoinGecko ID (e.g. 'bitcoin')
  symbol                TEXT NOT NULL,      -- Binance symbol (e.g. 'BTCUSDT')
  name                  TEXT NOT NULL,
  image                 TEXT NOT NULL,      -- CoinGecko image URL
  market_cap            REAL,
  meta_fetched_at       INTEGER NOT NULL,   -- Unix ms
  market_cap_updated_at INTEGER NOT NULL    -- Unix ms
);
```

---

## Data Sources

### Binance (public API, no key required)

Base URL: `https://api.binance.com`

- **Live prices**: `GET /api/v3/ticker/24hr?symbol=BTCUSDT` — price, 24h change, volume
- **OHLCV candles**: `GET /api/v3/klines?symbol=BTCUSDT&interval=1h&limit=N`
- **All tickers**: `GET /api/v3/ticker/24hr` (no symbol param) — used by scanner
- Kline format: `[openTime, open, high, low, close, baseVolume, closeTime, quoteVolume, ...]`
  - `k[5]` = base asset volume (what we store) ✓
  - `k[7]` = quote asset volume in USDT (do NOT use)

### CoinGecko (free tier, no key required)

- **Coin metadata** (one-time per coin): name, image, market cap, CoinGecko symbol
- **Market cap refresh**: called every 24h
- Rate limited to ~1 req/sec on free tier; 1.2s delay between calls at startup

### Alternative.me Fear & Greed

- `GET https://api.alternative.me/fng/?limit=1`
- Returns `value` (0–100) and `value_classification` (Extreme Fear → Extreme Greed)
- Cached 1h in `data/feargreed.json`

### Anthropic API

- Used for AI signal generation (watchlist coins) and opportunity scanner winner
- Model: `claude-haiku-4-5-20251001`
- Max tokens: 800 per call (watchlist signals), 200 (scanner signal)
- Watchlist signals use a `system` prompt field (`WATCHLIST_SIGNAL_SYSTEM` constant in `server.js`) — scanner signals do not
- Watchlist returns extended JSON (see Claude Signal Generation section); scanner returns `{ "signal": "...", "summary": "..." }`

---

## Coin Identity

Watchlist stores **CoinGecko IDs** (e.g. `bitcoin`, `avalanche-2`). Binance symbols resolved via:
1. `SYMBOL_MAP` hardcoded in `binance.js` (e.g. `bitcoin → BTCUSDT`)
2. Fallback: `cgSymbol + USDT` from CoinGecko metadata

Resolved Binance symbol stored in `coin_meta.symbol`.

---

## Technical Indicators (`indicators.js`)

All functions are pure math (no I/O). Take arrays oldest-first.

| Indicator | Function | Settings | Min data |
|-----------|----------|----------|----------|
| EMA | `calcEMA(values, period)` | Any period | `period` values |
| MACD | `calcMACD(closes)` | 12/26/9 | 35 closes |
| Bollinger Bands | `calcBollingerBands(closes)` | 20-period, 2 std dev (population) | 20 closes |
| Stochastic RSI | `calcStochRSI(closes)` | 14/14/3/3 | 28 closes |
| Volume Ratio | `calcVolumeRatio(volumes)` | vs 20-period avg | 21 volumes |
| ATR | `calcATR(candles, period=14)` | Simplified: avg(high−low) over 14 candles | 14 candles |

`calcATR` takes `{high, low, close}` objects — use `db.getOHLCLimit(coin_id, interval, 14)` to fetch.

**Completed-candle rule**: All indicators in `updateIndicators` and `updateRSI` use the last **completed** candle, not the currently forming one. The forming candle has partial volume (typically much lower than average) and would skew `volumeRatio` significantly. Implementation: fetch N+1 candles and call `.slice(0, -1)` before any calculation. The same rule applies in `scanner.js` `buildCandidate` — `candles.slice(0, -1)` strips the forming candle from the Binance klines response before all indicator math.

**EMA**: seeded from SMA of first `period` values, `k = 2/(period+1)`.

**MACD**: walks full array once building EMA12 and EMA26 series. Critical: EMA26 smoothing starts at `i >= 26` (not 25) to avoid double-counting index 25 in the seed. Returns `{ macd, signal, histogram }`.

**Bollinger Bands**: population variance (`/ 20`, not `/ 19`). Returns `{ upper, middle, lower, bandwidthPct }`.

**StochRSI**: builds full RSI series → 14-period sliding window stochastic → SMA-3 for %K → SMA-3 for %D. Returns `{ k, d }`.

**Volume Ratio**: `volumes[volumes.length - 1] / avg(volumes[0..19])`. Caller must pass 21 completed candles (strip forming candle first).

`scanner.js` also implements `calcRSI14` (Wilder RSI-14, same logic) and `calcEMAAligned` (returns array aligned with closes for crossover detection) locally, since the scanner needs series-level EMA values rather than just the current value.

---

## Data Flow

### Startup sequence

```
initDb()
  → seedAndBackfill() — for each watchlist coin:
      · fetch CoinGecko metadata (if not cached)
      · backfill 90d of 1h candles (if first run)
      · backfill 7d of 1m candles (if first run, 2s gap between coins)
  +2s  → checkAlerts()
  +4s  → updateCandles() → updateRSI() → updateIndicators() → updateSignals()
  +6s  → updateFearGreed()
  +10s → updateScanner()
```

### Cron schedule

| Schedule | What runs |
|----------|-----------|
| Every minute (`* * * * *`) | `checkAlerts()` + `update1mCandles()` |
| Every 15 min (`*/15 * * * *`) | `updateCandles()` → `updateRSI()` → `updateIndicators()` → `updateSignals()` |
| Every hour at :00 (`0 * * * *`) | `updateFearGreed()` |
| Every hour at :05 (`5 * * * *`) | `updateScanner()` |
| Daily at midnight (`0 0 * * *`) | `refreshAllMarketCaps()` + `pruneCandles('1m', 7d)` |

### 15-min chain detail

1. `updateCandles()` — fetch new 1h candles from Binance for each watchlist coin
2. `updateRSI()` — read closes from SQLite, recalculate RSI-14, write `rsi.json`
3. `updateIndicators()` — compute MACD, Bollinger, EMA50/200, golden/death cross, StochRSI, volume ratio, ATR-14; write `indicators.json`
4. `updateSignals()` — for each watchlist coin: fetch live ticker, build prompt, call Claude API, write `signals.json`

`signals.json` is the **signal bridge** — Freqtrade reads it on every candle close.

---

## Candle Aggregation

`/api/candles/:coinId?interval=` serves OHLCV arrays. Fixed depth windows:

| Interval | Source | Depth |
|----------|--------|-------|
| `1m` | Native SQLite | 24h |
| `5m` | Aggregated from `1m` | 7d |
| `15m` | Aggregated from `1m` | 7d |
| `4h` | Aggregated from `1h` | 90d |
| `1h` | Native SQLite | 90d |
| `1d` | Aggregated from `1h` | 90d |

---

## Claude Signal Generation

### Watchlist signals (`updateSignals`)

Called every 15 min for every watchlist coin. Uses a **system prompt** (`WATCHLIST_SIGNAL_SYSTEM` in `server.js`) defining the **Mean Reversion in Uptrend** strategy, and a per-coin **user prompt** built by `buildWatchlistSignalPrompt()`.

**Strategy parameters embedded in system prompt (phase-adaptive):**

System prompt built by `buildSignalSystem(btcPhase)` in `server.js`. Phase detected
from `indCache['bitcoin'].emaAbovePrice` before the coin loop.

| Parameter | Bear phase (BTC < EMA200) | Bull phase (BTC > EMA200) |
|-----------|--------------------------|--------------------------|
| RSI range | 34–49 | 32–53 |
| StochRSI %K | < 17 | < 39 |
| Volume ratio | ≥ 1.7× | ≥ 1.8× |
| EMA50 distance | ≤ 6.2% | ≤ 1.2% |
| Stop loss | 5% | 7% |
| Take profit | 15% | 20% |
| Time stop | 89h | 67h |

- Signal scale: `strong_buy` (all 6 met), `buy` (5/6), `hold`, `sell`, `strong_sell`

**User prompt includes:**
- Coin name, price, 24h change, RSI-14
- MACD line / signal / histogram (6 decimal places)
- Bollinger Bands (upper, middle, lower, bandwidth%)
- EMA50, EMA200, price direction vs 200 EMA
- Golden/death cross flag (if detected in last 3 candles)
- StochRSI %K and %D
- Volume ratio vs 20-period avg (annotated with above/below phase threshold: 1.7× bear, 1.8× bull)
- ATR-14 (1h) in $ and as % of price
- Fear & Greed index

**Returns extended JSON** stored in `signals.json`:
```json
{
  "signal": "strong_buy",
  "summary": "...",
  "entryQuality": {
    "allCriteriaMet": true,
    "marginalCriteria": [],
    "failingCriteria": []
  },
  "riskAssessment": {
    "stopLossRisk": "low",
    "stopLossNote": "ATR 1.8% well within 5% stop",
    "takeProfitReachable": true,
    "takeProfitNote": "Momentum suggests 10% achievable",
    "timeStopRisk": "medium",
    "timeStopNote": "Setup may take >24h to resolve"
  },
  "newsImpact": "none",
  "newsNote": null,
  "updatedAt": "2026-06-05T12:00:00.000Z"
}
```

Signal must be one of: `strong_buy`, `buy`, `hold`, `sell`, `strong_sell`. If `entryQuality`/`riskAssessment` fields are absent (old cached entries or parse failure), they are stored as `null` — the UI degrades gracefully, and Freqtrade will not act on the signal (allCriteriaMet is treated as false when absent).

**IMPORTANT — keep in sync with Freqtrade:** The system prompt must stay in sync with `CryptodashStrategy.py` and `config.json`. If entry criteria, stop/target levels, or signal scale change, update `WATCHLIST_SIGNAL_SYSTEM` in `server.js` **and** the corresponding Freqtrade parameters.

Stale entries (coins removed from watchlist) are evicted on each run.

### Scanner signal (`updateScanner`)

Called once per scan, for the winner only. Same indicator fields plus:
- Distance from EMA50 (%)
- Relative strength vs BTC (coin 24h% − BTC 24h%)
- Tier-specific context line:
  - **Tier 0**: "price has just crossed above the 200 EMA with volume confirmation and momentum alignment. Frame the signal as an early entry opportunity."
  - **Tier C**: "identified as a dip-in-uptrend candidate within a confirmed uptrend. Frame the signal as a measured re-entry opportunity."
- For Tier 0: hours since 200 EMA crossover

Scanner signals are **not read by Freqtrade** — they drive the Opportunities tab only.

---

## Freqtrade Integration

### Overview

Freqtrade runs as a separate Python service in **dry-run (paper trading) mode**. It executes the same Mean Reversion in Uptrend strategy as the Claude signal system, but applied to live Kraken GBP pairs. Cryptodash generates signals every 15 min; Freqtrade reads them on each 1h candle close.

### Paths

| Item | Path |
|------|------|
| Freqtrade root | `/home/gallus23/freqtrade` |
| Virtualenv | `/home/gallus23/freqtrade/.venv` |
| Config | `/home/gallus23/freqtrade/user_data/config.json` |
| Strategy (canonical) | `/home/gallus23/freqtrade/user_data/strategies/CryptodashStrategy.py` |
| Strategy (copy) | `/home/gallus23/crypto-dashboard/CryptodashStrategy.py` |
| FreqUI | `http://localhost:8080` |
| FreqUI credentials | username: `cryptodash` |

### Freqtrade Configuration (`config.json`)

| Parameter | Value |
|-----------|-------|
| `dry_run` | `true` (paper trading) |
| `timeframe` | `1h` |
| `stoploss` | `-0.07` (compromise; bear 5%, bull 7%) |
| `minimal_roi` | `{"0": 0.20}` (bull default 20%; bear 15% via signal reversal) |
| `max_open_trades` | `2` |
| `stake_currency` | `GBP` |
| `dry_run_wallet` | `1000` (£1,000) |
| `exchange.name` | `kraken` |

### Traded Pairs

```
BTC/GBP, ETH/GBP, SOL/GBP, XRP/GBP, ADA/GBP, BNB/GBP, LINK/GBP
```

### Signal Bridge (`signals.json`)

Freqtrade reads `/home/gallus23/crypto-dashboard/data/signals.json` directly from disk on every candle close (every hour, at close of 1h candle).

**Pair → CoinGecko ID mapping in `CryptodashStrategy.py`:**

| Freqtrade pair | signals.json key |
|----------------|------------------|
| BTC/GBP | `bitcoin` |
| ETH/GBP | `ethereum` |
| SOL/GBP | `solana` |
| XRP/GBP | `ripple` |
| ADA/GBP | `cardano` |
| BNB/GBP | `binancecoin` |
| LINK/GBP | `chainlink` |

**Entry conditions in `CryptodashStrategy.py` (all must be true):**

1. Signal is `"strong_buy"` (not merely `"buy"`)
2. `entryQuality.allCriteriaMet` is `true`
3. Signal `updatedAt` is within 20 minutes (`MAX_SIGNAL_AGE_MINUTES = 20`)
4. Phase detected via `get_market_phase(dataframe)` → `get_phase_params(phase)`
5. Belt-and-braces dataframe confirmation (phase-adaptive):
   - `close > ema200`
   - `rsi >= rsi_min AND rsi <= rsi_max` (bear: 34–49; bull: 32–53)
   - `fastk < stochrsi` (bear: <17; bull: <39)
   - `volume_ratio >= volume` (bear: ≥1.7×; bull: ≥1.8×)
   - `ema50_dist_pct <= ema50_dist` (bear: ≤6.2%; bull: ≤1.2%)
   - `macd > 0 AND macd_hist > 0`
   - `volume > 0`

Entry tag: `cryptodash_bull_strong_buy` or `cryptodash_bear_strong_buy`

**Exit reasons:**

| Reason | Mechanism |
|--------|-----------|
| `stoploss` | Freqtrade built-in, -7% (compromise) |
| `roi` | Freqtrade built-in, +20% at any time (bull default) |
| `time_stop_67h` | `custom_exit`: bull phase, trade open > 67h |
| `time_stop_89h` | `custom_exit`: bear phase, trade open > 89h |
| `signal_reversal` | `custom_exit`: signal becomes `sell` or `strong_sell` |

Phase for exit always read from `trade.enter_tag`, not re-evaluated at exit time.

### Freqtrade Useful Commands

```bash
cd /home/gallus23/freqtrade
source .venv/bin/activate

# Verify strategy loads
freqtrade list-strategies --userdir user_data

# View open trades (dry-run)
freqtrade show-trades --config user_data/config.json

# FreqUI (web interface)
http://localhost:8080
```

---

## Parameters That Must Stay in Sync

**Changing any of these in one place requires updating the other.** Drift between cryptodash and Freqtrade will cause the signal prompt to evaluate against different parameters than Freqtrade acts on.

| Parameter | cryptodash location | Freqtrade location |
|-----------|--------------------|--------------------|
| Phase detection | `buildSignalSystem(btcPhase)` in `server.js` | `get_market_phase()` in `CryptodashStrategy.py` |
| Bear stop loss: **5%** | `buildSignalSystem('bear')` in `server.js` | `get_phase_params('bear')` in `CryptodashStrategy.py` |
| Bull stop loss: **7%** | `buildSignalSystem('bull')` in `server.js` | `get_phase_params('bull')` in `CryptodashStrategy.py` |
| Bear take profit: **15%** | `buildSignalSystem('bear')` in `server.js` | signal reversal exit (no per-trade ROI in Freqtrade) |
| Bull take profit: **20%** | `buildSignalSystem('bull')` in `server.js` | `minimal_roi: {"0": 0.20}` in `config.json` |
| Bear time stop: **89h** | `buildSignalSystem('bear')` in `server.js` | `get_phase_params('bear').time_stop` in `CryptodashStrategy.py` |
| Bull time stop: **67h** | `buildSignalSystem('bull')` in `server.js` | `get_phase_params('bull').time_stop` in `CryptodashStrategy.py` |
| Max positions: **2** | (informational in prompt) | `max_open_trades: 2` in `config.json` |
| Signal freshness: **20 min** | (implicit — signals refresh every 15 min) | `MAX_SIGNAL_AGE_MINUTES = 20` in `CryptodashStrategy.py` |
| Bear entry criteria | `buildSignalSystem('bear')` in `server.js` | `get_phase_params('bear')` in `populate_entry_trend` |
| Bull entry criteria | `buildSignalSystem('bull')` in `server.js` | `get_phase_params('bull')` in `populate_entry_trend` |
| Both param sets | `tradingConfig.json` `marketPhase` section | `get_phase_params()` in `CryptodashStrategy.py` |

---

## Going Live (when ready)

Edit `/home/gallus23/freqtrade/user_data/config.json`:

```json
"dry_run": false,
"exchange": {
  "key": "YOUR_KRAKEN_API_KEY",
  "secret": "YOUR_KRAKEN_API_SECRET"
}
```

Then:
```bash
sudo systemctl restart freqtrade
```

**Complete all items in a go-live checklist first.** At minimum: backtest win rate satisfactory, strategy reviewed on paper for ≥30 days, API key scoped to trade-only (no withdrawal permissions), position sizing reviewed for real-money risk tolerance.

---

## Automated Trading Flow

The system operates fully autonomously once running. No human input is required for signal generation, entries, or exits. The only human touchpoints are watchlist management, reviewing learning recommendations, and the one-time decision to go live.

### End-to-end flow

**Every 15 minutes — cryptodash signal cycle:**

1. Fetches latest 1h candles from Binance into SQLite
2. Recalculates RSI, MACD, Bollinger, EMA50/200, StochRSI, volume ratio, ATR-14
3. Calls Claude API (`claude-haiku-4-5-20251001`) with all indicators + full strategy context (5% SL, 10% TP, 72h time stop embedded in system prompt)
4. Claude returns structured JSON: `{ signal, summary, entryQuality, riskAssessment, newsImpact, newsNote }`
5. Saves result to `data/signals.json` keyed by CoinGecko ID

**Every hour — Freqtrade entry check (top of hour, on 1h candle close):**

For each pair in the whitelist, Freqtrade runs the 7-point entry check:

| # | Check | Source |
|---|-------|--------|
| 1 | `signal === "strong_buy"` | `signals.json` |
| 2 | `entryQuality.allCriteriaMet === true` | `signals.json` |
| 3 | Signal age < 20 minutes (`updatedAt` timestamp) | `signals.json` |
| 4 | `close > EMA200` | Freqtrade dataframe |
| 5 | `RSI < 49` | Freqtrade dataframe |
| 6 | `MACD > 0` | Freqtrade dataframe |
| 7 | `volume > 0` | Freqtrade dataframe |

If ALL 7 pass → Freqtrade places a BUY order automatically → desktop notification fires.

**Every 60 seconds — Freqtrade position monitor:**

Open positions are checked continuously against current price:

- Price drops 5% from entry → **stop loss** → position closed automatically → notification
- Price rises 10% from entry → **take profit** → position closed automatically → notification
- 72 hours elapsed since entry → **time stop** → `custom_exit` fires → notification
- All closures are automatic with zero human input required

**Every 10 minutes — signal reversal check:**

- If `signals.json` flips to `sell` or `strong_sell` while a position is open, `custom_exit` triggers on the next hourly candle close with reason `signal_reversal` → notification

### What runs automatically (no human input)

- Signal generation (Claude API call every 15 min)
- Entry decisions (7-point check on every hourly candle)
- Stop loss exits (-5%)
- Take profit exits (+10%)
- Time stop exits (72h)
- Signal reversal exits
- All desktop notifications

### What requires human input

- **Adding coins to watchlist** — deliberate decision; affects which coins get signals and which Freqtrade pairs are monitored
- **Reviewing learning analysis** — every 5 closed trades, the system surfaces recommendations (accept/reject)
- **Responding to daily loss limit notifications** — automated trading suspends; human decides whether to resume
- **Going live** — the only action that moves real money: manually setting `dry_run: false` in `config.json` and restarting Freqtrade

### Current market behaviour

The strategy only enters confirmed uptrends (price > EMA200). During bearish market conditions (BTC below its 200 EMA), Claude will correctly generate `hold` or `strong_sell` signals and Freqtrade will place no entries. This is by design — the strategy is conservative and sits out downtrends entirely.

First entries will fire when BTC reclaims its 200 EMA and individual coins independently meet all 7 entry criteria.

### Notification types

Notifications fire via the Pi desktop (node-notifier) for all automated events:

| Event | Content |
|-------|---------|
| Trade opened | Pair, entry price, stop loss level, take profit level |
| Take profit hit | Pair, exit price, gain in £ |
| Stop loss hit | Pair, exit price, loss in £ |
| Time stop triggered | Pair, exit price, P&L |
| Signal reversal exit | Pair, exit price, P&L |
| Daily loss limit reached | Auto trading suspended — manual resume required |
| Learning analysis ready | Number of recommendations pending review |

### Live mode

The automated flow is identical in live mode. The only difference is that Freqtrade places real Kraken orders instead of simulated ones. See the Going Live section above and complete the go-live checklist (section 14 of this document) before switching `dry_run` to `false`.

---

## Opportunity Scanner (`scanner.js`)

Runs hourly at :05. Scans top 100 USDT pairs by 24h quote volume, excluding all watchlist coins. Fetches 250 1h candles per coin.

### Relative strength vs BTC

```
relStrength = coin_24h_change_pct − btc_24h_change_pct
```

Positive = outperforming BTC. BTC's 24h change is always taken from the same all-tickers call regardless of whether BTC is in the watchlist.

### Tier 0 — New Riser (all must be true)

1. Price below EMA200 for ≥30 of the last 35 candles
2. Price crossed above EMA200 within the last 5 candles
3. RSI crossed above 50 from below within the last 5 candles
4. Volume on the crossover candle ≥ 2× 20-period average before it
5. MACD line crossed above zero within the last 5 candles
6. Relative strength vs BTC > 0

Crossover detection uses aligned EMA200/RSI/MACD series (one value per candle endpoint) to detect sign changes within the lookback window.

### Tier C — Dip in Uptrend (all must be true)

1. Price above EMA200
2. RSI between 34 and 49
3. MACD line > 0
4. Price within 5% of EMA50
5. Relative strength vs BTC ≥ −1%

### Selection logic

1. Run Tier 0 filter on all 100 candidates
2. If any Tier 0 → score them, pick highest scorer as winner; all Tier C also computed for "also qualified"
3. If no Tier 0 → run Tier C filter, pick highest Tier C scorer as winner
4. If neither → no winner (empty state shown)
5. Claude called for winner only

### Tier 0 scoring (0–100 points)

| Component | Max | Formula |
|-----------|-----|---------|
| Recency of EMA200 crossover | 25 | `30 − 5 × candles_ago` (1 ago = 25, 5 ago = 5) |
| Volume conviction | 25 | `5 + (ratio − 2) × 6.67`, clamped to 0–25 (2× avg = 5, 5× avg = 25) |
| MACD histogram | 25 | `histogram / max_histogram × 25`, normalised across candidates |
| Relative strength vs BTC | 25 | `relStrength × 5`, clamped to 0–25 (5%+ = 25) |

### Tier C scoring (0–100 points)

| Component | Max | Formula |
|-----------|-----|---------|
| RSI proximity to 30 | 40 | `(45 − rsi) / 15 × 40` (RSI 30 = 40, RSI 45 = 0) |
| EMA50 proximity | 30 | `(5 − distPct) / 4 × 30` (1% away = 30, 5% away = 0) |
| MACD magnitude | 30 | `macd / max_macd × 30`, normalised across candidates |

### `scanner.json` structure

```json
{
  "latest": {
    "timestamp": 1234567890,
    "btcChange24h": -2.3,
    "winnerTier": 0,
    "winner": {
      "symbol": "FILUSDT",
      "price": 3.45,
      "change24h": 5.6,
      "rsi": 52.3,
      "macd": { "macd": 0.001, "signal": -0.0005, "histogram": 0.0015 },
      "ema50": 3.15,
      "ema200": 3.10,
      "volRatio": 3.2,
      "relStrength": 7.9,
      "distFromEMA50Pct": 9.5,
      "ema200CrossoverAgo": 2,
      "tier": 0,
      "score": 86,
      "scoreBreakdown": { "recency": 20, "volume": 22, "macd": 25, "relStrength": 19 },
      "signal": "buy",
      "signalSummary": "..."
    },
    "otherTier0": [ { "symbol": "...", "score": 72, "scoreBreakdown": {...}, "tier": 0 } ],
    "otherTierC":  [ { "symbol": "...", "score": 68, "scoreBreakdown": {...}, "tier": "C" } ]
  },
  "history": [ ...last 24 scan results... ],
  "updatedAt": 1234567890
}
```

---

## Backtesting (`backtest.js`)

Pure computation module, no I/O. Called from `server.js`. Uses incremental indicator classes for O(n) total computation — each candle processed exactly once with no lookahead bias.

### Incremental indicator classes

| Class | Description |
|-------|-------------|
| `IncrEMA(period)` | Standard EMA, seeds from SMA of first `period` values |
| `IncrRSI(period=14)` | Wilder smoothing RSI |
| `IncrMACD()` | Composes IncrEMA 12/26/9; returns `{ macd, signal, histogram }` |
| `IncrBollinger(period=20)` | Population std dev; returns `{ upper, middle, lower }` |
| `IncrStochRSI()` | 14/14/3/3; returns `{ k, d }` |
| `IncrVolumeRatio()` | Current volume vs 20-period average |

### Signal scoring (`computeRawScore` + `classifySignal`)

Raw score: 0–9 points from indicator conditions.

| Condition | Points |
|-----------|--------|
| RSI < 30 | +2 |
| RSI 30–45 | +1 |
| MACD line > 0 AND histogram > 0 | +2 |
| Price < Bollinger lower band | +2 |
| Price > EMA200 | +1 |
| StochRSI %K < 20 | +1 |
| Volume ratio > 1.5× | +1 |

Signal classification applies **four guards** on top of the raw score:

| Score | Signal | Guards applied |
|-------|--------|----------------|
| ≥ 8 | `strong_buy` | 2-candle confirmation + BTC above EMA200 + 4h cooldown |
| ≥ 6 | `buy` | 2-candle confirmation + BTC above EMA200 + 4h cooldown |
| 3–5 | `hold` | — |
| = 2 | `sell` | None |
| ≤ 1 | `strong_sell` | None |

**2-candle confirmation**: previous candle must also have met the same score threshold (≥8 for strong_buy, ≥6 for buy). Filters single-candle noise.

**Market phase gate**: BUY/STRONG_BUY suppressed when BTC is below its EMA200. `btcAbove200 === false` blocks buys; `null` (unknown) allows them.

**4-hour cooldown**: no new BUY signal on same coin within 4h of previous BUY.

### `runBacktest(db, params, onProgress)` params

```json
{ "coins": ["bitcoin", "ethereum"], "days": 90, "forwardWindows": [4, 24, 72] }
```

- `coins`: array of CoinGecko IDs — must be a non-empty array; the frontend populates it from the watchlist
- `days`: test period length; all prior candles used for indicator seeding (no lookahead)
- `forwardWindows`: hours ahead to measure signal outcome

### Market phase detection

BTC EMA200 computed over full history. For candles in test period, `btcAbove200` flag set per hour. `marketPhase` reports: label (`Predominantly Bearish / Mixed / Ranging / Predominantly Bullish`), `abovePct` (% of test-period hours BTC was above its EMA200).

### Per-coin stats (`calcCoinStats`)

For each forward window × signal class: `count`, `wins`, `winRate`, `avgGain`, `avgLoss`, `rr` (reward/risk), `ev` (expected value %). `bestWindow` = forward window with highest combined BUY+STRONG_BUY win rate. `phaseSplit` included if ≥10 BUY signals in each phase — reports `aboveEMA200` and `belowEMA200` win rates separately.

### £100 simulation (`runSimulation`)

- BUY: invest 5% of pot; STRONG_BUY: 8%
- Max 50% of pot in any single coin (across all open positions)
- Stop opening positions if pot < £10
- Entry fee: 0.26% of invested amount; exit fee: 0.26% of gross proceeds
- Position held for `bestWindow` hours, then exited at forward price
- SELL/STRONG_SELL signals trigger early exit for that coin's open positions
- Returns: `{ startingPot, finalPot, profitLoss, profitLossPct, trades, winningTrades, losingTrades, largestWin, largestLoss, minPot, totalFees, equityCurve }`
- `equityCurve`: `[{ timestamp, potValue }]`

### Benchmark (`calcBenchmark`)

Equal-weighted buy-and-hold across all tested coins. Buys at first signal timestamp, sells at last. 0.26% fee each side. Returns `{ finalValue, returnPct }`.

### `backtest.json` structure

Top-level keys are `current` and `previous` (both have the same shape; `previous` is null on first run).

```json
{
  "current": {
    "runAt": 1234567890,
    "params": { "coins": ["bitcoin"], "days": 90, "forwardWindows": [4, 24, 72] },
    "marketPhase": { "label": "Mixed / Ranging", "abovePct": 34.6, "ema200Start": 77822, "ema200End": 72346 },
    "coinStats": {
      "bitcoin": {
        "totalSignals": 720,
        "byClassification": { "strong_buy": 2, "buy": 20, "hold": 660, "sell": 20, "strong_sell": 18 },
        "byWindowByClass": { "4": { "buy": { "count": 20, "wins": 11, "winRate": 0.55, "avgGain": 1.2, "avgLoss": 0.9, "rr": 1.33, "ev": 0.21 } } },
        "bestWindow": 4,
        "avgHoursBetweenBuys": 96.0,
        "maxConsecutiveLosses": 3,
        "phaseSplit": null
      }
    },
    "simulation": { "finalPot": 99.33, "profitLoss": -0.67, "trades": 22, "winningTrades": 4, "losingTrades": 18, "totalFees": 0.53, "minPot": 73.47, "largestWin": 0.82, "largestLoss": 2.10, "equityCurve": [...] },
    "benchmark": { "finalValue": 86.98, "returnPct": -13.02 },
    "signals": { "bitcoin": [ { "timestamp": 1234567890, "close": 95000, "signal": "buy", "score": 6, "btcAbove200": true, "forward": { "4": { "price": 96200, "changePct": 1.26 } } } ] }
  },
  "previous": { ... }
}
```

---

## Frontend (`public/index.html`)

Single HTML file. No build step. Vanilla JS. Light theme design system.

**Design system**: Inter font, `#F9FAFB` page bg, `#FFFFFF` cards, `#111827` dark sticky header. CSS custom properties: `--accent: #16A34A`, `--red: #DC2626`, `--amber: #D97706`, `--muted: #9CA3AF`, `--mono`.

**Layout**: Sticky dark header with logo + inline nav tabs → persistent summary bar → full-width tab content (no sidebar).

**Four tabs**: Watchlist, Opportunities, Backtest, Portfolio (placeholder).

### Summary bar (always visible, below header)

Fear & Greed badge + 5 stat items: Tracked, Gainers, Losers, Best 24h, Worst 24h.

### Watchlist tab

- **Watchlist table**: 10 columns — Asset, Price, 1h%, 24h%, 7d%, Mkt Cap, Vol 24h, RSI, Signal, `?` (glossary button)
- **4-row-per-coin structure** (all rows carry `data-coin` attribute for hover grouping):
  1. **coin-row**: main data row
  2. **signal-row**: full-width `colspan="10"` — signal badge + Claude summary text
  3. **gauge-row**: full-width — RSI progress bar, MACD ▲/▼/◆ icon, BB position (Near Lower/Mid-Band/Near Upper), EMA50 + EMA200 coloured circles (green = above, red = below), StochRSI bar, F&G value, Funding (static "—"), "▼ explain" toggle button
  4. **indicator-row**: hidden by default, `max-height` CSS transition; contains breakdown table + Strategy Alignment section + Claude AI box
- **Indicator explanation panel**: 5-column breakdown table (Indicator / Value / Reading / Impact badge / How it's used). Indicator names have `cursor:help` dashed underline; hovering shows a custom dark tooltip (220px max-width, `#111827` bg, downward arrow, 0.15s fade) via event delegation on `document`. Single `#ind-tip` div shared across all tooltips. Only one panel open at a time (`openPanelCoin` global).
- **Strategy Alignment section**: green box rendered between indicator table and Claude AI box. Only rendered when `signalData[coinId].entryQuality` or `signalData[coinId].riskAssessment` is non-null (graceful degradation for old cached signals). Shows: all-criteria-met flag, marginal/failing criteria lists, 3-column risk grid (stop-loss risk / take-profit reachability / 72h time stop), and news impact if non-none. Risk levels colour-coded green/amber/red.
- **Claude AI interpretation box**: blue box at bottom of panel showing `"Signal refreshes every 10 minutes · Indicators update every 10 minutes · Generated HH:MM:SS"`. Time from `signalData[coinId].updatedAt`; shows `Generating...` if null.
- **Hover highlight**: `attachRowHovers()` adds `.row-hover` to all `[data-coin="${id}"]` rows on mouseenter; removed on mouseleave.
- **Glossary modal**: `?` column header opens full-screen backdrop modal with definitions for all 7 indicators. Closeable by clicking backdrop or Escape.
- **Coin tags**: clickable pills to remove coins from watchlist
- **Add coin**: input field (CoinGecko ID), Enter or button to confirm
- **Polling**: full market refresh every 60s (`loadMarket()` fetches `/api/market`, `/api/rsi`, `/api/signals`, `/api/indicators` in parallel); signal+indicator refresh every 30s (`loadSignals()`)
  - `loadSignals()` does **targeted in-place DOM updates** (not `renderTable()`): updates `.sig-td`, signal-row TD, and gauge-row TD per coin via `querySelector`. If an indicator panel is open, its content is updated in-place without collapsing — `panel.classList.contains('open')` guards the update, no class change fires

### Opportunities tab

- **Header**: title, last scan timestamp, countdown to next scan (updates every 1s), Scan Now button
  - Scan Now: shows `⟳ Scanning…` spinner while running, disables to prevent double-trigger, flashes `✓ Scan complete` for 2s on success
- **Hero card** (when winner found):
  - Tier badge: `★ NEW RISER` (green) or `● DIP IN UPTREND` (blue)
  - Symbol, price, 24h% change
  - Relative strength vs BTC (green if outperforming, red if under)
  - Score bar: horizontal stacked segments per component (colour-coded), legend below
  - Claude signal badge (large) + signal summary text
  - Key stats row: RSI, MACD, EMA50 distance, volume ratio, hours since 200 EMA crossover (Tier 0 only)
  - Add to Watchlist input (pre-filled with symbol, editable) + Add button
- **Also qualified** (`<details>` collapsed by default): Other Tier 0 and Other Tier C subsections, symbol + score only
- **Empty state**: 🔭 telescope icon, "No Opportunities Found" heading, explanatory subtext, last scan time
- **Disclaimer**: shown below hero card and empty state
- **Polling**: scanner data refreshed every 5 min (`loadScanner()`)

### Backtest tab

- **Controls bar**: coin dropdown (watchlist coins + "All Coins"), period selector (30/60/90d), forward window checkboxes (4h/24h/72h), Run Backtest button
- **Progress bar**: animated fill with status message while job runs; polls `GET /api/backtest/status` every 1s
- **Market phase banner**: color-coded left border (red = bearish, amber = mixed, green = bullish); shows label and BTC-above-EMA200 percentage
- **Current vs Previous comparison table**: shown when `backtestPrevious` exists; Δ column colour-coded
- **Equity curve**: SVG line chart with £100 baseline; line green if final > £100, red otherwise
- **Simulation card**: Strategy vs Buy-and-Hold side by side (final pot, P&L, return %); stats row with trade count, wins, losses, fees, min pot, max win
- **Per-coin stat cards**: grid layout; combined BUY+STRONG_BUY win rate, EV, R/R, signal count, bull/bear phase split (if available)
- **Polling**: results loaded once on tab open; re-fetched after each run completes

### Portfolio tab

Placeholder card — "Portfolio Tracker — Coming soon."

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/market` | Live market data for all watchlist coins (price, change, sparkline) |
| GET | `/api/candles/:coinId?interval=` | OHLCV candles (1m/5m/15m/1h/4h/1d) |
| GET | `/api/rsi` | RSI cache (`{ coinId: { rsi, updatedAt } }`) |
| GET | `/api/signals` | Signal cache (`{ coinId: { signal, summary, entryQuality, riskAssessment, newsImpact, newsNote, updatedAt } }`) |
| GET | `/api/indicators` | Full indicators cache per coin |
| GET | `/api/feargreed` | Fear & Greed index (`{ value, classification, fetchedAt }`) |
| GET | `/api/scanner` | Latest scanner result + 24-scan history |
| POST | `/api/scanner/run` | Trigger immediate scanner run; returns updated scanner data |
| POST | `/api/backtest` | Start async backtest job `{ coins, days, forwardWindows }`; returns `{ jobId }` immediately |
| GET | `/api/backtest/status` | Job state `{ status, progress, message, jobId }` — status: idle/running/done/error |
| GET | `/api/backtest/results` | Latest backtest results from `data/backtest.json` |
| GET | `/api/watchlist` | Current watchlist `{ coins: [...] }` |
| POST | `/api/watchlist` | Add coin `{ coin: "bitcoin" }` (seeds metadata + candles async) |
| DELETE | `/api/watchlist/:coin` | Remove coin |
| GET | `/api/alerts` | All alerts `{ alerts: [...] }` |
| POST | `/api/alerts` | Create alert `{ coin, condition, price, label }` |
| DELETE | `/api/alerts/:id` | Delete alert |
| PATCH | `/api/alerts/:id/reset` | Re-arm a triggered alert |

---

## Dev Workflow

```bash
# After backend changes to cryptodash
sudo systemctl restart crypto-dashboard
journalctl -u crypto-dashboard -f

# After changes to CryptodashStrategy.py
# (copy to Freqtrade first)
cp /home/gallus23/crypto-dashboard/CryptodashStrategy.py \
   /home/gallus23/freqtrade/user_data/strategies/CryptodashStrategy.py
sudo systemctl restart freqtrade
journalctl -u freqtrade -f

# Combined logs
journalctl -u crypto-dashboard -u freqtrade -f

# Inspect DB
node -e "const db=require('./db');db.initDb();console.log(db.getAllMeta())"

# Run tests
node --test test/

# Verify Freqtrade strategy loads
cd /home/gallus23/freqtrade && source .venv/bin/activate
freqtrade list-strategies --userdir user_data

# Dashboard URLs
http://localhost:3000   # Cryptodash
http://localhost:8080   # FreqUI
```

## Hyperopt Results

### Bear Market Hyperopt — June 2026

Run date: 09 June 2026
Data: Binance USDT pairs, 357 days (Jun 2025 - Jun 2026) — bear market conditions
Epochs: 500
Loss function: SharpeHyperOptLoss

Best epoch: 452/500
Results:
  Trades:       22 over 357 days
  Win rate:     81.8% (18 wins, 4 losses)
  Total profit: +4.11% vs market return of -38.99%
  Max drawdown: 0.36% (£3.71)
  Profit factor: 12.06
  Sharpe ratio:  0.69

Parameters applied (bear phase):
  RSI range:      34-49    StochRSI: < 17
  Volume ratio:   > 1.7x   EMA50 dist: < 6.2%
  Take profit:    15%      Time stop: 89h
  Stop loss:      5% (hyperopt suggested 30% — rejected, insufficient sample)

### Bull Market Hyperopt — June 2024

Run date: June 2024
Data: Binance USDT pairs, 144 days (Jun 2024 - Nov 2024) — bull market conditions

Parameters applied (bull phase):
  RSI range:      32-53    StochRSI: < 39
  Volume ratio:   > 1.8x   EMA50 dist: < 1.2%
  Take profit:    20%      Time stop: 67h
  Stop loss:      7% (hyperopt suggested -0.084 — rounded conservatively)

### Adaptive Switching Logic

Phase detected from BTC 200 EMA position at signal generation time (server.js) and
at entry/exit time (CryptodashStrategy.py). Phase is NOT re-evaluated on exit —
`custom_exit` reads phase from `trade.enter_tag` so exit parameters always match
the conditions that were active when the position was opened.

Entry tag format: `cryptodash_bull_strong_buy` or `cryptodash_bear_strong_buy`

Class-level `stoploss = -0.07`: compromise between bear -0.05 and bull -0.084.
Freqtrade requires a single static value; per-phase profit targets are embedded
in `minimal_roi = {"0": 0.20}` (bull default). Bear 15% TP enforced via signal
reversal logic rather than a lower ROI, since ROI cannot vary per trade.

Next hyperopt: recommended after 6 months of live data or when market conditions
change significantly (BTC reclaims or loses 200 EMA for sustained period).

---

## Conventions

- Frontend stays as a single HTML file unless it becomes unmanageable
- All API routes under `/api/`
- No ORM — `better-sqlite3` with hand-written prepared statements in `db.js`
- No unnecessary dependencies
- Watchlist coin IDs are always CoinGecko IDs (lowercase)
- All live price/volume data comes from Binance (USDT pairs) — never CoinGecko for live data
- Freqtrade trades GBP pairs on Kraken — different exchange, different denomination
- JSON files in `data/` are the source of truth for ephemeral caches; SQLite is the source of truth for candle history
- Volume stored as **base asset** (`k[5]`), not quote/USDT (`k[7]`) — do not change this
- `signals.json` is the contract between cryptodash and Freqtrade — schema changes require updating both sides
