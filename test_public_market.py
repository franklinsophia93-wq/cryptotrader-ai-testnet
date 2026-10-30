import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from io import BytesIO
import json
import public_market

NOW = datetime(2026, 10, 29, 21, 0, tzinfo=timezone.utc)

class FakeResponse:
    status = 200
    def __init__(self, payload):
        self.payload = payload
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, n):
        return json.dumps(self.payload).encode()

class TestPublicMarket(unittest.TestCase):
    def test_rejects_unknown_symbol(self):
        with self.assertRaises(ValueError):
            public_market.market_probe('BTC-USDT')

    @patch('public_market.urlopen')
    def test_fresh_price(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse({'price': '61321.12', 'time': '2026-10-29T20:59:00Z'})
        result = public_market.market_probe('BTC-USD', now=NOW)
        self.assertEqual(result['status'], 'FRESH')
        self.assertEqual(result['priceUSD'], 61321.12)

    @patch('public_market.urlopen')
    def test_stale_ticker_rejected(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse({'price': '61321.12', 'time': '2026-10-29T20:40:00Z'})
        self.assertEqual(public_market.market_probe('BTC-USD', now=NOW)['status'], 'STALE')

    @patch('public_market.urlopen')
    def test_future_data_rejected(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse({'price': '61321.12', 'time': '2026-10-29T21:02:00Z'})
        self.assertEqual(public_market.market_probe('BTC-USD', now=NOW)['status'], 'STALE')

    @patch('public_market.urlopen')
    def test_bad_price_rejected(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse({'price': '-3', 'time': '2026-10-29T20:59:00Z'})
        self.assertEqual(public_market.market_probe('ETH-USD', now=NOW)['status'], 'INVALID_RESPONSE')

    @patch('public_market.urlopen')
    def test_http_451_no_body_exposed(self, mock_urlopen):
        mock_urlopen.side_effect = HTTPError('https://api.exchange.coinbase.com', 451, 'Denied', {}, BytesIO(b'secret'))
        result = public_market.market_probe('BTC-USD', now=NOW)
        self.assertEqual(result['httpStatus'], 451)
        self.assertNotIn('secret', str(result))

    @patch('public_market.urlopen')
    def test_dns_rejected(self, mock_urlopen):
        mock_urlopen.side_effect = URLError('DNS')
        self.assertEqual(public_market.market_probe('BTC-USD', now=NOW)['status'], 'NETWORK_ERROR')

    @patch('public_market.market_probe')
    def test_composite_health_and_safety(self, mock_probe):
        mock_probe.side_effect = lambda s: {'symbol': s, 'status': 'FRESH'}
        result = public_market.public_market_check()
        self.assertTrue(result['healthy'])
        self.assertFalse(result['ordersEnabled'])
        self.assertFalse(result['binanceAuthenticated'])
        self.assertEqual(result['source'], 'COINBASE_EXCHANGE_PUBLIC')

if __name__ == '__main__':
    unittest.main()
