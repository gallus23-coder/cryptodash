import json
import logging
import sqlite3
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
    Exit:  adaptive ROI (custom_roi), 5% stop loss, 16h time stop, strong_sell reversal.
           Minimum hold: 240 minutes before any exit fires.

    Does NOT require allCriteriaMet: true or signal == strong_buy.
    Any non-sell signal (hold, buy, strong_buy) qualifies as trend-allowed entry.
    """

    INTERFACE_VERSION = 3

    timeframe = '1h'
    stoploss = -0.05

    # Fallback only — active if custom_roi returns None (before 4h minimum hold).
    minimal_roi = {
        "240": 0.03,
        "480": 0.02,
        "720": 0.015,
        "960": 0.008,
    }

    use_custom_roi = True
    use_custom_stoploss = True
    trailing_stop = False  # must stay False — custom_stoploss replaces it, don't run both
    process_only_new_candles = True
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    MAX_SIGNAL_AGE_MINUTES = 20
    TIME_STOP_HOURS = 16

    # Signal reversal confirmation — row-count based, cadence-independent.
    # Requires the last MIN_CONFIRMATION_READS rows for this coin ALL == 'strong_sell'.
    # No time window — works regardless of signal generation cadence (~10-15min or cached).
    MIN_CONFIRMATION_READS = 2
    SIGNAL_HISTORY_DB = '/home/gallus23/crypto-dashboard/data/crypto.db'

    # ── trailing stop activation (custom_stoploss) ──────────────────────────
    # Below this profit, custom_stoploss just returns the fixed -5% stop —
    # behaviour is unchanged from before this feature was added.
    TRAIL_ACTIVATION_PROFIT = 0.05   # 5%

    # Trail distance tiers — tighter as profit grows, so gains lock in
    # progressively rather than giving back a flat % regardless of peak size.
    TRAIL_TIERS_BULL = {
        0.05: 0.04,   # 5%+ profit  -> trail 4% behind peak
        0.10: 0.03,   # 10%+ profit -> trail 3% behind peak
        0.15: 0.02,   # 15%+ profit -> trail 2% behind peak (tightened from 20%)
    }
    TRAIL_TIERS_BEAR = {
        0.05: 0.03,   # 5%+ profit  -> trail 3% behind peak
        0.08: 0.025,  # 8%+ profit  -> trail 2.5% (tightened from 10%)
        0.12: 0.02,   # 12%+ profit -> trail 2% (tightened from 20%)
    }

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

    def confirmed_strong_sell(self, coin_id: str) -> bool:
        """
        Returns True only if the last MIN_CONFIRMATION_READS rows in signal_history
        for this coin ALL have signal == 'strong_sell'.

        Row-count based, cadence-independent — no time window.
        Works regardless of signal generation timing (~10-15min or API-cached ~1h).
        If fewer than MIN_CONFIRMATION_READS rows exist, returns False (fail-safe).

        Fail-safe: any DB error returns False — a hiccup never triggers an exit,
        only prevents one. Caller must not exit on False.
        """
        conn = None
        try:
            conn = sqlite3.connect(
                f'file:{self.SIGNAL_HISTORY_DB}?mode=ro', uri=True)
            rows = conn.execute(
                'SELECT signal FROM signal_history '
                'WHERE coin_id = ? '
                'ORDER BY timestamp DESC LIMIT ?',
                (coin_id, self.MIN_CONFIRMATION_READS)
            ).fetchall()

            count = len(rows)
            all_strong_sell = count > 0 and all(r[0] == 'strong_sell' for r in rows)
            confirmed = count >= self.MIN_CONFIRMATION_READS and all_strong_sell

            logger.debug(
                f'[trend] confirmed_strong_sell {coin_id} | '
                f'last {self.MIN_CONFIRMATION_READS} rows fetched: {count} | '
                f'all strong_sell: {all_strong_sell} | '
                f'confirmed: {confirmed}')

            return confirmed

        except Exception as e:
            logger.warning(
                f'[trend] confirmed_strong_sell DB error for {coin_id}: {e} '
                f'— defaulting to False (no exit)')
            return False
        finally:
            if conn:
                conn.close()

    def get_market_phase(self) -> str:
        """
        Detect current market phase by reading BTC's signal from signals.json —
        the same file already used by read_signal().

        Returns 'bull' if BTC is above its 200 EMA, 'bear' otherwise.
        Defaults to 'bear' if the file cannot be read or BTC signal is missing,
        to ensure conservative behaviour on any error.
        """
        try:
            if not SIGNALS_FILE.exists():
                return 'bear'
            with open(SIGNALS_FILE, 'r') as f:
                signals = json.load(f)
            btc = signals.get('bitcoin', {})
            # Use the summary field — phase-aware signal prompt in cryptodash
            # includes 'above ema200' or 'bull' in bull conditions
            summary = btc.get('summary', '').lower()
            if 'above ema200' in summary or 'bull' in summary:
                return 'bull'
            return 'bear'
        except Exception as e:
            logger.warning(
                f'[trend] Could not determine market phase, '
                f'defaulting to bear: {e}')
            return 'bear'

    # ── custom ROI ────────────────────────────────────────────────────────────
    def custom_roi(self, pair: str, trade, current_time: datetime,
                   trade_duration: int, entry_tag: Optional[str],
                   side: str, **kwargs) -> Optional[float]:
        """
        Adaptive ROI based on current market phase.

        Bull market (BTC above 200 EMA):
          Trends run further — higher targets, more time to develop before
          stepping down.

        Bear market (BTC below 200 EMA):
          Choppier conditions — take profit faster, floor at fee breakeven
          (0.8% gross ≈ 0% net after round-trip fees).

        Minimum hold time (240 min) enforced here and in custom_exit —
        belt and braces.

        Bear targets: based on actual observed peak gains from 13 live
          dry-run trades (Jun-Jul 2026): max 3.98%, median ~0.85%.
        Bull targets: based on Jun-Nov 2024 hyperopt data showing
          significantly higher peak moves in confirmed uptrend conditions.
        """
        # Enforce minimum hold — return None before 4h so no ROI exit fires
        if trade_duration < 240:
            return None

        phase = self.get_market_phase()

        if phase == 'bull':
            roi_table = {
                240:  0.08,   # 8% after 4h
                480:  0.05,   # 5% after 8h
                720:  0.03,   # 3% after 12h
                960:  0.015,  # 1.5% after 16h
                1440: 0.008,  # fee breakeven after 24h
            }
        else:  # bear
            roi_table = {
                240:  0.03,   # 3% after 4h
                480:  0.02,   # 2% after 8h
                720:  0.015,  # 1.5% after 12h
                900:  0.008,  # fee breakeven after 15h (time stop fires at 16h/960min)
            }

        # Find the highest applicable time key
        applicable = {k: v for k, v in roi_table.items() if k <= trade_duration}
        if not applicable:
            return None

        threshold = roi_table[max(applicable.keys())]

        logger.debug(
            f'[trend] custom_roi {pair} | '
            f'Phase: {phase} | '
            f'Duration: {trade_duration}min | '
            f'ROI threshold: {threshold:.3f} ({threshold*100:.1f}%)')

        return threshold

    # ── custom trailing stop ──────────────────────────────────────────────────
    def custom_stoploss(self, pair: str, trade, current_time: datetime,
                        current_rate: float, current_profit: float,
                        **kwargs) -> float:
        """
        Staged trailing stop for large trend moves (e.g. ADA +30% while a
        fixed ROI capped the exit at +2.72%).

        Below TRAIL_ACTIVATION_PROFIT: returns the normal fixed -5% stop —
        identical to prior behaviour, nothing changes for typical trades.

        Above it: trails behind trade.max_rate (Freqtrade's tracked peak
        price for this trade) with a distance that tightens as profit
        grows, locking in more of the move the further it runs.

        Not gated by MIN_HOLD_MINUTES — Freqtrade calls this every candle
        independently of custom_exit, so a sharp reversal after a big run
        is always protected, even inside the 240min hold window.
        """
        if current_profit < self.TRAIL_ACTIVATION_PROFIT:
            return self.stoploss  # unchanged fixed -5% stop

        phase = self.get_market_phase()
        tiers = self.TRAIL_TIERS_BULL if phase == 'bull' else self.TRAIL_TIERS_BEAR

        # Pick the tightest applicable tier for current profit level
        applicable = {k: v for k, v in tiers.items() if current_profit >= k}
        trail_pct = tiers[min(tiers.keys())] if not applicable else applicable[max(applicable.keys())]

        peak_price = trade.max_rate
        trail_stop_price = peak_price * (1 - trail_pct)

        # custom_stoploss must return a ratio relative to current_rate, negative = below
        stoploss_ratio = (trail_stop_price / current_rate) - 1

        logger.debug(
            f'[trend] custom_stoploss {pair} | '
            f'Phase: {phase} | Profit: {current_profit:.2%} | '
            f'Trail: {trail_pct:.1%} behind peak {peak_price:.6f} | '
            f'Stop ratio: {stoploss_ratio:.4f}')

        # Never return a stop looser than the fixed stoploss as a safety floor
        return max(stoploss_ratio, self.stoploss)

    # ── entry logic ───────────────────────────────────────────────────────────
    def populate_entry_trend(self, dataframe: DataFrame,
                             metadata: dict) -> DataFrame:
        # Zero out unconditionally first — never mark historical rows as entries
        dataframe['enter_long'] = 0
        dataframe['enter_tag']  = ''

        pair = metadata['pair']
        coin_id = self.pair_to_coin_id(pair)

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

        # Only signal entry on the CURRENT (last) candle — never historical rows
        if entry_conditions.iloc[-1]:
            dataframe.loc[dataframe.index[-1], 'enter_long'] = 1
            dataframe.loc[dataframe.index[-1], 'enter_tag']  = 'cryptodash_trend_entry'

        is_entry_now = dataframe['enter_long'].iloc[-1] == 1
        if is_entry_now:
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
        # Minimum hold time — don't let signal reversal exit
        # a trade that's barely open
        MIN_HOLD_MINUTES = 240
        trade_duration_minutes = (
            current_time - trade.open_date_utc
        ).total_seconds() / 60
        if trade_duration_minutes < MIN_HOLD_MINUTES:
            return None
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

        # Signal reversal — confirmed strong_sell only (≥2 reads in 10min window)
        coin_id = self.pair_to_coin_id(pair)
        if coin_id and self.confirmed_strong_sell(coin_id):
            logger.info(
                f'[trend] SIGNAL REVERSAL EXIT (confirmed): {pair} | '
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
