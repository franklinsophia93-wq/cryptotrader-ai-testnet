# CryptoTrader AI — independent Render network probe

Development-only, strictly read-only. Does not trade, sign, or access account data. Public GET `/health` checks this process. GET `/diagnostico` makes one request to Binance **Spot Testnet** `/api/v3/time` and reports HTTP status without secrets.

This is only a connectivity check, **not a full robot**. Do not configure Binance keys here. Deploy separately from Orion. Render Free web services spin down when idle, so this does not prove 24/7 uptime. First verify external access is permitted and the provider service pricing before proceeding to the real backend.
