import test from 'node:test';
import assert from 'node:assert/strict';
import {CONFIG,KEYS,blank,applyTick,failedTick,status,classify,decide} from './adaptive_shadow_core.mjs';
const H=3600000,SIX=6*H;
const NOW=Date.parse('2026-10-30T12:05:00Z');
function data(key,now=NOW,form='up',price=null){
 const ms=CONFIG.timeframeMs[key.split('|')[1]];
 const last=Math.floor(now/ms)*ms-ms;
 const f=i=>form==='flat'?100:form==='down'?300-i*1.2:100+i*1.4;
 const bars=Array.from({length:72},(_,i)=>{
  const x=f(i);
  return {t:last-(71-i)*ms,low:x*.99,high:x*1.01,open:x,close:x,volume:20+i%3};
 });
 return {key,price:price??f(71),tickerAt:now-1000,bars};
}
const feeds=(now=NOW,form='up')=>KEYS.map(k=>data(k,now,form));
const p=(s,key)=>s.portfolios[key];

test('four independent frozen combinations, never exchange order-routing',()=>{
 assert.equal(KEYS.length,4);
 const cfg=JSON.stringify(CONFIG);
 assert.ok(!cfg.includes('BINANCE_TESTNET_KEY'));
 assert.equal(CONFIG.mapping['ETH-USD|1h'].UPTREND,null);
});
test('no state is invented in status before first scheduled tick',()=>{
 const s=status(null);
 assert.equal(s.initialized,false);
 assert.equal(s.ordersEnabled,false);
});
test('uptrend produces one 6-hour entry per eligible account, but no ETH 1h entry',()=>{
 const s=applyTick(null,feeds(),NOW);
 assert.equal(s.lastError,null);
 assert.equal(s.cycles.healthy,1);
 assert.equal(p(s,'ETH-USD|1h').position,null);
 assert.equal(p(s,'BTC-USD|1h').position,null);
 assert.equal(p(s,'BTC-USD|6h').position?.strategy,'trend');
 assert.equal(p(s,'ETH-USD|6h').position?.strategy,'trend');
 assert.equal(p(s,'BTC-USD|6h').cashUSD,3750);
 assert.equal(s.events.filter(e=>e.type==='VIRTUAL_BUY').length,2);
});
test('same closed candle does not trigger a duplicate entry',()=>{
 const first=applyTick(null,feeds(),NOW);
 const next=feeds(NOW+5*60000);
 const second=applyTick(first,next,NOW+5*60000);
 assert.equal(second.events.filter(e=>e.type==='VIRTUAL_BUY').length,2);
 assert.equal(p(second,'BTC-USD|6h').decisions,1);
 assert.equal(second.cycles.total,2);
});
test('ticker-based stop exits independently; no reentry on same candle',()=>{
 const initial=applyTick(null,feeds(),NOW);
 const next=feeds(NOW+5*60000);
 const f=next.find(x=>x.key==='BTC-USD|6h');
 f.price=initial.portfolios['BTC-USD|6h'].position.entryPrice*.95;
 const after=applyTick(initial,next,NOW+5*60000);
 assert.equal(p(after,'BTC-USD|6h').position,null);
 assert.equal(p(after,'BTC-USD|6h').trades,1);
 assert.equal(after.events.filter(e=>e.type==='VIRTUAL_SELL'&&e.key==='BTC-USD|6h').length,1);
 assert.ok(p(after,'BTC-USD|6h').realizedUSD<0);
});
test('if any of four feeds is missing, no portfolio is changed',()=>{
 const a=applyTick(null,feeds().slice(0,3),NOW);
 assert.equal(a.cycles.failed,1);
 assert.equal(a.cycles.healthy,0);
 assert.equal(a.events.length,0);
 assert.equal(a.lastError,'INCOMPLETE_FEED');
 assert.ok(Object.values(a.portfolios).every(x=>x.cashUSD===5000));
});
test('stale ticker, even on a single feed, fails the full tick closed',()=>{
 const q=feeds();q[3].tickerAt=NOW-400000;
 const s=applyTick(null,q,NOW);
 assert.equal(s.lastError,'STALE_TICKER');
 assert.equal(s.events.length,0);
});
test('gapped candles are rejected without invented decisions',()=>{
 const q=feeds();q[2].bars[20].t+=SIX;
 const s=applyTick(null,q,NOW);
 assert.equal(s.lastError,'GAPPED_CANDLES');
 assert.ok(Object.values(s.portfolios).every(x=>x.decisions===0));
});
test('price and trade outcomes depend only on data received in future cycles',()=>{
 const first=applyTick(null,feeds(),NOW);
 assert.equal(p(first,'BTC-USD|6h').trades,0);
 assert.equal(p(first,'BTC-USD|6h').realizedUSD,0);
 const second=feeds(NOW+5*60000);
 const s=applyTick(first,second,NOW+5*60000);
 assert.equal(p(s,'BTC-USD|6h').trades,0);
});
test('never opens retroactive trade if first observation is late',()=>{
 const late=NOW+40*60000;
 const q=feeds(late);
 const s=applyTick(null,q,late);
 assert.ok(Object.values(s.portfolios).every(x=>x.position===null));
 assert.equal(p(s,'BTC-USD|6h').latestDecision?.reason,'BAR_TOO_OLD');
});
test('cash mode explicitly records decision rather than inventing a trade',()=>{
 const s=applyTick(null,feeds(),NOW);
 const d=p(s,'ETH-USD|1h').latestDecision;
 assert.equal(d?.chosenStrategy,'CASH');
 assert.equal(d?.reason,'FROZEN_CASH');
 assert.equal(p(s,'ETH-USD|1h').decisions,1);
});
test('failure diagnostics do not trigger virtual sell or buy',()=>{
 const initial=applyTick(null,feeds(),NOW);
 const oldEvents=initial.events.length;
 const failed=failedTick(initial,NOW+5*60000,'HTTP_429_BTC_CANDLES_6H');
 assert.equal(failed.events.length,oldEvents);
 assert.equal(failed.cycles.failed,1);
 assert.equal(failed.lastError,'HTTP_429_BTC_CANDLES_6H');
 assert.ok(failed.portfolios['BTC-USD|6h'].position);
});
test('regressed closed candle fails entire tick without modifying portfolios',()=>{
 const first=applyTick(null,feeds(),NOW);
 const second=feeds(NOW+5*60000);
 const bad=second.find(x=>x.key==='ETH-USD|1h');
 bad.bars=bad.bars.map(c=>({...c,t:c.t-H}));
 const next=applyTick(first,second,NOW+5*60000);
 assert.equal(next.lastError,'REGRESSED_BAR');
 assert.equal(next.cycles.failed,1);
 assert.equal(next.events.length,first.events.length);
 assert.deepEqual(next.portfolios,first.portfolios);
});
test('untrusted error content never leaks into status',()=>{
 const failed=failedTick(null,NOW,'api secret key abcdef');
 assert.equal(failed.lastError,'MARKET_UNAVAILABLE');
 assert.ok(!JSON.stringify(status(failed)).includes('abcdef'));
});
test('downtrend detection and reversion conditions are based on completed bars',()=>{
 const q=data('BTC-USD|1h',NOW,'down');
 assert.equal(classify(q.bars),'DOWNTREND');
 assert.equal(decide(q.bars,'reversion').enter,true);
});
test('modifying unseen future candle does not change current decision',()=>{
 const q=data('BTC-USD|6h');
 const future=[...q.bars,{t:q.bars.at(-1).t+SIX,low:1,high:1e6,open:100,close:1000,volume:20000}];
 assert.equal(classify(q.bars),classify(future.slice(0,-1)));
 assert.deepEqual(decide(q.bars,'trend'),decide(future.slice(0,-1),'trend'));
});
test('risk guard prevents new entries once peak drawdown limit is breached',()=>{
 const st=blank(NOW);
 const slot=p(st,'BTC-USD|6h');
 slot.peakEquity=7000;
 const s=applyTick(st,feeds(),NOW);
 assert.equal(p(s,'BTC-USD|6h').position,null);
 assert.equal(p(s,'BTC-USD|6h').latestDecision.reason,'RISK_GUARD');
});
