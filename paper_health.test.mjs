import test from 'node:test';
import assert from 'node:assert/strict';
import {recordCycle, summarizeCycles, CADENCE_MS} from './paper_health.mjs';

const start = Date.parse('2026-10-29T20:00:00.000Z');
const fresh = () => ({positions:{},journal:[]});

test('no claim of 24h validation before first tick', () => {
  const result=summarizeCycles(undefined,start);
  assert.equal(result.fullDayVerified,false);
  assert.equal(result.totalCycles,0);
  assert.equal(result.observedCyclesInWindow,0);
});
test('a successful cycle is persisted as healthy', () => {
  const s=recordCycle(fresh(),start,true);
  const result=summarizeCycles(s.cycleMetrics,start);
  assert.equal(result.totalCycles,1);
  assert.equal(result.successfulCycles,1);
  assert.equal(result.consecutiveFailures,0);
  assert.equal(result.healthyCyclesInWindow,1);
});
test('duplicate scheduled invocation within 60 seconds does not inflate counts',()=>{
  const s=recordCycle(fresh(),start,true);
  recordCycle(s,start+10000,true);
  assert.equal(s.cycleMetrics.totalCycles,1);
});
test('data errors counted separately from transport success',()=>{
  const s=recordCycle(fresh(),start,true);
  recordCycle(s,start+CADENCE_MS,false,'HTTP_429');
  recordCycle(s,start+2*CADENCE_MS,false,'STALE_CANDLES');
  const r=summarizeCycles(s.cycleMetrics,start+2*CADENCE_MS);
  assert.equal(r.totalCycles,3);
  assert.equal(r.failedCyclesInWindow,2);
  assert.equal(r.consecutiveFailures,2);
  assert.equal(r.recentCycles.at(-1).error,'STALE_CANDLES');
  recordCycle(s,start+3*CADENCE_MS,true);
  assert.equal(s.cycleMetrics.consecutiveFailures,0);
});
test('we do not leak arbitrary upstream error data in public metrics',()=>{
  const s=recordCycle(fresh(),start,false,'some token that must not be logged');
  const r=summarizeCycles(s.cycleMetrics,start);
  assert.equal(r.recentCycles[0].error,'DATA_UNAVAILABLE');
  assert.equal(JSON.stringify(r).includes('token'),false);
});
test('a skipped cycle is detected as a gap',()=>{
  const s=recordCycle(fresh(),start,true);
  recordCycle(s,start+3*CADENCE_MS,true);
  const r=summarizeCycles(s.cycleMetrics,start+3*CADENCE_MS);
  assert.equal(r.missingIntervalsEstimate,2);
  assert.equal(r.fullDayVerified,false);
});
test('a healthy observed 24 hour window meets strict certification criteria',()=>{
  const s=fresh();
  for(let i=0;i<=288;i++) recordCycle(s,start+i*CADENCE_MS,true);
  const r=summarizeCycles(s.cycleMetrics,start+288*CADENCE_MS);
  assert.equal(r.fullDayVerified,true);
  assert.equal(r.observedCyclesInWindow,289);
  assert.equal(r.missingIntervalsEstimate,0);
  assert.equal(r.failedCyclesInWindow,0);
});
test('one failed feed cycle in the last 24 hours prevents certification',()=>{
  const s=fresh();
  for(let i=0;i<=288;i++)recordCycle(s,start+i*CADENCE_MS,i!==57,i===57?'STALE_TICKER':null);
  const r=summarizeCycles(s.cycleMetrics,start+288*CADENCE_MS);
  assert.equal(r.fullDayVerified,false);
  assert.equal(r.failedCyclesInWindow,1);
});
test('window ignores old observations without resetting global counters',()=>{
  const s=fresh();
  for(let i=0;i<320;i++)recordCycle(s,start+i*CADENCE_MS,true);
  const r=summarizeCycles(s.cycleMetrics,start+319*CADENCE_MS);
  assert.equal(r.totalCycles,320);
  assert.ok(r.observedCyclesInWindow<=289);
  assert.ok(s.cycleMetrics.history.length<=310);
});
test('no first successful tick or stored metric can fabricate a 24h history',()=>{
  const s=recordCycle(fresh(),start,false,'STALE_TICKER');
  const r=summarizeCycles(s.cycleMetrics,start);
  assert.equal(r.fullDayVerified,false);
  assert.equal(r.lastSuccessfulAt,null);
});
