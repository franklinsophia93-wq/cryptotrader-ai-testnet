"""Isolated comparative historical strategy lab: strictly read-only, no orders.
All decisions use completed prior candles; trade fills are simulated and conservative.
This is NOT live paper trading, a trained ML model, or a profitability claim.
"""
from __future__ import annotations
import json
import math
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from strategy_validation import fetch_candles, SYMBOLS, PERIODS

STRATEGIES = ('trend', 'reversion', 'breakout', 'range')
STRATEGY_DESCRIPTIONS = {
    'trend': 'SMA15 above SMA40; exit on reversal',
    'reversion': 'RSI14 below 40 and previous close 1% below SMA20; exit on recovery',
    'breakout': 'Prior close exceeds preceding 20-bar high with above-average volume',
    'range': 'Narrow 30-bar range and near lower quartile; exit near midpoint',
}
FEE = 0.001
SLIP = 0.0005
INITIAL = 5000.0
ALLOC = 0.25
CACHE_SECONDS = 900
_WARMUP = 70
_CACHE = {'expires': 0.0, 'value': None}
_LOCK = threading.Lock()

def _utc(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def _average(seq):
    return sum(seq) / len(seq)

def _rsi(closes, end, n=14):
    if end < n + 1:
        return 50.0
    gains = 0.0
    losses = 0.0
    for k in range(end-n, end):
        delta = closes[k] - closes[k-1]
        gains += max(0.0, delta)
        losses += max(0.0, -delta)
    if losses == 0:
        return 100.0 if gains > 0 else 50.0
    return 100.0 - 100.0 / (1.0 + gains / losses)

def decision(candles, i, strategy):
    """Return (entry, exit) based exclusively on OHLCV candles indexed < i."""
    if strategy not in STRATEGIES or i < _WARMUP or i > len(candles):
        raise ValueError('INVALID_DECISION_REQUEST')
    past = candles[:i]
    closes = [c[4] for c in past]
    prev = closes[-1]
    avg20 = _average(closes[-20:])
    if strategy == 'trend':
        is_up = _average(closes[-15:]) > _average(closes[-40:])
        return is_up, not is_up
    if strategy == 'reversion':
        rsi = _rsi(closes, len(closes))
        return (prev < avg20 * 0.99 and rsi < 40), (prev >= avg20 or rsi > 60)
    if strategy == 'breakout':
        prior20 = past[-21:-1]
        high20 = max(c[2] for c in prior20)
        vol20 = _average([c[5] for c in prior20])
        entry = prev > high20 and past[-1][5] > vol20 * 1.2 and vol20 > 0
        exit_signal = prev < min(c[1] for c in past[-10:-1])
        return entry, exit_signal
    window = past[-30:]
    low = min(c[1] for c in window)
    high = max(c[2] for c in window)
    width = high/low - 1
    near_lower = prev < low + 0.3*(high-low)
    sideways = width <= 0.12 and abs(_average(closes[-15:])/_average(closes[-40:])-1) <= 0.015
    return (sideways and near_lower), (prev >= low + 0.6*(high-low) or not sideways)

def simulate(candles, strategy, start, end, capital=INITIAL):
    if strategy not in STRATEGIES or not (_WARMUP <= start < end <= len(candles)):
        raise ValueError('INVALID_SIMULATION_WINDOW')
    if not (math.isfinite(capital) and 0 < capital <= 1e9):
        raise ValueError('INVALID_CAPITAL')
    cash, qty, cost, entry_px = capital, 0.0, 0.0, 0.0
    gross_fees, trades, wins, bars_exposed = 0.0, 0, 0, 0
    peak, worst_dd = capital, 0.0
    rules = {'trend': (0.03, 0.06), 'reversion': (0.02, 0.035),
             'breakout': (0.03, 0.07), 'range': (0.02, 0.03)}
    stop_pct, target_pct = rules[strategy]
    for i in range(start, end):
        _ts, low, high, opening, closing, _volume = candles[i]
        enter, exit_signal = decision(candles, i, strategy)
        closed_this_bar = False
        def exit_position(reference):
            nonlocal cash, qty, cost, entry_px, trades, wins, gross_fees, closed_this_bar
            px = reference * (1 - SLIP)
            proceeds_before_fee = qty * px
            fee = proceeds_before_fee * FEE
            revenue = proceeds_before_fee - fee
            gross_fees += fee
            cash += revenue
            wins += int(revenue > cost)
            trades += 1
            qty, cost, entry_px = 0.0, 0.0, 0.0
            closed_this_bar = True
        if qty and exit_signal:
            exit_position(opening)
        if not qty and not closed_this_bar and enter:
            budget = cash * ALLOC
            if budget >= 1.0:
                entry_px = opening * (1 + SLIP)
                qty = budget / (entry_px * (1 + FEE))
                fee = qty * entry_px * FEE
                gross_fees += fee
                cost = budget
                cash -= budget
        if qty:
            stop_price = entry_px * (1 - stop_pct)
            target_price = entry_px * (1 + target_pct)
            if low <= stop_price:
                exit_position(min(stop_price, opening))
            elif high >= target_price:
                exit_position(target_price)
        if qty:
            bars_exposed += 1
        equity = cash + qty * closing * (1 - SLIP) * (1 - FEE)
        peak = max(equity, peak)
        worst_dd = max(worst_dd, (peak-equity)/peak)
    if qty:
        exit_position(candles[end-1][4])
        worst_dd = max(worst_dd, (peak-cash)/peak)
    return {
        'strategy': strategy,
        'startingUSD': round(capital, 2), 'endingUSD': round(cash, 2),
        'returnPct': round(100*(cash/capital-1), 2),
        'maxDrawdownPct': round(100*worst_dd, 2),
        'trades': trades, 'winningTrades': wins,
        'exposurePct': round(100*bars_exposed/(end-start), 2),
        'estimatedFeesUSD': round(gross_fees, 2), 'barsTested': end-start,
    }

def _validate_candles(candles, interval):
    if len(candles) < 300:
        raise ValueError('INSUFFICIENT_HISTORY')
    for idx, row in enumerate(candles):
        if len(row) != 6:
            raise ValueError('INVALID_MARKET_DATA')
        ts, lo, hi, op, cl, vol = row
        if not all(math.isfinite(x) for x in row) or not (lo > 0 and vol >= 0 and lo <= min(op, cl) <= max(op, cl) <= hi):
            raise ValueError('INVALID_MARKET_DATA')
        if idx and ts - candles[idx-1][0] != interval:
            raise ValueError('GAPPED_CANDLES')

def passive_quarter(candles, start, end):
    """25%-allocated passive long position, matching active strategy sizing."""
    entry = candles[start][3] * (1 + SLIP)
    units = (INITIAL*ALLOC)/(entry*(1+FEE))
    exit_net = units*candles[end-1][4]*(1-SLIP)*(1-FEE)
    return round(100*((INITIAL*(1-ALLOC)+exit_net)/INITIAL-1), 2)

def compare(candles, symbol, timeframe):
    if symbol not in SYMBOLS or timeframe not in PERIODS:
        raise ValueError('UNSUPPORTED_MARKET')
    _validate_candles(candles, PERIODS[timeframe][0])
    cut = int(len(candles)*0.70)
    candidates = []
    for strategy in STRATEGIES:
        train = simulate(candles, strategy, _WARMUP, cut)
        test = simulate(candles, strategy, cut, len(candles))
        candidates.append({'strategy': strategy, 'training': train, 'holdout': test,
                           'eligibleForSelection': train['trades'] >= 3})
    eligible = [v for v in candidates if v['eligibleForSelection']]
    selected = max(eligible, key=lambda x: (x['training']['returnPct'], -x['training']['maxDrawdownPct']))['strategy'] if eligible else None
    return {
        'symbol': symbol, 'timeframe': timeframe, 'candleCount': len(candles),
        'trainingBars': cut-_WARMUP, 'holdoutBars': len(candles)-cut,
        'trainingThroughUTC': _utc(candles[cut-1][0]),
        'holdoutFromUTC': _utc(candles[cut][0]),
        'dataThroughUTC': _utc(candles[-1][0]),
        'strategies': candidates, 'selectedFromTrainingOnly': selected,
        'selectedHoldout': next((x['holdout'] for x in candidates if x['strategy'] == selected), None),
        'holdoutPassive25PctReturnPct': passive_quarter(candles, cut, len(candles)),
    }

def lab_report():
    with _LOCK:
        clock = time.monotonic()
        if _CACHE['value'] is not None and clock < _CACHE['expires']:
            return _CACHE['value']
        output = {
            'status': 'UNAVAILABLE', 'mode': 'RESEARCH_ONLY', 'source': 'COINBASE_EXCHANGE_PUBLIC',
            'sourceCurrency': 'USD', 'orderRoutingEnabled': False,
            'doesNotModify': 'CLOUDFLARE_PAPER_ENGINE',
            'strategies': list(STRATEGIES), 'strategyDescriptions': STRATEGY_DESCRIPTIONS,
            'holdoutPct': 30, 'feePerSidePct': 0.1, 'slippagePerSidePct': 0.05,
            'positionSizePctOfAvailableCash': 25, 'longOnly': True,
            'warnings': ['Historical simulation only, no forward trades or proof of profits',
                         'Train/holdout split is not multi-fold walk-forward validation',
                         'Coinbase USD spot candles are not Binance USDT quotes',
                         'Stops use OHLC conservative stop-before-target ordering; actual fills can be worse'],
            'evaluations': [],
        }
        try:
            for timeframe in PERIODS:
                for symbol in SYMBOLS:
                    output['evaluations'].append(compare(fetch_candles(symbol,timeframe),symbol,timeframe))
            output['status'] = 'EXPERIMENTAL_COMPARISON_COMPLETE'
        except HTTPError as exc:
            output['error'] = 'UPSTREAM_HTTP_'+str(exc.code)
        except (URLError, OSError, TimeoutError):
            output['error'] = 'UPSTREAM_UNREACHABLE'
        except (ValueError, TypeError, OverflowError, KeyError) as exc:
            msg = str(exc)
            output['error'] = msg if msg in {
                'GAPPED_CANDLES', 'INSUFFICIENT_HISTORY','INVALID_MARKET_DATA',
                'CONFLICTING_CANDLES','MISSING_OR_GAPPED_CANDLES','INVALID_TIMESTAMP',
                'INVALID_HTTP_RESPONSE'} else 'INVALID_RESEARCH_DATA'
        _CACHE['value'] = output
        _CACHE['expires'] = clock + (CACHE_SECONDS if output['status']=='EXPERIMENTAL_COMPARISON_COMPLETE' else 90)
        return output
