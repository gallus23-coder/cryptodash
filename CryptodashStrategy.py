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
    Mean Reversion in Uptrend — Adaptive Market Phase strategy.
    Entries driven by cryptodash Claude AI signals.
    Parameters adapt automatically based on BTC 200 EMA position.

    BEAR MARKET (BTC below 200 EMA) — Jun 2026 hyperopt:
      Data: Jun 2025 - Jun 2026 (357 days bear market)
      Stop loss: 5%   Take profit: 15%   Time stop: 89h
      RSI: 34-49      StochRSI: <17      Volume: >1.7x   EMA50 dist: <6.2%

    BULL MARKET (BTC above 200 EMA) — Jun 2024 hyperopt:
      Data: Jun 2024 - Nov 2024 (144 days bull market)
      Stop loss: 7%   Take profit: 20%   Time stop: 67h
      RSI: 32-53      StochRSI: <39      Volume: >1.8x   EMA50 dist: <1.2%

    Class-level stoploss -0.07: compromise between bear -0.05 and bull -0.084.
    Freqtrade requires a single static value; actual phase stop tracked via
    tradingConfig.json. Entry tag encodes phase: cryptodash_{bull|bear}_strong_buy.
    Exit uses phase from entry tag so parameters always match entry conditions.

    Hyperopt run: June 2026
    Max trades: 2 (set in config.json)
    Timeframe:  1h
    """

    INTERFACE_VERSION = 3

    # ── strategy parameters ───────────────────────────────────────────────────
    timeframe = '1h'
    stoploss = -0.07          # compromise between bear -0.05 and bull -0.084
    minimal_roi = {"0": 0.20} # bull take profit as default; bear overridden via custom_stoploss

    trailing_stop = False
    process_only_new_candles = True
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    # How stale a signal can be before we ignore it (minutes)
    MAX_SIGNAL_AGE_MINUTES = 20

    # Default time stop — overridden per phase in custom_exit
    TIME_STOP_HOURS = 89

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

        # StochRSI — used in phase-adaptive entry criteria
        dataframe['fastk'], dataframe['fastd'] = ta.STOCHRSI(
            dataframe['close'],
            timeperiod=14, fastk_period=3, fastd_period=3)

        # Volume ratio vs 20-period average
        dataframe['volume_mean'] = dataframe['volume'].rolling(20).mean()
        dataframe['volume_ratio'] = (
            dataframe['volume'] / dataframe['volume_mean'])

        # EMA50 distance as percentage
        dataframe['ema50_dist_pct'] = (
            abs(dataframe['close'] - dataframe['ema50'])
            / dataframe['ema50'] * 100)

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

    def get_market_phase(self, dataframe: DataFrame) -> str:
        """
        Detect bull or bear market phase based on
        BTC 200 EMA position using last candle.
        Returns 'bull' or 'bear'
        """
        last = dataframe.iloc[-1]
        if last['close'] > last['ema200']:
            return 'bull'
        return 'bear'

    def get_phase_params(self, phase: str) -> dict:
        """
        Return optimised entry and exit parameters
        for current market phase.

        Bear params: from Jun 2026 hyperopt (357 days bear market)
        Bull params: from Jun 2024 hyperopt (144 days bull market)
        """
        if phase == 'bull':
            return {
                'rsi_min':     32,
                'rsi_max':     53,
                'stochrsi':    39,
                'volume':      1.8,
                'ema50_dist':  1.2,
                'stop_loss':   -0.07,
                'take_profit': 0.20,
                'time_stop':   67,
            }
        else:  # bear
            return {
                'rsi_min':     34,
                'rsi_max':     49,
                'stochrsi':    17,
                'volume':      1.7,
                'ema50_dist':  6.2,
                'stop_loss':   -0.05,
                'take_profit': 0.15,
                'time_stop':   89,
            }

    # ── entry logic ───────────────────────────────────────────────────────────
    def populate_entry_trend(self, dataframe: DataFrame,
                             metadata: dict) -> DataFrame:
        """
        Entry logic — STRONG BUY signal from cryptodash
        with phase-adaptive belt-and-braces confirmation.

        Parameters adapt automatically based on whether BTC
        is above or below its 200 EMA (bull vs bear market).
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

        # Detect market phase and get appropriate parameters
        phase = self.get_market_phase(dataframe)
        params = self.get_phase_params(phase)

        # Belt-and-braces confirmation using phase parameters
        entry_conditions = (
            (dataframe['close'] > dataframe['ema200']) &
            (dataframe['rsi'] >= params['rsi_min']) &
            (dataframe['rsi'] <= params['rsi_max']) &
            (dataframe['fastk'] < params['stochrsi']) &
            (dataframe['volume_ratio'] >= params['volume']) &
            (dataframe['ema50_dist_pct'] <= params['ema50_dist']) &
            (dataframe['macd'] > 0) &
            (dataframe['macd_hist'] > 0) &
            (dataframe['volume'] > 0)
        )

        dataframe.loc[entry_conditions, 'enter_long'] = 1
        dataframe.loc[entry_conditions, 'enter_tag'] = \
            f'cryptodash_{phase}_strong_buy'

        if entry_conditions.any():
            logger.info(
                f'[cryptodash] ENTRY SIGNAL: {pair} | '
                f'Phase: {phase} | '
                f'RSI: {params["rsi_min"]}-{params["rsi_max"]} | '
                f'StochRSI: <{params["stochrsi"]} | '
                f'Signal: {signal.get("signal")} | '
                f'Summary: {signal.get("summary", "")[:80]}')
        else:
            logger.info(
                f'[cryptodash] {pair} STRONG BUY signal but '
                f'dataframe confirmation failed | '
                f'Phase: {phase} | '
                f'Params: RSI {params["rsi_min"]}-{params["rsi_max"]} '
                f'StochRSI <{params["stochrsi"]} '
                f'Volume >{params["volume"]}x '
                f'EMA50 dist <{params["ema50_dist"]}%')

        return dataframe

    # ── exit logic ────────────────────────────────────────────────────────────
    def populate_exit_trend(self, dataframe: DataFrame,
                            metadata: dict) -> DataFrame:
        """
        Exit via minimal_roi and stoploss.
        Signal reversal and time stop handled in custom_exit.
        """
        dataframe['exit_long'] = 0
        return dataframe

    def custom_exit(self, pair: str, trade, current_time: datetime,
                    current_rate: float, current_profit: float,
                    **kwargs) -> Optional[str]:
        """
        Custom exit conditions:
        1. Time stop — phase-appropriate duration
        2. Signal reversal — close if cryptodash flips to sell

        Phase is determined from the entry tag set at open
        so exit parameters always match entry conditions.
        """
        # Determine phase from entry tag
        phase = 'bull' if 'bull' in (trade.enter_tag or '') else 'bear'
        params = self.get_phase_params(phase)

        # Time stop — use phase-appropriate duration
        trade_duration_hours = (
            current_time - trade.open_date_utc
        ).total_seconds() / 3600

        if trade_duration_hours >= params['time_stop']:
            logger.info(
                f'[cryptodash] TIME STOP: {pair} | '
                f'Phase: {phase} | '
                f'Duration: {trade_duration_hours:.1f}h | '
                f'Time stop: {params["time_stop"]}h | '
                f'P&L: {current_profit:.2%}')
            return f'time_stop_{params["time_stop"]}h'

        # Signal reversal exit
        coin_id = self.pair_to_coin_id(pair)
        if coin_id:
            signal = self.read_signal(coin_id)
            if signal and self.signal_is_sell(signal):
                logger.info(
                    f'[cryptodash] SIGNAL REVERSAL EXIT: {pair} | '
                    f'Phase: {phase} | '
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
                'StochRSI': {
                    'fastk': {
                        'color': '#7C3AED',
                        'width': 1,
                    },
                    'fastd': {
                        'color': '#DB2777',
                        'width': 1,
                    },
                },
            },
        }
