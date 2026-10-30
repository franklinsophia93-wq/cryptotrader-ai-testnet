// Pure read-only accounting/reporting; never changes decisions or stored capital.
import {CONFIG, KEYS} from './adaptive_shadow_core.mjs';
const round=(n,d=2)=>Number(n.toFixed(d));
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const clean=n=>finite(n)?n:0;
export function deriveFinancials(state){
 if(!state?.portfolios)return null;
 const accounts={};
 for(const key of KEYS){
  const p=state.portfolios[key];
  if(!p)continue;
  const equity=clean(p.equityUSD),cash=clean(p.cashUSD),realized=clean(p.realizedUSD);
  const open=Boolean(p.position);
  // Marked equity is already net of estimated liquidation fees and slippage.
  // Without a position there is no unrealized P&L, even if equity is rounded.
  const unrealized=open?round(equity-cash-clean(p.position.costUSD)):0;
  accounts[key]={equityUSD:round(equity),cashUSD:round(cash),
    realizedUSD:round(realized),unrealizedUSD:unrealized,
    totalResultUSD:round(equity-5000),openPosition:open,
    completedTrades:p.trades||0,winningTrades:p.wins||0,
    accounting:'SIMULATED_EXIT_NET_OF_MODELED_SLIPPAGE_AND_FEES'};
 }
 const vals=Object.values(accounts);
 return {startedAt:state.startedAt,initialTotalUSD:5000*KEYS.length,
  totalEquityUSD:round(vals.reduce((n,x)=>n+x.equityUSD,0)),
  realizedUSD:round(vals.reduce((n,x)=>n+x.realizedUSD,0)),
  unrealizedUSD:round(vals.reduce((n,x)=>n+x.unrealizedUSD,0)),
  totalResultUSD:round(vals.reduce((n,x)=>n+x.totalResultUSD,0)),
  openPositions:vals.filter(x=>x.openPosition).length,
  completedTrades:vals.reduce((n,x)=>n+x.completedTrades,0),
  accounts, 
  explanation:'Unrealized values assume immediate virtual liquidation including modeled fees/slippage; no real fill is guaranteed.'};
}
export function reconstructTrades(state,max=20){
 if(!state?.events)return [];
 const buys=new Map(),trades=[];
 for(const event of state.events){
  if(!KEYS.includes(event.key))continue;
  if(event.type==='VIRTUAL_BUY'){buys.set(event.key,event);continue;}
  if(event.type!=='VIRTUAL_SELL')continue;
  const buy=buys.get(event.key);
  const qty=clean(event.quantity),salePrice=clean(event.price);
  const sellFee=round(qty*salePrice*CONFIG.fee,4);
  let result={market:event.key,exitedAt:event.at,reason:event.reason,
    strategy:event.strategy,realizedUSD:finite(event.realizedUSD)?round(event.realizedUSD):null,
    modeledExitFeeUSD:sellFee,feeMethod:'ESTIMATED_FROM_ROUNDED_EVENT',
    matchedEntry:!!buy};
  if(buy){
   const buyQty=clean(buy.quantity),buyPrice=clean(buy.price),budget=clean(buy.allocatedUSD);
   result={...result,enteredAt:buy.at,entryPriceUSD:buyPrice,exitPriceUSD:salePrice,
    quantity:qty,modeledEntryFeeUSD:round(Math.max(0,budget-buyQty*buyPrice),4),
    modeledTotalFeesUSD:round(Math.max(0,budget-buyQty*buyPrice)+sellFee,4)};
   buys.delete(event.key);
  }
  trades.push(result);
 }
 return trades.slice(-Math.max(0,Math.min(100,max))).reverse();
}