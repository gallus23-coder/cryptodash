'use strict';
const WebSocket = require('ws');
const EventEmitter = require('events');

const DEFAULT_PUBLIC_URL = 'wss://ws.kraken.com/v2';

class KrakenPublicWs extends EventEmitter {
  constructor({ url = DEFAULT_PUBLIC_URL, reconnectDelayMs = 2000 } = {}) {
    super();
    this.url = url;
    this.reconnectDelayMs = reconnectDelayMs;
    this.subscriptions = [];
    this.closedByUser = false;
    this.ws = null;
  }

  connect() {
    this.closedByUser = false;
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.emit('open');
      for (const sub of this.subscriptions) this._send(sub);
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.emit('message', msg);
      if (msg.channel) this.emit(msg.channel, msg);
    });

    this.ws.on('close', () => {
      this.emit('close');
      if (!this.closedByUser) setTimeout(() => this.connect(), this.reconnectDelayMs);
    });

    this.ws.on('error', (err) => this.emit('error', err));
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  subscribeTicker(symbols) {
    const sub = { method: 'subscribe', params: { channel: 'ticker', symbol: symbols } };
    this.subscriptions.push(sub);
    this._send(sub);
  }

  subscribeOhlc(symbols, interval) {
    const sub = { method: 'subscribe', params: { channel: 'ohlc', symbol: symbols, interval } };
    this.subscriptions.push(sub);
    this._send(sub);
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
  }
}

module.exports = { KrakenPublicWs, DEFAULT_PUBLIC_URL };
