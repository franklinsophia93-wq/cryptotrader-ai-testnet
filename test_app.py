import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
import io
import app

class TestEgress(unittest.TestCase):
    def test_disallow_arbitrary_host(self):
        with self.assertRaises(ValueError): app.probe('https://api.binance.com/api/v3/time')
    @patch('app.urlopen')
    def test_success(self, u):
        class R:
            status=200
            def read(self,n): return b'{"serverTime":1793300000000}'
            def __enter__(self): return self
            def __exit__(self,*args): pass
        u.return_value=R()
        self.assertTrue(app.probe()['reachable'])
    @patch('app.urlopen')
    def test_451(self,u):
        u.side_effect=HTTPError(app.TESTNET_URL,451,'Unavailable',{},io.BytesIO(b''))
        self.assertEqual(app.probe()['httpStatus'],451)
    @patch('app.urlopen')
    def test_451_location_classified_without_raw_body(self,u):
        u.side_effect=HTTPError(app.TESTNET_URL,451,'Unavailable',{},io.BytesIO(b'Access denied from a restricted location. account-id=DO_NOT_LOG'))
        result=app.probe()
        self.assertEqual(result['result'],'LOCATION_OR_LEGAL_RESTRICTION')
        self.assertEqual(result['httpStatus'],451)
        self.assertNotIn('account-id',str(result))
    @patch('app.urlopen')
    def test_530_dns_1016(self,u):
        u.side_effect=HTTPError(app.TESTNET_URL,530,'Error',{},io.BytesIO(b'Cloudflare Error 1016 Origin DNS error'))
        self.assertEqual(app.probe()['result'],'DNS_1016')
    @patch('app.urlopen')
    def test_network_error(self,u):
        u.side_effect=URLError('DNS')
        self.assertEqual(app.probe()['result'],'NETWORK_ERROR')
    @patch('app.urlopen')
    def test_invalid(self,u):
        class R:
            status=200
            def read(self,n): return b'{"hello": true}'
            def __enter__(self): return self
            def __exit__(self,*args): pass
        u.return_value=R()
        self.assertEqual(app.probe()['result'],'INVALID_RESPONSE')
