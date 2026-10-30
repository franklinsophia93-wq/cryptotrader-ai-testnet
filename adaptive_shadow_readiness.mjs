// Read-only research sufficiency assessment. NEVER authorizes orders or strategy promotion.
// Evaluates a fair simultaneous forward comparison, not historical backtest results.
import {summarizePaired} from './adaptive_paired_forward.mjs';
const MIN_DAYS=30;
const MIN_CLOSED_TRADES_PER_ARM=30;
const DAY=86400000;
const round=(n,d=2)=>Number(n.toFixed(d));
export function assessResearch(paired,operational,now=Date.now()){
 const base={mode:'OBSERVATION_ONLY',automaticPromotion:false,realOrdersAuthorized:false,
   minimumDays:MIN_DAYS,minimumClosedTradesPerArm:MIN_CLOSED_TRADES_PER_ARM,
   warnings:['This is a sample-size gate, not a statistical significance test or investment recommendation.',
     'Virtual trading uses sampled Coinbase prices, estimated costs and no order-book executions.',
     'Successful validation NEVER activates real trades. Human review remains necessary.']};
 if(!paired)return{...base,status:'NOT_STARTED',elapsedDays:0,
   operational24hVerified:operational?.certified24h===true,
   sampleAdequate:false,adaptiveTrades:0,fixedTrades:0};
 const start=Date.parse(paired.startedAt||''),last=Date.parse(paired.lastTick||'');
 const invalid=!Number.isFinite(start)||!Number.isFinite(last)||
   !Number.isFinite(now)||start>last||last>now+60000;
 if(invalid)return{...base,status:'INVALID_OBSERVATION_DATES',elapsedDays:0,
   operational24hVerified:false,sampleAdequate:false};
 const summary=summarizePaired(paired);
 const adaptive=summary.arms.adaptive,fixed=summary.arms.fixed;
 const goodCount=n=>Number.isSafeInteger(n)&&n>=0;
 const goodDollar=n=>typeof n==='number'&&Number.isFinite(n);
 if(![adaptive,fixed].every(x=>x&&goodCount(x.completedTrades)&&
     goodDollar(x.netResultUSD)&&goodDollar(x.totalEquityUSD)))
    return{...base,status:'INVALID_PAIRED_ACCOUNTING',sampleAdequate:false};
 const elapsedDays=Math.max(0,(last-start)/DAY),
   timeQualified=elapsedDays>=MIN_DAYS,
   tradesQualified=adaptive.completedTrades>=MIN_CLOSED_TRADES_PER_ARM&&
     fixed.completedTrades>=MIN_CLOSED_TRADES_PER_ARM,
   operational24hVerified=operational?.certified24h===true,
   fresh=now-last<=11*60000,
   skippedCycles=paired.skippedCycles||0;
 const checks={minObservationDays:timeQualified,
   minClosedTradesBothArms:tradesQualified,
   operational24hVerified,upToDate:fresh,
   noSkippedPairedCycles:skippedCycles===0};
 const complete=Object.values(checks).every(Boolean);
 const status=complete?'READY_FOR_MANUAL_RESEARCH_REVIEW':
   !fresh?'DATA_NOT_RECENT':!operational24hVerified?'OPERATIONAL_24H_NOT_VERIFIED':
   !timeQualified?'INSUFFICIENT_FORWARD_DAYS':!tradesQualified?'INSUFFICIENT_CLOSED_TRADES':
   'PAIRED_CYCLES_SKIPPED';
 return{...base,status,elapsedDays:round(elapsedDays,3),
   startedAt:paired.startedAt,lastTick:paired.lastTick,
   adaptiveTrades:adaptive.completedTrades,fixedTrades:fixed.completedTrades,
   adaptiveNetUSD:adaptive.netResultUSD,fixedNetUSD:fixed.netResultUSD,
   adaptiveMinusFixedUSD:round(adaptive.netResultUSD-fixed.netResultUSD),
   skippedPairedCycles:skippedCycles,checks,sampleAdequate:complete,
   resultInterpretation:'Descriptive difference only; no confidence interval or claim of statistically superior strategy.'};
}