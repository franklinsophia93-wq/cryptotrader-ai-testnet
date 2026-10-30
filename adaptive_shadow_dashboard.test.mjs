import test from 'node:test';
import assert from 'node:assert/strict';
import {blank, status} from './adaptive_shadow_core.mjs';
import {renderDashboard} from './adaptive_shadow_dashboard.mjs';

const now=Date.parse('2026-10-30T15:45:00Z');

test('mobile report renders friendly Portuguese with viewport and no trading controls',()=>{
 const s=status(blank(now));
 const html=renderDashboard(s,now);
 assert.match(html,/<html lang="pt-BR">/);
 assert.match(html,/name="viewport"/);
 assert.match(html,/Monitor experimental/);
 assert.match(html,/BTC/);
 assert.match(html,/ETH/);
 assert.match(html,/Patrimônio fictício total/);
 assert.match(html,/Dados técnicos/);
 assert.doesNotMatch(html,/<script/);
 assert.doesNotMatch(html,/<form/);
});
test('no initialized account is displayed as if initial balance were persisted',()=>{
 const html=renderDashboard(status(undefined),now);
 assert.match(html,/Aguardando primeiro ciclo/);
 assert.match(html,/Sem eventos registrados/);
 assert.doesNotMatch(html,/20\.000/);
});
test('renders local timestamp in Sao Paulo, independent of viewer timezone',()=>{
 const s=status(blank(now));
 s.lastTick=new Date(now).toISOString();
 const html=renderDashboard(s,now);
 assert.match(html,/12:45:00/);
});
test('escapes unexpected strings in market errors and events',()=>{
 const s=status(blank(now));
 s.lastTick=new Date(now).toISOString();
 s.lastError='<img src=x onerror=alert(1)>';
 s.recentEvents=[{at:new Date(now).toISOString(),key:'<script>x</script>',type:'DECISION',reason:'<b>inject</b>'}];
 const html=renderDashboard(s,now);
 assert.doesNotMatch(html,/<img src=x/);
 assert.doesNotMatch(html,/<script>x/);
 assert.doesNotMatch(html,/<b>inject/);
 assert.match(html,/&lt;script&gt;/);
 assert.match(html,/&lt;b&gt;inject/);
});
test('shows real persisted virtual-account details, never claims Binance authentication',()=>{
 const s=status(blank(now));
 s.lastTick=new Date(now).toISOString();
 s.cycles={total:50,healthy:50,failed:0,mostRecent:[]};
 s.portfolios['BTC-USD|1h'].processedClosedBars=5;
 s.portfolios['BTC-USD|1h'].latestDecision={
  regime:'DOWNTREND',chosenStrategy:'reversion',reason:'NO_ENTRY_SIGNAL',
  closedBarAt:new Date(now-3600000).toISOString()
 };
 const html=renderDashboard(s,now);
 assert.match(html,/50 \/ 50/);
 assert.match(html,/Reversão/);
 assert.match(html,/sem sinal de compra/);
 assert.match(html,/20\.000/);
 assert.doesNotMatch(html,/Ativo na Binance/);
});
