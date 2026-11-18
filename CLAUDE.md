# Cryptodash v2 — Kraken-only trading platform

**Status:** rebuild in progress on branch `v2`. The full design is in [`docs/v2-design.md`](docs/v2-design.md). Read it before starting any milestone. v1 notes (Freqtrade era) are in `docs/v1-CLAUDE.md` for reference only.

One Node service on a Raspberry Pi. It talks to **Kraken only** (Spot REST + WebSocket v2, Kraken Futures public data). Claude makes the hourly decision via `claude -p` on the Pi (Pro plan). Telegram is used for outbound notifications. Access is via Tailscale Serve.

## Current milestone
**Milestone 1: Kraken client.** See `docs/v2-design.md` §10 for the full order. Milestone 4 (backtest of default playbook, after fees, in R, vs buy-and-hold BTC) is a **pass/fail gate**: don't build the Claude layer (milestone 6) until it passes.

First task in milestone 1: verify against the real Kraken API how `stop-loss`, `trailing-stop` and OCO (if available via API) behave for spot, including whether two sell orders on the same holding are rejected. The exit design (§6) depends on this.

## Hard rules
- **No secrets in the repo or in Claude's context.** Kraken keys, Telegram token and the dashboard password live in `~/.config/cryptodash/env` (outside the repo, gitignored patterns too). Never read, print or log that file. The Kraken key must have **no withdraw permission**.
- **Completed candles only.** Kraken's latest OHLC row is still forming; never use it. Each setup runs only when its own timeframe closes (4h setups at 00/04/08/12/16/20 UTC).
- **`src/engine/` is pure.** No network, no clock, no DB inside engine code; data comes in as arguments. Backtest and live run identical engine code.
- **Results in R** (P&L ÷ amount risked) as well as £. Sizing is risk-based (0.5% of balance per trade, default).
- **One exit order per position** on Kraken (a holding is reserved by each open sell order).
- **Every order has a client order ID** built from the candidate ID; reconcile DB vs Kraken on startup and pause on mismatch.
- **Claude can't exceed limits.** Its JSON is schema-validated, values clamped to ranges, stops only tighten, unknown candidates ignored. Any failure → skip the cycle (never trade on a bad response).
- **Guardrails live in code**, not prompts. Paper and live have separate caps.
- **Every trade/order/decision is tagged `paper` or `live`.** Never mix them in P&L.
- Atomic writes for any shared JSON (write `.tmp` then rename). No ORM: `better-sqlite3` prepared statements.

## Stack
Node.js 20, Express, `better-sqlite3`, `node-cron`, `ws`. Front-end: vanilla JS, `lightweight-charts` vendored in `public/vendor/` (no CDN). Tests: `node --test test/`.

## Layout (target)
```
src/kraken/    rest.js (HMAC-SHA512 signing via Node crypto), ws.js, futures.js
src/data/      candles.js (store, aggregate 1h→4h→1d, CSV backfill), db.js
src/engine/    indicators.js, regime.js, playbook/<setup>.js, decide.js, risk.js
src/broker/    paper.js, live.js (same interface), reconcile.js
src/backtest/  run.js (replays candles through engine + paper broker)
src/review/    weekly.js
server.js      Express API + scheduler
public/        dashboard (desktop + phone layouts)
```

## v1 → v2
v1 files (`server.js`, `binance.js`, `coingecko.js`, `feargreed.js`, `scanner.js`, `lib/freqtradeClient.js`, `*.py`) remain on this branch until v2 replaces them; delete each once its v2 equivalent exists. `main` still holds v1. v1 services (`crypto-dashboard`, `freqtrade`, `freqtrade-trend`) are stopped and disabled on the Pi.
