import test from 'node:test';
import assert from 'node:assert/strict';
import {freshState,step,publicView} from './paper_core.mjs';
const HOUR=3600000;
const base=Math.floor(Date.now()/HOUR)*HOUR+60000;
const bar=base-base%HOUR-HOUR;
const make=(up=true,ts=bar)=>({
  symbol:'BTC-USD',price:200,tickerAt:base-1000,barTimestamp:ts,
  closes:Array.from({length:60},(_,i)=>up?100+i:220-i)
});
const pair=(a=make(),b=null)=>[a,{...(b??a),symbol:'ETH-USD'}];
test('no secrets, real orders, or sensitive tokens appear in public state',()=>{
 const status=publicView(freshState(base));
 assert.equal(status.ordersEnabled,false);
 assert.equal(status.mode,'PAPER_ONLY');
 assert.equal(JSON.stringify(status).includes('BINANCE_TESTNET_KEY'),false);
});
test('simultaneous independent virtual positions across two assets',()=>{
 const result=step(freshState(base),pair(),base);
 assert.deepEqual(Object.keys(result.positions).sort(),['BTC-USD','ETH-USD']);
 assert.equal(result.journal.filter(e=>e.side==='BUY').length,2);
 assert.ok(result.cashUSD>=6000-0.1);
});
test('the same hourly bar never generates duplicate entry',()=>{
 const one=step(freshState(base),pair(),base);
 const two=step(one,pair(),base+60000);
 assert.equal(two.journal.length,2);
 assert.equal(two.completedTrades,0);
});
test('stale ticker freezes execution',()=>{
 const bad=make();bad.tickerAt=base-400000;
 const result=step(freshState(base),pair(bad),base);
 assert.equal(result.lastError,'STALE_TICKER');
 assert.equal(result.journal.length,0);
});
test('missing asset freezes all entries',()=>{
 const result=step(freshState(base),[make()],base);
 assert.equal(result.lastError,'INCOMPLETE_MARKET_FEED');
 assert.equal(Object.keys(result.positions).length,0);
});
test('stop loss is recorded on newer tick even for same bar',()=>{
 const one=step(freshState(base),pair(),base);
 const low=make();low.price=180;low.tickerAt=base+59000;
 const other=make();other.price=200;other.tickerAt=base+59000;
 const two=step(one,pair(low,other),base+60000);
 assert.equal(two.journal.filter(e=>e.side==='SELL'&&e.symbol==='BTC-USD').length,1);
 assert.equal(two.positions['BTC-USD'],undefined);
 assert.equal(two.completedTrades,1);
});
test('no immediate same-tick reentry after a stop',()=>{
 const one=step(freshState(base),pair(),base);
 const low=make();low.price=170;low.tickerAt=base+59000;
 const after=step(one,pair(low),base+60000);
 assert.equal(after.positions['BTC-USD'],undefined);
 assert.equal(after.journal.filter(e=>e.symbol==='BTC-USD').length,2);
});
test('gates prevent new entries on daily loss',()=>{
 const s=freshState(base);
 s.dayStartEquity=11000;
 const out=step(s,pair(),base);
 assert.equal(out.newEntriesBlocked,true);
 assert.equal(Object.keys(out.positions).length,0);
});
test('drawdown gate prevents entries',()=>{
 const s=freshState(base);
 s.peakEquity=12000;
 const out=step(s,pair(),base);
 assert.equal(out.newEntriesBlocked,true);
 assert.equal(Object.keys(out.positions).length,0);
});
test('trend down prevents entries for both assets',()=>{
 const out=step(freshState(base),pair(make(false)),base);
 assert.equal(Object.keys(out.positions).length,0);
});
test('new bar advances lastBar idempotently',()=>{
 const down=step(freshState(base),pair(make(false)),base);
 assert.equal(down.lastBar['BTC-USD'],bar);
 assert.equal(down.journal.length,0);
});
test('invalid candle timestamps block orders',()=>{
 const bad=make();bad.barTimestamp=bar+45;
 const out=step(freshState(base),pair(bad),base);
 assert.equal(out.lastError,'STALE_CANDLES');
 assert.equal(out.journal.length,0);
});
