import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from io import BytesIO
import json
import paper_research as pr

def candles(n=100, prices=None, t0=1790000000):
    prices = prices if prices is not None else [100.0] * n
    return [(t0 + 3600 * i, p * 0.995, p * 1.005, p, p) for i, p in enumerate(prices)]

class TestPaperResearch(unittest.TestCase):
    def test_no_trades_flat(self):
        r = pr.simulate('BTC-USD', candles())
        self.assertEqual(r['trades'], 0)
        self.assertEqual(r['endingUSD'], 5000)

    def test_max_two_is_metadata_only(self):
        with patch.object(pr, '_read_candles', return_value=candles()):
            pr._CACHE.update(expires=0, result=None)
            result = pr.research_snapshot()
            self.assertEqual(result['maxConcurrentPositions'], 2)
            self.assertFalse(result['ordersEnabled'])
            self.assertEqual(result['endingTotalUSD'], 10000)

    def test_reject_unlisted_symbol(self):
        with self.assertRaises(ValueError): pr.simulate('BTC-USDT', candles())

    def test_missing_history_rejected(self):
        with self.assertRaises(ValueError): pr.simulate('ETH-USD', candles(20))

    def test_signal_uses_previous_closes(self):
        prices = [150 - i * 0.6 for i in range(50)] + [120 + i * 1.1 for i in range(80)]
        r = pr.simulate('BTC-USD', candles(len(prices), prices))
        self.assertGreaterEqual(r['trades'], 1)
        self.assertLessEqual(r['maxDrawdownPct'], 100)

    def test_closes_positions_end_window(self):
        prices = [150 - i * 0.6 for i in range(50)] + [120 + i * 1.1 for i in range(80)]
        r = pr.simulate('ETH-USD', candles(len(prices), prices))
        self.assertGreaterEqual(r['startingUSD'], r['endingUSD'] - 5000)

    def test_provider_http_error_sanitized(self):
        pr._CACHE.update(expires=0, result=None)
        with patch.object(pr, '_read_candles', side_effect=HTTPError('x', 451, 'blocked', {}, BytesIO(b'secret'))):
            result = pr.research_snapshot()
        self.assertEqual(result['error'], 'UPSTREAM_HTTP_451')
        self.assertNotIn('secret', str(result))

    def test_read_rejects_gapped_candles(self):
        now = 2000000000
        rows = [[now - (i + 2) * 3600, 99, 101, 100, 100, 1] for i in range(78)]
        rows[30][0] -= 1800
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, n): return json.dumps(rows).encode()
        with patch.object(pr, 'urlopen', return_value=Response()):
            with self.assertRaisesRegex(ValueError, 'GAPPED_CANDLES'):
                pr._read_candles('BTC-USD', now)

    def test_read_rejects_stale_candles(self):
        now = 2000000000
        rows = [[now - (i + 40) * 3600, 99, 101, 100, 100, 1] for i in range(90)]
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, n): return json.dumps(rows).encode()
        with patch.object(pr, 'urlopen', return_value=Response()):
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_OR_STALE_CANDLES'):
                pr._read_candles('BTC-USD', now)

if __name__ == '__main__':
    unittest.main()
