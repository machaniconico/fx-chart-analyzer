import { createStrategyEvaluator, isWithinTradingSession, pipSize, priceToPips, pipsToPrice } from './strategy';
import type { StrategyDefinition, StrategyDirection } from './strategy';
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
  exitReason: TradeExitReason;
}

export interface EquityPoint {
  time: number;
  equityPips: number;
  drawdownPips: number;
  drawdownPct: number;
}

export interface BacktestResult {
  pair: Pair;
  spreadPips: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPips: number;
  maxDrawdownPct: number;
  tradeCount: number;
  netPips: number;
  grossProfitPips: number;
  grossLossPips: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
}

export interface BacktestOptions {
  spreadPips?: number;
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

const oppositeDirection = (direction: StrategyDirection): StrategyDirection =>
  direction === 'long' ? 'short' : 'long';

const roundPips = (value: number): number => Math.round(value * 10) / 10;

const closePosition = (
  position: OpenPosition,
  bar: Bar,
  exitPrice: number,
  exitReason: TradeExitReason,
  spreadPips: number,
  nextId: number,
  pair: Pair,
): BacktestTrade => {
  const priceMove =
    position.direction === 'long'
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;
  const grossPips = priceToPips(pair, priceMove);
  const netPips = grossPips - spreadPips;
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
    exitReason,
  };
};

const makePosition = (
  strategy: StrategyDefinition,
  pair: Pair,
  bar: Bar,
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
  const initialBalancePips = options.initialBalancePips ?? 10_000;
  const evaluator = createStrategyEvaluator(bars);
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let position: OpenPosition | null = null;
  let pendingEntry = false;
  let pendingOppositeClose = false;
  let realizedPips = 0;
  let peakEquityPips = 0;
  let maxDrawdownPips = 0;
  let maxDrawdownPct = 0;

  const recordEquity = (time: number): void => {
    peakEquityPips = Math.max(peakEquityPips, realizedPips);
    const drawdownPips = Math.max(0, peakEquityPips - realizedPips);
    const denominator = Math.max(1, initialBalancePips + peakEquityPips);
    const drawdownPct = (drawdownPips / denominator) * 100;
    maxDrawdownPips = Math.max(maxDrawdownPips, drawdownPips);
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    const point = {
      time,
      equityPips: roundPips(realizedPips),
      drawdownPips: roundPips(drawdownPips),
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
      );
      trades.push(trade);
      realizedPips += trade.netPips;
      position = null;
      pendingOppositeClose = false;
    }

    if (!position && pendingEntry) {
      if (isWithinTradingSession(bar.t, strategy.sessionFilter)) {
        position = makePosition(strategy, pair, bar);
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
        );
        trades.push(trade);
        realizedPips += trade.netPips;
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
    );
    trades.push(trade);
    realizedPips += trade.netPips;
    recordEquity(last.t);
  }

  const grossProfitPips = trades
    .filter((trade) => trade.netPips > 0)
    .reduce((sum, trade) => sum + trade.netPips, 0);
  const grossLossPips = trades
    .filter((trade) => trade.netPips < 0)
    .reduce((sum, trade) => sum + trade.netPips, 0);
  const wins = trades.filter((trade) => trade.netPips > 0).length;
  const profitFactor =
    grossLossPips === 0
      ? grossProfitPips > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : grossProfitPips / Math.abs(grossLossPips);

  return {
    pair,
    spreadPips,
    winRate: trades.length === 0 ? 0 : (wins / trades.length) * 100,
    profitFactor,
    maxDrawdownPips: roundPips(maxDrawdownPips),
    maxDrawdownPct,
    tradeCount: trades.length,
    netPips: roundPips(realizedPips),
    grossProfitPips: roundPips(grossProfitPips),
    grossLossPips: roundPips(grossLossPips),
    trades,
    equityCurve,
  };
};
