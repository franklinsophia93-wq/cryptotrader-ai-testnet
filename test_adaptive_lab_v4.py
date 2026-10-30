"""Offline tests for the frozen training-only adaptive research selector."""
import io
import math
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import adaptive_lab_v4 as lab

BASE=1790000000//3600*3600

def bars(n=840,tf=3600,price=None):
    price = price or (lambda i:100+0.08*i+2*math.sin(i/9))
    output=[]
    for i in range(n):
        p=float(price(i))
        output.append((BASE+i*tf,p*0.99,p*1.01,p,p,10.0+i%3))
    return output

class AdaptiveTests(unittest.TestCase):
    def setUp(self):
        lab._CACHE.update(expires=0,value=None)

    def test_frozen_regimes_cover_all_cases(self):
        self.assertEqual(len(lab.REGIMES),4)

    def test_regime_only_reads_prior_candles(self):
        a=bars()
        old=lab.regime(a,140)
        b=list(a)
        for i in range(140,len(b)):
            b[i]=(b[i][0],1,1e6,100,100,200)
        self.assertEqual(old,lab.regime(b,140))

    def test_detect_uptrend_and_downtrend(self):
        self.assertEqual(lab.regime(bars(price=lambda i:100+i*0.5),120),'UPTREND')
        self.assertEqual(lab.regime(bars(price=lambda i:400-i*1.2),120),'DOWNTREND')

    def test_high_volatility_has_priority_over_direction(self):
        def price(i):
            return 100 if i<120 else (145 if i%2 else 85)
        self.assertEqual(lab.regime(bars(price=price),140),'HIGH_VOLATILITY')

    def test_flat_market_classified_as_sideways(self):
        self.assertEqual(lab.regime(bars(price=lambda i:100),100),'SIDEWAYS')

    def test_cash_mapping_stays_in_cash_even_if_market_rises(self):
        x=bars(price=lambda i:100+i*0.5)
        summary,trades=lab.replay(x,70,350,mapping={r:None for r in lab.REGIMES})
        self.assertEqual(summary['endingUSD'],5000.0)
        self.assertEqual(summary['trades'],0)
        self.assertEqual(trades,[])

    def test_fixed_trend_executes_with_fees(self):
        x=bars(price=lambda i:100+i*0.5)
        result,trades=lab.replay(x,70,350,fixed='trend')
        self.assertGreater(result['trades'],0)
        self.assertEqual(result['trades'],len(trades))
        self.assertTrue(all(e['strategy']=='trend' for e in trades))
        self.assertTrue(all(e['entryRegime'] in lab.REGIMES for e in trades))

    def test_adaptive_follows_only_frozen_allowed_regimes(self):
        x=bars(price=lambda i:100+i*0.4)
        mapping={r:None for r in lab.REGIMES}
        mapping['UPTREND']='trend'
        summary,trades=lab.replay(x,70,350,mapping=mapping)
        self.assertGreater(summary['trades'],0)
        self.assertTrue(all(e['entryRegime']=='UPTREND' for e in trades))

    def test_training_ignores_all_holdout_changes(self):
        a=bars()
        cut=int(len(a)*0.70)
        b=list(a)
        for i in range(cut,len(a)):
            p=3000+4*(i-cut)
            b[i]=(a[i][0],p*0.99,p*1.01,p,p,10)
        m1,s1,f1=lab.train_mapping(a,cut)
        m2,s2,f2=lab.train_mapping(b,cut)
        self.assertEqual(m1,m2)
        self.assertEqual(s1,s2)
        self.assertEqual(f1,f2)
        d1=lab.evaluate(a,'BTC-USD','1h')
        d2=lab.evaluate(b,'BTC-USD','1h')
        self.assertEqual(d1['frozenMapping'],d2['frozenMapping'])
        self.assertEqual(d1['trainingEvidence'],d2['trainingEvidence'])

    def test_insufficient_training_evidence_gives_cash(self):
        frozen,diagnostics,_=lab.train_mapping(bars(price=lambda i:100),560)
        self.assertTrue(all(x is None for x in frozen.values()))
        self.assertTrue(all(v['chosen']=='CASH' for v in diagnostics.values()))

    def test_limited_positive_training_samples_are_rejected(self):
        s=bars(price=lambda i:100+i*0.5)
        map_,diag,_=lab.train_mapping(s,76)
        self.assertTrue(all(x is None for x in map_.values()))
        self.assertTrue(all(c['completedTrainingTrades']<3 for v in diag.values()
                            for c in v['trainingEvidence']))

    def test_comparisons_include_same_holdout_window(self):
        x=bars()
        report=lab.evaluate(x,'ETH-USD','1h')
        self.assertEqual(report['holdoutBars'],252)
        self.assertEqual(report['adaptiveHoldout']['barsTraded'],252)
        self.assertTrue(all(x in report['frozenMapping'] for x in lab.REGIMES))
        self.assertIn(report['trainingSelectedFixed'],(*lab.STRATEGIES,None))
        self.assertIsInstance(report['passive25PctHoldoutReturnPct'],float)

    def test_invalid_selection_settings_fail_closed(self):
        with self.assertRaises(ValueError):lab.replay(bars(),70,300,mapping={'UPTREND':'trend'})
        with self.assertRaises(ValueError):lab.replay(bars(),70,300,fixed='trend',mapping={r:None for r in lab.REGIMES})
        with self.assertRaises(ValueError):lab.replay(bars(),70,300)
        with self.assertRaises(ValueError):lab.replay(bars(),69,300,fixed='trend')

    def test_reject_invalid_ohlc_and_gap(self):
        x=bars();x[75]=(x[75][0],0,200,100,100,10)
        with self.assertRaisesRegex(ValueError,'INVALID_MARKET_DATA'):
            lab.evaluate(x,'BTC-USD','1h')
        y=bars();y[75]=(y[75][0]+3600,*y[75][1:])
        with self.assertRaisesRegex(ValueError,'GAPPED_CANDLES'):
            lab.evaluate(y,'BTC-USD','1h')

    def test_unknown_market_rejected(self):
        with self.assertRaises(ValueError):
            lab.evaluate(bars(),'BTC-USDT','1h')

    def test_report_is_read_only_and_four_markets(self):
        with patch.object(lab,'fetch_candles',side_effect=lambda sym,tf:bars(n=840 if tf=='1h' else 480,tf=3600 if tf=='1h' else 21600)):
            result=lab.report()
        self.assertEqual(result['status'],'EXPLORATORY_REGIME_HOLDOUT_COMPLETE')
        self.assertFalse(result['ordersEnabled'])
        self.assertFalse(result['binanceAuthenticated'])
        self.assertEqual(len(result['evaluations']),4)

    def test_http_451_error_redacts_body(self):
        with patch.object(lab,'fetch_candles',side_effect=HTTPError('secret-url',451,'private',{},io.BytesIO(b'secret'))):
            r=lab.report()
        self.assertEqual(r['error'],'UPSTREAM_HTTP_451')
        self.assertNotIn('secret',str(r).lower())

    def test_cache_does_not_fetch_twice(self):
        with patch.object(lab,'fetch_candles',side_effect=lambda sym,tf:bars(n=840 if tf=='1h' else 480,tf=3600 if tf=='1h' else 21600)):
            lab.report()
        with patch.object(lab,'fetch_candles',side_effect=AssertionError('no second fetch')):
            self.assertEqual(lab.report()['status'],'EXPLORATORY_REGIME_HOLDOUT_COMPLETE')

if __name__=='__main__':unittest.main()
