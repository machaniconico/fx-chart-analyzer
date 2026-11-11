/**
 * Deterministic VIRTUAL ONLY event-tape replay. No broker/network/persistence.
 * Not an OHLC executor: caller supplies point-in-time executable bid/ask quotes
 * and contemporaneous quote-currency -> account-currency conversion. No intra-bar
 * path, liquidity, margin, swaps or financing model is claimed. Stops can gap.
 *
 * replayVirtualPortfolio({ config, instruments, events }) starts flat.
 * config: initialEquity, maxTotalRiskFraction, maxCurrencyRiskFraction,
 * maxDailyLossFraction, maxDrawdownFraction, maxPositions, maxQuoteAgeMs,
 * maxSignalAgeMs (entry intents only), maxGrossLeverage. All fields required; fractions in (0,1].
 * instruments: { SYMBOL: {base, quote, contractSize, lotStep, minLot, maxLot,
 * commissionPerLot, slippage} }. Costs are per side in account currency/price.
 * events: integer UTC epoch milliseconds `t`; chronological (ties allowed).
 * quote: {type:'quote',t,observedAt:t,conversionObservedAt,symbol,bid,ask,quoteToAccount}
 * enter: {type:'enter',t,id,ea,symbol,side:'long'|'short',stop,riskFraction,priority}
 * exit: {type:'exit',t,id,positionId} (positionId is the entry id).
 * An intent executes only on a strictly later quote, never the signal quote.
 * Ties: all quotes mark atomically, stops, requested exits, then entries ordered
 * by signal time, ascending priority, id. Stop wins over requested exit.
 * UTC daily loss is latched until the next UTC day; drawdown is latched forever.
 * Gates deny new entries, not forcibly liquidate stale/unquoted positions.
 * Exit intents persist through feed gaps until a later quote or tape end.
 * Equity is conservative liquidation equity including exit slippage/commission.
 * Admission caps use projected post-fill equity and remaining mark-to-stop risk;
 * entry sizing/plannedRisk use pre-fill equity and full round-trip loss.
 * Per-currency stop risk counts both legs without netting; opposing currency
 * legs are blocked. Risk budgets are planned losses, NOT gap-loss guarantees.
 * Invalid input/state throws without returning a partial successful replay.
 */
const fail = message => { throw new Error(`virtual-portfolio: ${message}`); };
const object = (x, label) => { if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`${label} must be an object`); };
const number = (x, label, min = 0, inclusive = false) => {
  if (!Number.isFinite(x) || (inclusive ? x < min : x <= min)) fail(`invalid ${label}`);
};
const integer = (x, label, min = 0) => { if (!Number.isSafeInteger(x) || x < min) fail(`invalid ${label}`); };
const name = (x, label) => { if (typeof x !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(x)) fail(`invalid ${label}`); };
const keys = (x, allowed, label) => { for (const k of Object.keys(x)) if (!allowed.includes(k)) fail(`unknown ${label} field ${k}`); };
const fraction = (x, label) => { number(x, label); if (x > 1) fail(`invalid ${label}`); };
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function replayVirtualPortfolio(input) {
  object(input, 'input'); keys(input, ['config', 'instruments', 'events'], 'input');
  const { config: c, instruments, events } = input;
  object(c, 'config'); object(instruments, 'instruments');
  keys(c, ['initialEquity', 'maxTotalRiskFraction', 'maxCurrencyRiskFraction', 'maxDailyLossFraction', 'maxDrawdownFraction', 'maxPositions', 'maxQuoteAgeMs', 'maxSignalAgeMs', 'maxGrossLeverage'], 'config');
  number(c.initialEquity, 'initialEquity'); number(c.maxGrossLeverage, 'maxGrossLeverage');
  for (const k of ['maxTotalRiskFraction', 'maxCurrencyRiskFraction', 'maxDailyLossFraction', 'maxDrawdownFraction']) fraction(c[k], k);
  for (const k of ['maxPositions', 'maxQuoteAgeMs', 'maxSignalAgeMs']) integer(c[k], k, 1);
  if (!Object.keys(instruments).length) fail('no instruments');
  for (const [symbol, spec] of Object.entries(instruments)) {
    name(symbol, 'symbol'); object(spec, 'instrument');
    keys(spec, ['base', 'quote', 'contractSize', 'lotStep', 'minLot', 'maxLot', 'commissionPerLot', 'slippage'], 'instrument');
    for (const k of ['base', 'quote']) if (!/^[A-Z]{3}$/.test(spec[k])) fail(`invalid ${k}`);
    if (spec.base === spec.quote) fail('identical currency legs');
    for (const k of ['contractSize', 'lotStep', 'minLot', 'maxLot']) number(spec[k], k);
    for (const k of ['commissionPerLot', 'slippage']) number(spec[k], k, 0, true);
    if (spec.minLot > spec.maxLot || spec.lotStep > spec.maxLot) fail('invalid lot bounds');
  }
  if (!Array.isArray(events)) fail('events must be an array');
  // Validate the entire tape before simulation; duplicate timestamps per symbol
  // are ambiguous observations, not an invitation to cherry-pick a fill.
  const ids = new Set(), quoteIds = new Set(); let previous = -1;
  for (const e of events) {
    object(e, 'event'); integer(e.t, 'timestamp');
    if (e.t > 8640000000000000 || e.t < previous) fail('invalid or backwards timestamp'); previous = e.t;
    if (!['quote', 'enter', 'exit'].includes(e.type)) fail('unknown event type');
    const fields = e.type === 'quote' ? ['symbol', 'bid', 'ask', 'quoteToAccount', 'observedAt', 'conversionObservedAt'] : e.type === 'enter' ? ['id', 'ea', 'symbol', 'side', 'stop', 'riskFraction', 'priority'] : ['id', 'positionId'];
    keys(e, ['type', 't', ...fields], 'event');
    if (e.type !== 'exit' && !Object.hasOwn(instruments, e.symbol)) fail('unknown symbol');
    if (e.type === 'quote') {
      for (const k of ['bid', 'ask', 'quoteToAccount']) number(e[k], k);
      integer(e.observedAt, 'observedAt'); integer(e.conversionObservedAt, 'conversionObservedAt');
      if (e.observedAt !== e.t || e.conversionObservedAt > e.t || e.t - e.conversionObservedAt > c.maxQuoteAgeMs) fail('noncontemporaneous quote or conversion');
      if (e.ask < e.bid || e.bid <= instruments[e.symbol].slippage) fail('invalid executable quote');
      const key = `${e.t}/${e.symbol}`; if (quoteIds.has(key)) fail('duplicate quote'); quoteIds.add(key);
    } else {
      name(e.id, 'id'); if (ids.has(e.id)) fail('duplicate intent id'); ids.add(e.id);
      if (e.type === 'exit') name(e.positionId, 'positionId');
      else {
        name(e.ea, 'ea'); number(e.stop, 'stop'); fraction(e.riskFraction, 'riskFraction'); integer(e.priority, 'priority');
        if (!['long', 'short'].includes(e.side)) fail('invalid side');
      }
    }
  }
  let cash = c.initialEquity, peak = cash, dayStart = cash, day = null, dailyHalt = false, drawdownHalt = false;
  const quotes = new Map(), positions = new Map(), audit = [], curve = []; let pending = [];
  const emit = (t, type, detail = {}) => audit.push({ sequence: audit.length, t, type, ...detail });
  const sign = p => p.side === 'long' ? 1 : -1;
  const liquidationPrice = (p, q) => sign(p) === 1 ? q.bid - instruments[p.symbol].slippage : q.ask + instruments[p.symbol].slippage;
  const pnl = (p, q) => sign(p) * (liquidationPrice(p, q) - p.entryPrice) * p.lots * instruments[p.symbol].contractSize * q.quoteToAccount - instruments[p.symbol].commissionPerLot * p.lots;
  const equity = () => cash + [...positions.values()].reduce((sum, p) => sum + pnl(p, quotes.get(p.symbol)), 0);
  const check = t => {
    const eq = equity(); if (!Number.isFinite(eq) || !Number.isFinite(cash)) fail('non-finite account state');
    peak = Math.max(peak, eq);
    if (!dailyHalt && eq <= dayStart * (1 - c.maxDailyLossFraction)) { dailyHalt = true; emit(t, 'halt', { reason: 'daily-loss', equity: eq }); }
    if (!drawdownHalt && eq <= peak * (1 - c.maxDrawdownFraction)) { drawdownHalt = true; emit(t, 'halt', { reason: 'drawdown', equity: eq }); }
    return eq;
  };
  const close = (p, t, reason) => {
    const q = quotes.get(p.symbol), net = pnl(p, q); cash += net; positions.delete(p.id);
    emit(t, 'close', { id: p.id, reason, lots: p.lots, price: liquidationPrice(p, q), netPnlExcludingEntryFee: net, cash }); check(t);
  };
  const reject = (e, t, reason) => emit(t, 'reject', { id: e.id, reason });
  const order = (a, b) => a.t - b.t || (a.priority ?? 0) - (b.priority ?? 0) || compareText(a.id, b.id);
  for (let i = 0; i < events.length;) {
    const t = events[i].t, group = []; while (i < events.length && events[i].t === t) group.push(events[i++]);
    const nextDay = Math.floor(t / 86400000);
    if (day !== nextDay) { day = nextDay; dayStart = equity(); dailyHalt = dayStart <= 0; emit(t, 'day-start', { day, equity: dayStart }); }
    const updated = new Set();
    for (const e of group.filter(e => e.type === 'quote').sort((a, b) => compareText(a.symbol, b.symbol))) {
      quotes.set(e.symbol, { ...e }); updated.add(e.symbol); emit(t, 'quote', { symbol: e.symbol, bid: e.bid, ask: e.ask, quoteToAccount: e.quoteToAccount, observedAt: e.observedAt, conversionObservedAt: e.conversionObservedAt });
    }
    check(t); // Latch unrealized breaches even if later exits/recovery would hide them.
    for (const p of [...positions.values()].sort((a, b) => compareText(a.id, b.id))) {
      if (!updated.has(p.symbol)) continue;
      const q = quotes.get(p.symbol);
      if (sign(p) === 1 ? q.bid <= p.stop : q.ask >= p.stop) close(p, t, 'stop-observed-quote');
    }
    const eligible = [], waiting = [];
    for (const e of pending) {
      if (e.type === 'enter' && t - e.t > c.maxSignalAgeMs) { reject(e, t, 'intent-expired'); continue; }
      const symbol = e.type === 'enter' ? e.symbol : positions.get(e.positionId)?.symbol;
      if (e.type === 'exit' && !symbol) { reject(e, t, 'position-not-open'); continue; }
      if (t > e.t && updated.has(symbol)) eligible.push(e); else waiting.push(e);
    }
    pending = waiting;
    for (const e of eligible.filter(e => e.type === 'exit').sort(order)) {
      const p = positions.get(e.positionId); if (p) close(p, t, 'requested-exit'); else reject(e, t, 'position-not-open');
    }
    for (const e of eligible.filter(e => e.type === 'enter').sort(order)) {
      const eq = check(t), spec = instruments[e.symbol], q = quotes.get(e.symbol), s = sign(e);
      if (drawdownHalt || dailyHalt || eq <= 0) { reject(e, t, drawdownHalt ? 'drawdown-halt' : 'daily-loss-halt'); continue; }
      if ([...positions.values()].some(p => t - Math.min(quotes.get(p.symbol).t, quotes.get(p.symbol).conversionObservedAt) > c.maxQuoteAgeMs)) { reject(e, t, 'stale-portfolio-mark'); continue; }
      if (positions.size >= c.maxPositions) { reject(e, t, 'max-positions'); continue; }
      const legs = p => [[instruments[p.symbol].base, sign(p)], [instruments[p.symbol].quote, -sign(p)]];
      if ([...positions.values()].some(p => legs(p).some(([currency, direction]) => legs(e).some(([cc, dd]) => currency === cc && direction !== dd)))) { reject(e, t, 'currency-exposure-conflict'); continue; }
      const entryPrice = s === 1 ? q.ask + spec.slippage : q.bid - spec.slippage;
      if (s === 1 ? e.stop >= q.bid : e.stop <= q.ask) { reject(e, t, 'stop-not-protective-at-fill'); continue; }
      const riskPerLot = (s * (entryPrice - e.stop) + spec.slippage) * spec.contractSize * q.quoteToAccount + 2 * spec.commissionPerLot;
      if (!Number.isFinite(riskPerLot) || riskPerLot <= 0) fail('non-finite sizing risk');
      const lots = Math.floor(Math.min(eq * e.riskFraction / riskPerLot, spec.maxLot) / spec.lotStep) * spec.lotStep;
      if (!Number.isFinite(lots) || lots < spec.minLot) { reject(e, t, 'below-min-lot'); continue; }
      const candidate = { id: e.id, ea: e.ea, symbol: e.symbol, side: e.side, stop: e.stop, lots, entryPrice, enteredAt: t };
      const newRisk = lots * riskPerLot;
      const postFillEquity = eq - lots * spec.commissionPerLot + pnl(candidate, q);
      // Entry friction is already deducted from post-fill liquidation equity.
      // Both old and new positions therefore use remaining mark-to-stop loss,
      // excluding commissions/slippage already reserved in liquidation marks.
      const remainingRisk = (p, mark) => {
        const ps = instruments[p.symbol];
        return Math.max(0, sign(p) * (liquidationPrice(p, mark) - (p.stop - sign(p) * ps.slippage)) * p.lots * ps.contractSize * mark.quoteToAccount);
      };
      const newRemainingRisk = remainingRisk(candidate, q);
      let totalRisk = newRemainingRisk;
      const currencyRisk = new Map([[spec.base, newRemainingRisk], [spec.quote, newRemainingRisk]]);
      let gross = lots * spec.contractSize * q.ask * q.quoteToAccount;
      for (const p of positions.values()) {
        const mark = quotes.get(p.symbol), ps = instruments[p.symbol];
        // Loss from currently marked equity to planned stop execution; no hedging credit.
        const risk = remainingRisk(p, mark);
        totalRisk += risk;
        for (const currency of [ps.base, ps.quote]) currencyRisk.set(currency, (currencyRisk.get(currency) ?? 0) + risk);
        gross += p.lots * ps.contractSize * mark.ask * mark.quoteToAccount;
      }
      if (![newRisk, postFillEquity, totalRisk, gross, ...currencyRisk.values()].every(Number.isFinite)) fail('non-finite risk state');
      if (postFillEquity <= 0) { reject(e, t, 'nonpositive-post-fill-equity'); continue; }
      if (postFillEquity <= dayStart * (1 - c.maxDailyLossFraction)) { reject(e, t, 'post-fill-daily-loss'); continue; }
      if (postFillEquity <= peak * (1 - c.maxDrawdownFraction)) { reject(e, t, 'post-fill-drawdown'); continue; }
      if (totalRisk > postFillEquity * c.maxTotalRiskFraction) { reject(e, t, 'total-stop-risk'); continue; }
      if ([...currencyRisk.values()].some(r => r > postFillEquity * c.maxCurrencyRiskFraction)) { reject(e, t, 'currency-stop-risk'); continue; }
      if (gross > postFillEquity * c.maxGrossLeverage) { reject(e, t, 'gross-leverage'); continue; }
      cash -= lots * spec.commissionPerLot;
      positions.set(e.id, candidate);
      emit(t, 'open', { ...positions.get(e.id), signalAt: e.t, sizingEquity: eq, plannedRisk: newRisk, remainingStopRisk: newRemainingRisk, postFillEquity, entryFee: lots * spec.commissionPerLot }); check(t);
    }
    for (const e of group.filter(e => e.type !== 'quote').sort(order)) { pending.push({ ...e }); const { type, ...detail } = e; emit(t, 'intent', { ...detail, intentType: type }); }
    const eq = check(t); curve.push({ t, cash, equity: eq, positions: positions.size, dailyHalt, drawdownHalt, staleMarks: [...positions.values()].filter(p => t - Math.min(quotes.get(p.symbol).t, quotes.get(p.symbol).conversionObservedAt) > c.maxQuoteAgeMs).map(p => p.id).sort() });
  }
  const lastTime = events.at(-1)?.t ?? null;
  for (const e of pending.sort(order)) reject(e, lastTime, 'no-later-executable-quote');
  return { mode: 'virtual-only', cash, equity: equity(), positions: [...positions.values()].map(p => ({ ...p })), audit, equityCurve: curve, dailyHalt, drawdownHalt };
}
