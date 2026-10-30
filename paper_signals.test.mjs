import test from 'node:test';
import assert from 'node:assert/strict';
import {explainMarketSignal} from './paper_signals.mjs';
const tm=Date.parse('2026-10-30T07:00:00Z');
const base={symbol:'BTC-USD',barTimestamp:tm,closes:Array(60).fill(100)};
test('no bullish trend on flat prices',()=>{
 const r=explainMarketSignal(base,{});
 assert.equal(r.bullishTrend,false);
 assert.equal(r.bullishConditionMet,false);
 assert.equal(r.reason,'NO_BULLISH_TREND_SMA15_AT_OR_BELOW_SMA40');
});
test('downtrend means no entry',()=>{
 const closes=Array.from({length:60},(_,i)=>160-i);
 const r=explainMarketSignal({...base,closes},{});
 assert.equal(r.bullishTrend,false);
 assert.ok(r.sma15<r.sma40);
});
test('uptrend is only a condition not guaranteed entry',()=>{
 const closes=Array.from({length:60},(_,i)=>100+i);
 const r=explainMarketSignal({...base,closes},{});
 assert.equal(r.bullishTrend,true);
 assert.equal(r.bullishConditionMet,true);
 assert.equal(r.reason,'BULLISH_TREND_WAIT_FOR_NEXT_ELIGIBLE_HOURLY_CYCLE');
});
test('risk gate overrides bullish trend',()=>{
 const closes=Array.from({length:60},(_,i)=>100+i);
 const r=explainMarketSignal({...base,closes},{newEntriesBlocked:true});
 assert.equal(r.reason,'RISK_LIMIT');
 assert.equal(r.bullishConditionMet,true);
});
test('existing virtual position explains no additional entry',()=>{
 const closes=Array.from({length:60},(_,i)=>100+i);
 const r=explainMarketSignal({...base,closes},{openPositions:[{symbol:'BTC-USD'}]});
 assert.equal(r.reason,'POSITION_ALREADY_OPEN');
});
test('invalid feed never invents signals',()=>{
 const r=explainMarketSignal({...base,closes:[]},{});
 assert.equal(r.status,'DATA_UNAVAILABLE');
 assert.equal(r.bullishConditionMet,false);
});
test('ETH uses same fixed rule',()=>{
 const r=explainMarketSignal({...base,symbol:'ETH-USD'},{});
 assert.equal(r.symbol,'ETH-USD');
 assert.equal(r.ordersEnabled,false);
});
