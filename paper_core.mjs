// Isolated virtual-only portfolio state machine; NO exchange order APIs.
import {summarizeCycles} from './paper_health.mjs';
export const PAIRS=['BTC-USD','ETH-USD'];
export const RULES=Object.freeze({fee:0.001,slip:0.0005,assetCap:0.20,totalCap:0.40,stop:0.03,target:0.06,dailyLoss:0.03,maxDrawdown:0.08});
export const freshState=(now)=>({version:1,mode:'PAPER_ONLY',source:'COINBASE_EXCHANGE_PUBLIC',
  initialUSD:10000,cashUSD:10000,positions:{},lastBar:{},lastPrices:{},journal:[],
  realizedUSD:0,completedTrades:0,winningTrades:0,
  day:new Date(now).toISOString().slice(0,10),dayStartEquity:10000,peakEquity:10000,
  lastTick:null,lastError:null,initializedAt:new Date(now).toISOString(),ordersEnabled:false});
const n=(v,d=8)=>Number(v.toFixed(d));
const nav=(s,quotes)=>s.cashUSD+Object.values(s.positions).reduce((v,p)=>{
  const price=quotes[p.symbol]?.price??s.lastPrices[p.symbol];
  return v+(price>0?p.quantity*price*(1-RULES.slip)*(1-RULES.fee):0);
},0);
const avg=(arr,len)=>arr.slice(-len).reduce((a,b)=>a+b,0)/len;
function validate(markets,now){
  if(!Array.isArray(markets)||markets.length!==2)throw Error('INCOMPLETE_MARKET_FEED');
  const q={};
  for(const m of markets){
    if(!PAIRS.includes(m.symbol)||q[m.symbol])throw Error('INVALID_SYMBOL');
    if(!(Number.isFinite(m.price)&&m.price>0&&Number.isFinite(m.tickerAt)&&
      m.tickerAt<=now+60000&&now-m.tickerAt<=300000))throw Error('STALE_TICKER');
    if(!Number.isSafeInteger(m.barTimestamp)||m.barTimestamp%3600000!==0||
      m.barTimestamp+3600000>now||now-m.barTimestamp>3*3600000)throw Error('STALE_CANDLES');
    if(!Array.isArray(m.closes)||m.closes.length<60||m.closes.some(p=>!(Number.isFinite(p)&&p>0)))throw Error('BAD_CANDLES');
    q[m.symbol]=m;
  }
  return q;
}
export function step(previous,markets,now){
  const s=structuredClone(previous??freshState(now));
  s.lastTick=new Date(now).toISOString();
  let quotes;
  try{quotes=validate(markets,now)}
  catch(e){s.lastError=String(e.message).slice(0,60);return s}
  s.lastError=null;
  for(const pair of PAIRS)s.lastPrices[pair]=quotes[pair].price;
  let equity=nav(s,quotes);
  const day=new Date(now).toISOString().slice(0,10);
  if(s.day!==day){s.day=day;s.dayStartEquity=n(equity)}
  s.peakEquity=Math.max(s.peakEquity,equity);
  const blocked=()=>equity<s.dayStartEquity*(1-RULES.dailyLoss)||
     equity<s.peakEquity*(1-RULES.maxDrawdown);
  const add=(record)=>{s.journal.push(record);if(s.journal.length>150)s.journal=s.journal.slice(-150)};
  const sell=(sym,p,quote,reason)=>{
    const fill=quote.price*(1-RULES.slip);
    const gross=p.quantity*fill,fees=gross*RULES.fee,net=gross-fees;
    s.cashUSD=n(s.cashUSD+net);
    const profit=net-p.entryCost;
    s.realizedUSD=n(s.realizedUSD+profit);
    s.completedTrades++;
    if(profit>0)s.winningTrades++;
    add({at:s.lastTick,side:'SELL',symbol:sym,price:n(fill),qty:n(p.quantity),feeUSD:n(fees),realizedUSD:n(profit),reason});
    delete s.positions[sym];
    equity=nav(s,quotes);
  };
  // Exits occur on every 5-minute tick, even if there isn't a new hourly candle.
  const exited=new Set();
  for(const sym of PAIRS){
    const p=s.positions[sym],q=quotes[sym];if(!p)continue;
    if(q.price<=p.entryPrice*(1-RULES.stop)){sell(sym,p,q,'STOP_LOSS');exited.add(sym)}
    else if(q.price>=p.entryPrice*(1+RULES.target)){sell(sym,p,q,'TAKE_PROFIT');exited.add(sym)}
  }
  for(const sym of PAIRS){
    const q=quotes[sym];
    if(s.lastBar[sym]===q.barTimestamp)continue; // idempotent entries / signal exits
    s.lastBar[sym]=q.barTimestamp;
    const fast=avg(q.closes,15),slow=avg(q.closes,40);
    const up=fast>slow;
    if(s.positions[sym]){
      if(!up){sell(sym,s.positions[sym],q,'TREND_EXIT');exited.add(sym)}
      continue;
    }
    if(!up||exited.has(sym)||blocked())continue;
    const currentExposure=Object.values(s.positions).reduce((a,p)=>a+p.quantity*quotes[p.symbol].price,0);
    const amount=Math.min(equity*RULES.assetCap,Math.max(0,equity*RULES.totalCap-currentExposure),s.cashUSD*0.90);
    if(amount<20)continue;
    const fill=q.price*(1+RULES.slip);
    const qty=amount/(fill*(1+RULES.fee));
    if(!(qty>0))continue;
    s.cashUSD=n(s.cashUSD-amount);
    s.positions[sym]={symbol:sym,entryPrice:n(fill),quantity:n(qty),entryCost:n(amount),openedAt:s.lastTick};
    add({at:s.lastTick,side:'BUY',symbol:sym,price:n(fill),qty:n(qty),feeUSD:n(qty*fill*RULES.fee),reason:'SMA15_GT_SMA40'});
    equity=nav(s,quotes);
  }
  s.equityUSD=n(equity,2);
  s.drawdownPct=n(100*Math.max(0,1-equity/s.peakEquity),2);
  s.dailyLossPct=n(100*Math.max(0,1-equity/s.dayStartEquity),2);
  s.newEntriesBlocked=blocked();
  s.cashUSD=n(s.cashUSD,2);
  return s;
}
export function publicView(previous){
 const s=previous??freshState(Date.now());
 return{mode:'PAPER_ONLY',source:s.source,stateInitialized:previous!=null,initializedAt:previous?s.initializedAt:null,lastTick:s.lastTick,
   lastError:s.lastError,initialUSD:s.initialUSD,cashUSD:s.cashUSD,
   equityUSD:s.equityUSD??s.cashUSD,drawdownPct:s.drawdownPct??0,
   dailyLossPct:s.dailyLossPct??0,newEntriesBlocked:s.newEntriesBlocked??false,
   openPositions:Object.values(s.positions),completedTrades:s.completedTrades,
   winningTrades:s.winningTrades,realizedUSD:s.realizedUSD,
   recentEvents:s.journal.slice(-25),cycleHealth:summarizeCycles(s.cycleMetrics,Date.now()),ordersEnabled:false,
   persistence:'CLOUDFLARE_DURABLE_OBJECT',monitorCadence:'EVERY_5_MINUTES_WHEN_SCHEDULED'};
}
