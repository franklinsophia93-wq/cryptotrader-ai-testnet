import test from 'node:test';
import assert from 'node:assert/strict';
import {assessResearch} from './adaptive_shadow_readiness.mjs';
import {startPaired} from './adaptive_paired_forward.mjs';
import {KEYS,CONFIG} from './adaptive_shadow_core.mjs';

const start=Date.parse('2026-10-30T15:15:00Z'),DAY=86400000;
function mk(){
 const feeds=KEYS.map(key=>({key,bars:[{t:Math.floor(start/CONFIG.timeframeMs[key.split('|')[1]])*CONFIG.timeframeMs[key.split('|')[1]]}]}));
 return startPaired(feeds,start);
}
const ops={certified24h:true};
test('never approves non-started comparison, even with healthy 24h monitor',()=>{
 const x=assessResearch(null,ops,start);
 assert.equal(x.status,'NOT_STARTED');
 assert.equal(x.sampleAdequate,false);
 assert.equal(x.realOrdersAuthorized,false);
});
test('rejects an invalid or future dated record',()=>{
 const s=mk();s.lastTick='broken';
 const x=assessResearch(s,ops,start+DAY);
 assert.equal(x.status,'INVALID_OBSERVATION_DATES');
 assert.equal(x.sampleAdequate,false);
});
test('only a few hours and no trades is NOT performance evidence',()=>{
 const s=mk();s.lastTick=new Date(start+2*3600000).toISOString();
 const x=assessResearch(s,ops,start+2*3600000);
 assert.equal(x.status,'INSUFFICIENT_FORWARD_DAYS');
 assert.equal(x.adaptiveTrades,0);
 assert.equal(x.fixedTrades,0);
 assert.equal(x.sampleAdequate,false);
});
test('operational uptime alone is not proof of profitability',()=>{
 const s=mk();s.lastTick=new Date(start+31*DAY).toISOString();
 const x=assessResearch(s,ops,start+31*DAY);
 assert.equal(x.status,'INSUFFICIENT_CLOSED_TRADES');
 assert.equal(x.sampleAdequate,false);
});
test('one arm with adequate number of trades cannot pass alone',()=>{
 const s=mk();s.lastTick=new Date(start+31*DAY).toISOString();
 for(const p of Object.values(s.portfolios.adaptive))p.closedTrades=10;
 const x=assessResearch(s,ops,start+31*DAY);
 assert.equal(x.adaptiveTrades,40);
 assert.equal(x.fixedTrades,0);
 assert.equal(x.sampleAdequate,false);
});
test('both arms after 30 days can qualify ONLY for manual research review',()=>{
 const s=mk();s.lastTick=new Date(start+31*DAY).toISOString();
 for(const arm of ['adaptive','fixed'])
  for(const p of Object.values(s.portfolios[arm])){p.closedTrades=8;p.equityUSD=4980;}
 const x=assessResearch(s,ops,start+31*DAY);
 assert.equal(x.sampleAdequate,true);
 assert.equal(x.status,'READY_FOR_MANUAL_RESEARCH_REVIEW');
 assert.equal(x.realOrdersAuthorized,false);
 assert.equal(x.automaticPromotion,false);
 assert.equal(x.adaptiveMinusFixedUSD,0);
 assert.equal(x.adaptiveNetUSD,-80);
});
test('any skipped paired cycles block automatic research maturity',()=>{
 const s=mk();s.lastTick=new Date(start+32*DAY).toISOString();
 s.skippedCycles=1;
 for(const arm of ['adaptive','fixed'])
  for(const p of Object.values(s.portfolios[arm]))p.closedTrades=8;
 const x=assessResearch(s,ops,start+32*DAY);
 assert.equal(x.status,'PAIRED_CYCLES_SKIPPED');
 assert.equal(x.sampleAdequate,false);
});
test('lost 24h operational health blocks maturity',()=>{
 const s=mk();s.lastTick=new Date(start+32*DAY).toISOString();
 for(const arm of ['adaptive','fixed'])
  for(const p of Object.values(s.portfolios[arm]))p.closedTrades=8;
 const x=assessResearch(s,{certified24h:false},start+32*DAY);
 assert.equal(x.status,'OPERATIONAL_24H_NOT_VERIFIED');
 assert.equal(x.sampleAdequate,false);
});
test('old last tick fails closed',()=>{
 const s=mk();s.lastTick=new Date(start+32*DAY).toISOString();
 for(const arm of ['adaptive','fixed'])
  for(const p of Object.values(s.portfolios[arm]))p.closedTrades=8;
 const x=assessResearch(s,ops,start+32*DAY+20*60000);
 assert.equal(x.status,'DATA_NOT_RECENT');
 assert.equal(x.sampleAdequate,false);
});
test('assessment is pure and never modifies original fictitious portfolios',()=>{
 const s=mk();const before=JSON.stringify(s);
 assessResearch(s,ops,start);
 assert.equal(JSON.stringify(s),before);
});
