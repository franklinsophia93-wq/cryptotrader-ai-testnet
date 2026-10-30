# CryptoTrader AI — isolated diagnostics and exploratory research

This public repository contains **only** a read-only network diagnostic and a historical market-data simulation. It does not contain the full CryptoTrader AI engine, API keys, user balances or any ability to place Binance orders.

## Live endpoints on Render

- `GET /health` — process alive, not proof that Binance is reachable.
- `GET /diagnostico` — public Binance Spot Testnet time endpoint, **unauthenticated**.
- `GET /market-check` — public Coinbase Exchange BTC-USD and ETH-USD tickers.
- `GET /research/backtest` — historical, stateless two-asset replay using up to 200 *completed* Coinbase hourly candles per asset. Long-only SMA(15)/SMA(40), at most one position per asset, with a per-position virtual cash bucket of $5,000, 0.1% simulated fee per side, 0.05% simulated slippage per side, 2% stop and 4% target. Simulation includes end-window liquidation and uses only earlier closed candles for entry signals.

Historical replay is **not** live paper trading, a forward test, an approved strategy, a prediction, or proof of profitability. Drawdown is estimated at candle closes and can understate intrabar losses. Fees/slippage are estimates. Real market data is quoted in USD from Coinbase, **not** USDT from Binance. The data window is short and not suitable for selecting strategies for real money.

The Render Free tier can suspend an idle web service; it does **not** provide guaranteed 24/7 execution. All order submission is intentionally absent; no Binance keys should be configured in this service.

## Tests

```sh
python -m unittest discover -p 'test_*.py' -v
```

Keep this service separate from the Orion website. A legal/geographical access refusal such as HTTP 451 from Binance is not solved by using Coinbase market data.
