# UI mockups (design reference)

Static HTML exports of the agreed v2 dashboard design (claude.ai Design canvas, 18 Nov 2026). Open any file in a browser; tabs link between them. **All numbers are sample data.**

| File | Screen |
|---|---|
| `Charts.html` | Charts (default tab): watchlist sidebar, candles + markers + stop/trail lines, regime band, RSI, open-position + entry-decision side cards |
| `Strategy.html` | Current strategy: regime card, plain-English + Claude market note, setups table (with trial status), positions, guardrails in risk %, fee check, controls, Claude usage, pending config |
| `Decisions.html` | Decision log: bot vs holding BTC/cash, R scorecard with "not enough data" banner, filters, timeline with plain-English + Claude reasoning |
| `HowItWorks.html` | How it works: 9-step plain-English walkthrough generated from config |
| `Settings.html` | Settings: paper vs live, go-live checklist, switching rules, guardrail caps (paper/live), Telegram notifications |
| `M_Overview.html`, `M_Trade.html`, `M_Decisions.html` | Phone layout (under ~700px): bottom tab bar Overview / Charts / Decisions / Settings |

Look: light theme (`#F3F4F6` page, white panels, `#111827` header), Inter + JetBrains Mono for numbers, wide fluid layout (max 1440px) with a main column and a side column that stacks on narrow screens. Live mode adds a red top stripe and a red `LIVE · REAL MONEY` pill.
