// Separate research-only paper-trading Worker. It never calls Binance order endpoints.
import { DurableObject } from 'cloudflare:workers';
import { PAIRS, freshState, step, publicView } from './paper_core.mjs';
const HOUR=3600000;
const BASE='https://api.exchange.coinbase.com/products/';
const reply=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{
  'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'
}});
async function fetchJSON(url){
 const r=await fetch(url,{method:'GET',headers:{accept:'application/json'},redirect:'manual',
   signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error('HTTP_'+r.status);
 return r.json();
}
async function market(sym,now){
 if(!PAIRS.includes(sym))throw Error('INVALID_SYMBOL');
 const [ticker,candles]=await Promise.all([
    fetchJSON(BASE+sym+'/ticker'),
    fetchJSON(BASE+sym+'/candles?granularity=3600')
 ]);
 const price=Number(ticker?.price),tickerAt=Date.parse(ticker?.time);
 if(!Array.isArray(candles)||candles.length<60)throw Error('INSUFFICIENT_CANDLES');
 const byTime=new Map();
 for(const item of candles){
   if(!Array.isArray(item)||item.length<6)throw Error('BAD_CANDLE');
   const [sec,low,high,open,close,volume]=item.map(Number);
   if(![sec,low,high,open,close,volume].every(Number.isFinite)||
      !(low>0&&low<=open&&open<=high&&low<=close&&close<=high&&volume>=0))throw Error('BAD_CANDLE');
   const ts=sec*1000;
   if(ts%HOUR!==0)throw Error('MISALIGNED_CANDLE');
   if(byTime.has(ts)&&byTime.get(ts)!==close)throw Error('CONFLICTING_CANDLES');
   if(ts+HOUR<=now)byTime.set(ts,close);
 }
 const ordered=[...byTime].sort((a,b)=>a[0]-b[0]).slice(-60);
 if(ordered.length!==60)throw Error('MISSING_CANDLES');
 if(ordered.some(([t],i)=>i&&t-ordered[i-1][0]!==HOUR))throw Error('GAPPED_CANDLES');
 const barTimestamp=ordered[59][0];
 if(now-barTimestamp>3*HOUR)throw Error('STALE_CANDLES');
 return{symbol:sym,price,tickerAt,barTimestamp,closes:ordered.map(x=>x[1])};
}
export class PaperPortfolio extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.busy=false}
 async fetch(request){
   const path=new URL(request.url).pathname;
   if(path==='/state'){const state=await this.ctx.storage.get('portfolio');return reply(publicView(state))}
   if(path!=='/tick'||request.method!=='POST')return reply({error:'NOT_FOUND'},404);
   if(this.busy)return reply({status:'BUSY'});
   this.busy=true;
   try{
     const now=Date.now();
     let previous=await this.ctx.storage.get('portfolio');
     if(!previous)previous=freshState(now);
     let next;
     try{
       const quotes=await Promise.all(PAIRS.map(s=>market(s,now)));
       next=step(previous,quotes,now);
     }catch(e){
       next=structuredClone(previous);
       next.lastTick=new Date(now).toISOString();
       const code=String(e?.message||'NETWORK_ERROR');
       next.lastError=/^(HTTP_[0-9]{3}|INSUFFICIENT_CANDLES|BAD_CANDLE|MISALIGNED_CANDLE|CONFLICTING_CANDLES|MISSING_CANDLES|GAPPED_CANDLES|STALE_CANDLES)$/.test(code)?code:'DATA_SOURCE_UNAVAILABLE';
       next.newEntriesBlocked=true;
     }
     await this.ctx.storage.put('portfolio',next);
     return reply({updated:true,marketError:next.lastError,ordersEnabled:false});
   }catch{return reply({updated:false,marketError:'PERSISTENCE_ERROR',ordersEnabled:false},503)}
   finally{this.busy=false}
 }
}
const portfolio=env=>env.PAPER.get(env.PAPER.idFromName('virtual-usd-portfolio-v1'));
export default {
 async fetch(request,env){
   const path=new URL(request.url).pathname;
   if(request.method!=='GET')return reply({error:'METHOD_NOT_ALLOWED'},405);
   if(path==='/health')return reply({service:'cryptotrader-paper-engine',mode:'PAPER_ONLY',ordersEnabled:false});
   if(path==='/status')return portfolio(env).fetch('https://internal/state');
   if(path==='/price-test'){
      const now=Date.now(),arr=await Promise.all(PAIRS.map(async sym=>{
        try{const x=await market(sym,now);return {symbol:sym,status:'FRESH',closedBar:x.barTimestamp}}
        catch(e){return {symbol:sym,status:/^HTTP_[0-9]{3}$/.test(e?.message||'')?e.message:'UNAVAILABLE_OR_STALE'}}
      }));
      return reply({source:'COINBASE_EXCHANGE_PUBLIC',results:arr,ordersEnabled:false});
   }
   return reply({error:'NOT_FOUND'},404);
 },
 async scheduled(_event,env,ctx){
   ctx.waitUntil(portfolio(env).fetch('https://internal/tick',{method:'POST'}));
 }
};
