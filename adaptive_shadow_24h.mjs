// Read-only rolling 24-hour verification of documented scheduled checks.
// This is operational-cycle validation, NOT 24 hours of profitable performance.
const WINDOW=24*60*60*1000;
const MAX_GAP=7.5*60*1000;
const MAX_STALENESS=11*60*1000;
export function verify24h(cycles,now=Date.now()){
 const recent=Array.isArray(cycles?.mostRecent)?cycles.mostRecent:[];
 const points=recent.map(x=>({at:Date.parse(x?.at||''),healthy:x?.healthy===true}))
  .filter(x=>Number.isFinite(x.at)).sort((a,b)=>a.at-b.at);
 const last=points.at(-1)?.at??null;
 const stale=last===null||last>now+60000||now-last>MAX_STALENESS;
 const first=points[0]?.at??null;
 const coverage=first===null||last===null?0:Math.max(0,Math.min(WINDOW,last-first));
 const windowStart=last===null?null:last-WINDOW;
 const included=points.filter(x=>windowStart!==null&&x.at>=windowStart);
 const failed=included.filter(x=>!x.healthy).length;
 let maxGap=0,broken=false;
 for(let i=1;i<points.length;i++){
  const gap=points[i].at-points[i-1].at;
  if(gap<=0)broken=true;
  if(gap>maxGap)maxGap=gap;
 }
 const anchor=windowStart===null?null:[...points].reverse().find(x=>x.at<=windowStart);
 const anchored=anchor!==undefined&&anchor!==null;
 let gapsInWindow=0;
 if(anchored){
  let prior=anchor.at;
  for(const p of included){
   if(p.at===prior)continue;
   const gap=p.at-prior;
   if(gap>MAX_GAP||gap<=0)gapsInWindow++;
   prior=p.at;
  }
 }else if(included.length>1){
  for(let i=1;i<included.length;i++)if(included[i].at-included[i-1].at>MAX_GAP)gapsInWindow++;
 }
 const enoughSamples=included.length>=287; // 5-minute cadence with boundary jitter
 const valid=anchored&&enoughSamples&&!stale&&failed===0&&gapsInWindow===0&&!broken;
 return {
  certified24h:valid,
  status:valid?'VERIFIED_24H':stale?'STALE_MONITOR':failed?'FAILED_CYCLES':
    gapsInWindow||broken?'GAPS_DETECTED':!anchored?'INSUFFICIENT_24H_HISTORY':'INSUFFICIENT_SAMPLES',
  lastRecordedAt:last===null?null:new Date(last).toISOString(),
  oldestRetainedAt:first===null?null:new Date(first).toISOString(),
  recordedCoverageHours:Number((coverage/3600000).toFixed(2)),
  requiredHours:24,
  healthyChecksWithinWindow:included.filter(x=>x.healthy).length,
  failedChecksWithinWindow:failed,
  gapsInWindow,stale,
  observationOnly:true,
  note:'Only recorded scheduled cycles count. Retained history begins from the observation log available; old aggregate counters cannot certify missing timestamps.'
 };
}
