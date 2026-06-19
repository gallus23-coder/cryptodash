import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd
from pandas import DataFrame
from freqtrade.strategy import IStrategy
from freqtrade.strategy.interface import IStrategy
import talib.abstract as ta

logger = logging.getLogger(__name__)

SIGNALS_FILE = Path('/home/gallus23/crypto-dashboard/data/signals.json')

PAIR_TO_COIN = {
    'BTC/GBP':  'bitcoin',
    'ETH/GBP':  'ethereum',
    'SOL/GBP':  'solana',
    'XRP/GBP':  'ripple',
    'ADA/GBP':  'cardano',
    'BNB/GBP':  'binancecoin',
    'LINK/GBP': 'chainlink',
}


class CryptodashTrendStrategy(IStrategy):
    """
    Trend Following Strategy — catches trend continuation moves.
    Runs alongside CryptodashStrategy as a second Freqtrade instance on port 8081.

    Entry: price above both EMA50 and EMA200, RSI 45-70, MACD positive and rising,
           volume above 1.2x average, signal is not sell/strong_sell.
    Exit:  15% take profit, 5% stop loss, 48h time stop, strong_sell reversal.

    Does NOT require allCriteriaMet: true or signal == strong_buy.
    Any non-sell signal (hold, buy, strong_buy) qualifies as trend-allowed entry.
    """

    INTERFACE_VERSION = 3

    timeframe = '1h'
    stoploss = -0.05
    minimal_roi = {
        "0":  0.15,
        "48": 0.05,
        "72": 0.00,
    }

    trailing_stop = False
    process_only_new_candles = True
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    MAX_SIGNAL_AGE_MINUTES = 20
    TIME_STOP_HOURS = 48

    # ── indicators ────────────────────────────────────────────────────────────
    def populate_indicators(self, dataframe: DataFrame,
                            metadata: dict) -> DataFrame:
        # EMA 200 — primary trend filter
        dataframe['ema200'] = ta.EMA(dataframe['close'], timeperiod=200)

        # EMA 50 — medium term trend
        dataframe['ema50'] = ta.EMA(dataframe['close'], timeperiod=50)

        # RSI 14
        dataframe['rsi'] = ta.RSI(dataframe['close'], timeperiod=14)

        # MACD
        macd, macd_signal, macd_hist = ta.MACD(
            dataframe['close'],
            fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe['macd']        = macd
        dataframe['macd_signal'] = macd_signal
        dataframe['macd_hist']   = macd_hist

        # StochRSI
        dataframe['fastk'], dataframe['fastd'] = ta.STOCHRSI(
            dataframe['close'],
            timeperiod=14, fastk_period=3, fastd_period=3)

        # Volume ratio vs 20-period average
        dataframe['volume_mean']  = dataframe['volume'].rolling(20).mean()
        dataframe['volume_ratio'] = dataframe['volume'] / dataframe['volume_mean']

        # EMA50 distance percentage
        dataframe['ema50_dist_pct'] = (
            abs(dataframe['close'] - dataframe['ema50'])
            / dataframe['ema50'] * 100)

        return dataframe

    # ── helpers ───────────────────────────────────────────────────────────────
    def read_signal(self, coin_id: str) -> Optional[dict]:
        try:
            if not SIGNALS_FILE.exists():
                logger.warning(f'[trend] signals.json not found at {SIGNALS_FILE}')
                return None

            with open(SIGNALS_FILE, 'r') as f:
                signals = json.load(f)

            if coin_id not in signals:
                logger.debug(f'[trend] No signal found for {coin_id}')
                return None

            signal = signals[coin_id]
            updated_at = signal.get('updatedAt')
            if not updated_at:
                logger.warning(f'[trend] Signal for {coin_id} has no timestamp')
                return None

            signal_time = datetime.fromisoformat(updated_at.replace('Z', '+00:00'))
            now = datetime.now(timezone.utc)
            age_minutes = (now - signal_time).total_seconds() / 60

            if age_minutes > self.MAX_SIGNAL_AGE_MINUTES:
                logger.warning(
                    f'[trend] Signal for {coin_id} is stale '
                    f'({age_minutes:.1f} min old, max {self.MAX_SIGNAL_AGE_MINUTES})')
                return None

            return signal

        except json.JSONDecodeError as e:
            logger.error(f'[trend] signals.json malformed: {e}')
            return None
        except Exception as e:
            logger.error(f'[trend] Error reading signal for {coin_id}: {e}')
            return None

    def pair_to_coin_id(self, pair: str) -> Optional[str]:
        return PAIR_TO_COIN.get(pair)

    def signal_allows_trend_entry(self, signal: dict) -> bool:
        """
        Returns True if signal is not sell/strong_sell AND is fresh (not None).
        Does NOT require allCriteriaMet: true or signal == strong_buy.
        hold, buy, strong_buy all qualify.
        """
        sig_value = signal.get('signal')
        return sig_value not in ('sell', 'strong_sell') and sig_value is not None

    def signal_is_strong_sell(self, signal: dict) -> bool:
        return signal.get('signal') == 'strong_sell'

    # ── entry logic ───────────────────────────────────────────────────────────
    def populate_entry_trend(self, dataframe: DataFrame,
                             metadata: dict) -> DataFrame:
        pair = metadata['pair']
        coin_id = self.pair_to_coin_id(pair)

        dataframe['enter_long'] = 0
        dataframe['enter_tag']  = ''

        if not coin_id:
            logger.warning(f'[trend] No coin mapping for {pair}')
            return dataframe

        signal = self.read_signal(coin_id)
        if signal is None:
            return dataframe

        if not self.signal_allows_trend_entry(signal):
            logger.debug(
                f'[trend] {pair} signal is {signal.get("signal")} — entry blocked')
            return dataframe

        last = dataframe.iloc[-1]
        rsi  = last['rsi']
        hist = last['macd_hist']
        vol  = last['volume_ratio']

        entry_conditions = (
            (dataframe['close'] > dataframe['ema200']) &
            (dataframe['close'] > dataframe['ema50']) &
            (dataframe['rsi'] >= 45) &
            (dataframe['rsi'] <= 70) &
            (dataframe['macd'] > 0) &
            (dataframe['macd_hist'] > 0) &
            (dataframe['volume_ratio'] >= 1.2) &
            (dataframe['volume'] > 0)
        )

        dataframe.loc[entry_conditions, 'enter_long'] = 1
        dataframe.loc[entry_conditions, 'enter_tag']  = 'cryptodash_trend_entry'

        if entry_conditions.any():
            logger.info(
                f'[trend] ENTRY: {pair} | Signal: {signal.get("signal")} | '
                f'RSI: {rsi:.1f} | MACD hist: {hist:.4f} | Vol: {vol:.2f}x')
        else:
            logger.info(
                f'[trend] {pair} — no entry | '
                f'Signal: {signal.get("signal")} | RSI: {rsi:.1f} | '
                f'MACD hist: {hist:.4f} | Vol: {vol:.2f}x')

        return dataframe

    # ── exit logic ────────────────────────────────────────────────────────────
    def populate_exit_trend(self, dataframe: DataFrame,
                            metadata: dict) -> DataFrame:
        dataframe['exit_long'] = 0
        return dataframe

    def custom_exit(self, pair: str, trade, current_time: datetime,
                    current_rate: float, current_profit: float,
                    **kwargs) -> Optional[str]:
        # Time stop at 48h
        trade_duration_hours = (
            current_time - trade.open_date_utc
        ).total_seconds() / 3600

        if trade_duration_hours >= self.TIME_STOP_HOURS:
            logger.info(
                f'[trend] TIME STOP: {pair} | '
                f'Duration: {trade_duration_hours:.1f}h | '
                f'P&L: {current_profit:.2%}')
            return f'trend_time_stop_{self.TIME_STOP_HOURS}h'

        # Signal reversal — only on strong_sell
        coin_id = self.pair_to_coin_id(pair)
        if coin_id:
            signal = self.read_signal(coin_id)
            if signal and self.signal_is_strong_sell(signal):
                logger.info(
                    f'[trend] SIGNAL REVERSAL EXIT: {pair} | '
                    f'Signal: {signal.get("signal")} | '
                    f'P&L: {current_profit:.2%}')
                return 'trend_signal_reversal'

        return None

    # ── plot config ───────────────────────────────────────────────────────────
    @property
    def plot_config(self):
        return {
            'main_plot': {
                'ema200': {'color': '#DC2626', 'width': 2, 'type': 'line'},
                'ema50':  {'color': '#D97706', 'width': 1, 'type': 'line'},
            },
            'subplots': {
                'RSI': {
                    'rsi': {'color': '#2563EB', 'width': 1},
                },
                'MACD': {
                    'macd':        {'color': '#16A34A', 'width': 1},
                    'macd_signal': {'color': '#DC2626', 'width': 1},
                    'macd_hist':   {'color': '#6B7280', 'type': 'bar'},
                },
                'StochRSI': {
                    'fastk': {'color': '#7C3AED', 'width': 1},
                    'fastd': {'color': '#DB2777', 'width': 1},
                },
            },
        }
