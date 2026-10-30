// Isolated forward-only v4 shadow observer on Coinbase public data.
// No API keys, no trading endpoints, no interaction with other Cloudflare Workers.
import {DurableObject} from 'cloudflare:workers';
import {CONFIG, KEYS, blank, applyTick, failedTick, status} from './adaptive_shadow_core.mjs';
import {renderDashboard} from './adaptive_shadow_dashboard.mjs';
import {deriveFinancials,reconstructTrades} from './adaptive_shadow_audit.mjs';
import {advancePaired,skippedPaired,summarizePaired} from './adaptive_paired_forward.mjs';
const BASE='https://api.exchange.coinbase.com/products/';
const response=(body,statusCode=200)=>new Response(JSON.stringify(body),{status:statusCode,headers:{
 'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'
}});
async function getJSON(url,key,stage){
 try{
  const r=await fetch(url,{method:'GET',headers:{accept:'application/json'},
    redirect:'manual',signal:AbortSignal.timeout(8000)});
  if(!r.ok){const [symbol,tf]=key.split('|');
   throw Error('HTTP_'+r.status+'_'+symbol.split('-')[0]+'_'+(stage==='TICKER'?'TICKER':'CANDLES_'+tf.toUpperCase()));}
  return await r.json();
 }catch(e){
  if(/^HTTP_[0-9]{3}_(BTC|ETH)_(TICKER|CANDLES_[16]H)$/.test(String(e?.message)))throw e;
  throw Error('NETWORK_UNAVAILABLE');
 }
}
async function collect(key,now,ticker){
 const [symbol,tf]=key.split('|');
 const interval=CONFIG.timeframeMs[tf],seconds=interval/1000;
 const raw=await getJSON(BASE+symbol+'/candles?granularity='+seconds,key,'CANDLES');
 if(!Array.isArray(raw)||raw.length<70)throw Error('MISSING_CANDLES');
 const byTime=new Map();
 for(const row of raw){
  if(!Array.isArray(row)||row.length<6)throw Error('INVALID_CANDLES');
  const [sec,low,high,open,close,volume]=row.map(Number);
  if(![sec,low,high,open,close,volume].every(Number.isFinite)||
     !(low>0&&low<=Math.min(open,close)&&high>=Math.max(open,close)&&volume>=0))
      throw Error('INVALID_CANDLES');
  const ms=sec*1000;
  if(!Number.isSafeInteger(ms)||ms%interval!==0)throw Error('INVALID_CANDLES');
  if(ms+interval>now)continue;
  const val={t:ms,low,high,open,close,volume};
  if(byTime.has(ms)&&JSON.stringify(byTime.get(ms))!==JSON.stringify(val))throw Error('INVALID_CANDLES');
  byTime.set(ms,val);
 }
 const bars=[...byTime.values()].sort((a,b)=>a.t-b.t).slice(-72);
 if(bars.length<70)throw Error('MISSING_CANDLES');
 for(let i=1;i<bars.length;i++){
  if(bars[i].t-bars[i-1].t!==interval)throw Error('GAPPED_CANDLES');
 }
 if(now-(bars.at(-1).t+interval)>interval+600000)throw Error('INVALID_CANDLE_AGE');
 return{key,price:ticker.price,tickerAt:ticker.at,bars};
}
async function collectAll(now){
 const tickerEntries=await Promise.all(['BTC-USD','ETH-USD'].map(async(symbol)=>{
  const key=symbol+'|1h',item=await getJSON(BASE+symbol+'/ticker',key,'TICKER');
  const price=Number(item.price),at=Date.parse(item.time);
  if(!(Number.isFinite(price)&&price>0&&Number.isFinite(at)&&at<=now+60000&&now-at<=300000))
    throw Error('STALE_TICKER');
  return[symbol,{price,at}];
 }));
 const tickers=Object.fromEntries(tickerEntries);
 return Promise.all(KEYS.map(key=>collect(key,now,tickers[key.split('|')[0]])));
}
export class AdaptiveShadow extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.busy=false}
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/state'&&request.method==='GET'){
   const stored=await this.ctx.storage.get('shadow');
   return response({...status(stored),
     financialAudit:deriveFinancials(stored),
     recentClosedTrades:reconstructTrades(stored),
     pairedComparison:summarizePaired(stored?.pairedComparison),
     pairedComparisonError:stored?.pairedComparisonError||null});
  }
  if(path!=='/tick'||request.method!=='POST')return response({error:'NOT_FOUND'},404);
  if(this.busy)return response({updated:false,error:'BUSY'},409);
  this.busy=true;
  try{
   const now=Date.now(),previous=await this.ctx.storage.get('shadow');
   let next,feeds=null;
   try{
    feeds=await collectAll(now);
    next=applyTick(previous,feeds,now);
   }catch(e){next=failedTick(previous,now,String(e?.message||'MARKET_UNAVAILABLE'))}
   // The original paper portfolio and strategy decisions are never changed by the paired benchmark.
   if(next.lastError===null&&feeds){
    try{
     next.pairedComparison=advancePaired(previous?.pairedComparison,feeds,now);
     next.pairedComparisonError=null;
    }catch{
     next.pairedComparison=previous?.pairedComparison??null;
     next.pairedComparisonError='PAIRED_COMPARISON_UNAVAILABLE';
    }
   }else{
    next.pairedComparison=skippedPaired(previous?.pairedComparison);
   }
   await this.ctx.storage.put('shadow',next);
   const overview={
     positions:KEYS.filter(k=>next.portfolios[k].position!==null).length,
     closedTrades:KEYS.reduce((a,k)=>a+next.portfolios[k].trades,0),
     decisions:KEYS.reduce((a,k)=>a+next.portfolios[k].decisions,0),
     reasons:Object.fromEntries(KEYS.map(k=>[k,next.portfolios[k].latestDecision?.reason??null])),
     pairedComparisonInitialized:Boolean(next.pairedComparison),
     pairedComparisonError:next.pairedComparisonError||null
   };
   return response({updated:true,healthy:next.lastError===null,error:next.lastError,
    totalCycles:next.cycles.total,overview,ordersEnabled:false});
  }catch{
   return response({updated:false,error:'PERSISTENCE_UNAVAILABLE',ordersEnabled:false},503);
  }finally{this.busy=false}
 }
}
const instance=env=>env.SHADOW.get(env.SHADOW.idFromName('frozen-v4-forward-20261030'));
export default{
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(request.method!=='GET')return response({error:'METHOD_NOT_ALLOWED'},405);
  if(path==='/'||path==='/dashboard'){
   try{
    const internal=await instance(env).fetch('https://internal/state');
    if(!internal.ok)return response({error:'DASHBOARD_UNAVAILABLE'},503);
    const state=await internal.json();
    return new Response(renderDashboard(state,Date.now()),{status:200,headers:{
     'content-type':'text/html; charset=utf-8','cache-control':'no-store',
     'x-content-type-options':'nosniff',
     'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
    }});
   }catch{return response({error:'DASHBOARD_UNAVAILABLE'},503)}
  }
  if(path==='/health')return response({service:'cryptotrader-adaptive-shadow',
   mode:'SHADOW_FORWARD_ONLY',ordersEnabled:false,
   warning:'Service response does not establish market data health or 24-hour uptime'});
  if(path==='/status')return instance(env).fetch('https://internal/state');
  if(path==='/configuration')return response({mode:'SHADOW_FORWARD_ONLY',
   version:CONFIG.version,frozenMappings:CONFIG.mapping,feePerSidePct:CONFIG.fee*100,
   slippagePerSidePct:CONFIG.slippage*100,allocationPct:CONFIG.size*100,
   ordersEnabled:false,trainingCompletedBeforeActivation:true});
  return response({error:'NOT_FOUND'},404);
 },
 async scheduled(_event,env,ctx){
  ctx.waitUntil((async()=>{
   try{
    const r=await instance(env).fetch('https://internal/tick',{method:'POST'});
    const j=await r.json();
    console.log('SHADOW_CYCLE',JSON.stringify({http:r.status,updated:j.updated===true,
      healthy:j.healthy===true,error:j.error||null,total:j.totalCycles||0,
      overview:j.overview||null}));
   }catch{
    console.log('SHADOW_CYCLE',JSON.stringify({updated:false,error:'SCHEDULED_INVOCATION_FAILED'}));
   }
  })());
 }
};
