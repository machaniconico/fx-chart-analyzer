import {
  ColorType,
  createChart,
  IChartApi,
  LineData,
  Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { runBacktest, type BacktestResult, type BacktestTrade } from '../lib/backtest';
import { formatPrice } from '../lib/chart-data';
import { generateMql4, generateMql5 } from '../lib/mql';
import {
  createOptimizationCancelToken,
  runGridSearchOptimization,
  type OptimizationCancelToken,
  type OptimizationRanges,
  type OptimizationResultRow,
} from '../lib/optimize';
import {
  defaultMoneyManagement,
  defaultStrategies,
  type BollingerCondition,
  type EntryCondition,
  type LotSizingMode,
  type MaCrossCondition,
  type MacdCrossCondition,
  type MovingAverageType,
  type RsiComparison,
  type RsiCondition,
  type StrategyDefinition,
} from '../lib/strategy';
import type { Bar, Pair, Timeframe } from '../types';
import { timeframeLabels } from '../types';

interface EaBuilderPanelProps {
  bars: Bar[];
  pair: Pair;
  timeframe: Timeframe;
  usdJpyBars?: Bar[];
}

const cloneStrategy = (strategy: StrategyDefinition): StrategyDefinition =>
  JSON.parse(JSON.stringify(strategy)) as StrategyDefinition;

const formatPips = (value: number): string => `${value.toFixed(1)} pips`;

const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const yenFormatter = new Intl.NumberFormat('ja-JP', {
  style: 'currency',
  currency: 'JPY',
  maximumFractionDigits: 0,
});

const formatYen = (value: number): string => yenFormatter.format(Math.round(value));

const formatProfitFactor = (value: number): string =>
  Number.isFinite(value) ? value.toFixed(2) : '∞';

const exitReasonLabels: Record<BacktestTrade['exitReason'], string> = {
  stop_loss: 'SL',
  take_profit: 'TP',
  trailing_stop: 'トレーリング',
  opposite_signal: '反対シグナル',
  end: '最終バー',
};

const defaultMaCondition = (): MaCrossCondition => ({
  type: 'maCross',
  fastType: 'ema',
  fastPeriod: 20,
  slowType: 'ema',
  slowPeriod: 50,
});

const defaultRsiCondition = (): RsiCondition => ({
  type: 'rsi',
  period: 14,
  threshold: 30,
  comparison: 'below',
});

const defaultBollingerCondition = (): BollingerCondition => ({
  type: 'bollinger',
  period: 20,
  multiplier: 2,
  mode: 'touch',
  band: 'lower',
});

const defaultMacdCondition = (): MacdCrossCondition => ({
  type: 'macdCross',
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
});

type ConditionType = EntryCondition['type'];

type ConditionByType<T extends ConditionType> = Extract<EntryCondition, { type: T }>;

const dateLabel = (timestamp: number): string =>
  new Date(timestamp * 1000).toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const downloadText = (filename: string, content: string): void => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finiteFallback = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const numericInput = (
  rawValue: string,
  previousValue: number,
  defaultValue: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number => {
  const fallback = finiteFallback(previousValue, defaultValue);
  const parsed = rawValue.trim() === '' ? fallback : Number(rawValue);
  const nextValue = Number.isFinite(parsed) ? parsed : fallback;
  return clampNumber(nextValue, min, max);
};

const integerInput = (
  rawValue: string,
  previousValue: number,
  defaultValue: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number => Math.round(numericInput(rawValue, previousValue, defaultValue, min, max));

const pipsInput = (rawValue: string, previousValue: number, defaultValue: number): number =>
  integerInput(rawValue, previousValue, defaultValue, 1);

interface OptimizationFormState {
  stopLossMin: number;
  stopLossMax: number;
  stopLossStep: number;
  takeProfitMin: number;
  takeProfitMax: number;
  takeProfitStep: number;
  trailingEnabled: boolean;
  trailingMin: number;
  trailingMax: number;
  trailingStep: number;
}

const defaultOptimizationForm: OptimizationFormState = {
  stopLossMin: 15,
  stopLossMax: 60,
  stopLossStep: 15,
  takeProfitMin: 20,
  takeProfitMax: 100,
  takeProfitStep: 20,
  trailingEnabled: false,
  trailingMin: 10,
  trailingMax: 40,
  trailingStep: 10,
};

const timeTextPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const strategyValidationMessages = (strategy: StrategyDefinition): string[] => {
  const messages: string[] = [];
  for (const condition of strategy.entryConditions) {
    if (condition.type === 'maCross' && condition.fastPeriod >= condition.slowPeriod) {
      messages.push('MAクロスは短期期間を長期期間より小さくしてください。');
    }
    if (condition.type === 'macdCross' && condition.fastPeriod >= condition.slowPeriod) {
      messages.push('MACDは短期期間を長期期間より小さくしてください。');
    }
  }
  if (
    strategy.sessionFilter.enabled &&
    (!timeTextPattern.test(strategy.sessionFilter.start) || !timeTextPattern.test(strategy.sessionFilter.end))
  ) {
    messages.push('取引許可時間帯は HH:MM 形式で入力してください。');
  }
  if (strategy.newsFilter.enabled && strategy.newsFilter.blockMinutes < 1) {
    messages.push('ニュース停止時間は1分以上にしてください。');
  }
  const moneyManagement = strategy.moneyManagement ?? defaultMoneyManagement(strategy.lotSize);
  if (moneyManagement.initialBalanceYen <= 0) {
    messages.push('初期資金は1円以上にしてください。');
  }
  if (moneyManagement.fixedLot <= 0) {
    messages.push('固定ロットは0より大きい値にしてください。');
  }
  if (moneyManagement.maxLot <= 0) {
    messages.push('上限ロットは0より大きい値にしてください。');
  }
  if (
    moneyManagement.lotSizingMode === 'fixedRisk' &&
    (moneyManagement.riskPercent <= 0 || moneyManagement.riskPercent > 100)
  ) {
    messages.push('リスク%は0より大きく100以下にしてください。');
  }
  return messages;
};

const createEquityChart = (container: HTMLDivElement): IChartApi =>
  createChart(container, {
    height: 260,
    layout: {
      background: { type: ColorType.Solid, color: '#10151f' },
      textColor: '#b9c2d0',
      fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(142,155,179,0.12)' },
      horzLines: { color: 'rgba(142,155,179,0.12)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(142,155,179,0.24)',
    },
    timeScale: {
      borderColor: 'rgba(142,155,179,0.24)',
      timeVisible: true,
      secondsVisible: false,
    },
  });

function EquityCurve({ result }: { result: BacktestResult }) {
  const chartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!chartRef.current || result.equityCurve.length === 0) {
      return;
    }

    const chart = createEquityChart(chartRef.current);
    const resizeObserver = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width > 0) {
        chart.applyOptions({ width });
      }
    });
    resizeObserver.observe(chartRef.current);

    const line = chart.addLineSeries({
      color: result.netProfitYen >= 0 ? '#20c997' : '#ff5b78',
      lineWidth: 2,
      title: '残高(円)',
    });
    line.setData(
      result.equityCurve.map<LineData>((point) => ({
        time: point.time as Time,
        value: point.equityYen,
      })),
    );
    chart.timeScale().fitContent();

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [result]);

  return <div ref={chartRef} className="chart-area ea-equity-chart" />;
}

export function EaBuilderPanel({ bars, pair, timeframe, usdJpyBars }: EaBuilderPanelProps) {
  const [strategy, setStrategy] = useState<StrategyDefinition>(() => cloneStrategy(defaultStrategies[0]));
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [optimizationForm, setOptimizationForm] = useState<OptimizationFormState>(() => ({
    ...defaultOptimizationForm,
  }));
  const [optimizationRows, setOptimizationRows] = useState<OptimizationResultRow[]>([]);
  const [optimizationProgress, setOptimizationProgress] = useState({
    completed: 0,
    total: 0,
    percent: 0,
    cancelled: false,
  });
  const [optimizationRunning, setOptimizationRunning] = useState(false);
  const [optimizationError, setOptimizationError] = useState<string | null>(null);
  const optimizationTokenRef = useRef<OptimizationCancelToken | null>(null);
  const validationMessages = useMemo(() => strategyValidationMessages(strategy), [strategy]);
  const hasValidationErrors = validationMessages.length > 0;
  const mql5Source = useMemo(() => generateMql5(strategy), [strategy]);
  const mql4Source = useMemo(() => generateMql4(strategy), [strategy]);
  const moneyManagement = strategy.moneyManagement ?? defaultMoneyManagement(strategy.lotSize);

  useEffect(() => () => {
    if (optimizationTokenRef.current) {
      optimizationTokenRef.current.aborted = true;
    }
  }, []);

  useEffect(() => {
    setResult(null);
    setOptimizationRows([]);
    if (optimizationTokenRef.current) {
      optimizationTokenRef.current.aborted = true;
      optimizationTokenRef.current = null;
    }
    setOptimizationRunning(false);
  }, [bars, pair, timeframe, usdJpyBars]);

  const getCondition = <T extends ConditionType>(type: T): ConditionByType<T> | undefined =>
    strategy.entryConditions.find((condition): condition is ConditionByType<T> => condition.type === type);

  const hasCondition = (type: ConditionType): boolean =>
    strategy.entryConditions.some((condition) => condition.type === type);

  const updateCondition = <T extends ConditionType>(
    type: T,
    fallback: () => ConditionByType<T>,
    updater: (condition: ConditionByType<T>) => ConditionByType<T>,
  ): void => {
    setResult(null);
    setOptimizationRows([]);
    setStrategy((current) => {
      const existingIndex = current.entryConditions.findIndex((condition) => condition.type === type);
      const existing =
        existingIndex >= 0
          ? (current.entryConditions[existingIndex] as ConditionByType<T>)
          : fallback();
      const nextCondition = updater(existing);
      const entryConditions =
        existingIndex >= 0
          ? current.entryConditions.map((condition, index) =>
              index === existingIndex ? nextCondition : condition,
            )
          : [...current.entryConditions, nextCondition];
      return { ...current, entryConditions };
    });
  };

  const toggleCondition = <T extends ConditionType>(
    type: T,
    checked: boolean,
    fallback: () => ConditionByType<T>,
  ): void => {
    setResult(null);
    setOptimizationRows([]);
    setStrategy((current) => ({
      ...current,
      entryConditions: checked
        ? current.entryConditions.some((condition) => condition.type === type)
          ? current.entryConditions
          : [...current.entryConditions, fallback()]
        : current.entryConditions.filter((condition) => condition.type !== type),
    }));
  };

  const updateStrategy = (updater: (current: StrategyDefinition) => StrategyDefinition): void => {
    setResult(null);
    setOptimizationRows([]);
    setStrategy(updater);
  };

  const maCondition = getCondition('maCross');
  const rsiCondition = getCondition('rsi');
  const bbCondition = getCondition('bollinger');
  const macdCondition = getCondition('macdCross');

  const updateMoneyManagement = (
    updater: (current: typeof moneyManagement) => typeof moneyManagement,
  ): void => {
    updateStrategy((current) => {
      const currentMoneyManagement = current.moneyManagement ?? defaultMoneyManagement(current.lotSize);
      const nextMoneyManagement = updater(currentMoneyManagement);
      return {
        ...current,
        lotSize: nextMoneyManagement.fixedLot,
        moneyManagement: nextMoneyManagement,
      };
    });
  };

  const run = (): void => {
    if (hasValidationErrors) {
      return;
    }
    setResult(runBacktest(bars, strategy, pair, { usdJpyBars }));
  };

  const updateOptimizationForm = (
    updater: (current: OptimizationFormState) => OptimizationFormState,
  ): void => {
    setOptimizationForm(updater);
    setOptimizationError(null);
  };

  const optimizationRanges = (): OptimizationRanges => ({
    stopLossPips: {
      min: optimizationForm.stopLossMin,
      max: optimizationForm.stopLossMax,
      step: optimizationForm.stopLossStep,
    },
    takeProfitPips: {
      min: optimizationForm.takeProfitMin,
      max: optimizationForm.takeProfitMax,
      step: optimizationForm.takeProfitStep,
    },
    trailingStopPips: optimizationForm.trailingEnabled
      ? {
          min: optimizationForm.trailingMin,
          max: optimizationForm.trailingMax,
          step: optimizationForm.trailingStep,
        }
      : null,
  });

  const runOptimization = (): void => {
    if (hasValidationErrors || optimizationRunning) {
      return;
    }
    const token = createOptimizationCancelToken();
    optimizationTokenRef.current = token;
    setOptimizationRunning(true);
    setOptimizationError(null);
    setOptimizationRows([]);
    setOptimizationProgress({ completed: 0, total: 0, percent: 0, cancelled: false });

    runGridSearchOptimization(bars, strategy, pair, optimizationRanges(), {
      usdJpyBars,
      cancelToken: token,
      onProgress: setOptimizationProgress,
    })
      .then((runResult) => {
        if (optimizationTokenRef.current !== token) {
          return;
        }
        setOptimizationRows(runResult.rows);
        setOptimizationProgress({
          completed: runResult.completed,
          total: runResult.total,
          percent: runResult.total === 0 ? 100 : (runResult.completed / runResult.total) * 100,
          cancelled: runResult.cancelled,
        });
      })
      .catch((reason: unknown) => {
        if (optimizationTokenRef.current === token) {
          setOptimizationError(reason instanceof Error ? reason.message : '最適化に失敗しました。');
        }
      })
      .finally(() => {
        if (optimizationTokenRef.current === token) {
          optimizationTokenRef.current = null;
          setOptimizationRunning(false);
        }
      });
  };

  const cancelOptimization = (): void => {
    if (optimizationTokenRef.current) {
      optimizationTokenRef.current.aborted = true;
    }
  };

  const applyOptimizationParameters = (row: OptimizationResultRow): void => {
    setResult(null);
    setStrategy((current) => ({
      ...current,
      exit: {
        ...current.exit,
        stopLossPips: row.parameters.stopLossPips,
        takeProfitPips: row.parameters.takeProfitPips,
        trailingStopPips: row.parameters.trailingStopPips,
      },
    }));
  };

  const filenameBase = `${strategy.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${pair}_${timeframe}`;

  return (
    <div className="ea-builder-stack">
      <section className="ea-builder-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">EAビルダー</p>
            <h2>{pair} / {timeframeLabels[timeframe]}</h2>
          </div>
          <button className="primary-action" type="button" onClick={run} disabled={hasValidationErrors}>
            バックテスト実行
          </button>
        </div>

        <div className="ea-form-grid">
          <label className="form-field">
            <span className="field-label">プリセット</span>
            <select
              value={strategy.id}
              onChange={(event) => {
                const preset = defaultStrategies.find((item) => item.id === event.target.value) ?? defaultStrategies[0];
                setStrategy(cloneStrategy(preset));
                setResult(null);
                setOptimizationRows([]);
              }}
            >
              {defaultStrategies.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span className="field-label">戦略名</span>
            <input
              value={strategy.name}
              onChange={(event) =>
                updateStrategy((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>

          <label className="form-field">
            <span className="field-label">方向</span>
            <select
              value={strategy.direction}
              onChange={(event) =>
                updateStrategy((current) => ({
                  ...current,
                  direction: event.target.value as StrategyDefinition['direction'],
                }))
              }
            >
              <option value="long">ロング</option>
              <option value="short">ショート</option>
            </select>
          </label>

          <label className="form-field">
            <span className="field-label">マジックナンバー</span>
            <input
              min="1"
              step="1"
              type="number"
              value={strategy.magicNumber}
              onChange={(event) =>
                updateStrategy((current) => ({
                  ...current,
                  magicNumber: integerInput(event.target.value, current.magicNumber, 20260701, 1),
                }))
              }
            />
          </label>
        </div>

        <section className="exit-card">
          <h3>資金管理</h3>
          <div className="ea-form-grid money-management-grid">
            <label className="form-field">
              <span className="field-label">初期資金(円)</span>
              <input
                min="1"
                step="10000"
                type="number"
                value={moneyManagement.initialBalanceYen}
                onChange={(event) =>
                  updateMoneyManagement((current) => ({
                    ...current,
                    initialBalanceYen: integerInput(
                      event.target.value,
                      current.initialBalanceYen,
                      1_000_000,
                      1,
                    ),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">ロット方式</span>
              <select
                value={moneyManagement.lotSizingMode}
                onChange={(event) =>
                  updateMoneyManagement((current) => ({
                    ...current,
                    lotSizingMode: event.target.value as LotSizingMode,
                  }))
                }
              >
                <option value="fixedLot">固定ロット</option>
                <option value="fixedRisk">固定リスク%</option>
                <option value="compound">複利(残高比例)</option>
              </select>
            </label>
            <label className="form-field">
              <span className="field-label">固定/基準ロット</span>
              <input
                min="0.01"
                step="0.01"
                type="number"
                value={moneyManagement.fixedLot}
                disabled={moneyManagement.lotSizingMode === 'fixedRisk'}
                onChange={(event) =>
                  updateMoneyManagement((current) => ({
                    ...current,
                    fixedLot: numericInput(event.target.value, current.fixedLot, 0.1, 0.01),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">リスク%</span>
              <input
                min="0.01"
                max="100"
                step="0.1"
                type="number"
                value={moneyManagement.riskPercent}
                disabled={moneyManagement.lotSizingMode !== 'fixedRisk'}
                onChange={(event) =>
                  updateMoneyManagement((current) => ({
                    ...current,
                    riskPercent: numericInput(event.target.value, current.riskPercent, 1, 0.01, 100),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">上限ロット</span>
              <input
                min="0.01"
                step="0.01"
                type="number"
                value={moneyManagement.maxLot}
                onChange={(event) =>
                  updateMoneyManagement((current) => ({
                    ...current,
                    maxLot: numericInput(event.target.value, current.maxLot, 100, 0.01),
                  }))
                }
              />
            </label>
          </div>
          <p className="disclaimer-copy">
            円換算は1ロット=10万通貨で計算します。クロス円/JPYクォートは1pip=1,000円/lot、EURUSD/GBPUSDは10 USD/pip/lotを同時刻近傍のUSDJPYバーで円換算し、バーがない場合はUSDJPY=150円固定で近似します。
          </p>
        </section>

        <div className="condition-grid">
          <section className="condition-card">
            <label className="condition-title">
              <input
                type="checkbox"
                checked={hasCondition('maCross')}
                onChange={(event) => toggleCondition('maCross', event.target.checked, defaultMaCondition)}
              />
              <span>MAクロス</span>
            </label>
            {maCondition && (
              <div className="mini-grid">
                <label>
                  <span>短期種別</span>
                  <select
                    value={maCondition.fastType}
                    onChange={(event) =>
                      updateCondition('maCross', defaultMaCondition, (condition) => ({
                        ...condition,
                        fastType: event.target.value as MovingAverageType,
                      }))
                    }
                  >
                    <option value="sma">SMA</option>
                    <option value="ema">EMA</option>
                  </select>
                </label>
                <label>
                  <span>短期期間</span>
                  <input
                    min="1"
                    type="number"
                    value={maCondition.fastPeriod}
                    onChange={(event) =>
                      updateCondition('maCross', defaultMaCondition, (condition) => ({
                        ...condition,
                        fastPeriod: integerInput(event.target.value, condition.fastPeriod, 20, 1),
                      }))
                    }
                  />
                </label>
                <label>
                  <span>長期種別</span>
                  <select
                    value={maCondition.slowType}
                    onChange={(event) =>
                      updateCondition('maCross', defaultMaCondition, (condition) => ({
                        ...condition,
                        slowType: event.target.value as MovingAverageType,
                      }))
                    }
                  >
                    <option value="sma">SMA</option>
                    <option value="ema">EMA</option>
                  </select>
                </label>
                <label>
                  <span>長期期間</span>
                  <input
                    min="2"
                    type="number"
                    value={maCondition.slowPeriod}
                    onChange={(event) =>
                      updateCondition('maCross', defaultMaCondition, (condition) => ({
                        ...condition,
                        slowPeriod: integerInput(event.target.value, condition.slowPeriod, 50, 2),
                      }))
                    }
                  />
                </label>
              </div>
            )}
          </section>

          <section className="condition-card">
            <label className="condition-title">
              <input
                type="checkbox"
                checked={hasCondition('rsi')}
                onChange={(event) => toggleCondition('rsi', event.target.checked, defaultRsiCondition)}
              />
              <span>RSI閾値</span>
            </label>
            {rsiCondition && (
              <div className="mini-grid">
                <label>
                  <span>期間</span>
                  <input
                    min="1"
                    type="number"
                    value={rsiCondition.period}
                    onChange={(event) =>
                      updateCondition('rsi', defaultRsiCondition, (condition) => ({
                        ...condition,
                        period: integerInput(event.target.value, condition.period, 14, 1),
                      }))
                    }
                  />
                </label>
                <label>
                  <span>判定</span>
                  <select
                    value={rsiCondition.comparison}
                    onChange={(event) =>
                      updateCondition('rsi', defaultRsiCondition, (condition) => ({
                        ...condition,
                        comparison: event.target.value as RsiComparison,
                      }))
                    }
                  >
                    <option value="below">以下</option>
                    <option value="above">以上</option>
                    <option value="crossBelow">下抜け</option>
                    <option value="crossAbove">上抜け</option>
                  </select>
                </label>
                <label>
                  <span>閾値</span>
                  <input
                    max="99"
                    min="1"
                    type="number"
                    value={rsiCondition.threshold}
                    onChange={(event) =>
                      updateCondition('rsi', defaultRsiCondition, (condition) => ({
                        ...condition,
                        threshold: numericInput(event.target.value, condition.threshold, 30, 1, 99),
                      }))
                    }
                  />
                </label>
              </div>
            )}
          </section>

          <section className="condition-card">
            <label className="condition-title">
              <input
                type="checkbox"
                checked={hasCondition('bollinger')}
                onChange={(event) => toggleCondition('bollinger', event.target.checked, defaultBollingerCondition)}
              />
              <span>ボリンジャー</span>
            </label>
            {bbCondition && (
              <div className="mini-grid">
                <label>
                  <span>期間</span>
                  <input
                    min="1"
                    type="number"
                    value={bbCondition.period}
                    onChange={(event) =>
                      updateCondition('bollinger', defaultBollingerCondition, (condition) => ({
                        ...condition,
                        period: integerInput(event.target.value, condition.period, 20, 1),
                      }))
                    }
                  />
                </label>
                <label>
                  <span>偏差</span>
                  <input
                    min="0.1"
                    step="0.1"
                    type="number"
                    value={bbCondition.multiplier}
                    onChange={(event) =>
                      updateCondition('bollinger', defaultBollingerCondition, (condition) => ({
                        ...condition,
                        multiplier: numericInput(event.target.value, condition.multiplier, 2, 0.1),
                      }))
                    }
                  />
                </label>
                <label>
                  <span>バンド</span>
                  <select
                    value={bbCondition.band}
                    onChange={(event) =>
                      updateCondition('bollinger', defaultBollingerCondition, (condition) => ({
                        ...condition,
                        band: event.target.value as BollingerCondition['band'],
                      }))
                    }
                  >
                    <option value="lower">下限</option>
                    <option value="upper">上限</option>
                  </select>
                </label>
                <label>
                  <span>判定</span>
                  <select
                    value={bbCondition.mode}
                    onChange={(event) =>
                      updateCondition('bollinger', defaultBollingerCondition, (condition) => ({
                        ...condition,
                        mode: event.target.value as BollingerCondition['mode'],
                      }))
                    }
                  >
                    <option value="touch">タッチ</option>
                    <option value="break">ブレイク</option>
                  </select>
                </label>
              </div>
            )}
          </section>

          <section className="condition-card">
            <label className="condition-title">
              <input
                type="checkbox"
                checked={hasCondition('macdCross')}
                onChange={(event) => toggleCondition('macdCross', event.target.checked, defaultMacdCondition)}
              />
              <span>MACDクロス</span>
            </label>
            {macdCondition && (
              <div className="mini-grid">
                <label>
                  <span>短期</span>
                  <input
                    min="1"
                    type="number"
                    value={macdCondition.fastPeriod}
                    onChange={(event) =>
                      updateCondition('macdCross', defaultMacdCondition, (condition) => ({
                        ...condition,
                        fastPeriod: integerInput(event.target.value, condition.fastPeriod, 12, 1),
                      }))
                    }
                  />
                </label>
                <label>
                  <span>長期</span>
                  <input
                    min="2"
                    type="number"
                    value={macdCondition.slowPeriod}
                    onChange={(event) =>
                      updateCondition('macdCross', defaultMacdCondition, (condition) => ({
                        ...condition,
                        slowPeriod: integerInput(event.target.value, condition.slowPeriod, 26, 2),
                      }))
                    }
                  />
                </label>
                <label>
                  <span>シグナル</span>
                  <input
                    min="1"
                    type="number"
                    value={macdCondition.signalPeriod}
                    onChange={(event) =>
                      updateCondition('macdCross', defaultMacdCondition, (condition) => ({
                        ...condition,
                        signalPeriod: integerInput(event.target.value, condition.signalPeriod, 9, 1),
                      }))
                    }
                  />
                </label>
              </div>
            )}
          </section>
        </div>

        <section className="exit-card">
          <h3>取引フィルター</h3>
          <div className="ea-form-grid ea-filter-grid">
            <label className="toggle">
              <input
                type="checkbox"
                checked={strategy.sessionFilter.enabled}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    sessionFilter: { ...current.sessionFilter, enabled: event.target.checked },
                  }))
                }
              />
              <span>時間帯フィルター</span>
            </label>
            <label className="form-field">
              <span className="field-label">開始(サーバー時刻)</span>
              <input
                type="time"
                value={strategy.sessionFilter.start}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    sessionFilter: { ...current.sessionFilter, start: event.target.value || '00:00' },
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">終了(サーバー時刻)</span>
              <input
                type="time"
                value={strategy.sessionFilter.end}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    sessionFilter: { ...current.sessionFilter, end: event.target.value || '23:59' },
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">サーバーUTC差(分)</span>
              <input
                max="840"
                min="-720"
                step="15"
                type="number"
                value={strategy.sessionFilter.serverUtcOffsetMinutes}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    sessionFilter: {
                      ...current.sessionFilter,
                      serverUtcOffsetMinutes: integerInput(
                        event.target.value,
                        current.sessionFilter.serverUtcOffsetMinutes,
                        0,
                        -720,
                        840,
                      ),
                    },
                  }))
                }
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={strategy.newsFilter.enabled}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    newsFilter: { ...current.newsFilter, enabled: event.target.checked },
                  }))
                }
              />
              <span>ニュース停止(MQL5)</span>
            </label>
            <label className="form-field">
              <span className="field-label">前後停止(分)</span>
              <input
                min="1"
                type="number"
                value={strategy.newsFilter.blockMinutes}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    newsFilter: {
                      ...current.newsFilter,
                      blockMinutes: integerInput(event.target.value, current.newsFilter.blockMinutes, 30, 1),
                    },
                  }))
                }
              />
            </label>
          </div>
          <p className="disclaimer-copy">
            時間帯はサーバー時刻で新規エントリーだけを制限します。バックテストではUTC差を使ってサーバー時刻へ換算します。
            ニュース停止はMQL5内蔵カレンダーAPIを使う生成コード専用です。
          </p>
        </section>

        {validationMessages.length > 0 && (
          <div className="validation-list" role="alert">
            {validationMessages.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}

        <section className="exit-card">
          <h3>決済</h3>
          <div className="ea-form-grid">
            <label className="form-field">
              <span className="field-label">SL(pips)</span>
              <input
                min="1"
                type="number"
                value={strategy.exit.stopLossPips}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    exit: { ...current.exit, stopLossPips: pipsInput(event.target.value, current.exit.stopLossPips, 30) },
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">TP(pips)</span>
              <input
                min="1"
                type="number"
                value={strategy.exit.takeProfitPips}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    exit: { ...current.exit, takeProfitPips: pipsInput(event.target.value, current.exit.takeProfitPips, 60) },
                  }))
                }
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={Boolean(strategy.exit.trailingStopPips && strategy.exit.trailingStopPips > 0)}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    exit: {
                      ...current.exit,
                      trailingStopPips: event.target.checked ? current.exit.trailingStopPips || 20 : null,
                    },
                  }))
                }
              />
              <span>トレーリング有効</span>
            </label>
            <label className="form-field">
              <span className="field-label">トレーリング(pips)</span>
              <input
                min="1"
                type="number"
                disabled={!strategy.exit.trailingStopPips}
                value={strategy.exit.trailingStopPips ?? 0}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    exit: {
                      ...current.exit,
                      trailingStopPips: pipsInput(event.target.value, current.exit.trailingStopPips ?? 20, 20),
                    },
                  }))
                }
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={strategy.exit.closeOnOppositeSignal}
                onChange={(event) =>
                  updateStrategy((current) => ({
                    ...current,
                    exit: { ...current.exit, closeOnOppositeSignal: event.target.checked },
                  }))
                }
              />
              <span>反対シグナル決済</span>
            </label>
          </div>
        </section>

        <section className="exit-card optimization-card">
          <div className="section-heading-row">
            <h3>最適化</h3>
            <span className="optimization-status" aria-live="polite">
              {optimizationRunning
                ? `${optimizationProgress.percent.toFixed(0)}%`
                : optimizationRows.length > 0
                  ? `${optimizationRows.length.toLocaleString('ja-JP')}件`
                  : '未実行'}
            </span>
          </div>
          <div className="optimization-grid">
            <label className="form-field">
              <span className="field-label">SL最小</span>
              <input
                min="1"
                type="number"
                value={optimizationForm.stopLossMin}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    stopLossMin: pipsInput(event.target.value, current.stopLossMin, 15),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">SL最大</span>
              <input
                min="1"
                type="number"
                value={optimizationForm.stopLossMax}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    stopLossMax: pipsInput(event.target.value, current.stopLossMax, 60),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">SL刻み</span>
              <input
                min="1"
                type="number"
                value={optimizationForm.stopLossStep}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    stopLossStep: pipsInput(event.target.value, current.stopLossStep, 15),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">TP最小</span>
              <input
                min="1"
                type="number"
                value={optimizationForm.takeProfitMin}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    takeProfitMin: pipsInput(event.target.value, current.takeProfitMin, 20),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">TP最大</span>
              <input
                min="1"
                type="number"
                value={optimizationForm.takeProfitMax}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    takeProfitMax: pipsInput(event.target.value, current.takeProfitMax, 100),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">TP刻み</span>
              <input
                min="1"
                type="number"
                value={optimizationForm.takeProfitStep}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    takeProfitStep: pipsInput(event.target.value, current.takeProfitStep, 20),
                  }))
                }
              />
            </label>
            <label className="toggle optimization-toggle">
              <input
                type="checkbox"
                checked={optimizationForm.trailingEnabled}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    trailingEnabled: event.target.checked,
                  }))
                }
              />
              <span>トレーリングも最適化</span>
            </label>
            <label className="form-field">
              <span className="field-label">TR最小</span>
              <input
                min="1"
                type="number"
                disabled={!optimizationForm.trailingEnabled}
                value={optimizationForm.trailingMin}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    trailingMin: pipsInput(event.target.value, current.trailingMin, 10),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">TR最大</span>
              <input
                min="1"
                type="number"
                disabled={!optimizationForm.trailingEnabled}
                value={optimizationForm.trailingMax}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    trailingMax: pipsInput(event.target.value, current.trailingMax, 40),
                  }))
                }
              />
            </label>
            <label className="form-field">
              <span className="field-label">TR刻み</span>
              <input
                min="1"
                type="number"
                disabled={!optimizationForm.trailingEnabled}
                value={optimizationForm.trailingStep}
                onChange={(event) =>
                  updateOptimizationForm((current) => ({
                    ...current,
                    trailingStep: pipsInput(event.target.value, current.trailingStep, 10),
                  }))
                }
              />
            </label>
          </div>

          <div className="optimization-actions">
            <button
              className="primary-action"
              type="button"
              onClick={runOptimization}
              disabled={hasValidationErrors || optimizationRunning}
            >
              最適化実行
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={cancelOptimization}
              disabled={!optimizationRunning}
            >
              キャンセル
            </button>
          </div>

          {(optimizationRunning || optimizationProgress.completed > 0) && (
            <div className="progress-block">
              <div className="progress-track" aria-label="最適化進捗">
                <div
                  className="progress-fill"
                  style={{ width: `${clampNumber(optimizationProgress.percent, 0, 100)}%` }}
                />
              </div>
              <span>
                {optimizationProgress.completed.toLocaleString('ja-JP')} / {optimizationProgress.total.toLocaleString('ja-JP')}
                {optimizationProgress.cancelled ? ' キャンセル済み' : ''}
              </span>
            </div>
          )}

          {optimizationError && (
            <div className="validation-list" role="alert">
              <p>{optimizationError}</p>
            </div>
          )}

          <p className="disclaimer-copy optimization-disclaimer">
            過去データへの最適化は将来の成績を保証しません
          </p>

          {optimizationRows.length > 0 && (
            <div className="trade-table-wrap optimization-table-wrap">
              <table className="trade-table optimization-table">
                <thead>
                  <tr>
                    <th>SL</th>
                    <th>TP</th>
                    <th>TR</th>
                    <th>最適化損益</th>
                    <th>検証損益</th>
                    <th>最適化PF</th>
                    <th>検証PF</th>
                    <th>最適化DD</th>
                    <th>検証DD</th>
                    <th>警告</th>
                  </tr>
                </thead>
                <tbody>
                  {optimizationRows.slice(0, 20).map((row) => (
                    <tr
                      key={`${row.parameters.stopLossPips}:${row.parameters.takeProfitPips}:${row.parameters.trailingStopPips ?? 'none'}`}
                      className="optimization-row"
                      tabIndex={0}
                      onClick={() => applyOptimizationParameters(row)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          applyOptimizationParameters(row);
                        }
                      }}
                    >
                      <td>{formatPips(row.parameters.stopLossPips)}</td>
                      <td>{formatPips(row.parameters.takeProfitPips)}</td>
                      <td>{row.parameters.trailingStopPips ? formatPips(row.parameters.trailingStopPips) : '-'}</td>
                      <td className={row.optimization.netProfitYen >= 0 ? 'metric-up' : 'metric-down'}>
                        {formatYen(row.optimization.netProfitYen)}
                      </td>
                      <td className={row.validation.netProfitYen >= 0 ? 'metric-up' : 'metric-down'}>
                        {formatYen(row.validation.netProfitYen)}
                      </td>
                      <td>{formatProfitFactor(row.optimization.profitFactor)}</td>
                      <td>{formatProfitFactor(row.validation.profitFactor)}</td>
                      <td>{formatYen(row.optimization.maxDrawdownYen)}</td>
                      <td>{formatYen(row.validation.maxDrawdownYen)}</td>
                      <td>{row.overfitWarning ? '⚠️過剰適合の疑い' : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="download-row">
          <button
            className="secondary-action"
            type="button"
            disabled={hasValidationErrors}
            onClick={() => downloadText(`${filenameBase}.mq5`, mql5Source)}
          >
            MQL5をダウンロード
          </button>
          <button
            className="secondary-action"
            type="button"
            disabled={hasValidationErrors}
            onClick={() => downloadText(`${filenameBase}.mq4`, mql4Source)}
          >
            MQL4をダウンロード
          </button>
        </div>
      </section>

      {result && (
        <section className="ea-result-panel">
          <div className="metric-grid">
            <article className="metric-card">
              <span>純損益</span>
              <strong className={result.netProfitYen >= 0 ? 'metric-up' : 'metric-down'}>
                {formatYen(result.netProfitYen)}
              </strong>
              <small>{formatPips(result.netPips)}</small>
            </article>
            <article className="metric-card">
              <span>勝率</span>
              <strong>{formatPercent(result.winRate)}</strong>
            </article>
            <article className="metric-card">
              <span>PF</span>
              <strong>{formatProfitFactor(result.profitFactor)}</strong>
            </article>
            <article className="metric-card">
              <span>最大DD</span>
              <strong>{formatYen(result.maxDrawdownYen)}</strong>
              <small>{formatPercent(result.maxDrawdownPct)}</small>
            </article>
            <article className="metric-card">
              <span>取引回数</span>
              <strong>{result.tradeCount.toLocaleString('ja-JP')}</strong>
            </article>
            <article className="metric-card">
              <span>RR</span>
              <strong>{formatProfitFactor(result.riskRewardRatio)}</strong>
            </article>
            <article className="metric-card">
              <span>平均勝ち</span>
              <strong className="metric-up">{formatYen(result.averageWinYen)}</strong>
            </article>
            <article className="metric-card">
              <span>平均負け</span>
              <strong className="metric-down">{formatYen(result.averageLossYen)}</strong>
            </article>
            <article className="metric-card">
              <span>最大連勝/連敗</span>
              <strong>{result.maxConsecutiveWins} / {result.maxConsecutiveLosses}</strong>
            </article>
            <article className="metric-card">
              <span>スプレッド</span>
              <strong>{formatPips(result.spreadPips)}</strong>
            </article>
          </div>

          <p className="disclaimer-copy result-conversion-note">{result.conversionNote}</p>

          <section className="chart-card">
            <div className="chart-heading">
              <span>資産曲線</span>
              <span>円残高</span>
            </div>
            <EquityCurve result={result} />
          </section>

          <section className="trade-table-card">
            <div className="chart-heading">
              <span>取引一覧</span>
              <span>{result.trades.length}件</span>
            </div>
            {result.trades.length === 0 ? (
              <p className="empty-copy">条件に一致する取引はありません。</p>
            ) : (
              <div className="trade-table-wrap">
                <table className="trade-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>方向</th>
                      <th>エントリー</th>
                      <th>決済</th>
                      <th>入口</th>
                      <th>出口</th>
                      <th>ロット</th>
                      <th>損益(円)</th>
                      <th>損益(pips)</th>
                      <th>理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((trade) => (
                      <tr key={trade.id}>
                        <td>{trade.id}</td>
                        <td>{trade.direction === 'long' ? '買い' : '売り'}</td>
                        <td>{dateLabel(trade.entryTime)}</td>
                        <td>{dateLabel(trade.exitTime)}</td>
                        <td>{formatPrice(pair, trade.entryPrice)}</td>
                        <td>{formatPrice(pair, trade.exitPrice)}</td>
                        <td>{trade.lotSize.toFixed(2)}</td>
                        <td className={trade.netProfitYen >= 0 ? 'metric-up' : 'metric-down'}>
                          {formatYen(trade.netProfitYen)}
                        </td>
                        <td className={trade.netPips >= 0 ? 'metric-up' : 'metric-down'}>
                          {formatPips(trade.netPips)}
                        </td>
                        <td>{exitReasonLabels[trade.exitReason]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </section>
      )}
    </div>
  );
}
