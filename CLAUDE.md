# Crypto Dashboard

Local crypto watchlist dashboard running on a Raspberry Pi.

## Stack
- Node.js + Express backend
- Vanilla JS / HTML frontend (single file: public/index.html)
- JSON file persistence (data/)
- CoinGecko free API (no key required)
- systemd service

## Project structure
- server.js — Express API, cron alert checker, desktop notifications
- public/index.html — full frontend UI
- data/watchlist.json — persisted coin watchlist
- data/alerts.json — persisted price alerts
- data/triggered.json — auto-created, tracks fired alerts

## Dev workflow
- Restart after backend changes: sudo systemctl restart crypto-dashboard
- Logs: journalctl -u crypto-dashboard -f
- Runs on: http://localhost:3000

## Conventions
- Keep frontend as a single HTML file unless it gets unwieldy
- API routes all under /api/
- No database — JSON files only
- Don't add unnecessary dependencies
