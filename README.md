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


## Persistent operational verification v3

The Cloudflare paper portfolio `/status` now includes a `cycleHealth` field. It is calculated from **successfully persisted scheduled executions**, not page visits or the worker's public HTTP health response.

- `totalCycles`, `successfulCycles`, `failedCycles` and `consecutiveFailures` are stored in the same Durable Object record as the fictional portfolio.
- `lastSuccessfulAt` and `lastFailedAt` expose UTC timestamps; `recentCycles` includes at most 12 recent cycle results with sanitized error codes.
- `missingIntervalsEstimate`, `maxGapMinutes` and `coveredHours` evaluate the 24-hour observational window. Duplicate triggers within 60 seconds are not double-counted.
- `fullDayVerified` is deliberately **false** until the recorded period spans essentially a full 24 hours with adequate sample count, zero feed failures and no scheduling gaps. A 200 response alone does not count as healthy market data.
- Historical cycles that took place before v3 are **not** fabricated into the new counters. Their logs remain separate evidence.

The virtual trading rules were not changed. The Cloudflare Cron Trigger is still configured at five-minute intervals; this is not a proof of 24/7 uptime or availability at every future moment. **No real-money or exchange-Testnet orders are implemented.**

For offline checks: `node --test paper_core.test.mjs paper_health.test.mjs`.


## Experimental strategy lab v3 — separate from Cloudflare paper engine

Read-only endpoint: GET /research/strategies-v3.

Compares four predefined LONG-ONLY spot strategies using the SAME completed historical Coinbase Exchange USD candles for BTC-USD and ETH-USD in 1h (~35 days) and 6h (~120 days):
1. Trend: SMA15 > SMA40, exit on reversal.
2. Mean reversion: previous close < SMA20 by at least 1% and RSI14 < 40; exit on recovery.
3. Breakout: last completed close above preceding 20-bar high with volume > 120% of preceding 20-bar average.
4. Range trading: prior 30-bar range width <= 12%, trend difference <=1.5%, recent close in its lower 30%; exit near midpoint or if sideways regime ends.

All four start independently with $5,000 fictitious cash and invest 25% of AVAILABLE CASH per entry, long-only. Rates include estimated fees 0.10% per side, slippage 0.05% per side, and fixed stop/target per strategy. Stop hits are assumed before targets when both occur in a bar; gaps can get worse fills. No leverage, shorts, real trades, Binance account, or keys.

Data split chronologically: first 70% for in-sample strategy comparison, last 30% for holdout. Strategy choice uses training results ONLY and requires at least three completed training trades. Each candidate's holdout result is shown but must NOT be used to reselect a winner. A 25%-allocated passive holdout benchmark with transaction costs is included. Holdout comparison is exploratory, not a guarantee or exhaustive walk-forward study.

Research caveats: OHLC fills are approximations; fees and slippage estimates; no order book, outage or funding costs; short history and selection bias remain. This does NOT trade continuously. The live Cloudflare virtual portfolio and SMA rules have NOT changed.

Run tests: python -m unittest discover -p 'test_*.py' -v.


## Frozen market-regime adaptive research v4 (independent Render endpoint)

`GET /research/adaptive-v4` runs a historical research-only evaluation of BTC-USD and ETH-USD on 1h and 6h completed Coinbase candles. **It never places any order and does not modify the existing Cloudflare paper portfolio.**

The market regime at each candle open is identified exclusively from earlier closed candles: UPTREND, DOWNTREND, SIDEWAYS, or HIGH_VOLATILITY. The selection is NOT machine learning: it is a deterministic, rule-based regime map.

For each asset/timeframe the first 70% of the candles provide training-only **completed** virtual trades for four previously defined strategies. Each regime may select a strategy only when that strategy has >=3 completed training trades attributed to that regime, a positive total after modeled transaction costs, and mean net return >0.20% per completed trade. Otherwise that regime maps to CASH and opens no positions.

The learned regime-to-strategy mapping is then **frozen** and replayed on the last 30% of candles without adaptation or looking at holdout results. A new entry uses the strategy of its current regime; an open position retains its original strategy's exit and risk rules. One long-only position per asset, 25% of available fictitious cash per entry. Historical approximations include fee 0.1%/side, slippage 0.05%/side, stop-loss, take-profit and conservative stop-before-target assumptions. Results are compared against a fixed in-sample-selected strategy and a 25%-allocated passive benchmark on the same holdout.

This is a **single historical holdout**. It is not prospective/live forward testing, fully rolling walk-forward, reliable predictive intelligence, or evidence of profitability. Sparse samples and selection bias can lead to cash-only or losing results. The already-running Cloudflare simulator is unaffected. Binance testnet and live orders remain disabled.

Offline: `python -m unittest discover -p 'test_*.py' -v`.


## Adaptive v4 prospective shadow observer (Cloudflare — isolated)

A separate Cloudflare Worker `cryptotrader-adaptive-shadow` and its own SQLite-backed Durable Object store are deployed. No changes are made to `cryptotrader-paper-engine`, its money balance, trading logic, monitoring, or Binance/Orion resources.

- `GET https://cryptotrader-adaptive-shadow.franklinsophia93.workers.dev/health`: process status only.
- `GET https://cryptotrader-adaptive-shadow.franklinsophia93.workers.dev/configuration`: immutable training-era regime mapping and modeled costs.
- `GET https://cryptotrader-adaptive-shadow.franklinsophia93.workers.dev/status`: durable forward-only observation status, market decisions, strictly fictitious portfolios, and recent entries/exits.
- Private Cron Trigger every 5 minutes. No public `/tick` or write endpoints. Data sources are **Coinbase Exchange public** BTC-USD and ETH-USD ticker plus completed 1h/6h candles. No API keys used.

Pre-selected strategy mappings, frozen from the experimental v4 training run before this prospective monitor's activation:
- BTC-USD 1h: DOWNTREND -> reversion, other regimes -> CASH.
- ETH-USD 1h: all regimes -> CASH.
- BTC-USD 6h: UPTREND -> trend; DOWNTREND -> reversion; SIDEWAYS -> breakout; HIGH_VOLATILITY -> CASH.
- ETH-USD 6h: UPTREND/HIGH_VOLATILITY -> trend; SIDEWAYS -> reversion; DOWNTREND -> CASH.

Each of the FOUR independent comparison accounts starts with **US$5,000 virtual USD** (US$20,000 total across scenarios, NOT linked to or transferred from the original US$10,000 Cloudflare paper account). It can hold at most one long-only position per market/timeframe, allocating 25% of available fictional cash. Entry triggers are considered only on a newly completed candle received promptly (<=15 minutes after close); exit/risk management can use subsequent fresh 5-minute snapshots. Fees 0.10% and slippage 0.05% per side, simulated stop/target per selected strategy; day loss guard 3% and peak drawdown guard 8% prevent **new entries**. Any incomplete/stale/missing market feed freezes **all** virtual fills for the cycle and logs a sanitized error.

**Prospective observations are not historical OHLC backtest fills**. Quotes are sampled every five minutes, so unobserved intratick price moves, order-book liquidity, spreads, platform downtime and slippage can make real fills substantially worse. Existing research strategy choices are fixed, no retraining occurs, and observation of future decisions starts with the first Cron cycle after deployment. A successful HTTP `/health` is not proof of market access, a prospective trading result, 24-hour reliability or profitability. The prior Binance Testnet HTTP 451 limitation persists for the unrelated original worker.

Safety: Worker contains no exchange trading route and no Binance/Cloudflare keys. Public endpoints expose **fictional** status only. The individual decision events are persisted in the separate Durable Object, capped to 300 recent events; this does not replace archival backups. Before any live trading, require much longer forward tests and independent risk review.

Tests: `node --test adaptive_shadow_core.test.mjs` (also included in GitHub Actions).


## Mobile dashboard for the adaptive forward-only monitor

The isolated Cloudflare Worker now exposes an additional **read-only** mobile-oriented HTML view:

- `GET https://cryptotrader-adaptive-shadow.franklinsophia93.workers.dev/dashboard` — Portuguese responsive status: last recorded cycle (Brasilia timezone), all four independent virtual account balances, open virtual positions, latest regime/decision, and recent events.
- `GET https://cryptotrader-adaptive-shadow.franklinsophia93.workers.dev/` — same dashboard.
- Existing `/status`, `/health`, and `/configuration` JSON routes remain unchanged.

The dashboard refreshes itself every 60 seconds, but **does not trigger trading or data collection**; only the existing five-minute Cron Trigger runs the market feed and virtual simulator. The dashboard does not provide buttons to place orders, configure credentials, or change the frozen strategy. A strict Content Security Policy blocks scripts and external resources. The UI shows a warning when the last successful record is more than eleven minutes old, and never claims 24-hour validation on a page-view alone.

Scheduled execution logs now contain anonymized aggregate counts of open virtual positions, closed virtual trades, processed decisions and last known reason codes for each scenario. They do not include API keys or actual orders. The fixed strategy map, Durable Object ID, stored state, and order-disabled guard are unchanged.

Run `node --test adaptive_shadow_core.test.mjs adaptive_shadow_dashboard.test.mjs`.


## Shadow v4 financial audit and equal-start paired forward benchmark

The isolated Cloudflare Worker `cryptotrader-adaptive-shadow` now adds read-only fields to `/status`: `financialAudit` and `recentClosedTrades`. They separate realized P&L from unrealized P&L (liquidation-equivalent value of the one open virtual position per account), with a total account and cross-account view. Per-side simulated costs are 0.10% fees and 0.05% slippage. Historic fees are **reconstructed estimates from rounded virtual events**, not actual Binance or Coinbase invoices. Historical events may be truncated by the 300-event rolling window; an unmatched sale is reported as such rather than inventing an entry.

An independent **prospective paired** benchmark now begins at its own first successful five-minute feed after deployment. This does not modify the original four `shadow` portfolios nor the frozen regime mapping. It creates TWO NEW ARMS, each containing four independently funded US$5,000 virtual accounts (US$20,000 per arm):
- `adaptive`: frozen regime-to-strategy selection from v4.
- `fixed`: frozen training-selected v3 benchmark (`BTC-USD|1h` reversion, `ETH-USD|1h` breakout, `BTC-USD|6h` breakout, `ETH-USD|6h` reversion).

Both arms start simultaneously with ZERO open positions and no retrospective fills, observe the **same** future public Coinbase quotes and completed candles, and apply the same modeled fees/slippage, 25% per-entry sizing, long-only constraints, stop/target risk controls, and three percent daily/eight percent peak drawdown entry guards. They do **not** share cash with the pre-existing live paper account. `pairedComparison` in `/status` and the mobile `/dashboard` show per-arm portfolio equity, cumulative return and closed trades for the **aligned forward period only**. A skipped feed leaves both paired arms unchanged. It is inappropriate to compare the new paired arm's performance with returns from a different earlier start date.

Use `node --test adaptive_shadow_audit.test.mjs` and existing CI. Only completed future trades and adequate sample sizes can support meaningful conclusions. The original Cloudflare `cryptotrader-paper-engine`, Binance keys, real orders, and Orion remain unchanged.


## Strict rolling 24-hour certification for the forward-only shadow

`GET /status` now includes `health24h`, calculated from the persisted timestamps and health flags of the **actual scheduled cycles**, rather than from cumulative counters. The mobile `/dashboard` shows recorded hours, healthy/failed checks, missing intervals, and certification state. Each successful or failed scheduled cycle retains one entry in a rolling 340-cycle history (about 28 hours 20 minutes at the intended 5-minute cadence).

Certification requires a full 24-hour window of recorded checks with at least 287 qualifying 5-minute observations, no failed entries, no intervals greater than 7.5 minutes, and a last observation at most 11 minutes old. Missing cycles and stale data fail closed. Prior timestamps discarded under the old 24-entry retention are NOT reconstructed; the system must accumulate fresh evidence and may not immediately show certification after this upgrade.

**Operational** 24-hour certification is not a profitability guarantee, a market-data completeness guarantee, exchange execution proof, a fee quote, or approval for real trading. The comparison and the original four virtual portfolios keep their existing independent state; no strategy mapping, position, real order, or account credential is modified by this addition.

Tests: `node --test adaptive_shadow_24h.test.mjs`. CI verifies missing cycles, a failed cycle, staleness, recovery after old failures leave the window, and retention.


## Forward comparison research-maturity guard

The isolated Shadow v4 Worker now exposes an additional **read-only** `researchMaturity` field under `/status` and a companion section in `/dashboard`. It assesses *whether there is enough prospective evidence to request human research review*. It never grants trading permissions, promotes a strategy, changes virtual orders, or alters stored portfolios.

Conservative minimums (all required): >=30 calendar days elapsed from the simultaneous paired benchmark start to its last recorded tick; >=30 completed virtual trades per paired arm (fixed AND adaptive); rolling 24-hour operational verification; latest paired tick <=11 minutes old; no skipped paired cycles. Underlying net result is shown after modeled fees/slippage but even passing these gates does **not** demonstrate statistical significance or validate real execution. Sample-size thresholds are research policy, not a guarantee of validity.

Status values include NOT_STARTED, INSUFFICIENT_FORWARD_DAYS, INSUFFICIENT_CLOSED_TRADES, OPERATIONAL_24H_NOT_VERIFIED, DATA_NOT_RECENT, PAIRED_CYCLES_SKIPPED, or READY_FOR_MANUAL_RESEARCH_REVIEW. The final status is **not** approval to trade with money. It is intentionally normal for the comparison to remain 'insufficient' for weeks or months, especially when frozen mappings choose CASH.

Automated checks: `node --test adaptive_shadow_readiness.test.mjs`. This is research-only and has no Binance keys or order endpoints.
