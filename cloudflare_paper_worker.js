// Cloudflare connectivity preflight: public Coinbase price feed, no trading.
const COINBASE='https://api.exchange.coinbase.com/products/';
const reply=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
async function checkMarket(sym){
 try {
  const res=await fetch(COINBASE+sym+'/ticker',{headers:{accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(6000)});
  if(!res.ok)return{symbol:sym,status:'HTTP_'+res.status};
  const body=await res.json();const price=Number(body.price),stamp=Date.parse(body.time);
  const age=Date.now()-stamp;
  if(!(price>0&&Number.isFinite(price)&&Number.isFinite(stamp)&&age>=-60000&&age<300000))return{symbol:sym,status:'INVALID_OR_STALE'};
  return{symbol:sym,status:'FRESH'};
 }catch{return{symbol:sym,status:'NETWORK_OR_PARSE_ERROR'}}
}
export default{async fetch(request){
 const path=new URL(request.url).pathname;
 if(path==='/health')return reply({worker:'cryptotrader-paper-engine',status:'PREFLIGHT',ordersEnabled:false});
 if(path==='/price-test')return reply({source:'COINBASE_PUBLIC',checks:await Promise.all([checkMarket('BTC-USD'),checkMarket('ETH-USD')]),ordersEnabled:false});
 return reply({error:'NOT_FOUND'},404)
}}
