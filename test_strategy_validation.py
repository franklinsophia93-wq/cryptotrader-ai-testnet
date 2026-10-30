import io
import json
import math
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from datetime import datetime

import strategy_validation as s

BASE = 1790000000 // 3600 * 3600

def mkdata(n=840, step=3600, start=BASE, f=None):
    prices = [float(f(i) if f else 100+0.03*i+3*math.sin(i/13)) for i in range(n)]
    return [(start+i*step,p*0.99,p*1.01,p,p,1.0) for i,p in enumerate(prices)]

class R:
    status=200
    def __init__(self, payload): self.payload=payload
    def __enter__(self): return self
    def __exit__(self,*args): return None
    def read(self,n): return json.dumps(self.payload).encode()

class WalkforwardTests(unittest.TestCase):
    def setUp(self): s._CACHE.update(until=0,value=None)
    def test_no_future_candle_signal(self):
        c=mkdata(150)
        for strategy in ('trend_15_40','trend_20_60','mean_reversion_20'):
            prev = s.signal(c, 100, strategy)
            x = list(c)
            x[100] = (x[100][0],1,100000,120,120,1)
            self.assertEqual(prev, s.signal(x, 100, strategy))
    def test_time_split_excludes_holdout_from_training(self):
        data=mkdata()
        left=s.evaluate(data,'BTC-USD','1h')
        cut=int(len(data)*0.7)
        changed=mkdata(f=lambda i:(100+0.03*i+3*math.sin(i/13)) if i<cut else 3000+40*(i-cut))
        right=s.evaluate(changed,'BTC-USD','1h')
        self.assertEqual(left['selectedStrategy'], right['selectedStrategy'])
        self.assertEqual(left['candidatesTrainingOnly'],right['candidatesTrainingOnly'])
        self.assertEqual(left['trainingBars'],cut-65)
    def test_synthetic_rising_revenue_limited(self):
        data=mkdata(f=lambda i:100+0.6*i)
        x=s.simulate(data,'trend_15_40',65,800)
        self.assertGreaterEqual(x['trades'],1)
        self.assertGreater(x['endingUSD'],0)
    def test_flat_history_no_spurious_returns(self):
        data=mkdata(f=lambda i:100)
        for st in ('trend_15_40','trend_20_60','mean_reversion_20'):
            x=s.simulate(data,st,65,800)
            self.assertEqual(x['trades'],0)
            self.assertEqual(x['endingUSD'],5000)
    def test_strategy_validation(self):
        with self.assertRaises(ValueError): s.simulate(mkdata(),'bogus',65,200)
        with self.assertRaises(ValueError): s.simulate(mkdata(),'trend_15_40',0,200)
    def test_select_training_only(self):
        result=s.evaluate(mkdata(),'ETH-USD','6h')
        self.assertEqual(result['holdoutBars'],252)
        self.assertEqual(len(result['candidatesTrainingOnly']),3)
        self.assertGreaterEqual(result['holdout']['trades'],0)
    def test_benchmark_fees(self):
        a=mkdata(f=lambda i:100)
        self.assertLess(s.benchmark(a,65,800),0)
    def test_disallow_unapproved_api(self):
        with self.assertRaises(ValueError): s.fetch_candles('BTC-USDT','1h')
        with self.assertRaises(ValueError): s.fetch_candles('ETH-USD','15m')
    def test_chunking_and_ignores_open_or_outside(self):
        step,count = s.PERIODS['6h']
        now=(BASE//step)*step+step*3+20
        end=now//step*step
        start=end-step*count
        calls=[]
        def fake_open(req,timeout):
            from urllib.parse import urlparse,parse_qs
            q=parse_qs(urlparse(req.full_url).query)
            lo=int(datetime.fromisoformat(q['start'][0].replace('Z','+00:00')).timestamp())
            hi=int(datetime.fromisoformat(q['end'][0].replace('Z','+00:00')).timestamp())
            calls.append((lo,hi))
            bars=[[i,99,101,100,100,1] for i in range(lo,hi,step)]
            bars.append([hi,99,101,100,100,1])
            return R(bars)
        with patch.object(s,'urlopen',side_effect=fake_open):
            data=s.fetch_candles('BTC-USD','6h',now=now)
        self.assertEqual(len(data),count)
        self.assertEqual(data[0][0],start)
        self.assertEqual(data[-1][0],end-step)
        self.assertEqual(len(calls),2)
        self.assertTrue(all((hi-lo)//step<=240 for lo,hi in calls))
    def test_gapped_data_rejected(self):
        step,count=s.PERIODS['6h'];now=BASE//step*step+100
        def fake_open(req,timeout):
            from urllib.parse import urlparse,parse_qs
            q=parse_qs(urlparse(req.full_url).query)
            lo=int(datetime.fromisoformat(q['start'][0].replace('Z','+00:00')).timestamp())
            hi=int(datetime.fromisoformat(q['end'][0].replace('Z','+00:00')).timestamp())
            return R([[i,99,101,100,100,1] for i in range(lo,hi,step) if i!=lo+step*10])
        with patch.object(s,'urlopen',side_effect=fake_open):
            with self.assertRaisesRegex(ValueError,'MISSING_OR_GAPPED_CANDLES'):
                s.fetch_candles('BTC-USD','6h',now=now)
    def test_conflicting_duplicate_rejected(self):
        step,count=s.PERIODS['6h'];now=BASE//step*step+100
        def fake_open(req,timeout):
            from urllib.parse import urlparse,parse_qs
            q=parse_qs(urlparse(req.full_url).query)
            lo=int(datetime.fromisoformat(q['start'][0].replace('Z','+00:00')).timestamp())
            hi=int(datetime.fromisoformat(q['end'][0].replace('Z','+00:00')).timestamp())
            rows=[[i,99,101,100,100,1] for i in range(lo,hi,step)]
            rows.append([lo,80,101,100,100,1])
            return R(rows)
        with patch.object(s,'urlopen',side_effect=fake_open):
            with self.assertRaisesRegex(ValueError,'CONFLICTING_CANDLES'):
                s.fetch_candles('ETH-USD','6h',now=now)
    def test_safe_network_error(self):
        with patch.object(s,'fetch_candles',side_effect=HTTPError('x',451,'private',{},io.BytesIO(b'secret'))):
            r=s.walkforward_report()
        self.assertEqual(r['error'],'UPSTREAM_HTTP_451')
        self.assertNotIn('secret',str(r))
    def test_cached(self):
        with patch.object(s,'fetch_candles',return_value=mkdata()):
            self.assertEqual(s.walkforward_report()['status'],'EXPLORATORY_HOLDOUT_COMPLETE')
        with patch.object(s,'fetch_candles',side_effect=AssertionError('should not fetch')):
            self.assertEqual(s.walkforward_report()['status'],'EXPLORATORY_HOLDOUT_COMPLETE')

if __name__=='__main__':unittest.main()
