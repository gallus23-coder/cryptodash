# Cryptodash v2: Kraken-only rebuild (design spec)

**Status:** Draft, 18 Nov 2026
**Replaces:** cryptodash v1 + Freqtrade (CryptodashStrategy / CryptodashTrendStrategy)

## 1. Goals

- **Fewer interfaces.** One Node service. The only outside services are Kraken and Anthropic.
- **Flexible, not hard-coded.** Trading adapts to market conditions through regimes, volatility-scaled setups and Claude's choices within limits.
- **Testable.** The backtester and live trading run the same strategy code, so anything that isn't Claude can be backtested.
- **Measurable AI.** Every Claude decision is logged next to the default action, so its value can be proven or disproven.
- **Safe.** Hard limits live in code, not in prompts. Every live position has a stop order on Kraken.

**Not in scope:** shorting, leverage, futures trading (futures data is read only), and high-frequency trading.

## 2. Dependencies

| Kept | Purpose |
|---|---|
| Kraken Spot REST + WebSocket v2 | Prices, candles, balances, orders |
| Kraken Futures public API | Funding rate and open interest (read only, no account needed) |
| Anthropic API | Hourly decisions and the weekly review |
| npm: `better-sqlite3`, `express`, `node-cron`, `ws` | Database, web server, scheduler, WebSocket client |
| Telegram Bot API (outbound only) | Trade and alert notifications |
| Tailscale (already in use) | Private access from phone/laptop; not called by the app |
| Front-end: `lightweight-charts` (stored in `public/vendor/`, not loaded from a CDN) | Candlestick charts |

**Removed:** Freqtrade, Binance spot and futures, CoinGecko, alternative.me (Fear & Greed), frankfurter.app, open.er-api.com, and the `signals.json` file handoff.
**Side benefit:** everything runs in GBP on Kraken data, so the USD/GBP mismatch and the currency-rate lookups go away.

## 3. Architecture

```
src/
  kraken/
    rest.js        signed private calls (HMAC-SHA512 with Node crypto), public OHLC/Ticker/AssetPairs
    ws.js          WebSocket v2: ticker + ohlc subscriptions, auto-reconnect
    futures.js     public funding/open interest per coin
  data/
    candles.js     store/aggregate 1h -> 4h -> 1d, gap detection, CSV backfill import
    db.js          SQLite schema + queries
  engine/
    indicators.js  EMA, RSI, ATR, ADX, Choppiness, Bollinger, Donchian (pure functions)
    regime.js      market -> regime label + metrics
    playbook/      one file per setup, each returns candidates
    decide.js      calls Claude, validates its JSON, applies limits
    risk.js        guardrails, sizing, kill switch
  broker/
    paper.js       simulated fills on live Kraken prices (fees + slippage)
    live.js        real Kraken orders; same interface as paper.js
    reconcile.js   on startup: match DB against Kraken open orders/balances
  backtest/
    run.js         replays stored candles through engine/ + broker/paper.js
  review/
    weekly.js      Claude review of results -> proposed config changes
  server.js        Express API + scheduler
public/            dashboard (see section 8)
```

**Rule:** `engine/` never calls the network or the clock directly. Data comes in as arguments. That is what lets the backtester and live trading run identical code.

## 4. Market data

- **Pairs (GBP on Kraken):** BTC, ETH, SOL, XRP, ADA, LINK. Kraken's own codes are mapped in one table (e.g. `XBT/GBP`, `XXBTZGBP`).
- **Timeframes:** 1h is stored. 4h and 1d are built from it.
- **720-candle limit:** Kraken's OHLC endpoint only returns the latest 720 candles. To get more:
  1. A one-off import of Kraken's downloadable OHLCVT history files (CSV) for the backtest period.
  2. From then on the service writes every closed candle itself, so history keeps growing.
  3. On startup, gaps are filled from the REST OHLC endpoint (fine as long as downtime is under ~30 days).
- **Futures context:** each coin's perpetual (`PF_XBTUSD` etc.) supplies the funding rate and open interest every hour.

## 5. The hourly decision cycle

Runs at every 1h candle close, about 30 seconds after the hour, using **completed candles only** (Kraken's most recent OHLC row is still forming and is never used). Each setup is evaluated only when **its own timeframe closes**: 4h setups at 00/04/08/12/16/20 UTC, 1h setups every hour. See section 13, stage A.

### 5.1 Regime (calculated, no AI)

| Metric | Source |
|---|---|
| Trend | BTC close vs daily EMA200, plus the EMA200's 20-day slope |
| Trendiness | ADX(14) on 4h; Choppiness Index(14) on 4h |
| Volatility | ATR(14) as % of price on 4h, ranked against the last 90 days |
| Breadth | % of watchlist coins above their 4h EMA50 |
| Positioning | Average funding rate; 24h change in open interest |

Starting labels. The thresholds live in the config. The weekly review may only propose regime threshold changes monthly. A buffer (enter vs exit thresholds, plus a minimum hold) is a stage B option, adopted only if it beats no buffer in backtest (section 13).

| Regime | Rule (first match wins) |
|---|---|
| `risk_off` | Volatility rank > 90th percentile **or** BTC 24h drop > 6% |
| `trend_up` | BTC above daily EMA200 **and** ADX > 22 **and** breadth ≥ 60% |
| `downtrend` | BTC below daily EMA200 **and** EMA200 slope falling |
| `range` | Everything else |

### 5.2 Playbook (finds candidates; never trades by itself)

Each setup lists the regimes it's allowed in, plus ranges for its settings. Stops and targets are set in ATR multiples, so they widen or tighten with volatility automatically.

| Setup | Allowed in | Entry idea | Default stop | Default exit |
|---|---|---|---|---|
| `trend_breakout` | trend_up | 4h close above the 20-bar high, ADX rising | 2×ATR | Trailing stop at 3×ATR below the high; no fixed target |
| `trend_pullback` | trend_up | Pullback to the 4h EMA20/50 that holds, RSI(14) 40–55 | 1.5×ATR | Trailing stop at 2.5×ATR |
| `range_reversion` | range | Close below the lower Bollinger band, RSI(2) < 10, price above daily EMA200 | 1.5×ATR | Bollinger middle band, or 24h time stop |
| `oversold_bounce` | downtrend (half size max) | RSI(2) < 5 on 4h after a 3-day fall | 1×ATR | First 4h close above the EMA20, or 12h |
| none | risk_off | No new entries; tighten trailing stops on open trades | | |

A candidate looks like this:
```json
{ "id": "c_20261118_10_SOL_trend_pullback", "coin": "SOL", "setup": "trend_pullback",
  "regime": "trend_up", "entry": 98.40, "atr": 3.10,
  "default": { "action": "take", "size": 1.0, "stopAtr": 1.5, "trailAtr": 2.5 },
  "ranges":  { "size": [0, 1], "stopAtr": [1.0, 3.0], "trailAtr": [1.5, 4.0] },
  "context": { "rsi14": 47.2, "adx4h": 26.1, "funding": 0.004, "oiChange24h": 0.031 } }
```

### 5.3 Claude decides

- **Input:** regime and its metrics, all candidates, open positions with profit/loss, the last 20 closed trades and their results, active setup config, and remaining guardrail headroom.
- **Allowed actions:** for each candidate `take` / `skip` / resize (0–1×), adjust stop and trail **within the ranges**, and `disable_setup` for the rest of the current regime. For open positions, tighten a stop (never loosen it) or close.
- **Output (strict JSON, schema-checked; anything invalid means no action this hour):**
```json
{ "decisions": [ { "candidateId": "c_..._SOL_trend_pullback", "action": "take",
    "size": 0.5, "stopAtr": 2.0, "trailAtr": 2.5,
    "reason": "Setup valid but funding elevated and breadth falling; half size, wider stop.",
    "plainReason": "Prices are rising but traders look over-excited, so it bought a smaller amount with more room." } ],
  "positionActions": [], "setupToggles": [], "marketNote": "One-paragraph read of conditions.",
  "plainNote": { "mood": "positive, but be careful", "bullets": ["Prices are mostly going up.", "..."], "botAction": "Buying small dips, half-size trades." } }
```
- **If Claude fails** (timeout, error, invalid output), fall back to `skip all`. A broken AI step must never open a trade.

### 5.4 Guardrails (code; Claude can't change these)

| Limit | Starting value |
|---|---|
| Risk per trade | 0.5% of balance (paper); stake = risk ÷ stop distance, clamped by the caps below. Claude's size multiplier scales the risk, not a £ amount. |
| Max open positions | 3 |
| Total open risk | 1.5% of balance across all open trades. The watchlist is treated as one correlated group. |
| Max exposure per coin | 20% of balance |
| Max total exposure | 60% of balance |
| Daily loss limit | 3% of balance; hit it and nothing new opens until midnight UTC |
| Weekly drawdown kill switch | 8%; hit it and everything pauses until restarted by hand |
| Cooldown after a stop on a coin | 6h |
| Stop order | Always placed on the exchange at entry (live mode) |
| Fee check | Skip a coin if its ATR (as % of price, on the setup's timeframe) is below 4× the round-trip fee |

### 5.5 Weekly review (learning loop)

Every Sunday Claude reads the week's trades, grouped by setup × regime, plus a comparison of its own choices against the default actions. It produces a **proposed config change** (new thresholds, ranges, setups to enable or disable) with reasons. The proposal appears in the UI as a pending change: **you approve it, then it applies.** Config versions are stored so any change can be rolled back.

### 5.6 API cost controls

The Anthropic API is billed separately from the claude.ai subscription (pay-as-you-go through the Console).

| Control | Detail |
|---|---|
| Call only when needed | Claude is called only if the hour has candidates, or an open position is near its stop/target, or the regime changed. Quiet hours make no call. |
| One call per cycle | All candidates and positions in one request (v1 made one call per coin, ~96/day). |
| Model | Sonnet 5.5 for decisions; Haiku 5.5 for the market note on regime change. Model is a config value. |
| Compact input | Numbers and summaries only, no raw candles. Target under 4k input tokens; cap output at 600 tokens and use low reasoning effort. |
| Prompt caching | Static system prompt and playbook definitions marked cacheable. Little benefit at hourly cadence, but free to add. |
| Batch API | Weekly review goes through the Batch API (50% off; not time-sensitive). |
| Budget cap in code | `usage` tokens from every response are stored on the decision row and costed. Monthly limit (default $10): once reached, the cycle falls back to `budgetFallback` (`skip` or `default`). |
| Console limit | A monthly spend limit is also set in the Anthropic Console, as a backstop. |
| Visible | Spend this month, calls today and average cost per call are shown on the Current strategy tab. |

**Provider switch:** `decide.js` sits behind a provider setting. **Default: `claude-cli`** (owner is on the Pro plan, which has no API credits).
- `api`: Anthropic API key, pay-as-you-go. On Max/Ultra plans, the plan's monthly API credits cover this when the key comes from the linked Console organisation.
- `claude-cli`: runs `claude -p --output-format json` on the Pi, signed in with the claude.ai plan, so it draws on subscription limits instead of credits. If a plan limit is hit, that cycle falls back to `budgetFallback`. Anthropic has changed this policy before, so `api` stays available as a one-line switch.

**Rough cost (Sonnet 5.5, ~4k in / ~400 out ≈ $0.012 per call):** a few calls a day if only called on candidates ≈ $1/month; worst case every hour ≈ $9/month. Haiku 5.5 for the same calls ≈ $0.0006 per call (well under $1/month even hourly).

## 6. Execution

- **Same interface for paper and live:** `placeEntry`, `placeStop`, `amendStop`, `close`, `getPositions`.
- **Entries:** limit orders, post-only by default (maker 0.25% vs taker 0.40%). If an order doesn't fill within 15 minutes, cancel it and mark the candidate `missed`; its shadow outcome is still tracked, so the fill rate and what missed trades would have made are both visible. Every order carries a client order ID built from the candidate ID, so a restart can't double-send.
- **One exit order per position** (Kraken holds the coins for each open sell order, so stop + trail + target orders can't all sit on the full amount):
  - **Trend setups:** a plain `stop-loss` until the trail activates, then replaced by a single `trailing-stop` order.
  - **Reversion setups:** OCO stop + target if the API supports it; otherwise the stop on Kraken and the target watched in code.
  - **Confirmed (milestone 1, 2026-11-18):** OCO is UI-only on Kraken Pro, not exposed via the REST or WS API — so reversion setups always use the stop-on-Kraken, target-in-code fallback. A sell/stop order reserves the full holding the moment it's placed (not on fill), so a second sell order on the same holding is rejected with `EOrder:Insufficient funds` — confirms "one exit order per position" is enforced by Kraken itself, not just convention. `AmendOrder` (not the older `EditOrder`) can tighten a stop-loss/trailing-stop's `trigger_price` in place, preserving order ID and queue position — use that instead of cancel+replace for "tighten only" stop updates. Live order placement and the reservation check are still unverified against the real account (it holds no funds yet); re-run `scripts/verify-kraken-orders.js`-style checks once it's funded, before going live in milestone 10.
- **Paper broker:** fills at the next tick past the limit price, applies taker or maker fees and 0.05% slippage, and checks stops against each 1h candle's low.
- **Reconcile on startup:** compare the DB against Kraken open orders and balances. Anything that doesn't match pauses trading and alerts.
- **API key:** query + trade permissions only, **no withdrawals**. Held in an env file outside the repo.

## 7. Database (SQLite)

| Table | Holds |
|---|---|
| `candles` | coin, timeframe, ts, OHLCV |
| `market_context` | hourly funding rate and open interest per coin |
| `regimes` | ts, label, metrics JSON |
| `candidates` | id, ts, coin, setup, regime, entry, default action, context JSON |
| `decisions` | candidate id, Claude action, size/stop/trail, reason, default action, `diverged` flag, model, latency, raw response |
| `orders` | Kraken txid or paper id, type, price, status, fills |
| `trades` | entry/exit, P&L after fees, exit reason, setup, regime, candidate id |
| `config_versions` | version, JSON, status (active/pending/rejected), who/when |
| `cycle_log` | one row per hourly run: duration, errors, guardrail state |
| `cycle_snapshots` | per cycle: all coin measures, regime, candidates, near-misses, Claude input/output, prompt version (compressed JSON) |
| `setups` | setup id, version, status (`trial` / `active` / `off` / `auto_off`), trade count, rolling expectancy in R, status history |
| `benchmarks` | daily equity of bot, buy-and-hold BTC and cash, from the mode's start date |

**Shadow outcome:** for every candidate, including skipped and missed ones, record what the default action would have made, simulated forward on the candles with the same exit logic. That gives the Claude-vs-default comparison. All results are stored in **R** (P&L ÷ amount risked) as well as £.

## 8. Dashboard (UI)

Three main tabs plus a settings view. No external calls from the browser: all data comes from the Node service.

### 8.1 Charts
- Candlestick chart per coin (1h / 4h / 1d toggle) with EMA20/50/200 and Bollinger bands you can switch on and off.
- **Trade markers:** entry ▲ and exit ▼, coloured by result. Open positions show the live stop and trail lines.
- **Candidate markers:** small dots where a setup fired, with a hover showing Claude's decision and reason.
- **Regime band** under the chart: a coloured strip showing which regime was active over time.
- Indicator panel underneath: RSI / ADX / funding.

### 8.2 Current strategy
- **Regime card:** current label, how long it's held, and the metrics behind it (trend, ADX, volatility rank, breadth, funding).
- **Market note in two versions, side by side:** a plain-English summary (a mood line, 3–4 short bullets and "what the bot is doing") and Claude's technical note. Both come from the same call, with the decision output's JSON gaining a `plainNote` field, so there's no extra cost.
- **Strategy controls:**
  - Risk level: Cautious / Normal / Bold. Scales stake and max positions, always within the guardrail caps.
  - An on/off tickbox per setup in the setups table.
  - Edit a setup's stop and trail ranges.
  - **Backtest changes** (last 90 days, deterministic, no Claude), then **Save as pending** to create a new config version for approval.
  - **Recalculate now:** re-reads the market and re-runs the playbook, free.
  - **Ask Claude to re-decide:** 1 call.
  - **Ask Claude to review the strategy:** runs the weekly review on demand, 1 larger call.
  - Guardrail caps are only editable in Settings, with a confirmation.
  - Every change creates a new config version.
- **Active setups:** which are enabled for this regime, their current ranges, and the win rate and expectancy for each over the last 30 / 90 days.
- **Open positions:** entry, current price, P&L, stop, trail distance, time in trade.
- **Guardrails:** used vs available for exposure, daily loss and weekly drawdown, plus the kill switch status and a manual pause button.
- **Config:** active version, any pending weekly proposal (with a diff and Approve / Reject buttons), and history.

### 8.3 Decision log
- A timeline with one row per hourly cycle: time, regime, number of candidates, actions taken, and a plain-English one-liner. Code writes the plain line for non-Claude events (no call, stop hit, fallback); Claude writes it for its own decisions. Click a row to expand it.
- **Expanded view:** each candidate's default vs Claude's decision, a **plain-English explanation** (green panel, 1–3 short sentences, no jargon) beside Claude's technical reasoning, the outcome (trade P&L or shadow P&L if skipped), plus position actions and setup toggles.
- **Filters:** coin, setup, regime, action, "Claude overrode default", result.
- **Scorecard at the top:** Claude's choices vs the defaults in **R**, over 7 / 30 / 90 days, with the number of decisions and a confidence range. It reads "not enough data yet" until about 100 overrides, which is likely 5–8 months. This is the number that says whether the AI layer earns its keep.
- Also logs errors, fallbacks ("Claude invalid → skipped") and guardrail blocks.

### 8.4 Settings: paper vs live
- **Always visible:** the header pill says `PAPER` (amber) or `LIVE · REAL MONEY` (red). Live mode adds a red stripe across the top of every screen and shows the real Kraken balance.
- **Mode cards:**
  - Paper: editable starting balance (default £1,000), current balance and return, and a reset button.
  - Live: Kraken GBP balance, API key status and permissions, with "no withdraw" confirmed.
- **Go-live checklist** (from section 11). Switch to live stays disabled until every check is done; reconcile and kill switch each have a "Run test" button.
- **Switching to live:**
  - You type `LIVE` and re-enter the dashboard password.
  - Open paper trades finish as paper; only new trades use real money.
  - Live stakes start at 25% of paper size.
  - Optionally, paper keeps running alongside live so the comparison continues.
- **Back to paper:** one click, immediate. You choose whether to leave open live trades with their Kraken stops in place, or close them at market.
- **Guardrail caps:** separate paper and live columns, with live tighter by default (stake £25, 2 positions, 40% exposure, 2% daily loss, 5% weekly kill switch). Saving asks for confirmation.
- **Separation:** `mode` column on `orders`, `trades`, `decisions`, `candidates` and `config_versions`. P&L and scorecards never mix modes; every screen has a Paper / Live / Both filter, and live markers on charts get a red outline.

### 8.5 Phone layout
- Same web app, responsive. Under ~700px wide it switches to a phone layout with a bottom tab bar: **Overview · Charts · Decisions · Settings**.
- **Overview:** balance and today's P&L, the plain-English market mood, open positions (tap for detail), the last decision, and a pause button in the top bar.
- **Charts:** coin chips, a compact candle chart with the regime strip and RSI, the position card, and a **Close position now** button.
- **Decisions:** the 30-day Claude-vs-default score, filter chips (All / Trades / Overrides / Errors), and the recent cycles.
- Add a web app manifest so it can be added to the phone's home screen and opens full-screen.

### 8.6 Notifications (Telegram)
- Bot token and chat ID live in the env file. **Outbound only.** The bot never accepts commands, so a leaked token can't change anything.
- Toggle per event: trade opened, trade closed, stop hit, guardrail or kill switch hit, Claude fallback/error, config waiting for approval, regime change (off by default), daily summary at 21:00.
- Each message starts with the mode (`PAPER` / `LIVE`) and ends with the Tailscale dashboard link. Settings has a **Send test message** button.
- Sending failures are logged and retried once. They never block trading.

### 8.7 Hosting and access
- **Tailscale (kept).** No ports are opened on the router.
- The Node app listens on `127.0.0.1:3000` only.
- `tailscale serve --bg 3000` publishes it as `https://<pi-name>.<tailnet>.ts.net` with an automatic HTTPS certificate, reachable only from your tailnet devices.
- **Don't** use Tailscale Funnel, which makes it public.
- Tailscale ACLs limit access to your phone and laptop.
- The dashboard password still applies on top. Live-mode actions (switch to live, raise caps, close all) ask for it again.

### 8.8 How it works (mechanics screen)
- A plain-English walk-through of the **current** process, in 8 numbered steps: check the market → decide the market mood → look for trade ideas → ask Claude → safety checks → place the trade → look after open trades → Sunday review.
- **Built from the active config, not hand-written.** Each step is a text template filled with live values (thresholds, risk %, which setups are on, the schedule). Approving a new config version regenerates it automatically, so it can't drift from what the code actually does.
- Each step has a green **"Right now"** line with live state, e.g. "Rising, for 3 days 4 hours" or "0.75% at risk across 2 trades".
- A **Plain English / Technical** toggle. Technical shows the same steps with indicator names, exact rules and config keys.
- Side panel:
  - **At a glance:** mode, config version, mood, risk numbers, Claude models.
  - **Optional features:** each section 13 stage B/C item marked On / Off / Testing.
  - **Changed in vN:** the config diff since the previous version, in plain English.

## 9. API (Express)

```
GET  /api/candles/:coin?tf=1h&from=&to=
GET  /api/markers/:coin?from=&to=          trades + candidates for chart overlays
GET  /api/regime/current
GET  /api/regime/history?from=&to=
GET  /api/strategy                          setups, ranges, stats, guardrails, config
GET  /api/positions
GET  /api/decisions?from=&to=&coin=&setup=&diverged=
GET  /api/decisions/:cycleId
GET  /api/scorecard?days=30
GET  /api/config/pending
POST /api/config/:version/approve | reject
GET  /api/mechanics?style=plain|technical    config-generated process walk-through
POST /api/control/pause | resume
POST /api/control/recalculate              regime + playbook, no Claude
POST /api/control/redecide                 re-run this hour's Claude decision
POST /api/control/review                   on-demand strategy review
POST /api/config/draft                     risk level, setup toggles, ranges -> draft
POST /api/config/draft/backtest            90-day backtest of the draft
POST /api/config/draft/submit              draft -> pending version
```
Auth: the API listens only on the Pi's local network, with a single password from an env file. No credentials in the repo.

## 10. Build order

| # | Milestone | Done when |
|---|---|---|
| 1 | Kraken client (REST public/private, WebSocket, futures) + tests | Can fetch candles and balance, and place/cancel a tiny limit order |
| 2 | Candle store + CSV backfill import | 6 months of 1h GBP candles for all 6 coins, no gaps |
| 3 | Indicators + regime | Regime history over 6 months looks sensible on the chart |
| 4 | Playbook + backtester (default actions only) | **Pass/fail point.** Results per setup for May–Nov 2026 after fees, in R, **and against buy-and-hold BTC**. Keep setups with positive expectancy and 30+ trades. If none pass, fix or replace setups before building milestones 6+. |
| 5 | Paper broker + risk + scheduler | Runs hourly in paper mode on the Pi |
| 6 | Claude decision layer + logging + shadow outcomes | Decision log filling up; fallbacks tested |
| 7 | Dashboard: Charts, Strategy, Decision log | All three tabs working on live paper data |
| 8 | Weekly review + config approval | First proposal approved through the UI |
| 9 | Parallel run vs Freqtrade (paper) | 4+ weeks |
| 10 | Live (small stake) | Go-live criteria met |

**Migration (decided 18 Nov):** v2 replaces v1 in place. No parallel run with Freqtrade; v1 is not performing well enough to be worth keeping. Build on a `v2` branch, then merge to `main` once milestones 1–5 work. At that point, stop and disable the `freqtrade` and `freqtrade-trend` services, archive their SQLite DBs, and repoint `crypto-dashboard` to v2. The v1 code stays in git history and under a `v1-final` tag. Step 9 becomes 4+ weeks of v2 paper trading before live.

## 11. Go-live criteria

- 60+ paper trades in v2, with positive expectancy after fees.
- Claude-vs-default scorecard not negative over 30 days. If it is, run with defaults only.
- Reconcile, kill switch and daily loss limit all tested deliberately.
- Kraken key confirmed to have no withdrawal permission.
- Start live at 25% of the paper stake.

## 12. Decisions made / open

- **Made:** Claude decides within limits (it's not a pure veto or a free agent); Kraken Futures supplies funding/OI; Fear & Greed, CoinGecko and Binance are dropped; new branch running in parallel.
- **Made (18 Nov):** Telegram for notifications (outbound only); Tailscale Serve for access; phone layout in scope.
- **Open:** final watchlist (keep 6 or add more Kraken GBP pairs?); whether to keep the opportunity scanner (it can be rebuilt on Kraken tickers).
- **Made (18 Nov):** staged mechanics revisions (section 13); results measured in R; milestone 4 is a pass/fail point.
- **Made (18 Nov):** benchmark vs holding BTC/cash, setup trial → active → auto-off lifecycle, and full cycle snapshots are part of stage A. Further mechanics wait for data; the design is complete enough to build.

## 13. Mechanics revisions (staged)

Added after reviewing the decision process. Each stage is gated: only build what the previous stage justified. Every refinement adds settings, and every setting is something else that can be over-tuned to past data.

### Stage A: build in from the start (milestones 1–5)
| Change | Why |
|---|---|
| Setups run only on their own timeframe's **completed** candles | Stops false signals from half-formed 4h candles |
| Risk-based sizing, results in R | Makes trades comparable; Claude scales risk, not £ |
| Fee check (ATR % ≥ 4× round-trip fee) | Blocks trades whose typical move can't beat fees, v1's main loss pattern |
| One total-risk cap for the whole watchlist (1.5%) | The coins are almost always >0.8 correlated; a per-pair correlation calc adds nothing |
| Client order IDs + reconcile on startup | No double orders after a restart |
| One exit order per position (section 6) | Kraken holds the coins for each open sell order |
| Data checks before each cycle (missing candle, outlier price, spread > 0.3%) | Kraken GBP pairs are thinner; skip the coin for that hour and log why |
| **Benchmark vs holding BTC and holding cash** | Return, worst drawdown and return ÷ worst drawdown for the bot, buy-and-hold BTC and cash, from the same start date and after fees. Shown on the Decision log and How it works screens. The core "is it worth running?" test. |
| **Setup lifecycle: trial → active → auto-off** | Setups are plug-ins (one file each, same interface). A new setup starts in `trial`: record-only shadow tracking, no paper or live orders. It can be activated (with your approval) after 30+ trades with positive expectancy after fees. An `active` setup whose rolling 30-trade expectancy falls below −0.2R switches to `auto_off`, sends a Telegram alert, and needs approval to come back. |
| **Full cycle snapshots** | Every hour, store each coin's measures, the regime, all candidates and near-misses, and Claude's full input/output (`cycle_snapshots` table, a few MB/month). Lets any decision be replayed exactly and lets new setup ideas be tested on real recorded data, including what Claude saw. |

### Stage B: only if the milestone 4 backtest shows an edge
Each item is A/B tested in the backtester against not having it, with trade counts shown.
| Change | Trade-off to test |
|---|---|
| Regime buffer: enter trend_up at ADX > 24, leave below 20, new regime must hold 2 × 4h closes (risk_off immediate) | Less flapping vs entries 8–12h later |
| Per-coin trend state alongside the BTC regime | Fewer bad entries vs fewer trades |
| Candidate quality score 0–100 + near-miss logging (40–59) | Better ranking vs more settings |
| Exit rules: on `risk_off` tighten all stops to 1×ATR; stale-trade exit after N candles; log each trade's best price to measure profit given back | v1 lost money on exits |
| Order type per setup (maker for pullbacks, taker for breakouts) | Better fills vs higher fees |

### Stage C: once there's live paper data (~2–3 months)
| Change | Detail |
|---|---|
| Weekly review guards | No proposal for a setup with < 20 trades in the window; each value moves at most ±20% per review and is locked for 2 weeks after a change; regime thresholds reviewed monthly only |
| Walk-forward check on proposals | Backtest on the earlier 60 days, check on the following 30. Show trade counts; anything under 30 trades is labelled "too few to judge", not pass or fail |
| Old vs new config shadow | After approving vN, the previous version keeps running as a **default-only** shadow (no Claude calls, so no extra cost). If vN trails after 2 weeks, the review proposes a rollback |
| Claude inputs | Summary stats per setup and regime (win rate, expectancy, sample size) instead of the raw last-20 trades, to reduce recency bias |
| Prompt versioning | Every decision logs a prompt version so results can be compared across prompt changes |
| Claude confidence score (1–5) | **Logged only.** Used for sizing only if the data shows it actually predicts results |
| Scorecard confidence | R-based, with decision count and confidence range; "not enough data yet" until ~100 overrides |

### Pass/fail point
At the end of milestone 4, if the default playbook shows no positive expectancy over May–Nov 2026 after fees, fix or replace the setups before building the Claude layer (milestone 6) and the review loop (milestone 8).
