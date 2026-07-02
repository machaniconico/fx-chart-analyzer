import {
  createStrategyEvaluator,
  defaultMoneyManagement,
  isWithinTradingSession,
  pipSize,
  priceToPips,
  pipsToPrice,
} from './strategy';
import type { MoneyManagementSettings, StrategyDefinition, StrategyDirection } from './strategy';
import type { Bar, Pair } from '../types';

export type TradeExitReason = 'stop_loss' | 'take_profit' | 'trailing_stop' | 'opposite_signal' | 'end';

export interface BacktestTrade {
  id: number;
  direction: StrategyDirection;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  grossPips: number;
  spreadPips: number;
  netPips: number;
  lotSize: number;
  pipValueYenPerLot: number;
  grossProfitYen: number;
  spreadYen: number;
  netProfitYen: number;
  balanceAfterYen: number;
  exitReason: TradeExitReason;
}

export interface EquityPoint {
  time: number;
  equityPips: number;
  drawdownPips: number;
  equityYen: number;
  netProfitYen: number;
  drawdownYen: number;
  drawdownPct: number;
}

export interface BacktestResult {
  pair: Pair;
  spreadPips: number;
  moneyManagement: MoneyManagementSettings;
  conversionNote: string;
  winRate: number;
  profitFactor: number;
  maxDrawdownPips: number;
  maxDrawdownYen: number;
  maxDrawdownPct: number;
  tradeCount: number;
  netPips: number;
  netProfitYen: number;
  grossProfitPips: number;
  grossLossPips: number;
  grossProfitYen: number;
  grossLossYen: number;
  riskRewardRatio: number;
  averageWinYen: number;
  averageLossYen: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
}

export interface BacktestOptions {
  spreadPips?: number;
  usdJpyBars?: readonly Bar[];
  fallbackUsdJpyRate?: number;
  moneyManagement?: Partial<MoneyManagementSettings>;
  /** @deprecated Drawdown percentage is now based on actual yen balance. */
  initialBalancePips?: number;
}

interface OpenPosition {
  direction: StrategyDirection;
  entryTime: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  trailingStopPrice: number | null;
  activeStopSource: 'stop_loss' | 'trailing_stop';
  lotSize: number;
  pipValueYenPerLot: number;
}

const defaultSpreadPips: Record<Pair, number> = {
  USDJPY: 0.9,
  EURUSD: 0.7,
  GBPJPY: 1.6,
  EURJPY: 1.1,
  AUDJPY: 1.2,
  GBPUSD: 1.0,
};

export const spreadPipsForPair = (pair: Pair): number => defaultSpreadPips[pair];

const DEFAULT_USDJPY_RATE = 150;

const oppositeDirection = (direction: StrategyDirection): StrategyDirection =>
  direction === 'long' ? 'short' : 'long';

const roundPips = (value: number): number => Math.round(value * 10) / 10;

const roundYen = (value: number): number => Math.round(value);

const roundLot = (value: number): number => Math.round(value * 100) / 100;

const sanitizePositive = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;

const resolveMoneyManagement = (
  strategy: StrategyDefinition,
  overrides?: Partial<MoneyManagementSettings>,
): MoneyManagementSettings => {
  const base = strategy.moneyManagement ?? defaultMoneyManagement(strategy.lotSize);
  const merged = { ...base, ...overrides };
  const fallback = defaultMoneyManagement(strategy.lotSize);
  return {
    initialBalanceYen: sanitizePositive(merged.initialBalanceYen, fallback.initialBalanceYen),
    lotSizingMode: merged.lotSizingMode ?? fallback.lotSizingMode,
    fixedLot: sanitizePositive(merged.fixedLot, sanitizePositive(strategy.lotSize, fallback.fixedLot)),
    riskPercent: sanitizePositive(merged.riskPercent, fallback.riskPercent),
    maxLot: Math.max(0.01, sanitizePositive(merged.maxLot, fallback.maxLot)),
  };
};

const nearestBar = (bars: readonly Bar[], time: number): Bar | null => {
  if (bars.length === 0) {
    return null;
  }
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].t === time) {
      return bars[middle];
    }
    if (bars[middle].t < time) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const previous = bars[Math.max(0, high)];
  const next = bars[Math.min(bars.length - 1, low)];
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  return Math.abs(previous.t - time) <= Math.abs(next.t - time) ? previous : next;
};

const pipValueYenPerLot = (
  pair: Pair,
  time: number,
  usdJpyBars: readonly Bar[] | undefined,
  fallbackUsdJpyRate: number,
): { value: number; usedFallback: boolean } => {
  if (pair.endsWith('JPY')) {
    return { value: 1000, usedFallback: false };
  }

  // For EURUSD/GBPUSD, 1 lot is 100,000 units and 1 pip is 10 USD.
  // If synchronized USDJPY bars are unavailable, this intentionally falls back
  // to a fixed USDJPY approximation. The UI surfaces the same assumption.
  const rateBar = usdJpyBars ? nearestBar(usdJpyBars, time) : null;
  const usdJpyRate = sanitizePositive(rateBar?.c, fallbackUsdJpyRate);
  return { value: 10 * usdJpyRate, usedFallback: !rateBar };
};

const conversionNote = (
  pair: Pair,
  usedFallbackUsdJpyRate: boolean,
  fallbackUsdJpyRate: number,
): string => {
  if (pair.endsWith('JPY')) {
    return 'JPYクォートのため、1ロット=10万通貨・1pip=1,000円/lotで円換算しています。';
  }
  if (usedFallbackUsdJpyRate) {
    return `非JPYクォートのため、pip価値(10 USD/pip/lot)をUSDJPY=${fallbackUsdJpyRate}円の固定近似で円換算しています。`;
  }
  return '非JPYクォートのため、pip価値(10 USD/pip/lot)を同時刻近傍のUSDJPYバーで円換算しています。';
};

const lotSizeForEntry = (
  moneyManagement: MoneyManagementSettings,
  strategy: StrategyDefinition,
  currentBalanceYen: number,
  pipValuePerLot: number,
  spreadPips: number,
): number => {
  const cappedLot = (lotSize: number): number =>
    Math.min(moneyManagement.maxLot, Math.max(0.01, roundLot(lotSize)));

  if (moneyManagement.lotSizingMode === 'fixedLot') {
    return cappedLot(moneyManagement.fixedLot);
  }

  if (moneyManagement.lotSizingMode === 'compound') {
    const balanceRatio = currentBalanceYen / moneyManagement.initialBalanceYen;
    return cappedLot(moneyManagement.fixedLot * Math.max(0, balanceRatio));
  }

  const stopLossPips = sanitizePositive(strategy.exit.stopLossPips, 1);
  const riskAmountYen = Math.max(0, currentBalanceYen) * (moneyManagement.riskPercent / 100);
  const lossPerLotYen = (stopLossPips + Math.max(0, spreadPips)) * pipValuePerLot;
  if (riskAmountYen <= 0 || lossPerLotYen <= 0) {
    return cappedLot(moneyManagement.fixedLot);
  }
  return cappedLot(riskAmountYen / lossPerLotYen);
};

const maxConsecutiveOutcomes = (
  trades: readonly BacktestTrade[],
): { wins: number; losses: number } => {
  let currentWins = 0;
  let currentLosses = 0;
  let wins = 0;
  let losses = 0;
  for (const trade of trades) {
    if (trade.netProfitYen > 0) {
      currentWins += 1;
      currentLosses = 0;
    } else if (trade.netProfitYen < 0) {
      currentLosses += 1;
      currentWins = 0;
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
    wins = Math.max(wins, currentWins);
    losses = Math.max(losses, currentLosses);
  }
  return { wins, losses };
};

const closePosition = (
  position: OpenPosition,
  bar: Bar,
  exitPrice: number,
  exitReason: TradeExitReason,
  spreadPips: number,
  nextId: number,
  pair: Pair,
  balanceBeforeCloseYen: number,
): BacktestTrade => {
  const priceMove =
    position.direction === 'long'
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;
  const grossPips = priceToPips(pair, priceMove);
  const netPips = grossPips - spreadPips;
  const grossProfitYen = grossPips * position.pipValueYenPerLot * position.lotSize;
  const spreadYen = spreadPips * position.pipValueYenPerLot * position.lotSize;
  const netProfitYen = grossProfitYen - spreadYen;
  return {
    id: nextId,
    direction: position.direction,
    entryTime: position.entryTime,
    exitTime: bar.t,
    entryPrice: position.entryPrice,
    exitPrice,
    grossPips: roundPips(grossPips),
    spreadPips,
    netPips: roundPips(netPips),
    lotSize: position.lotSize,
    pipValueYenPerLot: roundYen(position.pipValueYenPerLot),
    grossProfitYen: roundYen(grossProfitYen),
    spreadYen: roundYen(spreadYen),
    netProfitYen: roundYen(netProfitYen),
    balanceAfterYen: roundYen(balanceBeforeCloseYen + netProfitYen),
    exitReason,
  };
};

const makePosition = (
  strategy: StrategyDefinition,
  pair: Pair,
  bar: Bar,
  lotSize: number,
  pipValuePerLot: number,
): OpenPosition => {
  const pip = pipSize(pair);
  const direction = strategy.direction;
  const slDistance = strategy.exit.stopLossPips * pip;
  const tpDistance = strategy.exit.takeProfitPips * pip;
  return {
    direction,
    entryTime: bar.t,
    entryPrice: bar.o,
    stopLossPrice: direction === 'long' ? bar.o - slDistance : bar.o + slDistance,
    takeProfitPrice: direction === 'long' ? bar.o + tpDistance : bar.o - tpDistance,
    trailingStopPrice: null,
    activeStopSource: 'stop_loss',
    lotSize,
    pipValueYenPerLot: pipValuePerLot,
  };
};

const resolveIntrabarExit = (
  position: OpenPosition,
  bar: Bar,
): { exitPrice: number; reason: TradeExitReason } | null => {
  const stopPrice = position.trailingStopPrice ?? position.stopLossPrice;
  const stopReason = position.activeStopSource;

  if (position.direction === 'long') {
    const stopTouched = bar.l <= stopPrice;
    const takeProfitTouched = bar.h >= position.takeProfitPrice;
    if (stopTouched) {
      return { exitPrice: stopPrice, reason: stopReason };
    }
    if (takeProfitTouched) {
      return { exitPrice: position.takeProfitPrice, reason: 'take_profit' };
    }
    return null;
  }

  const stopTouched = bar.h >= stopPrice;
  const takeProfitTouched = bar.l <= position.takeProfitPrice;
  if (stopTouched) {
    return { exitPrice: stopPrice, reason: stopReason };
  }
  if (takeProfitTouched) {
    return { exitPrice: position.takeProfitPrice, reason: 'take_profit' };
  }
  return null;
};

const updateTrailingStop = (
  position: OpenPosition,
  bar: Bar,
  trailingStopPips: number | null | undefined,
  pair: Pair,
): void => {
  if (!trailingStopPips || trailingStopPips <= 0) {
    return;
  }

  const distance = pipsToPrice(pair, trailingStopPips);
  if (position.direction === 'long') {
    const candidate = bar.h - distance;
    const current = position.trailingStopPrice ?? position.stopLossPrice;
    if (candidate > current) {
      position.trailingStopPrice = candidate;
      position.activeStopSource = 'trailing_stop';
    }
    return;
  }

  const candidate = bar.l + distance;
  const current = position.trailingStopPrice ?? position.stopLossPrice;
  if (candidate < current) {
    position.trailingStopPrice = candidate;
    position.activeStopSource = 'trailing_stop';
  }
};

export const runBacktest = (
  bars: readonly Bar[],
  strategy: StrategyDefinition,
  pair: Pair,
  options: BacktestOptions = {},
): BacktestResult => {
  const spreadPips = options.spreadPips ?? spreadPipsForPair(pair);
  const moneyManagement = resolveMoneyManagement(strategy, options.moneyManagement);
  const fallbackUsdJpyRate = sanitizePositive(options.fallbackUsdJpyRate, DEFAULT_USDJPY_RATE);
  const evaluator = createStrategyEvaluator(bars);
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let position: OpenPosition | null = null;
  let pendingEntry = false;
  let pendingOppositeClose = false;
  let realizedPips = 0;
  let realizedYen = 0;
  let peakEquityPips = 0;
  let maxDrawdownPips = 0;
  let peakBalanceYen = moneyManagement.initialBalanceYen;
  let maxDrawdownYen = 0;
  let maxDrawdownPct = 0;
  let usedFallbackUsdJpyRate =
    !pair.endsWith('JPY') && (!options.usdJpyBars || options.usdJpyBars.length === 0);

  const recordEquity = (time: number): void => {
    peakEquityPips = Math.max(peakEquityPips, realizedPips);
    const drawdownPips = Math.max(0, peakEquityPips - realizedPips);
    const equityYen = moneyManagement.initialBalanceYen + realizedYen;
    peakBalanceYen = Math.max(peakBalanceYen, equityYen);
    const drawdownYen = Math.max(0, peakBalanceYen - equityYen);
    const drawdownPct = peakBalanceYen <= 0 ? 0 : (drawdownYen / peakBalanceYen) * 100;
    maxDrawdownPips = Math.max(maxDrawdownPips, drawdownPips);
    maxDrawdownYen = Math.max(maxDrawdownYen, drawdownYen);
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    const point = {
      time,
      equityPips: roundPips(realizedPips),
      drawdownPips: roundPips(drawdownPips),
      equityYen: roundYen(equityYen),
      netProfitYen: roundYen(realizedYen),
      drawdownYen: roundYen(drawdownYen),
      drawdownPct,
    };
    if (equityCurve[equityCurve.length - 1]?.time === time) {
      equityCurve[equityCurve.length - 1] = point;
      return;
    }
    equityCurve.push(point);
  };

  if (bars.length > 0) {
    recordEquity(bars[0].t);
  }

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];

    if (position && pendingOppositeClose) {
      const trade = closePosition(
        position,
        bar,
        bar.o,
        'opposite_signal',
        spreadPips,
        trades.length + 1,
        pair,
        moneyManagement.initialBalanceYen + realizedYen,
      );
      trades.push(trade);
      realizedPips += trade.netPips;
      realizedYen += trade.netProfitYen;
      position = null;
      pendingOppositeClose = false;
    }

    if (!position && pendingEntry) {
      if (isWithinTradingSession(bar.t, strategy.sessionFilter)) {
        const pipValue = pipValueYenPerLot(pair, bar.t, options.usdJpyBars, fallbackUsdJpyRate);
        usedFallbackUsdJpyRate ||= pipValue.usedFallback;
        const lotSize = lotSizeForEntry(
          moneyManagement,
          strategy,
          moneyManagement.initialBalanceYen + realizedYen,
          pipValue.value,
          spreadPips,
        );
        position = makePosition(strategy, pair, bar, lotSize, pipValue.value);
      }
      pendingEntry = false;
    }

    if (position) {
      const intrabarExit = resolveIntrabarExit(position, bar);
      if (intrabarExit) {
        const trade = closePosition(
          position,
          bar,
          intrabarExit.exitPrice,
          intrabarExit.reason,
          spreadPips,
          trades.length + 1,
          pair,
          moneyManagement.initialBalanceYen + realizedYen,
        );
        trades.push(trade);
        realizedPips += trade.netPips;
        realizedYen += trade.netProfitYen;
        position = null;
      } else {
        updateTrailingStop(position, bar, strategy.exit.trailingStopPips, pair);
      }
    }

    recordEquity(bar.t);

    if (
      position &&
      strategy.exit.closeOnOppositeSignal &&
      index < bars.length - 1 &&
      evaluator.isEntrySignal(strategy, index, oppositeDirection(strategy.direction))
    ) {
      pendingOppositeClose = true;
      continue;
    }

    if (!position && index < bars.length - 1 && evaluator.isEntrySignal(strategy, index)) {
      pendingEntry = true;
    }
  }

  if (position && bars.length > 0) {
    const last = bars[bars.length - 1];
    const trade = closePosition(
      position,
      last,
      last.c,
      'end',
      spreadPips,
      trades.length + 1,
      pair,
      moneyManagement.initialBalanceYen + realizedYen,
    );
    trades.push(trade);
    realizedPips += trade.netPips;
    realizedYen += trade.netProfitYen;
    recordEquity(last.t);
  }

  const grossProfitPips = trades
    .filter((trade) => trade.netPips > 0)
    .reduce((sum, trade) => sum + trade.netPips, 0);
  const grossLossPips = trades
    .filter((trade) => trade.netPips < 0)
    .reduce((sum, trade) => sum + trade.netPips, 0);
  const grossProfitYen = trades
    .filter((trade) => trade.netProfitYen > 0)
    .reduce((sum, trade) => sum + trade.netProfitYen, 0);
  const grossLossYen = trades
    .filter((trade) => trade.netProfitYen < 0)
    .reduce((sum, trade) => sum + trade.netProfitYen, 0);
  const wins = trades.filter((trade) => trade.netProfitYen > 0).length;
  const losses = trades.filter((trade) => trade.netProfitYen < 0).length;
  const averageWinYen = wins === 0 ? 0 : grossProfitYen / wins;
  const averageLossYen = losses === 0 ? 0 : grossLossYen / losses;
  const profitFactor =
    grossLossYen === 0
      ? grossProfitYen > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : grossProfitYen / Math.abs(grossLossYen);
  const riskRewardRatio =
    averageLossYen === 0
      ? averageWinYen > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : averageWinYen / Math.abs(averageLossYen);
  const consecutive = maxConsecutiveOutcomes(trades);

  return {
    pair,
    spreadPips,
    moneyManagement,
    conversionNote: conversionNote(pair, usedFallbackUsdJpyRate, fallbackUsdJpyRate),
    winRate: trades.length === 0 ? 0 : (wins / trades.length) * 100,
    profitFactor,
    maxDrawdownPips: roundPips(maxDrawdownPips),
    maxDrawdownYen: roundYen(maxDrawdownYen),
    maxDrawdownPct,
    tradeCount: trades.length,
    netPips: roundPips(realizedPips),
    netProfitYen: roundYen(realizedYen),
    grossProfitPips: roundPips(grossProfitPips),
    grossLossPips: roundPips(grossLossPips),
    grossProfitYen: roundYen(grossProfitYen),
    grossLossYen: roundYen(grossLossYen),
    riskRewardRatio,
    averageWinYen: roundYen(averageWinYen),
    averageLossYen: roundYen(averageLossYen),
    maxConsecutiveWins: consecutive.wins,
    maxConsecutiveLosses: consecutive.losses,
    trades,
    equityCurve,
  };
};
