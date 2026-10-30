"""Exploratory Coinbase historical replay. No credentials, persistence or orders."""
import json
import math
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_HOURLY = {
    'BTC-USD': 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600',
    'ETH-USD': 'https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=3600',
}
_CACHE = {'expires': 0, 'result': None}
_LOCK = threading.Lock()


def _read_candles(symbol, now=None):
    if symbol not in _HOURLY:
        raise ValueError('Unsupported instrument')
    now = int(now if now is not None else time.time())
    req = Request(_HOURLY[symbol], method='GET', headers={'User-Agent': 'CryptoTraderResearch/1.0 (read-only)', 'Accept': 'application/json'})
    with urlopen(req, timeout=8) as response:
        if response.status != 200:
            raise ValueError('INVALID_HTTP_RESPONSE')
        rows = json.loads(response.read(120000))
    if not isinstance(rows, list):
        raise ValueError('INVALID_CANDLES')
    candles = []
    seen = set()
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            raise ValueError('INVALID_CANDLES')
        ts = int(row[0])
        if ts in seen:
            raise ValueError('DUPLICATE_CANDLES')
        seen.add(ts)
        low, high, opening, closing, vol = map(float, row[1:6])
        if not all(map(math.isfinite, (low, high, opening, closing, vol))):
            raise ValueError('INVALID_CANDLES')
        if not (0 < low <= min(opening, closing) <= max(opening, closing) <= high and vol >= 0):
            raise ValueError('INVALID_CANDLES')
        if ts + 3600 <= now:  # strictly completed candles only
            candles.append((ts, low, high, opening, closing))
    candles.sort()
    candles = candles[-200:]
    if len(candles) < 70 or now - candles[-1][0] > 3 * 3600:
        raise ValueError('INSUFFICIENT_OR_STALE_CANDLES')
    if any(b[0] - a[0] != 3600 for a, b in zip(candles, candles[1:])):
        raise ValueError('GAPPED_CANDLES')
    return candles


def simulate(symbol, candles, initial_cash=5000.0):
    """One long-only position per asset; signal uses only *prior* closed bars."""
    if symbol not in _HOURLY or not 0 < initial_cash < 1e9:
        raise ValueError('Invalid simulation input')
    if len(candles) < 70:
        raise ValueError('Insufficient history')
    fee, slippage = 0.001, 0.0005
    cash, quantity, entry_cost, entry_price = initial_cash, 0.0, 0.0, 0.0
    peak, max_dd, trades, wins = initial_cash, 0.0, 0, 0
    closes = [x[4] for x in candles]

    def sell(reference):
        nonlocal cash, quantity, entry_cost, entry_price, trades, wins
        if quantity <= 0:
            return
        proceeds = quantity * reference * (1 - slippage) * (1 - fee)
        cash += proceeds
        wins += proceeds > entry_cost
        trades += 1
        quantity, entry_cost, entry_price = 0.0, 0.0, 0.0

    for i in range(41, len(candles)):
        _ts, low, high, opening, closing = candles[i]
        # The current candle is never used to decide whether to enter at its open.
        fast = sum(closes[i - 15:i]) / 15
        slow = sum(closes[i - 40:i]) / 40
        fast_before = sum(closes[i - 16:i - 1]) / 15
        slow_before = sum(closes[i - 41:i - 1]) / 40
        if quantity and fast < slow:
            sell(opening)
        if not quantity and fast > slow and fast_before <= slow_before:
            budget = 0.8 * cash
            entry_price = opening * (1 + slippage)
            quantity = budget / (entry_price * (1 + fee))
            entry_cost = budget
            cash -= budget
        if quantity:
            stop = entry_price * 0.98
            target = entry_price * 1.04
            if low <= stop:
                sell(min(opening, stop))  # conservative if stop and target both hit
            elif high >= target:
                sell(target)
        equity = cash + quantity * closing * (1 - slippage) * (1 - fee)
        peak = max(peak, equity)
        max_dd = max(max_dd, (peak - equity) / peak)
    if quantity:
        sell(candles[-1][4])  # conservative end-of-window liquidation
    return {
        'symbol': symbol, 'startingUSD': round(initial_cash, 2),
        'endingUSD': round(cash, 2), 'returnPct': round(100 * (cash / initial_cash - 1), 2),
        'trades': trades, 'winningTrades': wins, 'maxDrawdownPct': round(max_dd * 100, 2),
        'candlesUsed': len(candles),
        'fromUTC': datetime.fromtimestamp(candles[0][0], tz=timezone.utc).isoformat(),
        'toUTC': datetime.fromtimestamp(candles[-1][0] + 3600, tz=timezone.utc).isoformat(),
    }


def research_snapshot():
    with _LOCK:
        now = time.monotonic()
        if _CACHE['result'] is not None and now < _CACHE['expires']:
            return _CACHE['result']
        data = {'source': 'COINBASE_EXCHANGE_PUBLIC', 'mode': 'HISTORICAL_REPLAY_ONLY',
                'strategy': 'SMA15_40_LONG_ONLY', 'feePerSidePct': 0.1, 'slippagePerSidePct': 0.05,
                'initialTotalUSD': 10000, 'maxConcurrentPositions': 2, 'ordersEnabled': False,
                'binanceAuthenticated': False, 'status': 'UNAVAILABLE', 'results': []}
        try:
            results = [simulate(s, _read_candles(s)) for s in ('BTC-USD', 'ETH-USD')]
            data['results'] = results
            data['endingTotalUSD'] = round(sum(r['endingUSD'] for r in results), 2)
            data['status'] = 'EXPLORATORY_BACKTEST_COMPLETE'
        except HTTPError as exc:
            data['error'] = 'UPSTREAM_HTTP_' + str(exc.code)
        except (URLError, TimeoutError, OSError):
            data['error'] = 'NETWORK_UNAVAILABLE'
        except (ValueError, TypeError, KeyError, OverflowError) as exc:
            data['error'] = str(exc) if str(exc) in {
                'INVALID_CANDLES', 'DUPLICATE_CANDLES', 'GAPPED_CANDLES',
                'INSUFFICIENT_OR_STALE_CANDLES', 'INVALID_HTTP_RESPONSE'
            } else 'INVALID_MARKET_DATA'
        _CACHE['result'], _CACHE['expires'] = data, now + 300
        return data
