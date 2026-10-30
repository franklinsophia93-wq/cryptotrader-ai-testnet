"""Fully offline tests for isolated experimental strategy research."""
import io
import math
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import strategy_lab_v3 as lab

START = 1790000000 // 3600 * 3600

def candles(n=840, tf=3600, fn=None):
    prices = [float(fn(i) if fn else 100+0.08*i+2*math.sin(i/9)) for i in range(n)]
    rows = []
    for i,p in enumerate(prices):
        rows.append((START+i*tf,p*0.99,p*1.01,p,p,12+(i%10)*1.1))
    return rows

class LabTests(unittest.TestCase):
    def setUp(self): lab._CACHE.update(expires=0,value=None)
    def test_four_distinct_strategies(self):
        self.assertEqual(set(lab.STRATEGIES), {'trend','reversion','breakout','range'})
    def test_prevent_future_candle_lookahead(self):
        x=candles()
        for name in lab.STRATEGIES:
            old=lab.decision(x,120,name)
            changed=list(x)
            changed[120]=(x[120][0],1,100000,100,100,99999)
            for i in range(121,len(changed)):
                changed[i]=(x[i][0],1,100000,100,100,99999)
            self.assertEqual(old,lab.decision(changed,120,name))
    def test_train_selection_does_not_see_holdout(self):
        x=candles()
        y=list(x)
        cut=int(len(x)*0.7)
        future=candles(n=len(x)-cut,fn=lambda i:300+i*2)
        for i in range(cut,len(y)):
            t,lo,hi,o,c,v=future[i-cut]
            y[i]=(x[i][0],lo,hi,o,c,v)
        one=lab.compare(x,'BTC-USD','1h')
        two=lab.compare(y,'BTC-USD','1h')
        self.assertEqual(one['selectedFromTrainingOnly'],two['selectedFromTrainingOnly'])
        self.assertEqual([z['training'] for z in one['strategies']],[z['training'] for z in two['strategies']])
    def test_flat_market_no_trend_or_breakout(self):
        x=candles(fn=lambda i:100)
        self.assertFalse(lab.decision(x,200,'trend')[0])
        self.assertFalse(lab.decision(x,200,'breakout')[0])
    def test_uptrend_enters_long_only(self):
        x=candles(fn=lambda i:100+i*0.5)
        result=lab.simulate(x,'trend',70,500)
        self.assertGreater(result['trades'],0)
        self.assertGreater(result['endingUSD'],0)
        self.assertGreater(result['estimatedFeesUSD'],0)
        self.assertLessEqual(result['exposurePct'],100)
    def test_reversion_signal_on_oversold(self):
        x=candles(fn=lambda i:100 if i<96 else 100-(i-95)*1.6)
        self.assertTrue(lab.decision(x,105,'reversion')[0])
    def test_range_not_labeled_in_steep_downtrend(self):
        x=candles(fn=lambda i:150-i*0.4)
        self.assertFalse(lab.decision(x,120,'range')[0])
    def test_breakout_requires_volume_confirmation(self):
        x=candles(fn=lambda i:100 if i<110 else 103)
        rows=list(x)
        t,lo,hi,op,cl,_=rows[110]
        rows[110]=(t,lo,hi,op,cl,1000)
        self.assertTrue(lab.decision(rows,111,'breakout')[0])
        self.assertFalse(lab.decision(x,111,'breakout')[0])
    def test_full_holdout_for_each_of_four(self):
        r=lab.compare(candles(),'BTC-USD','1h')
        self.assertEqual(len(r['strategies']),4)
        self.assertEqual(r['holdoutBars'],252)
        self.assertTrue(all(z['holdout']['barsTested']==252 for z in r['strategies']))
    def test_reject_gap(self):
        x=candles();x[60]=(x[60][0]+3600,*x[60][1:])
        with self.assertRaisesRegex(ValueError,'GAPPED_CANDLES'):
            lab.compare(x,'ETH-USD','1h')
    def test_reject_bad_ohlc_or_negative_volume(self):
        x=candles();x[70]=(x[70][0],0,100,100,100,-1)
        with self.assertRaisesRegex(ValueError,'INVALID_MARKET_DATA'):
            lab.compare(x,'BTC-USD','1h')
    def test_invalid_symbol_or_timeframe(self):
        for sym,tf in [('BTC-USDT','1h'),('BTC-USD','15m')]:
            with self.assertRaisesRegex(ValueError,'UNSUPPORTED_MARKET'):
                lab.compare(candles(),sym,tf)
    def test_passive_quarter_has_costs_in_flat_market(self):
        self.assertLess(lab.passive_quarter(candles(fn=lambda i:100),70,500),0)
    def test_no_order_routing_and_complete_output(self):
        with patch.object(lab,'fetch_candles',side_effect=lambda symbol,tf:candles(n=840 if tf=='1h' else 480,tf=3600 if tf=='1h' else 21600)):
            report=lab.lab_report()
        self.assertEqual(report['status'],'EXPERIMENTAL_COMPARISON_COMPLETE')
        self.assertFalse(report['orderRoutingEnabled'])
        self.assertEqual(len(report['evaluations']),4)
        self.assertTrue(all(len(e['strategies'])==4 for e in report['evaluations']))
    def test_reports_upstream_error_without_secret(self):
        with patch.object(lab,'fetch_candles',side_effect=HTTPError('private',451,'Denied',{},io.BytesIO(b'SECRET'))):
            report=lab.lab_report()
        self.assertEqual(report['error'],'UPSTREAM_HTTP_451')
        self.assertNotIn('SECRET',str(report))
    def test_cached_report_does_not_requery(self):
        with patch.object(lab,'fetch_candles',side_effect=lambda symbol,tf:candles(n=840 if tf=='1h' else 480,tf=3600 if tf=='1h' else 21600)):
            lab.lab_report()
        with patch.object(lab,'fetch_candles',side_effect=AssertionError('should not call')):
            self.assertEqual(lab.lab_report()['status'],'EXPERIMENTAL_COMPARISON_COMPLETE')

if __name__=='__main__': unittest.main()
