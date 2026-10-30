"""Read-only Binance Spot Testnet connectivity probe; not a trading robot."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from public_market import public_market_check
from paper_research import research_snapshot
from strategy_validation import walkforward_report

TESTNET_URL = 'https://testnet.binance.vision/api/v3/time'


def probe(url=TESTNET_URL, timeout=7):
    if url != TESTNET_URL:
        raise ValueError('Only official Spot Testnet public time API is permitted')
    try:
        request = Request(url, headers={'Accept': 'application/json', 'User-Agent': 'CryptoTraderAI-EgressCheck/1.0'})
        with urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read(2048))
            valid = response.status == 200 and isinstance(data, dict) and type(data.get('serverTime')) is int
            return {'reachable': valid, 'httpStatus': response.status, 'result': 'OK' if valid else 'INVALID_RESPONSE'}
    except HTTPError as exc:
        # Classify the upstream response without logging its body or headers.
        try:
            detail = exc.read(2048).decode('utf-8', errors='replace').lower()
        except (OSError, ValueError):
            detail = ''
        if exc.code == 451:
            reason = 'LOCATION_OR_LEGAL_RESTRICTION' if (
                'restricted location' in detail
                or 'legal reason' in detail
                or 'eligibility' in detail
                or 'unavailable for legal reasons' in detail
            ) else 'HTTP_451_UNSPECIFIED'
        elif exc.code == 530:
            reason = 'DNS_1016' if '1016' in detail else 'HTTP_530_UNSPECIFIED'
        else:
            reason = 'HTTP_ERROR'
        return {'reachable': False, 'httpStatus': exc.code, 'result': reason}
    except (URLError, TimeoutError, OSError):
        return {'reachable': False, 'httpStatus': None, 'result': 'NETWORK_ERROR'}
    except (ValueError, json.JSONDecodeError):
        return {'reachable': False, 'httpStatus': None, 'result': 'INVALID_RESPONSE'}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/health':
            self.reply({'service': 'binance-testnet-egress-check', 'processRunning': True, 'ordersEnabled': False})
        elif path == '/diagnostico':
            self.reply({'environment': 'BINANCE_SPOT_TESTNET', **probe(), 'ordersEnabled': False})
        elif path == '/market-check':
            self.reply(public_market_check())
        elif path == '/research/backtest':
            self.reply(research_snapshot())
        elif path == '/research/validation-v2':
            self.reply(walkforward_report())
        else:
            self.reply({'error': 'NOT_FOUND'}, 404)

    def reply(self, data, status=200):
        blob = json.dumps(data, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def log_message(self, format, *args):
        return

def startup_check():
    result = probe()
    summary = {'reachable': result['reachable'], 'result': result['result'], 'httpStatus': result['httpStatus']}
    print('BINANCE_TESTNET_STARTUP_CHECK ' + json.dumps(summary, separators=(',', ':')), flush=True)
    market = public_market_check()
    safe = {'healthy': market['healthy'], 'symbols': [
        {'symbol': s['symbol'], 'status': s['status'], 'httpStatus': s.get('httpStatus')}
        for s in market['symbols']
    ]}
    print('PUBLIC_MARKET_STARTUP_CHECK ' + json.dumps(safe, separators=(',', ':')), flush=True)
    study = research_snapshot()
    sanitized = {'status': study['status'], 'error': study.get('error'),
                 'results': [{'symbol': v['symbol'], 'trades': v['trades'], 'candlesUsed': v['candlesUsed']}
                             for v in study.get('results', [])]}
    print('PAPER_RESEARCH_STARTUP_CHECK ' + json.dumps(sanitized, separators=(',', ':')), flush=True)
    v = walkforward_report()
    condensed = {
        'status': v['status'], 'error': v.get('error'),
        'assets': len(v['evaluations']),
        'samples': [{'symbol': x['symbol'], 'timeframe': x['timeframe'],
                     'holdoutReturnPct': x['holdout']['returnPct'],
                     'holdoutBuyHoldReturnPct': x['holdoutBuyHoldReturnPct'],
                     'qualified': x['selectionQualified']}
                    for x in v['evaluations']],
    }
    print('STRATEGY_VALIDATION_STARTUP_CHECK ' + json.dumps(condensed, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    import threading
    server = ThreadingHTTPServer(('0.0.0.0', int(os.getenv('PORT', '10000'))), Handler)
    threading.Thread(target=startup_check, daemon=True).start()
    server.serve_forever()
