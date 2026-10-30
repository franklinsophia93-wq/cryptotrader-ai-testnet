// Immutable v4 training selections, frozen before this forward observation begins.
// Coinbase public USD quotes only. Virtual fills only; NEVER requests an exchange order.
export const CONFIG=Object.freeze({
  version:'adaptive-v4-frozen-2026-10-30',
  fee:0.001, slippage:0.0005, size:0.25, dailyLoss:0.03, peakDrawdown:0.08,
  mapping:{
    'BTC-USD|1h':{HIGH_VOLATILITY:null,UPTREND:null,DOWNTREND:'reversion',SIDEWAYS:null},
    'ETH-USD|1h':{HIGH_VOLATILITY:null,UPTREND:null,DOWNTREND:null,SIDEWAYS:null},
    'BTC-USD|6h':{HIGH_VOLATILITY:null,UPTREND:'trend',DOWNTREND:'reversion',SIDEWAYS:'breakout'},
    'ETH-USD|6h':{HIGH_VOLATILITY:'trend',UPTREND:'trend',DOWNTREND:null,SIDEWAYS:'reversion'}
  },
  stops:{trend:[.03,.06],reversion:[.02,.035],breakout:[.03,.07],range:[.02,.03]},
  timeframeMs:{'1h':3600000,'6h':21600000}
});
export const KEYS=Object.keys(CONFIG.mapping);
const safe=(n,d=6)=>Number(n.toFixed(d));
const sma=(a,n)=>a.slice(-n).reduce((x,y)=>x+y,0)/n;
const stamp=t=>new Date(t).toISOString();
function rsi(a,n=14){
 let gains=0,loss=0;
 for(let i=a.length-n;i<a.length;i++){
  const delta=a[i]-a[i-1];gains+=Math.max(0,delta);loss+=Math.max(0,-delta);
 }
 if(loss===0)return gains>0?100:50;
 return 100-100/(1+gains/loss);
}
export function classify(bars){
 if(!Array.isArray(bars)||bars.length<70)throw Error('INSUFFICIENT_CANDLES');
 const closes=bars.slice(-61).map(x=>x.close);
 const changes=closes.slice(1).map((p,i)=>Math.abs(Math.log(p/closes[i])));
 const recent=sma(changes,20), baseline=sma(changes,60);
 if(baseline>=.002&&recent>1.7*baseline&&recent>.007)return'HIGH_VOLATILITY';
 const spread=sma(closes,15)/sma(closes,40)-1;
 return spread>.007?'UPTREND':spread<-.007?'DOWNTREND':'SIDEWAYS';
}
export function decide(bars,strategy){
 if(!Object.hasOwn(CONFIG.stops,strategy)||bars.length<70)throw Error('INVALID_STRATEGY');
 const closes=bars.map(x=>x.close), prev=closes.at(-1),ma20=sma(closes,20);
 if(strategy==='trend'){const up=sma(closes,15)>sma(closes,40);return{enter:up,exit:!up}}
 if(strategy==='reversion'){const strength=rsi(closes);return{enter:prev<ma20*.99&&strength<40,exit:prev>=ma20||strength>60}}
 if(strategy==='breakout'){
  const preceding=bars.slice(-21,-1),v=sma(preceding.map(x=>x.volume),20);
  return{enter:prev>Math.max(...preceding.map(x=>x.high))&&v>0&&bars.at(-1).volume>v*1.2,
         exit:prev<Math.min(...bars.slice(-10,-1).map(x=>x.low))}
 }
 const window=bars.slice(-30),lo=Math.min(...window.map(x=>x.low)),hi=Math.max(...window.map(x=>x.high));
 const sideways=hi/lo-1<=.12&&Math.abs(sma(closes,15)/sma(closes,40)-1)<=.015;
 return{enter:sideways&&prev<lo+.3*(hi-lo),exit:prev>=lo+.6*(hi-lo)||!sideways};
}
export function blank(now){
 return{version:CONFIG.version,startedAt:stamp(now),mode:'SHADOW_FORWARD_ONLY',
  source:'COINBASE_EXCHANGE_PUBLIC',lastTick:null,lastError:null,
  cycles:{total:0,healthy:0,failed:0,mostRecent:[]},events:[],
  portfolios:Object.fromEntries(KEYS.map(key=>[key,{
   cashUSD:5000,equityUSD:5000,position:null,peakEquity:5000,day:stamp(now).slice(0,10),
   dayStartEquity:5000,lastProcessedClosedBar:null,realizedUSD:0,trades:0,wins:0,
   decisions:0,latestDecision:null,blockedEntries:false
  }]))};
}
function freshFeed(f,now){
 if(!f||typeof f!=='object'||!KEYS.includes(f.key))throw Error('INVALID_MARKET');
 const ms=CONFIG.timeframeMs[f.key.split('|')[1]];
 if(!(Number.isFinite(f.price)&&f.price>0&&Number.isFinite(f.tickerAt)
      &&f.tickerAt<=now+60000&&now-f.tickerAt<=300000))throw Error('STALE_TICKER');
 if(!Array.isArray(f.bars)||f.bars.length<70)throw Error('INSUFFICIENT_CANDLES');
 for(let i=0;i<f.bars.length;i++){
  const b=f.bars[i];
  if(!Number.isSafeInteger(b.t)||b.t%ms!==0||![b.low,b.high,b.open,b.close,b.volume].every(Number.isFinite)
      ||b.low<=0||b.volume<0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close))
      throw Error('INVALID_CANDLES');
  if(i&&b.t-f.bars[i-1].t!==ms)throw Error('GAPPED_CANDLES');
 }
 const last=f.bars.at(-1).t;
 if(last+ms>now||now-(last+ms)>ms+600000)throw Error('INVALID_CANDLE_AGE');
 return ms;
}
const pnlAt=(p,price)=>p.quantity*price*(1-CONFIG.slippage)*(1-CONFIG.fee);
function recompute(p,price,now){
 const eq=p.cashUSD+(p.position?pnlAt(p.position,price):0);
 const day=stamp(now).slice(0,10);
 if(p.day!==day){p.day=day;p.dayStartEquity=eq}
 p.equityUSD=safe(eq,2);
 p.peakEquity=Math.max(p.peakEquity,eq);
 p.blockedEntries=eq<p.dayStartEquity*(1-CONFIG.dailyLoss)||eq<p.peakEquity*(1-CONFIG.peakDrawdown);
}
function record(s,e){s.events.push(e);if(s.events.length>300)s.events=s.events.slice(-300)}
export function applyTick(previous,feeds,now){
 if(!Number.isFinite(now))throw Error('INVALID_TIME');
 const s=structuredClone(previous??blank(now));
 s.lastTick=stamp(now);
 s.cycles.total++;
 let checks={};
 try{
  if(!Array.isArray(feeds)||feeds.length!==KEYS.length)throw Error('INCOMPLETE_FEED');
  for(const f of feeds){
   if(checks[f.key])throw Error('DUPLICATE_MARKET');
   checks[f.key]=freshFeed(f,now);
  }
  if(KEYS.some(k=>!checks[k]))throw Error('INCOMPLETE_FEED');
  for(const feed of feeds){
   const last=s.portfolios[feed.key]?.lastProcessedClosedBar;
   if(last!=null&&feed.bars.at(-1).t<last)throw Error('REGRESSED_BAR');
  }
 }catch(e){
  s.lastError=String(e.message).slice(0,36);
  s.cycles.failed++;
  s.cycles.mostRecent.push({at:s.lastTick,healthy:false,error:s.lastError});
  s.cycles.mostRecent=s.cycles.mostRecent.slice(-340);
  return s; // all-or-nothing; no fills on bad feed
 }
 s.lastError=null;s.cycles.healthy++;
 s.cycles.mostRecent.push({at:s.lastTick,healthy:true});
 s.cycles.mostRecent=s.cycles.mostRecent.slice(-340);
 for(const feed of feeds){
  const p=s.portfolios[feed.key], ms=checks[feed.key];
  recompute(p,feed.price,now);
  let justClosed=false;
  const close=(reason)=>{
   const pos=p.position;
   const net=pnlAt(pos,feed.price),profit=net-pos.costUSD;
   p.cashUSD=safe(p.cashUSD+net);p.realizedUSD=safe(p.realizedUSD+profit);
   p.trades++;if(profit>0)p.wins++;
   record(s,{at:s.lastTick,key:feed.key,type:'VIRTUAL_SELL',strategy:pos.strategy,
    regime:pos.regime,quantity:safe(pos.quantity,9),price:safe(feed.price*(1-CONFIG.slippage)),
    realizedUSD:safe(profit,2),reason});
   p.position=null;justClosed=true;
  };
  if(p.position){
   const pos=p.position,[stop,target]=CONFIG.stops[pos.strategy];
   if(feed.price<=pos.entryPrice*(1-stop))close('TICK_STOP');
   else if(feed.price>=pos.entryPrice*(1+target))close('TICK_TARGET');
  }
  const lastBar=feed.bars.at(-1).t;
  if(p.lastProcessedClosedBar!==lastBar){
   p.lastProcessedClosedBar=lastBar;
   const regime=classify(feed.bars),chosen=CONFIG.mapping[feed.key][regime];
   if(p.position){
    if(decide(feed.bars,p.position.strategy).exit)close('CLOSED_BAR_EXIT');
   }
   const qualified=chosen?decide(feed.bars,chosen).enter:false;
   const recent=(now-(lastBar+ms))<=15*60000;
   const reason=justClosed?'CLOSED_SAME_TICK':p.position?'POSITION_OPEN':
         !recent?'BAR_TOO_OLD':p.blockedEntries?'RISK_GUARD':
         !chosen?'FROZEN_CASH':!qualified?'NO_ENTRY_SIGNAL':'ELIGIBLE';
   p.decisions++;
   p.latestDecision={at:s.lastTick,closedBarAt:stamp(lastBar+ms),
     regime,chosenStrategy:chosen??'CASH',qualified,reason};
   record(s,{at:s.lastTick,key:feed.key,type:'DECISION',
     closedBarAt:stamp(lastBar+ms),regime,strategy:chosen??'CASH',reason});
   if(reason==='ELIGIBLE'){
    const budget=p.cashUSD*CONFIG.size;
    if(budget>=1){
     const fill=feed.price*(1+CONFIG.slippage);
     const qty=budget/(fill*(1+CONFIG.fee));
     p.cashUSD=safe(p.cashUSD-budget);
     p.position={strategy:chosen,regime,quantity:qty,entryPrice:fill,costUSD:budget,
       openedAt:s.lastTick,closedBarAt:stamp(lastBar+ms)};
     record(s,{at:s.lastTick,key:feed.key,type:'VIRTUAL_BUY',
       strategy:chosen,regime,quantity:safe(qty,9),price:safe(fill),allocatedUSD:safe(budget,2)});
    }
   }
  }
  recompute(p,feed.price,now);
 }
 return s;
}
export function failedTick(previous,now,reason='MARKET_UNAVAILABLE'){
 const s=structuredClone(previous??blank(now));
 s.lastTick=stamp(now);
 const safeReason=/^(HTTP_[0-9]{3}_(BTC|ETH)_(TICKER|CANDLES_[16]H)|DATA_UNAVAILABLE|MISSING_CANDLES|INVALID_CANDLES|GAPPED_CANDLES|STALE_TICKER|INVALID_CANDLE_AGE|NETWORK_UNAVAILABLE)$/.test(String(reason))?reason:'MARKET_UNAVAILABLE';
 s.lastError=safeReason;
 s.cycles.total++;s.cycles.failed++;
 s.cycles.mostRecent.push({at:s.lastTick,healthy:false,error:safeReason});
 s.cycles.mostRecent=s.cycles.mostRecent.slice(-340);
 return s;
}
export function status(s){
 if(!s)return{mode:'SHADOW_FORWARD_ONLY',initialized:false,ordersEnabled:false,
  description:'No scheduled cycle recorded yet'};
 return{mode:s.mode,initialized:true,startedAt:s.startedAt,lastTick:s.lastTick,
  lastError:s.lastError,source:s.source,frozenSelectionVersion:s.version,
  ordersEnabled:false,binanceAuthenticated:false,
  cycles:s.cycles,portfolios:Object.fromEntries(KEYS.map(k=>[k,{
   cashUSD:s.portfolios[k].cashUSD,equityUSD:s.portfolios[k].equityUSD,
   openPosition:s.portfolios[k].position?{...s.portfolios[k].position,quantity:safe(s.portfolios[k].position.quantity,9)}:null,
   realizedUSD:s.portfolios[k].realizedUSD,closedTrades:s.portfolios[k].trades,
   winningTrades:s.portfolios[k].wins,latestDecision:s.portfolios[k].latestDecision,
   processedClosedBars:s.portfolios[k].decisions,blockedEntries:s.portfolios[k].blockedEntries
  }])),
  recentEvents:s.events.slice(-30),notes:'These are only forward fictional fills at sampled tick prices; no exchange orders. Exposure and results not directly comparable to historical OHLC replay.'};
}
