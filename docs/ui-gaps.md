# UI gaps

Dashboard panels whose text was simplified to short, user-facing wording
("Coming soon", "not tracked", etc). This file keeps the technical detail
behind that wording so it isn't lost, without putting it in front of users.

## Strategy tab — Fee check line

UI text: "Fee check: a coin's typical 4h move must beat a multiple of the
round-trip fee."

Detail: the actual multiple is `feeViabilityMultiple` in
`src/engine/config.js` (`DEFAULT_RISK_CONFIG`, currently `4`). It's not
exposed via any API endpoint yet, so the UI can't show the live value —
only the static English description above. Wiring it through would need a
field added to `/api/settings/guardrail-caps` or `/api/strategy`.

## Strategy tab — Funding rate

UI text: "Funding (avg): Coming soon."

Detail: Kraken Futures funding-rate data isn't fetched anywhere in
`src/kraken/futures.js` yet — milestone 1 only covers Spot REST/WS. No
candidate work has started on this.

## Settings tab — Telegram toggles

UI text: "Telegram notifications: Coming soon."

Detail: Telegram outbound notifications are a documented v2 feature
(`CLAUDE.md`) but no `src/telegram/` module exists yet and no config key
for a bot token is read anywhere. The toggles in Settings are rendered
`disabled` to match the mockup's layout but have no backing endpoint —
checking one does nothing.
