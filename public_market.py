"""Independent, public market-data probe. No credentials and no trading."""
import json
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_ALLOWED = {
    "BTC-USD": "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
    "ETH-USD": "https://api.exchange.coinbase.com/products/ETH-USD/ticker",
}

def market_probe(symbol, timeout=7, now=None):
    if symbol not in _ALLOWED:
        raise ValueError("Unsupported symbol")
    try:
        request = Request(_ALLOWED[symbol], headers={
            "User-Agent": "CryptoTraderResearch/1.0 (read-only)",
            "Accept": "application/json"
        }, method="GET")
        with urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                return {"symbol": symbol, "status": "INVALID_HTTP_RESPONSE"}
            data = json.loads(response.read(4096))
        price = float(data["price"])
        if not (0 < price < 1e12):
            raise ValueError("Invalid price")
        stamp = datetime.fromisoformat(str(data["time"]).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("Time without timezone")
        age = ((now or datetime.now(timezone.utc)) - stamp).total_seconds()
        if age < -60 or age > 300:
            return {"symbol": symbol, "status": "STALE", "ageSeconds": round(age)}
        return {
            "symbol": symbol, "status": "FRESH",
            "priceUSD": round(price, 2), "sourceTime": stamp.isoformat()
        }
    except HTTPError as exc:
        return {"symbol": symbol, "status": "HTTP_ERROR", "httpStatus": exc.code}
    except (URLError, TimeoutError, OSError):
        return {"symbol": symbol, "status": "NETWORK_ERROR"}
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, OverflowError):
        return {"symbol": symbol, "status": "INVALID_RESPONSE"}

def public_market_check():
    rows = [market_probe(s) for s in ("BTC-USD", "ETH-USD")]
    return {
        "source": "COINBASE_EXCHANGE_PUBLIC",
        "currency": "USD",
        "purpose": "RESEARCH_ONLY_NOT_BINANCE",
        "healthy": all(r["status"] == "FRESH" for r in rows),
        "symbols": rows,
        "binanceAuthenticated": False,
        "ordersEnabled": False,
    }
