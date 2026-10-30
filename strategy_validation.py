"""Read-only exploratory strategy evaluation on public Coinbase Exchange candles.

This module has no order placement, no private endpoints, no secrets and no persistence.
Past performance is not evidence of future profitability. Not intended for live execution.
"""
from __future__ import annotations

import json
import math
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = 'https://api.exchange.coinbase.com/products/'
SYMBOLS = ('BTC-USD', 'ETH-USD')
PERIODS = {'1h': (3600, 840), '6h': (21600, 480)}
CACHE_SECONDS = 900
_CACHE = {'until': 0.0, 'value': None}
_LOCK = threading.Lock()


def _utc(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def fetch_candles(symbol, timeframe, now=None):
    """Fetch completed and contiguous candles in <=240-bar slices, no gap filling."""
    if symbol not in SYMBOLS or timeframe not in PERIODS:
        raise ValueError('UNSUPPORTED_MARKET')
    interval, count = PERIODS[timeframe]
    now = int(time.time() if now is None else now)
    end = now // interval * interval
    start = end - count * interval
    values = {}
    for first in range(start, end, interval * 240):
        limit = min(first + interval * 240, end)
        url = BASE + symbol + '/candles?' + urlencode({
            'granularity': interval, 'start': _utc(first), 'end': _utc(limit)})
        request = Request(url, method='GET', headers={
            'User-Agent': 'CryptoTraderAI-Research/2.0 (read-only)',
            'Accept': 'application/json',
        })
        with urlopen(request, timeout=9) as response:
            if response.status != 200:
                raise ValueError('INVALID_HTTP_RESPONSE')
            rows = json.loads(response.read(120000))
        if not isinstance(rows, list) or len(rows) > 301:
            raise ValueError('INVALID_MARKET_DATA')
        for item in rows:
            if not isinstance(item, list) or len(item) < 6:
                raise ValueError('INVALID_MARKET_DATA')
            ts = int(item[0])
            if not first <= ts < limit:
                continue
            if ts % interval:
                raise ValueError('INVALID_TIMESTAMP')
            low, high, opening, closing, volume = map(float, item[1:6])
            if not all(map(math.isfinite, (low, high, opening, closing, volume))):
                raise ValueError('INVALID_MARKET_DATA')
            if not (0 < low <= min(opening, closing) <= max(opening, closing) <= high and volume >= 0):
                raise ValueError('INVALID_MARKET_DATA')
            candle = (ts, low, high, opening, closing, volume)
            if ts in values and values[ts] != candle:
                raise ValueError('CONFLICTING_CANDLES')
            values[ts] = candle
    expected = list(range(start, end, interval))
    if sorted(values) != expected:
        raise ValueError('MISSING_OR_GAPPED_CANDLES')
    return [values[t] for t in expected]


def _sma(closes, i, length):
    if i < length:
        return None
    return sum(closes[i - length:i]) / length


def signal(candles, i, strategy):
    """A decision for candle i uses exclusively information prior to open[i]."""
    closes = [x[4] for x in candles]
    if strategy == 'trend_15_40':
        fast = _sma(closes, i, 15)
        slow = _sma(closes, i, 40)
        return 1 if fast is not None and slow is not None and fast > slow else 0
    if strategy == 'trend_20_60':
        fast = _sma(closes, i, 20)
        slow = _sma(closes, i, 60)
        return 1 if fast is not None and slow is not None and fast > slow else 0
    if strategy == 'mean_reversion_20':
        avg = _sma(closes, i, 20)
        if avg is None:
            return 0
        return 1 if closes[i - 1] < avg * 0.985 else 0
    raise ValueError('UNKNOWN_STRATEGY')


def simulate(candles, strategy, trade_start, trade_end, initial=5000.0):
    """Long-only asset bucket; entry at open from earlier closed candle signals."""
    if not 0 <= trade_start < trade_end <= len(candles) or trade_start < 65:
        raise ValueError('INVALID_WINDOW')
    if initial <= 0 or not math.isfinite(initial):
        raise ValueError('INVALID_CAPITAL')
    if strategy not in ('trend_15_40', 'trend_20_60', 'mean_reversion_20'):
        raise ValueError('UNKNOWN_STRATEGY')
    cash = initial
    qty = 0.0
    entry_cost = 0.0
    entry_price = 0.0
    peak = initial
    worst_dd = 0.0
    completed = 0
    wins = 0
    fee = 0.001
    slip = 0.0005
    curve = []
    for i in range(trade_start, trade_end):
        ts, lo, hi, op, cl, _vol = candles[i]
        state = signal(candles, i, strategy)
        closed = False
        def sell(px):
            nonlocal qty, entry_cost, entry_price, completed, wins, cash, closed
            received = qty * px * (1 - slip) * (1 - fee)
            cash += received
            wins += int(received > entry_cost)
            completed += 1
            qty = entry_cost = entry_price = 0.0
            closed = True
        if qty and (strategy.startswith('trend_') and not state or
                    strategy == 'mean_reversion_20' and not state):
            sell(op)
        if not qty and not closed and state:
            size = cash * 0.30
            entry_price = op * (1 + slip)
            qty = size / (entry_price * (1 + fee))
            entry_cost = size
            cash -= size
        if qty:
            stop = entry_price * (0.97 if strategy.startswith('trend_') else 0.98)
            target = entry_price * (1.06 if strategy.startswith('trend_') else 1.03)
            if lo <= stop:
                sell(min(stop, op))
            elif hi >= target:
                sell(target)
        equity = cash + qty * cl * (1 - slip) * (1 - fee)
        peak = max(peak, equity)
        worst_dd = max(worst_dd, (peak - equity) / peak)
        curve.append(equity)
    if qty:
        final_price = candles[trade_end - 1][4]
        sell(final_price)
        curve[-1] = cash
        worst_dd = max(worst_dd, (peak - cash) / peak)
    return {
        'strategy': strategy,
        'initialUSD': round(initial, 2),
        'endingUSD': round(cash, 2),
        'returnPct': round((cash / initial - 1) * 100, 2),
        'maxDrawdownPct': round(worst_dd * 100, 2),
        'trades': completed,
        'winningTrades': wins,
        'barsTraded': trade_end - trade_start,
    }


def benchmark(candles, trade_start, trade_end):
    op = candles[trade_start][3]
    close = candles[trade_end - 1][4]
    ret = (close / op * (1 - 0.0005) / (1 + 0.0005) *
           (1 - 0.001) / (1 + 0.001) - 1) * 100
    return round(ret, 2)


def evaluate(candles, symbol, tf):
    n = len(candles)
    if n < 300:
        raise ValueError('INSUFFICIENT_HISTORY')
    cut = int(n * 0.70)
    strategies = ('trend_15_40', 'trend_20_60', 'mean_reversion_20')
    training = [simulate(candles, name, 65, cut) for name in strategies]
    chosen = max(training, key=lambda x: (x['returnPct'] if x['trades'] >= 2 else -1e6,
                                          -x['maxDrawdownPct']))
    validation = simulate(candles, chosen['strategy'], cut, n)
    return {
        'symbol': symbol, 'timeframe': tf, 'candles': n,
        'trainingBars': cut - 65, 'holdoutBars': n - cut,
        'trainingFromUTC': _utc(candles[65][0]),
        'holdoutFromUTC': _utc(candles[cut][0]),
        'throughUTC': _utc(candles[-1][0]),
        'candidatesTrainingOnly': training,
        'selectedStrategy': chosen['strategy'],
        'selectionQualified': chosen['trades'] >= 2,
        'holdout': validation,
        'holdoutBuyHoldReturnPct': benchmark(candles, cut, n),
    }


def walkforward_report():
    """A cached read-only research endpoint, never forward/live trading."""
    with _LOCK:
        current = time.monotonic()
        if _CACHE['value'] is not None and current < _CACHE['until']:
            return _CACHE['value']
        output = {
            'source': 'COINBASE_EXCHANGE_PUBLIC',
            'type': 'TRAIN_HOLDOUT_HISTORICAL_RESEARCH',
            'holdoutPct': 30,
            'feePerSidePct': 0.1, 'slippagePerSidePct': 0.05,
            'risk': 'LONG_ONLY_30PCT_OF_AVAILABLE_CASH_PER_ASSET',
            'notes': 'Short windows; selection bias; no proof of profitability; Coinbase USD not Binance USDT.',
            'binanceAuthenticated': False, 'ordersEnabled': False,
            'status': 'UNAVAILABLE', 'evaluations': [],
        }
        try:
            for tf in PERIODS:
                for symbol in SYMBOLS:
                    output['evaluations'].append(evaluate(fetch_candles(symbol, tf), symbol, tf))
            output['status'] = 'EXPLORATORY_HOLDOUT_COMPLETE'
        except HTTPError as e:
            output['error'] = 'UPSTREAM_HTTP_' + str(e.code)
        except (URLError, TimeoutError, OSError):
            output['error'] = 'NETWORK_UNAVAILABLE'
        except (ValueError, TypeError, KeyError, OverflowError, json.JSONDecodeError) as e:
            code = str(e)
            output['error'] = code if code in {
                'INVALID_MARKET_DATA', 'INVALID_TIMESTAMP', 'CONFLICTING_CANDLES',
                'MISSING_OR_GAPPED_CANDLES', 'INSUFFICIENT_HISTORY',
                'INVALID_HTTP_RESPONSE'} else 'INVALID_DATA'
        _CACHE['value'] = output
        _CACHE['until'] = current + (CACHE_SECONDS if output['status'] == 'EXPLORATORY_HOLDOUT_COMPLETE' else 60)
        return output
