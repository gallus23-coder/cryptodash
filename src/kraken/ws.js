'use strict';
const WebSocket = require('ws');
const EventEmitter = require('events');

const DEFAULT_PUBLIC_URL = 'wss://ws.kraken.com/v2';

function computeReconnectDelay(attempt, { baseMs, maxMs }) {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

class KrakenPublicWs extends EventEmitter {
  constructor({
    url = DEFAULT_PUBLIC_URL, reconnectDelayMs = 2000, maxReconnectDelayMs = 30000,
    heartbeatTimeoutMs = 30000,
  } = {}) {
    super();
    this.url = url;
    this.reconnectDelayMs = reconnectDelayMs;
    this.maxReconnectDelayMs = maxReconnectDelayMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.subscriptions = [];
    this.closedByUser = false;
    this.reconnectAttempts = 0;
    this.ws = null;
    this.heartbeatTimer = null;
  }

  connect() {
    this.closedByUser = false;
    this.ws = new WebSocket(this.url);
    this._resetHeartbeat();

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.emit('open');
      for (const sub of this.subscriptions) this._send(sub);
    });

    this.ws.on('message', (raw) => {
      this._resetHeartbeat();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.emit('message', msg);
      if (msg.method === 'subscribe' && msg.success === false) {
        this.emit('error', new Error(`Kraken subscribe failed: ${msg.error || 'unknown error'}`));
        return;
      }
      if (msg.channel) this.emit(msg.channel, msg);
    });

    this.ws.on('close', () => {
      this._clearHeartbeat();
      this.emit('close');
      if (!this.closedByUser) {
        const delay = computeReconnectDelay(this.reconnectAttempts, {
          baseMs: this.reconnectDelayMs, maxMs: this.maxReconnectDelayMs,
        });
        this.reconnectAttempts += 1;
        setTimeout(() => this.connect(), delay);
      }
    });

    this.ws.on('error', (err) => this.emit('error', err));
  }

  _resetHeartbeat() {
    this._clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      if (this.ws) this.ws.terminate();
    }, this.heartbeatTimeoutMs);
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  _subscribe(sub) {
    const isDuplicate = this.subscriptions.some((s) => JSON.stringify(s) === JSON.stringify(sub));
    if (isDuplicate) return;
    this.subscriptions.push(sub);
    this._send(sub);
  }

  subscribeTicker(symbols) {
    this._subscribe({ method: 'subscribe', params: { channel: 'ticker', symbol: symbols } });
  }

  subscribeOhlc(symbols, interval) {
    this._subscribe({ method: 'subscribe', params: { channel: 'ohlc', symbol: symbols, interval } });
  }

  close() {
    this.closedByUser = true;
    this._clearHeartbeat();
    if (this.ws) this.ws.close();
  }
}

module.exports = { KrakenPublicWs, DEFAULT_PUBLIC_URL, computeReconnectDelay };
