import test from 'node:test';
import assert from 'node:assert/strict';
import {blank,CONFIG,KEYS,applyTick} from './adaptive_shadow_core.mjs';
import {deriveFinancials,reconstructTrades} from './adaptive_shadow_audit.mjs';
import {advancePaired,skippedPaired,summarizePaired,FROZEN_FIXED} from './adaptive_paired_forward.mjs';
const H=3600000,NOW=Date.parse('2026-10-30T12:05:00Z');
function feeds(now=NOW,trend='up'){
 return KEYS.map(key=>{
  const ms=CONFIG.timeframeMs[key.split('|')[1]],last=Math.floor(now/ms)*ms-ms;
  const price=i=>trend==='down'?300-i*1.2:trend==='flat'?100:100+i*1.4;
  return{key,price:price(71),tickerAt:now-2000,bars:Array.from({length:72},(_,i)=>{
   const p=price(i);return{t:last-(71-i)*ms,low:p*.99,high:p*1.01,open:p,close:p,volume:20+(i%3)};})};
 });
}
test('finance: blank accounts have no fictitious profit',()=>{
 const a=deriveFinancials(blank(NOW));
 assert.equal(a.totalEquityUSD,20000);
 assert.equal(a.totalResultUSD,0);
 assert.equal(a.realizedUSD,0);
 assert.equal(a.unrealizedUSD,0);
});
test('finance: realized versus unrealized are separated without double-counting',()=>{
 const s=blank(NOW);
 const a=s.portfolios['BTC-USD|1h'];
 a.cashUSD=4998.178563;a.equityUSD=4998.18;a.realizedUSD=-1.821437;a.trades=1;
 const b=s.portfolios['BTC-USD|6h'];
 b.cashUSD=3750;b.equityUSD=4992.75;
 b.position={quantity:.016168521,entryPrice:77233.48,costUSD:1250,strategy:'reversion'};
 const d=deriveFinancials(s);
 assert.equal(d.realizedUSD,-1.82);
 assert.equal(d.unrealizedUSD,-7.25);
 assert.equal(d.totalResultUSD,-9.07);
 assert.equal(d.openPositions,1);
});
test('no fictitious unrealized loss from rounded cash when position is flat',()=>{
 const s=blank(NOW);
 s.portfolios['BTC-USD|1h'].cashUSD=4998.178563;
 s.portfolios['BTC-USD|1h'].equityUSD=4998.18;
 s.portfolios['BTC-USD|1h'].realizedUSD=-1.821437;
 assert.equal(deriveFinancials(s).accounts['BTC-USD|1h'].unrealizedUSD,0);
});
test('trade fees are reconstructed from rounded public events, clearly estimated',()=>{
 const s=blank(NOW);
 s.events=[
  {at:'2026-10-30T12:05:00Z',key:'BTC-USD|1h',type:'VIRTUAL_BUY',
   price:77000,quantity:.01622,allocatedUSD:1250,strategy:'reversion'},
  {at:'2026-10-30T13:05:00Z',key:'BTC-USD|1h',type:'VIRTUAL_SELL',
   price:77050,quantity:.01622,realizedUSD:-.49,reason:'CLOSED_BAR_EXIT',strategy:'reversion'}
 ];
 const t=reconstructTrades(s)[0];
 assert.equal(t.matchedEntry,true);
 assert.equal(t.feeMethod,'ESTIMATED_FROM_ROUNDED_EVENT');
 assert.ok(t.modeledExitFeeUSD>0);
 assert.equal(t.realizedUSD,-.49);
});
test('missing historic entry event is reported, never fabricated',()=>{
 const s=blank(NOW);
 s.events=[{key:'BTC-USD|6h',type:'VIRTUAL_SELL',at:new Date(NOW).toISOString(),
   price:50,quantity:2,realizedUSD:1,reason:'TICK_TARGET'}];
 const t=reconstructTrades(s)[0];
 assert.equal(t.matchedEntry,false);
 assert.equal(t.enteredAt,undefined);
});
test('first paired cycle initializes BOTH arms in cash, no retrospective entry',()=>{
 const p=advancePaired(null,feeds(),NOW);
 const s=summarizePaired(p);
 assert.equal(s.initialized,true);
 assert.equal(s.arms.adaptive.totalEquityUSD,20000);
 assert.equal(s.arms.fixed.totalEquityUSD,20000);
 assert.equal(s.arms.adaptive.completedTrades,0);
 assert.equal(p.events.length,0);
 assert.equal(p.cycles,1);
});
test('paired cycle compares same new 6-hour candle without affecting main portfolio',()=>{
 const original=applyTick(null,feeds(),NOW);
 const frozen=JSON.stringify(original);
 const start=advancePaired(null,feeds(),NOW);
 const next=advancePaired(start,feeds(NOW+6*H),NOW+6*H);
 assert.equal(JSON.stringify(original),frozen);
 assert.equal(next.cycles,2);
 assert.equal(next.portfolios.adaptive['BTC-USD|6h'].position?.strategy,'trend');
 assert.equal(next.portfolios.fixed['BTC-USD|6h'].position,null);
 assert.equal(summarizePaired(next).ordersEnabled,false);
});
test('same closed bar cannot duplicate a virtual buy in either arm',()=>{
 const init=advancePaired(null,feeds(),NOW);
 const active=advancePaired(init,feeds(NOW+6*H),NOW+6*H);
 const again=advancePaired(active,feeds(NOW+6*H+5*60000),NOW+6*H+5*60000);
 const a=active.events.filter(e=>e.type==='OPEN').length;
 assert.equal(again.events.filter(e=>e.type==='OPEN').length,a);
});
test('skipped cycles do not create entries or change both portfolios',()=>{
 const s=advancePaired(null,feeds(),NOW);
 const result=skippedPaired(s);
 assert.deepEqual(result.portfolios,s.portfolios);
 assert.equal(result.skippedCycles,1);
});
test('fixed selection is deterministic and frozen across all markets',()=>{
 assert.deepEqual(Object.keys(FROZEN_FIXED),KEYS);
 assert.equal(FROZEN_FIXED['BTC-USD|1h'],'reversion');
 assert.equal(FROZEN_FIXED['ETH-USD|1h'],'breakout');
 assert.equal(FROZEN_FIXED['BTC-USD|6h'],'breakout');
 assert.equal(FROZEN_FIXED['ETH-USD|6h'],'reversion');
});
test('paired comparison refuses candle regression rather than replaying the past',()=>{
 const s=advancePaired(null,feeds(),NOW);
 const f=feeds(NOW+6*H);
 f[0].bars=f[0].bars.map(b=>({...b,t:b.t-12*H}));
 assert.throws(()=>advancePaired(s,f,NOW+6*H),/REGRESSED_BAR/);
});
