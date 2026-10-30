// Operational telemetry for a fictional-only portfolio; no exchange credentials or orders.
export const CADENCE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 310; // > 24 h at one observation per five minutes

const iso = n => new Date(n).toISOString();
const finiteTime = t => typeof t === 'number' && Number.isFinite(t);

export function recordCycle(state, now, healthy, error = null) {
  if (!finiteTime(now)) throw Error('INVALID_CYCLE_TIME');
  const m = state.cycleMetrics ?? {
    firstObservedAt: null, totalCycles: 0, successfulCycles: 0, failedCycles: 0,
    consecutiveFailures: 0, lastSuccessfulAt: null, lastFailedAt: null, history: []
  };
  const history = Array.isArray(m.history) ? m.history : [];
  const last = history.length ? history[history.length - 1] : null;
  // Avoid double-counting duplicate invocations of the same nominal cycle.
  if (last && now - last.t >= 0 && now - last.t < 60_000) {
    state.cycleMetrics = m;
    return state;
  }
  if (!m.firstObservedAt) m.firstObservedAt = iso(now);
  m.totalCycles++;
  const ok = healthy === true;
  if (ok) {
    m.successfulCycles++;
    m.consecutiveFailures = 0;
    m.lastSuccessfulAt = iso(now);
  } else {
    m.failedCycles++;
    m.consecutiveFailures++;
    m.lastFailedAt = iso(now);
  }
  history.push({ t: now, ok, code: ok ? null : (
    typeof error === 'string' && /^(HTTP_[0-9]{3}|[A-Z_]{3,40})$/.test(error)
      ? error : 'DATA_UNAVAILABLE') });
  m.history = history.slice(-MAX_RECORDS);
  state.cycleMetrics = m;
  return state;
}

export function summarizeCycles(metrics, now) {
  const blank = {
    has24HourEvidence: false, expectedCyclesIn24h: 288, observedCyclesInWindow: 0,
    healthyCyclesInWindow: 0, failedCyclesInWindow: 0, missingIntervalsEstimate: 0,
    maxGapMinutes: null, coveredHours: 0, fullDayVerified: false
  };
  if (!metrics) return {
    ...blank, totalCycles: 0, successfulCycles: 0, failedCycles: 0,
    consecutiveFailures: 0, lastSuccessfulAt: null, lastFailedAt: null, recentCycles: []
  };
  const history = (metrics.history || []).filter(x =>
    finiteTime(x.t) && x.t >= now - DAY_MS && x.t <= now).sort((a,b) => a.t-b.t);
  const okCount = history.filter(x=>x.ok).length;
  let missing = 0, maxGap = 0;
  for (let i = 1; i < history.length; i++) {
    const gap = history[i].t - history[i-1].t;
    maxGap = Math.max(maxGap, gap);
    missing += Math.max(0, Math.round(gap/CADENCE_MS)-1);
  }
  const covered = history.length > 1 ? history[history.length-1].t-history[0].t : 0;
  // Not a certification before a continuous, healthy, full-day observed window.
  const full = history.length >= 280 && covered >= DAY_MS-CADENCE_MS-60_000
    && missing === 0 && okCount === history.length && maxGap <= 7.5*60_000;
  return {
    has24HourEvidence: full, expectedCyclesIn24h: 288,
    observedCyclesInWindow: history.length, healthyCyclesInWindow: okCount,
    failedCyclesInWindow: history.length-okCount, missingIntervalsEstimate: missing,
    maxGapMinutes: history.length > 1 ? Number((maxGap/60_000).toFixed(2)) : null,
    coveredHours: Number((covered/3_600_000).toFixed(2)),
    fullDayVerified: full,
    totalCycles: metrics.totalCycles||0, successfulCycles: metrics.successfulCycles||0,
    failedCycles: metrics.failedCycles||0, consecutiveFailures: metrics.consecutiveFailures||0,
    lastSuccessfulAt: metrics.lastSuccessfulAt||null, lastFailedAt: metrics.lastFailedAt||null,
    recentCycles: history.slice(-12).map(x=>({at:iso(x.t),healthy:x.ok,error:x.code}))
  };
}
