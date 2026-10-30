// New paired forward comparison starts at activation; no backfilled orders or retroactive entries.
// Independent simulated accounts, one adaptive and one fixed strategy per market/timeframe.
import {CONFIG,KEYS,classify,decide} from './adaptive_shadow_core.mjs';
export const FROZEN_FIXED=Object.freeze({'BTC-USD|1h':'reversion','ETH-USD|1h':'breakout',
  'BTC-USD|6h':'breakout','ETH-USD|6h':'reversion'});
const round=(n,d=6)=>Number(n.toFixed(d));
const iso=n=>new Date(n).toISOString();
const mark=(p,price)=>p.cashUSD+(p.position?p.position.quantity*price*(1-CONFIG.slippage)*(1-CONFIG.fee):0);
function newAccount(bar){return{cashUSD:5000,equityUSD:5000,peakEquityUSD:5000,
  position:null,lastClosedBar:bar,day:null,dayStartEquityUSD:5000,
  closedTrades:0,wins:0,realizedUSD:0,decisions:0,blockedEntries:false};}
export function startPaired(feeds,now){
 const tickers=Object.fromEntries(feeds.map(f=>[f.key,f]));
 if(KEYS.some(k=>!tickers[k]||!tickers[k].bars?.length))throw Error('MISSING_FEEDS');
 const portfolios={adaptive:{},fixed:{}};
 for(const arm of ['adaptive','fixed'])
  for(const k of KEYS)portfolios[arm][k]=newAccount(tickers[k].bars.at(-1).t);
 return{version:'fixed-v3-versus-adaptive-v4-prospective',startedAt:iso(now),
  lastTick:iso(now),cycles:1,skippedCycles:0,events:[],portfolios};
}
function recompute(p,price,now){
 const equity=mark(p,price),day=iso(now).slice(0,10);
 if(day!==p.day){p.day=day;p.dayStartEquityUSD=equity;}
 p.equityUSD=round(equity,2);p.peakEquityUSD=Math.max(p.peakEquityUSD,equity);
 p.blockedEntries=equity<p.dayStartEquityUSD*(1-CONFIG.dailyLoss)
  ||equity<p.peakEquityUSD*(1-CONFIG.peakDrawdown);
}
function advanceOne(p,feed,key,arm,events,now){
 const current=feed.bars.at(-1).t,ms=CONFIG.timeframeMs[key.split('|')[1]];
 const price=feed.price,at=iso(now);let justClosed=false;
 const close=reason=>{
  const position=p.position;
  const proceeds=position.quantity*price*(1-CONFIG.slippage)*(1-CONFIG.fee);
  const gain=proceeds-position.costUSD;
  p.cashUSD=round(p.cashUSD+proceeds);p.realizedUSD=round(p.realizedUSD+gain);
  p.closedTrades++;p.wins+=gain>0?1:0;
  events.push({at,key,arm,type:'CLOSE',reason,strategy:position.strategy,netUSD:round(gain,2)});
  p.position=null;justClosed=true;
 };
 recompute(p,price,now);
 if(p.position){
  const [stop,target]=CONFIG.stops[p.position.strategy];
  if(price<=p.position.entryPrice*(1-stop))close('TICK_STOP');
  else if(price>=p.position.entryPrice*(1+target))close('TICK_TARGET');
 }
 if(current>p.lastClosedBar){
  if(p.position && decide(feed.bars,p.position.strategy).exit)close('CLOSED_BAR_EXIT');
  p.lastClosedBar=current;p.decisions++;
  const regime=classify(feed.bars);
  const selected=arm==='adaptive'?CONFIG.mapping[key][regime]:FROZEN_FIXED[key];
  const eligible=selected?decide(feed.bars,selected).enter:false;
  const timely=now-(current+ms)<=15*60000;
  const reason=justClosed?'CLOSED_SAME_TICK':p.position?'POSITION_OPEN':
    !timely?'BAR_TOO_OLD':p.blockedEntries?'RISK_GUARD':
    !selected?'FROZEN_CASH':!eligible?'NO_ENTRY_SIGNAL':'ELIGIBLE';
  events.push({at,key,arm,type:'DECISION',strategy:selected||'CASH',regime,reason});
  if(reason==='ELIGIBLE'){
   const cost=p.cashUSD*CONFIG.size;
   if(cost>=1){
    const fill=price*(1+CONFIG.slippage),quantity=cost/(fill*(1+CONFIG.fee));
    p.cashUSD=round(p.cashUSD-cost);
    p.position={strategy:selected,regime,quantity,entryPrice:fill,costUSD:cost,at};
    events.push({at,key,arm,type:'OPEN',strategy:selected,regime,allocationUSD:round(cost,2)});
   }
  }
 }
 recompute(p,price,now);
}
export function advancePaired(previous,feeds,now){
 if(!Number.isFinite(now)||!Array.isArray(feeds)||feeds.length!==KEYS.length)throw Error('BAD_FEED');
 const byKey=Object.fromEntries(feeds.map(f=>[f.key,f]));
 if(KEYS.some(k=>!byKey[k]||!Array.isArray(byKey[k].bars)||byKey[k].bars.length<70))throw Error('BAD_FEED');
 if(!previous)return startPaired(feeds,now);
 const s=structuredClone(previous);
 for(const key of KEYS){
  for(const arm of ['adaptive','fixed']){
   const p=s.portfolios[arm]?.[key];
   if(!p || byKey[key].bars.at(-1).t<p.lastClosedBar)throw Error('REGRESSED_BAR');
  }
 }
 s.cycles++;s.lastTick=iso(now);
 for(const arm of ['adaptive','fixed'])for(const key of KEYS)
  advanceOne(s.portfolios[arm][key],byKey[key],key,arm,s.events,now);
 s.events=s.events.slice(-120);
 return s;
}
export function skippedPaired(prev){
 if(!prev)return null;
 const s=structuredClone(prev);s.skippedCycles=(s.skippedCycles||0)+1;return s;
}
export function summarizePaired(paired){
 if(!paired)return{initialized:false,comparisonStatus:'WAITING_FIRST_HEALTHY_FEED',
  ordersEnabled:false,note:'Paired accounts will begin at zero trades after activation; no backfill.'};
 const arms={};
 for(const name of ['adaptive','fixed']){
  const accounts={},items=[];
  for(const key of KEYS){
   const p=paired.portfolios[name][key];
   const a={equityUSD:p.equityUSD,netResultUSD:round(p.equityUSD-5000,2),
     realizedUSD:round(p.realizedUSD,2),openPosition:Boolean(p.position),
     completedTrades:p.closedTrades,decisions:p.decisions};
   accounts[key]=a;items.push(a);
  }
  arms[name]={totalEquityUSD:round(items.reduce((n,x)=>n+x.equityUSD,0),2),
    netResultUSD:round(items.reduce((n,x)=>n+x.netResultUSD,0),2),
    completedTrades:items.reduce((n,x)=>n+x.completedTrades,0),accounts};
 }
 return{initialized:true,startedAt:paired.startedAt,lastTick:paired.lastTick,
  cycles:paired.cycles,skippedCycles:paired.skippedCycles,mode:'PROSPECTIVE_PAIRED_PAPER',
  fixedSelection:FROZEN_FIXED,arms,
  latestEvents:paired.events.slice(-12).reverse(),ordersEnabled:false,
  methodology:'Two NEW virtual arms initialized together after deployment, both initially cash-only. Same tick data, 25% allocation, fees, slippage, stops, and risk guards. Independent accounts; not historical backfill or the pre-existing live portfolio.'};
}