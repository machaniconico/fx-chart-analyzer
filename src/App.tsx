import { useEffect, useMemo, useState } from 'react';
import { ChartPanel, type IndicatorToggles } from './components/ChartPanel';
import { CotReportPanel } from './components/CotReportPanel';
import { EaBuilderPanel } from './components/EaBuilderPanel';
import { EconomicCalendarPanel } from './components/EconomicCalendarPanel';
import { ForwardTestPanel } from './components/ForwardTestPanel';
import { PredictionPanel } from './components/PredictionPanel';
import { RecommendationPanel } from './components/RecommendationPanel';
import { SignalPanel } from './components/SignalPanel';
import { loadCalendar, type CalendarEvent, type CalendarFile } from './lib/calendar';
import { loadCot, type CotFile } from './lib/cot';
import { formatPrice, lastBar, loadAdaptiveStats, loadBars, type AdaptiveStatsFile } from './lib/chart-data';
import { getDefaultMtfTimeframe, getSelectableMtfTimeframes } from './lib/mtf';
import { analyzeSignals } from './lib/signals';
import type { DataFile, Pair, Timeframe } from './types';
import { PAIRS, TIMEFRAMES, timeframeLabels } from './types';

const defaultToggles: IndicatorToggles = {
  sma20: true,
  sma50: true,
  sma200: false,
  ema12: false,
  ema26: false,
  bb: false,
  ichimoku: false,
  supportResistance: false,
  newsMarkers: true,
  patternMarkers: true,
};

const indicatorTogglesStorageKey = 'fx-chart-analyzer.indicator-toggles.v1';

const indicatorLabels: Array<[keyof IndicatorToggles, string]> = [
  ['sma20', 'SMA20'],
  ['sma50', 'SMA50'],
  ['sma200', 'SMA200'],
  ['ema12', 'EMA12'],
  ['ema26', 'EMA26'],
  ['bb', 'BB'],
  ['ichimoku', '一目雲'],
  ['supportResistance', 'サポレジ'],
  ['newsMarkers', 'ニュース'],
  ['patternMarkers', 'パターン'],
];

const emptyCalendarEvents: CalendarEvent[] = [];
const offlineDataHint = 'オフラインの可能性があります。一度表示したデータはキャッシュから表示されます';

const dataLoadErrorMessage = (reason: unknown, fallback: string): string => {
  const message = reason instanceof Error ? reason.message : fallback;
  return message.includes(offlineDataHint) ? message : `${message}。${offlineDataHint}`;
};

type ActiveTab = 'recommend' | 'chart' | 'prediction' | 'cot' | 'calendar' | 'ea' | 'forward';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const loadStoredIndicatorToggles = (): IndicatorToggles => {
  if (typeof window === 'undefined') {
    return defaultToggles;
  }

  try {
    const raw = window.localStorage.getItem(indicatorTogglesStorageKey);
    if (!raw) {
      return defaultToggles;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return defaultToggles;
    }

    const restored = { ...defaultToggles };
    (Object.keys(defaultToggles) as Array<keyof IndicatorToggles>).forEach((key) => {
      if (typeof parsed[key] === 'boolean') {
        restored[key] = parsed[key];
      }
    });
    return restored;
  } catch {
    return defaultToggles;
  }
};

function App() {
  const [pair, setPair] = useState<Pair>('USDJPY');
  const [timeframe, setTimeframe] = useState<Timeframe>('h1');
  const [activeTab, setActiveTab] = useState<ActiveTab>('recommend');
  const [toggles, setToggles] = useState<IndicatorToggles>(() => loadStoredIndicatorToggles());
  const [mtfEnabled, setMtfEnabled] = useState(false);
  const [mtfTimeframe, setMtfTimeframe] = useState<Timeframe>(() => getDefaultMtfTimeframe('h1'));
  const [data, setData] = useState<DataFile | null>(null);
  const [mtfData, setMtfData] = useState<DataFile | null>(null);
  const [usdJpyData, setUsdJpyData] = useState<DataFile | null>(null);
  const [calendar, setCalendar] = useState<CalendarFile | null>(null);
  const [cot, setCot] = useState<CotFile | null>(null);
  const [cotError, setCotError] = useState<string | null>(null);
  const [adaptiveStats, setAdaptiveStats] = useState<AdaptiveStatsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mtfError, setMtfError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mtfLoading, setMtfLoading] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const safeMtfTimeframe = mtfTimeframe === timeframe ? getDefaultMtfTimeframe(timeframe) : mtfTimeframe;
  const selectableMtfTimeframes = useMemo(
    () => getSelectableMtfTimeframes(timeframe),
    [timeframe],
  );

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setAdaptiveStats(null);
    Promise.all([
      loadBars(pair, timeframe),
      loadAdaptiveStats(pair, timeframe).catch(() => null),
    ])
      .then(([payload, stats]) => {
        if (!disposed) {
          setData(payload);
          setAdaptiveStats(stats);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(dataLoadErrorMessage(reason, 'データ読み込みに失敗しました'));
          setData(null);
          setAdaptiveStats(null);
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [pair, timeframe]);

  useEffect(() => {
    setMtfTimeframe((currentTimeframe) =>
      currentTimeframe === timeframe ? getDefaultMtfTimeframe(timeframe) : currentTimeframe,
    );
  }, [timeframe]);

  useEffect(() => {
    try {
      window.localStorage.setItem(indicatorTogglesStorageKey, JSON.stringify(toggles));
    } catch {
      // localStorage can be unavailable in private or restricted browser modes.
    }
  }, [toggles]);

  useEffect(() => {
    if (!mtfEnabled) {
      setMtfData(null);
      setMtfError(null);
      setMtfLoading(false);
      return;
    }

    let disposed = false;
    setMtfLoading(true);
    setMtfError(null);
    setMtfData(null);
    loadBars(pair, safeMtfTimeframe)
      .then((payload) => {
        if (!disposed) {
          setMtfData(payload);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setMtfError(dataLoadErrorMessage(reason, 'MTFデータ読み込みに失敗しました'));
          setMtfData(null);
        }
      })
      .finally(() => {
        if (!disposed) {
          setMtfLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [mtfEnabled, pair, safeMtfTimeframe]);

  useEffect(() => {
    if (pair.endsWith('JPY')) {
      setUsdJpyData(null);
      return;
    }

    let disposed = false;
    setUsdJpyData(null);
    loadBars('USDJPY', timeframe)
      .then((payload) => {
        if (!disposed) {
          setUsdJpyData(payload);
        }
      })
      .catch(() => {
        if (!disposed) {
          setUsdJpyData(null);
        }
      });

    return () => {
      disposed = true;
    };
  }, [pair, timeframe]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    let disposed = false;
    loadCalendar()
      .then((payload) => {
        if (!disposed) {
          setCalendar(payload);
        }
      })
      .catch(() => {
        if (!disposed) {
          setCalendar({ updatedAt: '', events: [] });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    setCotError(null);
    loadCot()
      .then((payload) => {
        if (!disposed) {
          setCot(payload);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setCot(null);
          setCotError(dataLoadErrorMessage(reason, 'COTデータを読み込めませんでした'));
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  const current = data ? lastBar(data.bars) : null;
  const previous = data && data.bars.length > 1 ? data.bars[data.bars.length - 2] : null;
  const change = current && previous ? current.c - previous.c : 0;
  const changePercent = current && previous ? (change / previous.c) * 100 : 0;
  const signalAnalysis = useMemo(
    () => (data ? analyzeSignals(data.bars) : null),
    [data],
  );
  const mtfSignalAnalysis = useMemo(
    () => (mtfData ? analyzeSignals(mtfData.bars) : null),
    [mtfData],
  );
  const calendarEvents = calendar?.events ?? emptyCalendarEvents;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">静的FXチャート分析</p>
          <h1>FX Chart Analyzer</h1>
        </div>
        <nav className="tabs" aria-label="機能タブ">
          <button
            className={activeTab === 'recommend' ? 'tab tab-active' : 'tab'}
            type="button"
            onClick={() => setActiveTab('recommend')}
          >
            おすすめ
          </button>
          <button
            className={activeTab === 'chart' ? 'tab tab-active' : 'tab'}
            type="button"
            onClick={() => setActiveTab('chart')}
          >
            チャート分析
          </button>
          <button
            className={activeTab === 'prediction' ? 'tab tab-active' : 'tab'}
            type="button"
            onClick={() => setActiveTab('prediction')}
          >
            予測
          </button>
          <button
            className={activeTab === 'cot' ? 'tab tab-active' : 'tab'}
            type="button"
            onClick={() => setActiveTab('cot')}
          >
            COT
          </button>
          <button
            className={activeTab === 'calendar' ? 'tab tab-active' : 'tab'}
            type="button"
            onClick={() => setActiveTab('calendar')}
          >
            経済指標
          </button>
          <button
            className={activeTab === 'ea' ? 'tab tab-active' : 'tab'}
            type="button"
            onClick={() => setActiveTab('ea')}
          >
            EAビルダー
          </button>
          <button
            className={activeTab === 'forward' ? 'tab tab-active' : 'tab'}
            type="button"
            onClick={() => setActiveTab('forward')}
          >
            フォワードテスト
          </button>
        </nav>
      </header>

      <section className="workspace">
        <aside className="control-panel" aria-label="チャート設定">
          <div className="panel-section">
            <label className="field-label" htmlFor="pair">通貨ペア</label>
            <select id="pair" value={pair} onChange={(event) => setPair(event.target.value as Pair)}>
              {PAIRS.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>

          <div className="panel-section">
            <span className="field-label">時間足</span>
            <div className="segmented">
              {TIMEFRAMES.map((item) => (
                <button
                  key={item}
                  className={item === timeframe ? 'segment segment-active' : 'segment'}
                  type="button"
                  onClick={() => setTimeframe(item)}
                >
                  {timeframeLabels[item]}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'chart' && (
            <>
              <div className="panel-section">
                <span className="field-label">指標</span>
                <div className="toggle-grid">
                  {indicatorLabels.map(([key, label]) => (
                    <label key={key} className="toggle">
                      <input
                        type="checkbox"
                        checked={toggles[key]}
                        onChange={(event) =>
                          setToggles((currentToggles) => ({
                            ...currentToggles,
                            [key]: event.target.checked,
                          }))
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="panel-section">
                <span className="field-label">マルチタイムフレーム</span>
                <label className="toggle mtf-toggle">
                  <input
                    type="checkbox"
                    checked={mtfEnabled}
                    onChange={(event) => setMtfEnabled(event.target.checked)}
                  />
                  <span>MTF表示</span>
                </label>
                <label className="field-label mtf-select-label" htmlFor="mtf-timeframe">
                  セカンダリ時間足
                </label>
                <select
                  id="mtf-timeframe"
                  value={safeMtfTimeframe}
                  disabled={!mtfEnabled}
                  onChange={(event) => setMtfTimeframe(event.target.value as Timeframe)}
                >
                  {selectableMtfTimeframes.map((item) => (
                    <option key={item} value={item}>{timeframeLabels[item]}</option>
                  ))}
                </select>
                <small className="control-hint">メインと同じ時間足は選択できません。</small>
              </div>
            </>
          )}

          <div className="panel-section market-card">
            <span className="field-label">現在値</span>
            <strong>{current ? formatPrice(pair, current.c) : '読み込み中'}</strong>
            <span className={change >= 0 ? 'change change-up' : 'change change-down'}>
              {change >= 0 ? '+' : ''}{current ? formatPrice(pair, change) : '0'} / {changePercent.toFixed(2)}%
            </span>
            {data && <small>更新: {new Date(data.updatedAt).toLocaleString('ja-JP')}</small>}
            {data && <small>表示本数: {data.bars.length.toLocaleString('ja-JP')}</small>}
          </div>
        </aside>

        <section className="chart-workarea" aria-live="polite">
          {activeTab === 'recommend' ? (
            <RecommendationPanel />
          ) : activeTab === 'forward' ? (
            <ForwardTestPanel now={now} />
          ) : (
            <>
              {loading && <div className="state-message">データを読み込んでいます...</div>}
              {error && <div className="state-message state-error">{error}</div>}
              {!loading && !error && data && (
                activeTab === 'chart' ? (
                  <div className="chart-stack">
                    <ChartPanel
                      bars={data.bars}
                      pair={pair}
                      timeframe={timeframe}
                      toggles={toggles}
                      calendarEvents={calendarEvents}
                      mainSignalAnalysis={signalAnalysis}
                      mtf={{
                        enabled: mtfEnabled,
                        timeframe: safeMtfTimeframe,
                        bars: mtfData?.bars ?? null,
                        analysis: mtfSignalAnalysis,
                        loading: mtfLoading,
                        error: mtfError,
                      }}
                      now={now}
                    />
                    {signalAnalysis && <SignalPanel analysis={signalAnalysis} />}
                  </div>
                ) : activeTab === 'prediction' ? (
                  <PredictionPanel
                    bars={data.bars}
                    pair={pair}
                    timeframe={timeframe}
                    adaptiveStats={adaptiveStats}
                    calendarEvents={calendarEvents}
                    now={now}
                  />
                ) : activeTab === 'cot' ? (
                  <CotReportPanel cot={cot} error={cotError} pair={pair} />
                ) : activeTab === 'calendar' ? (
                  <EconomicCalendarPanel
                    events={calendarEvents}
                    pair={pair}
                    updatedAt={calendar?.updatedAt}
                    now={now}
                  />
                ) : (
                  <EaBuilderPanel
                    bars={data.bars}
                    pair={pair}
                    timeframe={timeframe}
                    usdJpyBars={pair === 'USDJPY' ? data.bars : usdJpyData?.bars}
                  />
                )
              )}
            </>
          )}
        </section>
      </section>

      <footer>
        このサイトの予測・分析は投資助言ではありません。取引判断はご自身の責任で行ってください。
      </footer>
    </main>
  );
}

export default App;
