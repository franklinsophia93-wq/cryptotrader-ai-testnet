"""Public Cloudflare paper Worker smoke test. No private information is logged."""
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = "https://cryptotrader-paper-engine.franklinsophia93.workers.dev"

def check(path):
    try:
        req=Request(ROOT+"/"+path,headers={'Accept':'application/json'},method='GET')
        with urlopen(req,timeout=12) as res:
            obj=json.loads(res.read(65536))
            safe={'path':path,'http':res.status}
            if path=='health':
                safe['mode']=obj.get('mode')
            elif path=='price-test':
                safe['market']= [x.get('status') for x in obj.get('results',[])]
            elif path=='status':
                safe['heartbeatExists']=bool(obj.get('lastTick'))
                safe['feedError']=obj.get('lastError')
                safe['positions']=len(obj.get('openPositions',[]))
                safe['ordersEnabled']=obj.get('ordersEnabled')
            return safe
    except HTTPError as e:
        detail = e.read(300).decode('utf-8',errors='replace')
        reason = 'EGRESS_POLICY_DENY' if 'Forbidden: requests to' in detail else 'HTTP_ERROR_OTHER'
        return {'path':path,'http':e.code,'reason':reason}
    except (URLError,OSError,ValueError,TypeError):
        return {'path':path,'status':'NETWORK_OR_INVALID_JSON'}

if __name__=='__main__':
    for route in ('health','price-test','status'):
        print('PAPER_WORKER_SMOKE '+json.dumps(check(route),separators=(',',':')),flush=True)
    # Known existing Cloudflare Worker: unauthorized without token (401 expected).
    old=ROOT
    ROOT='https://cryptotrader-testnet-monitor.franklinsophia93.workers.dev'
    print('LEGACY_WORKER_CONTROL '+json.dumps(check('health'),separators=(',',':')),flush=True)
