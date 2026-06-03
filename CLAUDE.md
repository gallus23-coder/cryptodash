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

## Coin identity
Watchlist stores CoinGecko IDs (e.g. `bitcoin`, `avalanche-2`). Binance symbols resolved via hardcoded `SYMBOL_MAP` in `binance.js` (e.g. `bitcoin → BTCUSDT`). Unknown coins fall back to `cgSymbol + USDT` from CoinGecko metadata. Resolved symbol stored in `coin_meta.symbol`.

## Data flow
- On startup: seed CoinGecko metadata + backfill 90d of 1h candles + 7d of 1m candles for any new coin (2s delay between coins for 1m backfill)
- Every 1 min: check price alerts (Binance ticker) + fetch new 1m candles
- Every 15 min: fetch new 1h candles → recalculate RSI → recalculate indicators → update signals
- Every 1h: refresh Fear & Greed Index from Alternative.me
- Every 24h (midnight): refresh market caps from CoinGecko + prune 1m candles older than 7d
- `/api/market`: assembles live response from Binance ticker + SQLite candles (sparkline, 1h change, RSI) + coin_meta (name, image, market_cap)
- `/api/candles/:coinId?interval=`: returns OHLCV array; native 1m/1h or aggregated 5m/15m/4h/1d; fixed windows (1m→24h, 5m/15m→7d, 4h/1h/1d→90d)

## Dev workflow
- Restart after backend changes: `sudo systemctl restart crypto-dashboard`
- Logs: `journalctl -u crypto-dashboard -f`
- Runs on: http://localhost:3000
- Inspect SQLite: `node -e "const db=require('./db');db.initDb();console.log(db.getAllMeta())"`

## Signal display
- Signal badge (5-level: STRONG BUY / BUY / HOLD / SELL / STRONG SELL) shown in the Signal column; `Pending` when not yet available
- Signal summary text shown as third line below coin name/symbol in the Asset column (`.coin-summary`, font-size 11px, `--muted` color); hidden entirely when no signal available
- Tooltip on badge also shows summary text (HTML-escaped)
- `loadSignals()` polls `/api/signals` every 30 seconds and re-renders the table, keeping both the inline summary and the badge tooltip in sync

## Conventions
- Keep frontend as a single HTML file unless it gets unwieldy
- API routes all under /api/
- No ORM — better-sqlite3 with hand-written prepared statements in db.js
- Don't add unnecessary dependencies
- Watchlist coin IDs are always CoinGecko IDs (lowercase)
- All live price/volume data comes from Binance — never call CoinGecko for live prices
