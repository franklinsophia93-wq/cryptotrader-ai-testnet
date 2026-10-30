"""Experimental regime-conditioned selection, frozen before a historical holdout.

Read-only Coinbase historical replay: no credentials, persistence, or order routing.
Selection uses completed training trades; classification uses only PREVIOUS candles.
A regime without adequate positive net evidence stays in virtual USD (CASH).
"""
from __future__ import annotations
import math
import statistics
import threading
import time
from collections import defaultdict
from urllib.error import HTTPError, URLError

from strategy_validation import fetch_candles, PERIODS, SYMBOLS
from strategy_lab_v3 import (STRATEGIES, FEE, SLIP, ALLOC, INITIAL,
                             decision, compare as fixed_compare)

WARMUP = 70
REGIMES = ('HIGH_VOLATILITY', 'UPTREND', 'DOWNTREND', 'SIDEWAYS')
MIN_TRADES = 3
MIN_MEAN_NET_RETURN_PCT = 0.20
CACHE_SECONDS = 900
_CACHE = {'expires': 0.0, 'value': None}
_LOCK = threading.Lock()
_RULES = {'trend': (0.03, 0.06), 'reversion': (0.02, 0.035),
          'breakout': (0.03, 0.07), 'range': (0.02, 0.03)}


def regime(candles, i):
    """Classify *at the open of i*, reading completed candles [0:i] only."""
    if i < WARMUP or i > len(candles):
        raise ValueError('INVALID_REGIME_INDEX')
    closes = [c[4] for c in candles[i-61:i]]
    returns = [abs(math.log(b/a)) for a, b in zip(closes[:-1], closes[1:])]
    recent = sum(returns[-20:]) / 20
    baseline = sum(returns) / 60
    if baseline >= 0.002 and recent > 1.7*baseline and recent > 0.007:
        return 'HIGH_VOLATILITY'
    previous = closes[-1]
    ma15 = sum(closes[-15:])/15
    ma40 = sum(closes[-40:])/40
    deviation = ma15 / ma40 - 1
    if deviation > 0.007:
        return 'UPTREND'
    if deviation < -0.007:
        return 'DOWNTREND'
    return 'SIDEWAYS'


def replay(candles, start, end, *, fixed=None, mapping=None, capital=INITIAL):
    """One long-only virtual position, filled against OHLC with costs.

    *fixed* is a single strategy; *mapping* is frozen and keyed by entry regime.
    Historical OHLC fills are only approximations, not actual exchange executions.
    """
    if not (WARMUP <= start < end <= len(candles)):
        raise ValueError('INVALID_WINDOW')
    if (fixed is None) == (mapping is None):
        raise ValueError('SELECT_FIXED_OR_MAPPING')
    if fixed is not None and fixed not in STRATEGIES:
        raise ValueError('UNKNOWN_STRATEGY')
    if mapping is not None and (set(mapping) != set(REGIMES) or
                                any(s is not None and s not in STRATEGIES for s in mapping.values())):
        raise ValueError('INVALID_FROZEN_MAPPING')
    if not math.isfinite(capital) or not (0 < capital <= 1e9):
        raise ValueError('INVALID_CAPITAL')
    cash = capital
    qty = 0.0
    cost = 0.0
    entry_price = 0.0
    entry_strategy = None
    entry_regime = None
    peak = capital
    max_drawdown = 0.0
    bars_exposed = 0
    events = []

    def close(reference, ts, reason):
        nonlocal cash, qty, cost, entry_price, entry_strategy, entry_regime
        price = reference * (1-SLIP)
        proceeds = qty * price * (1-FEE)
        pnl = proceeds - cost
        cash += proceeds
        events.append({
            'entryRegime': entry_regime, 'strategy': entry_strategy,
            'pnlUSD': pnl, 'netReturnPct': 100*pnl/cost,
            'closedAt': int(ts), 'reason': reason,
        })
        qty, cost, entry_price = 0.0, 0.0, 0.0
        entry_strategy, entry_regime = None, None

    for i in range(start, end):
        ts, low, high, opening, closing, _volume = candles[i]
        today_regime = regime(candles, i)
        selected = fixed if fixed is not None else mapping.get(today_regime)
        closed_this_bar = False
        if qty:
            _want_entry, want_exit = decision(candles, i, entry_strategy)
            if want_exit:
                close(opening, ts, 'SIGNAL_EXIT')
                closed_this_bar = True
        if not qty and not closed_this_bar and selected is not None:
            enter, _exit = decision(candles, i, selected)
            if enter:
                budget = cash*ALLOC
                if budget >= 1.0:
                    entry_price = opening*(1+SLIP)
                    qty = budget/(entry_price*(1+FEE))
                    cost = budget
                    cash -= budget
                    entry_strategy, entry_regime = selected, today_regime
        if qty:
            stop_pct, target_pct = _RULES[entry_strategy]
            stop = entry_price*(1-stop_pct)
            target = entry_price*(1+target_pct)
            if low <= stop:
                close(min(stop,opening), ts, 'STOP_LOSS_FIRST')
                closed_this_bar = True
            elif high >= target:
                close(target, ts, 'TAKE_PROFIT')
                closed_this_bar = True
        if qty:
            bars_exposed += 1
        equity = cash + qty*closing*(1-SLIP)*(1-FEE)
        peak = max(peak,equity)
        max_drawdown = max(max_drawdown, (peak-equity)/peak)
    if qty:
        close(candles[end-1][4], candles[end-1][0], 'END_OF_WINDOW')
        max_drawdown = max(max_drawdown, (peak-cash)/peak)
    summary = {
        'startingUSD': round(capital,2), 'endingUSD': round(cash,2),
        'returnPct': round(100*(cash/capital-1),2),
        'maxDrawdownPct': round(100*max_drawdown,2),
        'trades': len(events),
        'winningTrades': sum(e['pnlUSD'] > 0 for e in events),
        'barsTraded': end-start,
        'exposurePct': round(100*bars_exposed/(end-start),2),
    }
    return summary, events


def train_mapping(candles, cut):
    """Fit a *fixed* regime-to-strategy map using training trades only."""
    if cut <= WARMUP or cut > len(candles):
        raise ValueError('INVALID_TRAINING_WINDOW')
    groups = defaultdict(list)
    by_strategy = {}
    for name in STRATEGIES:
        stats, events = replay(candles, WARMUP, cut, fixed=name)
        by_strategy[name] = {'returnPct':stats['returnPct'], 'trades':stats['trades']}
        for e in events:
            groups[(e['entryRegime'],name)].append(e['netReturnPct'])
    frozen, diagnostics = {}, {}
    for kind in REGIMES:
        candidates = []
        for name in STRATEGIES:
            vals = groups[(kind,name)]
            mean = statistics.mean(vals) if vals else None
            qualifying = (
                len(vals) >= MIN_TRADES and
                mean is not None and mean > MIN_MEAN_NET_RETURN_PCT and
                sum(vals) > 0
            )
            candidates.append({
                'strategy':name,'completedTrainingTrades':len(vals),
                'meanNetTradeReturnPct':round(mean,3) if mean is not None else None,
                'qualified':qualifying,
            })
        good = [x for x in candidates if x['qualified']]
        frozen[kind] = max(good,key=lambda x:(x['meanNetTradeReturnPct'],
                                             x['completedTrainingTrades']))['strategy'] if good else None
        diagnostics[kind] = {
            'chosen':frozen[kind] or 'CASH', 'trainingEvidence':candidates,
        }
    return frozen, diagnostics, by_strategy


def evaluate(candles, symbol, tf):
    if symbol not in SYMBOLS or tf not in PERIODS:
        raise ValueError('UNSUPPORTED_MARKET')
    interval, _ = PERIODS[tf]
    if len(candles) < 300:
        raise ValueError('INSUFFICIENT_HISTORY')
    for j, row in enumerate(candles):
        if len(row)!=6 or not all(math.isfinite(x) for x in row):
            raise ValueError('INVALID_MARKET_DATA')
        ts, low, high, op, close, vol = row
        if low<=0 or vol<0 or not(low <= min(op,close) <= max(op,close) <= high):
            raise ValueError('INVALID_MARKET_DATA')
        if j and ts-candles[j-1][0]!=interval:
            raise ValueError('GAPPED_CANDLES')
    cut = int(len(candles)*.70)
    frozen, training, train_returns = train_mapping(candles, cut)
    adaptive, holdout_trades = replay(candles,cut,len(candles),mapping=frozen)
    fixed = fixed_compare(candles,symbol,tf)
    observed_regimes = {r:0 for r in REGIMES}
    for i in range(cut,len(candles)):
        observed_regimes[regime(candles,i)] += 1
    return {
        'symbol':symbol, 'timeframe':tf,
        'candles':len(candles),'trainingBars':cut-WARMUP,'holdoutBars':len(candles)-cut,
        'frozenMapping':{r:frozen[r] or 'CASH' for r in REGIMES},
        'trainingEvidence':training,'trainingFixedStrategies':train_returns,
        'holdoutRegimes':observed_regimes,
        'adaptiveHoldout':adaptive,
        'adaptiveCompletedTradesByRegime':{
            r:sum(e['entryRegime']==r for e in holdout_trades) for r in REGIMES
        },
        'trainingSelectedFixed':fixed['selectedFromTrainingOnly'],
        'fixedHoldout':fixed['selectedHoldout'],
        'passive25PctHoldoutReturnPct':fixed['holdoutPassive25PctReturnPct'],
        'safeFallback':'CASH_IF_TRAINING_EVIDENCE_INSUFFICIENT',
    }


def report():
    with _LOCK:
        now=time.monotonic()
        if _CACHE['value'] is not None and now<_CACHE['expires']:
            return _CACHE['value']
        response = {
            'mode':'RESEARCH_ONLY', 'source':'COINBASE_EXCHANGE_PUBLIC',
            'status':'UNAVAILABLE', 'ordersEnabled':False, 'binanceAuthenticated':False,
            'selection':'FROZEN_TRAINING_ONLY_REGIME_TO_STRATEGY',
            'regimes':list(REGIMES),'strategies':list(STRATEGIES),
            'minTradesPerRegime':MIN_TRADES,'minMeanNetTradeReturnPct':MIN_MEAN_NET_RETURN_PCT,
            'trainingFraction':0.70,'feePerSidePct':FEE*100,'slippagePerSidePct':SLIP*100,
            'warnings':['Chronological historical replay, not a live forward test',
                        'CASH means no entry when training evidence is insufficient',
                        'Sparse regime samples, data selection and simulated OHLC fills can bias results',
                        'No real orders, leverage, or change to the Cloudflare paper bot'],
            'evaluations':[],
        }
        try:
            for tf in PERIODS:
                for symbol in SYMBOLS:
                    response['evaluations'].append(evaluate(fetch_candles(symbol,tf),symbol,tf))
            response['status']='EXPLORATORY_REGIME_HOLDOUT_COMPLETE'
        except HTTPError as e:
            response['error']='UPSTREAM_HTTP_'+str(e.code)
        except (OSError,URLError,TimeoutError):
            response['error']='NETWORK_UNAVAILABLE'
        except (ValueError,TypeError,OverflowError,KeyError,ZeroDivisionError) as e:
            msg=str(e)
            response['error']=msg if msg in ('INVALID_MARKET_DATA','INSUFFICIENT_HISTORY','GAPPED_CANDLES',
                'MISSING_OR_GAPPED_CANDLES','CONFLICTING_CANDLES','INVALID_TIMESTAMP',
                'INVALID_HTTP_RESPONSE') else 'INVALID_RESEARCH_DATA'
        _CACHE['value']=response
        _CACHE['expires']=now+(CACHE_SECONDS if response['status']=='EXPLORATORY_REGIME_HOLDOUT_COMPLETE' else 60)
        return response
