# Crypto Dashboard

A locally-hosted crypto watchlist dashboard with live price data and desktop price alerts.

## Features

- Live prices, 1h / 24h / 7d % change, market cap, volume, 7-day sparkline
- Persistent watchlist stored in `data/watchlist.json`
- Price alerts with Linux desktop notifications (via `node-notifier`)
- Alerts stored in `data/alerts.json` — survive server restarts
- Auto-refresh every 60 seconds
- Sortable table columns

## Requirements

- Node.js 18+ (uses native `fetch`)
- `libnotify` for desktop notifications:  
  `sudo apt install libnotify-bin`

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install system notification tool (if not already installed)
sudo apt install libnotify-bin

# 3. Start the server
npm start

# Or use file-watching mode during development
npm run dev
```

Then open http://localhost:3000 in your browser.

## Data files

| File | Purpose |
|------|---------|
| `data/watchlist.json` | Coin IDs to track |
| `data/alerts.json` | Alert definitions |
| `data/triggered.json` | Which alerts have fired (auto-created) |

All files are plain JSON — edit them directly if you want.

## Adding coins

Use the **+ Add coin** button in the dashboard and enter the CoinGecko coin ID.
To find a coin ID: https://www.coingecko.com — the ID is the last part of the URL,
e.g. `https://www.coingecko.com/en/coins/polkadot` → ID is `polkadot`.

## Price alerts

- Set alerts from the right-hand panel
- When a condition is met, a desktop notification fires and the alert is marked **Triggered**
- Use the ↺ button to re-arm a triggered alert
- Alerts are checked every minute via a background cron job

## Port

Default: `3000`. Override with:
```bash
PORT=8080 npm start
```

## Running as a background service (systemd)

Create `/etc/systemd/system/crypto-dashboard.service`:

```ini
[Unit]
Description=Crypto Dashboard
After=network.target

[Service]
WorkingDirectory=/path/to/crypto-dashboard
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable --now crypto-dashboard
```
