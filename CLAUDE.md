# Crypto Dashboard

Local crypto watchlist dashboard running on a Raspberry Pi.

## Stack
- Node.js + Express backend
- Vanilla JS / HTML frontend (single file: public/index.html)
- SQLite persistence for candles + coin metadata (`data/crypto.db`) via `better-sqlite3`
- JSON file persistence for watchlist, alerts, RSI cache, signals cache (`data/`)
- Binance public API (no key) — live prices, 1h + 1m OHLCV candles
- CoinGecko free API (no key) — coin metadata only (name, image, market cap)
- Anthropic API (`ANTHROPIC_API_KEY`) — strong_buy/buy/hold/sell/strong_sell signals via claude-haiku
- Alternative.me API (no key) — Crypto Fear & Greed Index, fetched hourly
- systemd service

## Project structure
- server.js — thin orchestrator: Express routes, crons, startup seed logic
- db.js — SQLite layer: schema init + migration, candle CRUD, coin_meta CRUD, calculateRSI, pruneCandles
- test/ — Node.js built-in test suite (node:test): test/db.test.js, test/binance.test.js, test/indicators.test.js, test/feargreed.test.js
- binance.js — Binance API: fetchTicker, backfillCandles (90d 1h / 7d 1m), fetchNewCandles
- indicators.js — Pure technical indicator functions: calcEMA, calcMACD, calcBollingerBands, calcStochRSI, calcVolumeRatio
- feargreed.js — Alternative.me Fear & Greed API: fetchFearGreed
- scanner.js — Opportunity scanner: runScanner (Tier 0 / Tier C dual-tier, top 100 USDT pairs)
- coingecko.js — CoinGecko API: fetchMetadata (one-time per coin), refreshMarketCaps (24h)
- public/index.html — full frontend UI
- data/crypto.db — SQLite: `candles` table (1h + 1m OHLCV, keyed by coin_id+interval+time), `coin_meta` table
- data/watchlist.json — persisted coin watchlist (stores CoinGecko IDs as canonical keys)
- data/alerts.json — persisted price alerts
- data/triggered.json — auto-created, tracks fired alerts
- data/rsi.json — RSI cache (calculated from SQLite candles, refreshed every 15 min)
- data/signals.json — Anthropic signal cache
- data/indicators.json — Technical indicators cache (MACD, BB, EMA, StochRSI, VolumeRatio) per coin
- data/feargreed.json — Fear & Greed Index cache (refreshed hourly)
- data/scanner.json — Opportunity scanner cache (updated hourly at :05, last 24 scans in history)

## Coin identity
Watchlist stores CoinGecko IDs (e.g. `bitcoin`, `avalanche-2`). Binance symbols resolved via hardcoded `SYMBOL_MAP` in `binance.js` (e.g. `bitcoin → BTCUSDT`). Unknown coins fall back to `cgSymbol + USDT` from CoinGecko metadata. Resolved symbol stored in `coin_meta.symbol`.

## Data flow
- On startup: seed CoinGecko metadata + backfill 90d of 1h candles + 7d of 1m candles for any new coin (2s delay between coins for 1m backfill)
- Every 1 min: check price alerts (Binance ticker) + fetch new 1m candles
- Every 15 min: fetch new 1h candles → recalculate RSI → recalculate indicators → update signals
- Every 1h: refresh Fear & Greed Index from Alternative.me
- Every 1h at :05: run opportunity scanner (top 100 USDT pairs, Tier 0 / Tier C detection)
- Every 24h (midnight): refresh market caps from CoinGecko + prune 1m candles older than 7d
- `/api/market`: assembles live response from Binance ticker + SQLite candles (sparkline, 1h change, RSI) + coin_meta (name, image, market_cap)
- `/api/candles/:coinId?interval=`: returns OHLCV array; native 1m/1h or aggregated 5m/15m/4h/1d; fixed windows (1m→24h, 5m/15m→7d, 4h/1h/1d→90d)

## Dev workflow
- Restart after backend changes: `sudo systemctl restart crypto-dashboard`
- Logs: `journalctl -u crypto-dashboard -f`
- Runs on: http://localhost:3000
- Inspect SQLite: `node -e "const db=require('./db');db.initDb();console.log(db.getAllMeta())"`

## Opportunity scanner

Scans top 100 USDT pairs by 24h volume (excluding watchlist) every hour at :05. Results in `data/scanner.json`. Route: `GET /api/scanner`, `POST /api/scanner/run` (manual trigger).

**Data**: Fetches last 250 1h candles per coin from Binance. Computes: RSI-14, MACD 12/26/9, EMA50, EMA200 (aligned series for crossover detection), volume ratio, relative strength vs BTC (coin 24h% − BTC 24h%).

**Tier 0 — New Riser** (all must be true):
- Price below EMA200 for ≥30 of last 35 candles
- Price crossed above EMA200 within last 5 candles
- RSI crossed above 50 from below within last 5 candles
- Volume at crossover candle ≥ 2× 20-period avg before it
- MACD line crossed above zero within last 5 candles
- Relative strength vs BTC > 0

**Tier C — Dip in Uptrend** (all must be true):
- Price above EMA200
- RSI between 30 and 45
- MACD line > 0
- Price within 5% of EMA50
- Relative strength vs BTC ≥ −1%

**Selection**: Tier 0 first; if none, fall back to Tier C; if neither, no winner. Claude called for winner only with tier-specific prompt framing.

**Tier 0 scoring (0–100)**:
- Recency of EMA200 crossover: 1 candle ago = 25 pts, 5 candles ago = 5 pts (linear: 30 − 5×offset)
- Volume conviction: 2× avg = 5 pts, 5× avg = 25 pts (linear, capped)
- MACD histogram: normalised across candidates, max = 25 pts
- Relative strength vs BTC: 0% = 0 pts, 5%+ = 25 pts (linear)

**Tier C scoring (0–100)**:
- RSI proximity to 30: RSI 30 = 40 pts, RSI 45 = 0 pts (linear)
- EMA50 proximity: within 1% = 30 pts, at 5% = 0 pts (linear)
- MACD magnitude: normalised across candidates, max = 30 pts

**Claude prompt additions**: tier type passed; Tier 0 framed as "early entry opportunity"; Tier C as "measured re-entry opportunity"; always includes relative strength vs BTC.

**scanner.json**: `{ latest: { timestamp, btcChange24h, winnerTier, winner, otherTier0, otherTierC }, history: [...last 24...], updatedAt }`

## Signal display
- Signal badge (5-level: STRONG BUY / BUY / HOLD / SELL / STRONG SELL) shown in the Signal column; `Pending` when not yet available
- Signal summary text shown as second full-width row beneath each coin row (`.summary-row`), spanning all columns via `colspan="10"`; not rendered at all when no signal available
- Summary row has a 3px left border colour-coded by signal: STRONG BUY #22c55e, BUY #4ade80, HOLD #fbbf24, SELL #f87171, STRONG SELL #ef4444
- Background `--bg3`, padding `6px 14px 10px 14px`, font-size 12px, colour `--muted`
- Coin row suppresses its bottom border (`has-summary` class) when a summary row follows, so the pair reads as one grouped unit
- Tooltip on badge also shows summary text (HTML-escaped)
- `loadSignals()` polls `/api/signals` every 30 seconds and re-renders the table, keeping both the summary row and the badge tooltip in sync

## Conventions
- Keep frontend as a single HTML file unless it gets unwieldy
- API routes all under /api/
- No ORM — better-sqlite3 with hand-written prepared statements in db.js
- Don't add unnecessary dependencies
- Watchlist coin IDs are always CoinGecko IDs (lowercase)
- All live price/volume data comes from Binance — never call CoinGecko for live prices
