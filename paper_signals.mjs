// Read-only snapshot explanations; NEVER place orders or mutate the portfolio.
const average = (prices,n) => prices.slice(-n).reduce((a,b)=>a+b,0)/n;
const round = x => Number(x.toFixed(4));

export function explainMarketSignal(market, portfolio={}) {
  const sym=market?.symbol;
  if (!['BTC-USD','ETH-USD'].includes(sym) ||
      !Array.isArray(market?.closes) || market.closes.length<60 ||
      market.closes.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<=0)) {
    return {symbol:sym||'UNKNOWN',status:'DATA_UNAVAILABLE',buySignal:false};
  }
  const sma15=average(market.closes,15),sma40=average(market.closes,40);
  const bullish=sma15>sma40;
  const alreadyOpen=(portfolio.openPositions||[]).some(p=>p.symbol===sym);
  const riskBlocked=portfolio.newEntriesBlocked===true;
  const reason=alreadyOpen?'POSITION_ALREADY_OPEN':
               riskBlocked?'RISK_LIMIT':
               bullish?'BULLISH_TREND_WAIT_FOR_NEXT_ELIGIBLE_HOURLY_CYCLE':
                       'NO_BULLISH_TREND_SMA15_AT_OR_BELOW_SMA40';
  return {
    symbol:sym,status:'OK',closedCandleUTC:new Date(market.barTimestamp+3600000).toISOString(),
    sma15:round(sma15),sma40:round(sma40),trendDifferencePct:round(100*(sma15/sma40-1)),
    bullishTrend:bullish,buySignal:bullish&&!riskBlocked&&!alreadyOpen,
    reason,ordersEnabled:false
  };
}
