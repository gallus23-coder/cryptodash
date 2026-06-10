import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd
from pandas import DataFrame
from freqtrade.strategy import IStrategy, informative
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
    'AVAX/GBP': 'avalanche-2',
}


class CryptodashStrategy(IStrategy):
    """
    Mean Reversion in Uptrend strategy.
    Entries driven by cryptodash Claude AI signals.
    
    Parameters (must match cryptodash tradingConfig.json):
      Stop loss:    5%
      Take profit:  15%
      Time stop:    89 hours
      Max trades:   2 (set in config.json)
      Timeframe:    1h
    """

    INTERFACE_VERSION = 3

    # ── strategy parameters ───────────────────────────────────────────────────
    timeframe = '1h'
    stoploss = -0.05          # 5% stop loss
    minimal_roi = {"0": 0.15} # 15% take profit

    trailing_stop = False
    process_only_new_candles = True
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    # How stale a signal can be before we ignore it (minutes)
    MAX_SIGNAL_AGE_MINUTES = 20

    # Time stop — close after this many hours regardless
    TIME_STOP_HOURS = 89 # was 72

    # ── indicator population ──────────────────────────────────────────────────
    def populate_indicators(self, dataframe: DataFrame,
                            metadata: dict) -> DataFrame:
        """
        Calculate indicators used for belt-and-braces 
        entry confirmation alongside cryptodash signals.
        """
        # EMA 200 — primary trend filter
        dataframe['ema200'] = ta.EMA(dataframe['close'], timeperiod=200)

        # EMA 50 — mean reversion reference
        dataframe['ema50'] = ta.EMA(dataframe['close'], timeperiod=50)

        # RSI 14 — momentum confirmation
        dataframe['rsi'] = ta.RSI(dataframe['close'], timeperiod=14)

        # MACD — momentum direction
        macd, macd_signal, macd_hist = ta.MACD(
            dataframe['close'],
            fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe['macd']        = macd
        dataframe['macd_signal'] = macd_signal
        dataframe['macd_hist']   = macd_hist

        return dataframe

    # ── helpers ───────────────────────────────────────────────────────────────
    def read_signal(self, coin_id: str) -> Optional[dict]:
        """
        Read and validate cryptodash signal for a coin.
        Returns signal dict or None if missing/stale/invalid.
        """
        try:
            if not SIGNALS_FILE.exists():
                logger.warning(
                    f'[cryptodash] signals.json not found at {SIGNALS_FILE}')
                return None

            with open(SIGNALS_FILE, 'r') as f:
                signals = json.load(f)

            if coin_id not in signals:
                logger.debug(
                    f'[cryptodash] No signal found for {coin_id}')
                return None

            signal = signals[coin_id]

            # Check signal freshness
            updated_at = signal.get('updatedAt')
            if not updated_at:
                logger.warning(
                    f'[cryptodash] Signal for {coin_id} has no timestamp')
                return None

            signal_time = datetime.fromisoformat(
                updated_at.replace('Z', '+00:00'))
            now = datetime.now(timezone.utc)
            age_minutes = (now - signal_time).total_seconds() / 60

            if age_minutes > self.MAX_SIGNAL_AGE_MINUTES:
                logger.warning(
                    f'[cryptodash] Signal for {coin_id} is stale '
                    f'({age_minutes:.1f} min old, max {self.MAX_SIGNAL_AGE_MINUTES})')
                return None

            logger.info(
                f'[cryptodash] Signal for {coin_id}: '
                f'{signal.get("signal")} ({age_minutes:.1f} min old)')
            return signal

        except json.JSONDecodeError as e:
            logger.error(f'[cryptodash] signals.json malformed: {e}')
            return None
        except Exception as e:
            logger.error(f'[cryptodash] Error reading signal for {coin_id}: {e}')
            return None

    def pair_to_coin_id(self, pair: str) -> Optional[str]:
        """Map Freqtrade pair format to cryptodash coin ID."""
        return PAIR_TO_COIN.get(pair)

    def signal_is_strong_buy(self, signal: dict) -> bool:
        """Check if signal is a valid strong buy."""
        return (
            signal.get('signal') == 'strong_buy' and
            signal.get('entryQuality', {}).get('allCriteriaMet', False)
        )

    def signal_is_sell(self, signal: dict) -> bool:
        """Check if signal is a sell/strong sell."""
        return signal.get('signal') in ['sell', 'strong_sell']

    # ── entry logic ───────────────────────────────────────────────────────────
    def populate_entry_trend(self, dataframe: DataFrame,
                             metadata: dict) -> DataFrame:
        """
        Entry logic — STRONG BUY signal from cryptodash
        with belt-and-braces indicator confirmation.
        """
        pair = metadata['pair']
        coin_id = self.pair_to_coin_id(pair)

        dataframe['enter_long'] = 0
        dataframe['enter_tag']  = ''

        if not coin_id:
            logger.warning(f'[cryptodash] No coin mapping for {pair}')
            return dataframe

        signal = self.read_signal(coin_id)

        if signal is None:
            return dataframe

        if not self.signal_is_strong_buy(signal):
            logger.debug(
                f'[cryptodash] {coin_id} signal is '
                f'{signal.get("signal")} — no entry')
            return dataframe

        # Belt-and-braces confirmation on the dataframe
        # These mirror the strategy entry criteria
        entry_conditions = (
            (dataframe['close'] > dataframe['ema200']) &  # uptrend confirmed
            (dataframe['rsi'] > 34) &
            (dataframe['rsi'] < 49) &                     # was 45 not overbought
            (dataframe['macd'] > 0) &                     # net bullish momentum
            (dataframe['macd_hist'] > 0) &
            (dataframe['volume'] > 0)                     # valid candle
        )

        dataframe.loc[entry_conditions, 'enter_long'] = 1
        dataframe.loc[entry_conditions, 'enter_tag'] = (
            f'cryptodash_strong_buy_'
            f'rsi{signal.get("entryQuality", {}).get("rsi", "")}'
        )

        if entry_conditions.any():
            logger.info(
                f'[cryptodash] ENTRY SIGNAL: {pair} | '
                f'Signal: {signal.get("signal")} | '
                f'Summary: {signal.get("summary", "")[:80]}')
        else:
            logger.info(
                f'[cryptodash] {pair} cryptodash signal is STRONG BUY '
                f'but dataframe confirmation failed '
                f'(EMA200/RSI/MACD check) — no entry')

        return dataframe

    # ── exit logic ────────────────────────────────────────────────────────────
    def populate_exit_trend(self, dataframe: DataFrame,
                            metadata: dict) -> DataFrame:
        """
        Exit via minimal_roi (10%) and stoploss (5%).
        Signal reversal and time stop handled in custom_exit.
        """
        dataframe['exit_long'] = 0
        return dataframe

    def custom_exit(self, pair: str, trade, current_time: datetime,
                    current_rate: float, current_profit: float,
                    **kwargs) -> Optional[str]:
        """
        Custom exit conditions:
        1. Time stop — close after 72h regardless of P&L
        2. Signal reversal — close if cryptodash flips to sell
        """
        # ── time stop ─────────────────────────────────────────────────────────
        trade_duration_hours = (
            current_time - trade.open_date_utc
        ).total_seconds() / 3600

        if trade_duration_hours >= self.TIME_STOP_HOURS:
            logger.info(
                f'[cryptodash] TIME STOP: {pair} | '
                f'Duration: {trade_duration_hours:.1f}h | '
                f'P&L: {current_profit:.2%}')
            return 'time_stop_72h'

        # ── signal reversal ───────────────────────────────────────────────────
        coin_id = self.pair_to_coin_id(pair)
        if coin_id:
            signal = self.read_signal(coin_id)
            if signal and self.signal_is_sell(signal):
                logger.info(
                    f'[cryptodash] SIGNAL REVERSAL EXIT: {pair} | '
                    f'New signal: {signal.get("signal")} | '
                    f'P&L: {current_profit:.2%}')
                return 'signal_reversal'

        return None

    # ── plot config ───────────────────────────────────────────────────────────
    @property
    def plot_config(self):
        return {
            'main_plot': {
                'ema200': {
                    'color': '#DC2626',
                    'width': 2,
                    'type': 'line'
                },
                'ema50': {
                    'color': '#D97706',
                    'width': 1,
                    'type': 'line'
                },
            },
            'subplots': {
                'RSI': {
                    'rsi': {
                        'color': '#2563EB',
                        'width': 1,
                    },
                },
                'MACD': {
                    'macd': {
                        'color': '#16A34A',
                        'width': 1,
                    },
                    'macd_signal': {
                        'color': '#DC2626',
                        'width': 1,
                    },
                    'macd_hist': {
                        'color': '#6B7280',
                        'type': 'bar',
                    },
                },
            },
        }
