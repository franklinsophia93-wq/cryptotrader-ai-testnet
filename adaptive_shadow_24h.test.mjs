import test from 'node:test';
import assert from 'node:assert/strict';
import {verify24h} from './adaptive_shadow_24h.mjs';
import {blank,applyTick,failedTick,KEYS,CONFIG} from './adaptive_shadow_core.mjs';
const START=Date.parse('2026-10-30T12:00:00Z');
const FIVE=300000;
function history(length=289,step=FIVE){
 return {mostRecent:Array.from({length},(_,i)=>({
  at:new Date(START+i*step).toISOString(),healthy:true
 }))};
}
test('does not certify a prior 24-cycle truncated history',()=>{
 const h=history(24);
 const result=verify24h(h,START+23*FIVE);
 assert.equal(result.certified24h,false);
 assert.equal(result.status,'INSUFFICIENT_24H_HISTORY');
});
test('certifies a complete 24h of continuously healthy scheduled cycles',()=>{
 const h=history();
 const r=verify24h(h,START+288*FIVE);
 assert.equal(r.certified24h,true);
 assert.equal(r.status,'VERIFIED_24H');
 assert.equal(r.healthyChecksWithinWindow,289);
 assert.equal(r.recordedCoverageHours,24);
});
test('does not claim 24h before 24h has elapsed',()=>{
 const h=history(288);
 assert.equal(verify24h(h,START+287*FIVE).certified24h,false);
});
test('a single failed cycle invalidates the 24h period',()=>{
 const h=history();
 h.mostRecent[130].healthy=false;
 const r=verify24h(h,START+288*FIVE);
 assert.equal(r.certified24h,false);
 assert.equal(r.failedChecksWithinWindow,1);
 assert.equal(r.status,'FAILED_CYCLES');
});
test('a missing scheduled cycle invalidates the 24h period',()=>{
 const h=history();
 h.mostRecent.splice(75,1);
 const r=verify24h(h,START+288*FIVE);
 assert.equal(r.certified24h,false);
 assert.equal(r.status,'GAPS_DETECTED');
 assert.equal(r.gapsInWindow,1);
});
test('a recently healthy full window is invalid when it becomes stale',()=>{
 const h=history();
 const r=verify24h(h,START+288*FIVE+12*60000);
 assert.equal(r.certified24h,false);
 assert.equal(r.status,'STALE_MONITOR');
});
test('a later rolling 24h can recover after an old failed cycle expires',()=>{
 const h=history(350);
 h.mostRecent[20].healthy=false;
 const r=verify24h(h,START+349*FIVE);
 assert.equal(r.certified24h,true);
 assert.equal(r.failedChecksWithinWindow,0);
});
test('every old aggregate count is irrelevant when there are no timestamps',()=>{
 const r=verify24h({total:1000,healthy:1000,failed:0,mostRecent:[]},Date.now());
 assert.equal(r.certified24h,false);
 assert.equal(r.healthyChecksWithinWindow,0);
});
function feeds(now){
 return KEYS.map(key=>{
  const ms=CONFIG.timeframeMs[key.split('|')[1]],last=Math.floor(now/ms)*ms-ms;
  return{key,price:120,tickerAt:now-2000,bars:Array.from({length:72},(_,i)=>({
   t:last-(71-i)*ms,low:119,high:121,open:120,close:120,volume:10
  }))};
 });
}
test('core preserves enough timestamps for 24h audit and keeps cap at 340',()=>{
 let s=blank(START);
 for(let i=0;i<350;i++){
  const now=START+i*FIVE;
  s=failedTick(s,now,'NETWORK_UNAVAILABLE');
 }
 assert.equal(s.cycles.mostRecent.length,340);
 assert.equal(s.cycles.total,350);
 assert.equal(s.cycles.failed,350);
});
