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


## New: comparative historical research v2

`GET /research/validation-v2` is a **read-only** chronological train/holdout evaluation. For each Coinbase BTC-USD / ETH-USD series at 1h (~35 days) and 6h (~120 days), it requests closed candles in chunks of 240 bars (maximum 300 per Coinbase request). Gaps, duplicate conflicts, malformed prices and still-open candles are rejected. The first 70% of bars is used only for training/selection, and the last 30% is evaluated after selecting one of three preset long-only strategies: SMA 15/40, SMA 20/60, or 20-bar mean reversion. A qualifying sample requires at least two in-sample trades. Each asset starts with a separate virtual $5,000 bucket; at most 30% of remaining cash is invested on entry, with 0.10% fee and 0.05% slippage each side and conservative stop-before-target assumptions. The selected strategy is also compared against a passive buy-and-hold benchmark **on the holdout period**.

This single chronological holdout is **not** a rolling walk-forward study, machine learning, a live simulation, or evidence of durable profitability. The short time windows, simplified OHLCV fills and training-selection bias require substantial further testing. No account keys or real/paper orders are used. The service can sleep on the Render Free plan. Binance access remains restricted by HTTP 451 from this server.

Tests: `python -m unittest discover -p 'test_*.py' -v`.


## Cloudflare persistent paper simulation (independent Worker)

A separate Cloudflare Worker named `cryptotrader-paper-engine` is deployed alongside, **not replacing**, the original Binance Testnet monitor or Orion website.

- GET `https://cryptotrader-paper-engine.franklinsophia93.workers.dev/health`: service information only
- GET `https://cryptotrader-paper-engine.franklinsophia93.workers.dev/price-test`: Coinbase BTC-USD and ETH-USD public ticker/candle connectivity test
- GET `https://cryptotrader-paper-engine.franklinsophia93.workers.dev/status`: **publicly visible** sanitized **fictional** portfolio status (no Binance credentials or live order data)
- `*/5 * * * *` Cloudflare UTC Cron Trigger calls the internal Durable Object `PaperPortfolio` and stores one atomic portfolio snapshot in Durable Object storage.
- Strict `PAPER_ONLY` mode: every buy/sell exists only in storage, no Coinbase or Binance order API or authorization credentials. Initial fictional balance US$10,000. BTC and ETH may be open simultaneously, one position per symbol. At most 20% virtual equity per asset and 40% total nominal exposure, 3% simulated stop, 6% target, 3% daily loss and 8% peak drawdown gate. Simulated 0.1% per-side fee and 0.05% per-side slippage. Maximum 150 persisted events.
- Idempotency via last completed hourly candle per symbol, but stop/target checks use the fresh ticker on every successful 5-minute tick.
- No candles or ticker => **no simulated orders**. The service tracks a feed error instead of inventing fills.

**Important:** Although the Worker, schedule and Durable Object binding are configured, live ingestion, persisted virtual transactions and 24-hour uptime are **not yet certified**. Cron changes can take up to 15 minutes to propagate. Tests are unit tests, not 24-hour operational verification. Public endpoint checks from Render and GitHub Actions currently receive HTTP 403; a mobile-browser check may help distinguish network restrictions.

Paper trading based on Coinbase USD data is **not** Binance Testnet trading. The blocked Binance credentials remain on the separate original Worker and are never copied into this Worker.
