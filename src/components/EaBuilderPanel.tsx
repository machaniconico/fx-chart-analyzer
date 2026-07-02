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
  defaultStrategies,
  type BollingerCondition,
  type EntryCondition,
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
}

const cloneStrategy = (strategy: StrategyDefinition): StrategyDefinition =>
  JSON.parse(JSON.stringify(strategy)) as StrategyDefinition;

const formatPips = (value: number): string => `${value.toFixed(1)} pips`;

const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

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
      color: result.netPips >= 0 ? '#20c997' : '#ff5b78',
      lineWidth: 2,
      title: '累積損益(pips)',
    });
    line.setData(
      result.equityCurve.map<LineData>((point) => ({
        time: point.time as Time,
        value: point.equityPips,
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

export function EaBuilderPanel({ bars, pair, timeframe }: EaBuilderPanelProps) {
  const [strategy, setStrategy] = useState<StrategyDefinition>(() => cloneStrategy(defaultStrategies[0]));
  const [result, setResult] = useState<BacktestResult | null>(null);
  const mql5Source = useMemo(() => generateMql5(strategy), [strategy]);
  const mql4Source = useMemo(() => generateMql4(strategy), [strategy]);

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
    setStrategy(updater);
  };

  const maCondition = getCondition('maCross');
  const rsiCondition = getCondition('rsi');
  const bbCondition = getCondition('bollinger');
  const macdCondition = getCondition('macdCross');

  const run = (): void => {
    setResult(runBacktest(bars, strategy, pair));
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
          <button className="primary-action" type="button" onClick={run}>
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
            <span className="field-label">ロット</span>
            <input
              min="0.01"
              step="0.01"
              type="number"
              value={strategy.lotSize}
              onChange={(event) =>
                updateStrategy((current) => ({
                  ...current,
                  lotSize: Number(event.target.value),
                }))
              }
            />
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
                  magicNumber: Math.round(Number(event.target.value)),
                }))
              }
            />
          </label>
        </div>

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
                        fastPeriod: Math.round(Number(event.target.value)),
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
                        slowPeriod: Math.round(Number(event.target.value)),
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
                        period: Math.round(Number(event.target.value)),
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
                        threshold: Number(event.target.value),
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
                        period: Math.round(Number(event.target.value)),
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
                        multiplier: Number(event.target.value),
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
                        fastPeriod: Math.round(Number(event.target.value)),
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
                        slowPeriod: Math.round(Number(event.target.value)),
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
                        signalPeriod: Math.round(Number(event.target.value)),
                      }))
                    }
                  />
                </label>
              </div>
            )}
          </section>
        </div>

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
                    exit: { ...current.exit, stopLossPips: Math.round(Number(event.target.value)) },
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
                    exit: { ...current.exit, takeProfitPips: Math.round(Number(event.target.value)) },
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
                    exit: { ...current.exit, trailingStopPips: Math.round(Number(event.target.value)) },
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

        <div className="download-row">
          <button
            className="secondary-action"
            type="button"
            onClick={() => downloadText(`${filenameBase}.mq5`, mql5Source)}
          >
            MQL5をダウンロード
          </button>
          <button
            className="secondary-action"
            type="button"
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
              <strong className={result.netPips >= 0 ? 'metric-up' : 'metric-down'}>
                {formatPips(result.netPips)}
              </strong>
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
              <strong>{formatPips(result.maxDrawdownPips)}</strong>
              <small>{formatPercent(result.maxDrawdownPct)}</small>
            </article>
            <article className="metric-card">
              <span>取引回数</span>
              <strong>{result.tradeCount.toLocaleString('ja-JP')}</strong>
            </article>
            <article className="metric-card">
              <span>スプレッド</span>
              <strong>{formatPips(result.spreadPips)}</strong>
            </article>
          </div>

          <section className="chart-card">
            <div className="chart-heading">
              <span>資産曲線</span>
              <span>累積pips</span>
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
                      <th>損益</th>
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
