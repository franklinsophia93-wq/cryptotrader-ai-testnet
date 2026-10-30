// Read-only mobile dashboard; no controls capable of trading.
const enc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=n=>Number.isFinite(n)?new Intl.NumberFormat('pt-BR',{style:'currency',currency:'USD'}).format(n):'—';
const num=n=>Number.isFinite(n)?new Intl.NumberFormat('pt-BR').format(n):'—';
const time=x=>{const t=Date.parse(x||'');return Number.isFinite(t)?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(t):'—'};
const age=(x,now)=>{const t=Date.parse(x||'');return !Number.isFinite(t)?'sem registro':now-t<60000?'menos de 1 minuto':Math.floor(Math.max(0,now-t)/60000)+' minutos'};
const reasons={CLOSED_BAR_EXIT:'Saída após mudança do sinal no candle fechado',TICK_STOP:'Stop de proteção simulado',TICK_TARGET:'Alvo simulado atingido',BAR_TOO_OLD:'Candle fora da janela segura para entrada',FROZEN_CASH:'Sem estratégia aprovada para este cenário',NO_ENTRY_SIGNAL:'Estratégia selecionada, mas sem sinal de compra',POSITION_OPEN:'Posição virtual já aberta',RISK_GUARD:'Limite de risco atingido',CLOSED_SAME_TICK:'Posição encerrada neste ciclo',ELIGIBLE:'Condição de entrada satisfeita'};
const regimes={UPTREND:'Tendência de alta',DOWNTREND:'Tendência de baixa',SIDEWAYS:'Mercado lateral',HIGH_VOLATILITY:'Alta volatilidade'};
const strategies={trend:'Tendência',reversion:'Reversão',breakout:'Rompimento',range:'Faixa',CASH:'Permanecer em caixa'};
const keys=['BTC-USD|1h','ETH-USD|1h','BTC-USD|6h','ETH-USD|6h'];
const css=[
':root{color-scheme:dark;font-family:system-ui,Arial,sans-serif}*{box-sizing:border-box}',
'body{margin:0;color:#ebf4fa;background:#091520;line-height:1.45}',
'.wrap{margin:auto;padding:25px 15px 50px;max-width:1100px}',
'a{color:#79e0c7;text-underline-offset:3px}h1{font-size:clamp(26px,5vw,36px);margin:6px 0 10px}h2{font-size:20px;margin:25px 0 12px}h3{margin:0;font-size:20px}',
'.eyebrow{color:#65dbbe;font-size:12px;letter-spacing:1px;text-transform:uppercase;font-weight:800}',
'.muted,small{color:#a5b9ca}.note{font-size:14px;color:#acbdce;margin:8px 0 18px}',
'.head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px;flex-wrap:wrap}',
'.pill{border:1px solid #567186;border-radius:99px;padding:6px 10px;font-size:12px;white-space:nowrap}',
'.good{color:#80e8c8;background:#103d32;border-color:#236b52}.warn{color:#ffe1a9;background:#3d321d;border-color:#846a37}',
'.overview{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px}',
'.tile,.card,.events{border:1px solid #2b4154;background:#112234;border-radius:14px;padding:15px}',
'.tile small,.card small{display:block;font-size:12px}.tile strong{font-size:clamp(19px,3vw,29px);display:block;margin-top:4px}',
'.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
'.cardtop{display:flex;align-items:start;justify-content:space-between;gap:10px;flex-wrap:wrap}',
'.numbers{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:18px 0}.numbers b{display:block;font-size:19px}',
'.info{background:#0b1928;padding:13px;border-radius:9px}.info b{display:block;margin:4px 0}',
'.info p{font-size:14px;margin:5px 0}.metrics{font-size:12px;color:#b6c6d4;margin-top:14px}',
'ul{list-style:none;margin:0;padding:0}li{padding:9px 0;border-bottom:1px solid #2b4154;font-size:13px;overflow-wrap:anywhere}',
'li:last-child{border:none}li time{color:#a1b5c5;margin-right:10px}footer{margin-top:25px;border-top:1px solid #2b4154;padding-top:14px;color:#a9bcce;font-size:13px}',
'@media(max-width:650px){.grid{grid-template-columns:1fr}.overview{grid-template-columns:repeat(2,1fr)}.tile:last-child{grid-column:span 2}.numbers b{font-size:17px}}'
].join('');
function marketCard(key,p,accounting){
 const d=p?.latestDecision||{},holding=p?.openPosition,parts=key.split('|');
 return [
 '<article class="card"><div class="cardtop"><div><h3>',enc(parts[0].replace('-USD','')),' <small>',enc(parts[1]),'</small></h3><small>',enc(regimes[d.regime]||'Regime ainda não classificado'),'</small></div>',
 '<span class="pill ',holding?'good':'warn','">',holding?'Posição fictícia aberta':'Sem posição','</span></div>',
 '<div class="numbers"><div><small>Patrimônio virtual</small><b>',enc(usd(p?.equityUSD)),'</b></div><div><small>Saldo em caixa</small><b>',enc(usd(p?.cashUSD)),'</b></div></div>',
 '<div class="info"><small>Estratégia</small><b>',enc(strategies[d.chosenStrategy]||'Aguardando dados'),'</b><p>',enc(reasons[d.reason]||'Aguardando próximo sinal'),'</p>',
 '<small>Candle fechado: ',enc(time(d.closedBarAt)),'</small></div>',
 '<div class="metrics">Decisões: ',num(p?.processedClosedBars||0),' · Negociações encerradas: ',num(p?.closedTrades||0),
 ' · Realizado: ',enc(usd(accounting?.realizedUSD??p?.realizedUSD??0)),
 ' · Não realizado: ',enc(usd(accounting?.unrealizedUSD??0)),'</div>',
 holding?'<p class="note">Posição virtual: '+enc(strategies[holding.strategy]||holding.strategy)+' · entrada '+enc(usd(holding.entryPrice))+'</p>':'',
 '</article>'
 ].join('');
}
function renderPaired(p){
 if(!p?.initialized)return '<section class="events"><p class="note">As duas carteiras de comparação iniciarão juntas no próximo ciclo saudável, sem operações retroativas.</p></section>';
 const arm=(name,title)=>{
  const x=p.arms?.[name];
  return '<div class="tile"><small>'+enc(title)+'</small><strong>'+enc(usd(x?.netResultUSD))+'</strong>'+
    '<small>Patrimônio: '+enc(usd(x?.totalEquityUSD))+' · Operações fechadas: '+num(x?.completedTrades||0)+'</small></div>';
 };
 return '<div class="note">Mesmo período a partir de '+enc(time(p.startedAt))+
  ' (Brasília). Capital virtual novo de US$ 20.000 em cada braço; não inclui posições anteriores.</div>'+
  '<div class="overview">'+arm('adaptive','Seleção adaptativa v4')+
  arm('fixed','Seleção fixa v3')+
  '<div class="tile"><small>Ciclos pareados</small><strong>'+num(p.cycles||0)+'</strong>'+
  '<small>Ignorados por indisponibilidade dos dados: '+num(p.skippedCycles||0)+'</small></div></div>';
}
function renderTrades(trades){
 if(!Array.isArray(trades)||!trades.length)return '<section class="events"><p class="note">Sem novas operações encerradas disponíveis no histórico recente.</p></section>';
 return '<section class="events"><ul>'+trades.slice(0,8).map(t=>
  '<li><time>'+enc(time(t.exitedAt))+'</time><b>'+enc(t.market)+'</b> · Resultado: '+
  enc(usd(t.realizedUSD))+' · '+enc(reasons[t.reason]||t.reason||'Saída registrada')+
  ' · Taxa de saída aproximada: '+enc(usd(t.modeledExitFeeUSD))+
  (t.matchedEntry?' · Taxas totais aproximadas: '+enc(usd(t.modeledTotalFeesUSD)):' · entrada não disponível neste histórico')+
  '</li>').join('')+'</ul></section>';
}
export function renderDashboard(s,now=Date.now()){
 const initialized=s?.initialized===true;
 const portfolios=s?.portfolios||{},cycles=s?.cycles||{};
 const finance=s?.financialAudit||null,paired=s?.pairedComparison||null;
 const equity=keys.reduce((a,k)=>a+(Number(portfolios[k]?.equityUSD)||0),0);
 const positions=keys.filter(k=>portfolios[k]?.openPosition).length;
 const last=Date.parse(s?.lastTick||'');
 const stale=!Number.isFinite(last)||now-last>11*60000;
 const alert=!initialized||stale||Boolean(s?.lastError);
 const label=!initialized?'Aguardando primeiro ciclo':s?.lastError?'Última consulta apresentou erro':stale?'Dados sem atualização recente':'Execução recente confirmada';
 const events=Array.isArray(s?.recentEvents)?s.recentEvents.slice(-8).reverse():[];
 const items=events.map(e=>[
  '<li><time>',enc(time(e.at)),'</time><b>',enc(e.key||'Monitor'),'</b> — ',
  enc(e.type==='VIRTUAL_BUY'?'Compra simulada':e.type==='VIRTUAL_SELL'?'Venda simulada':'Decisão'),
  ' · ',enc(reasons[e.reason]||e.reason||strategies[e.strategy]||'Registrado'),'</li>'
 ].join('')).join('');
 return [
  '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="60"><title>CryptoTrader AI v4 — Monitor</title>',
  '<style>',css,'</style></head><body><main class="wrap">',
  '<div class="head"><div><div class="eyebrow">CryptoTrader AI · Adaptive Shadow v4</div><h1>Monitor experimental</h1>',
  '<p class="note">Simulação prospectiva sem acesso a ordens financeiras.</p></div><span class="pill ',alert?'warn':'good','">',enc(label),'</span></div>',
  '<p class="note"><a href="/status">Dados técnicos</a> · <a href="/configuration">Estratégias congeladas</a></p>',
  '<section class="overview"><div class="tile"><small>Patrimônio fictício total</small><strong>',initialized?enc(usd(equity)):'—','</strong></div>',
  '<div class="tile"><small>Ciclos saudáveis / total</small><strong>',num(cycles.healthy||0),' / ',num(cycles.total||0),'</strong></div>',
  '<div class="tile"><small>Posições abertas</small><strong>',initialized?num(positions):'—','</strong></div>',
  '<div class="tile"><small>Resultado realizado</small><strong>',initialized?enc(usd(finance?.realizedUSD)):'—','</strong></div>',
  '<div class="tile"><small>Resultado não realizado*</small><strong>',initialized?enc(usd(finance?.unrealizedUSD)):'—','</strong></div>',
  '<div class="tile"><small>Resultado total simulado</small><strong>',initialized?enc(usd(finance?.totalResultUSD)):'—','</strong></div></section>',
  '<p class="note">Último ciclo: ',enc(time(s?.lastTick)),' (Brasília), ',enc(age(s?.lastTick,now)),'. ',
  s?.lastError?'Último erro: '+enc(s.lastError)+'. ':'','Atualização automática desta página a cada 60 segundos.</p>',
  '<h2>Quatro contas virtuais independentes</h2><section class="grid">',
  keys.map(k=>marketCard(k,portfolios[k],finance?.accounts?.[k])).join(''),
  '</section><h2>Comparação prospectiva: adaptativo x fixo</h2>',
  renderPaired(paired),
  '<h2>Últimas operações encerradas</h2>',renderTrades(s?.recentClosedTrades),
  '<h2>Atividade recente</h2><section class="events"><ul>',
  items||'<li>Sem eventos registrados.</li>','</ul></section>',
  '<footer>Coinbase Exchange pública · saldos e negociações exclusivamente fictícios · US$ 5.000 iniciais por cenário. ',
  'O resultado não realizado* é uma estimativa de liquidação da posição virtual, incluindo custos modelados. ',
  'As taxas de eventos antigos são reconstruídas a partir de números arredondados, não recibos de corretora. ',
  'As decisões dependem de candles fechados e os preços são amostrados a cada cinco minutos. ',
  'Este monitor não demonstra lucros, disponibilidade contínua de 24 horas nem desempenho real de corretora.</footer>',
  '</main></body></html>'
 ].join('');
}
