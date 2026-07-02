import { useEffect, useMemo, useState } from 'react';
import { ChartPanel, type IndicatorToggles } from './components/ChartPanel';
import { EaBuilderPanel } from './components/EaBuilderPanel';
import { EconomicCalendarPanel } from './components/EconomicCalendarPanel';
import { PredictionPanel } from './components/PredictionPanel';
import { SignalPanel } from './components/SignalPanel';
import { loadCalendar, type CalendarEvent, type CalendarFile } from './lib/calendar';
import { formatPrice, lastBar, loadAdaptiveStats, loadBars, type AdaptiveStatsFile } from './lib/chart-data';
import { analyzeSignals } from './lib/signals';
import type { DataFile, Pair, Timeframe } from './types';
import { PAIRS, TIMEFRAMES, timeframeLabels } from './types';

const defaultToggles: IndicatorToggles = {
  sma20: true,
  sma50: true,
  sma200: false,
  ema12: false,
  ema26: false,
  bb: true,
  ichimoku: true,
};

const indicatorLabels: Array<[keyof IndicatorToggles, string]> = [
  ['sma20', 'SMA20'],
  ['sma50', 'SMA50'],
  ['sma200', 'SMA200'],
  ['ema12', 'EMA12'],
  ['ema26', 'EMA26'],
  ['bb', 'BB'],
  ['ichimoku', '一目雲'],
];

const emptyCalendarEvents: CalendarEvent[] = [];

type ActiveTab = 'chart' | 'prediction' | 'calendar' | 'ea';

function App() {
  const [pair, setPair] = useState<Pair>('USDJPY');
  const [timeframe, setTimeframe] = useState<Timeframe>('h1');
  const [activeTab, setActiveTab] = useState<ActiveTab>('chart');
  const [toggles, setToggles] = useState<IndicatorToggles>(defaultToggles);
  const [data, setData] = useState<DataFile | null>(null);
  const [calendar, setCalendar] = useState<CalendarFile | null>(null);
  const [adaptiveStats, setAdaptiveStats] = useState<AdaptiveStatsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

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
          setError(reason instanceof Error ? reason.message : 'データ読み込みに失敗しました');
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

  const current = data ? lastBar(data.bars) : null;
  const previous = data && data.bars.length > 1 ? data.bars[data.bars.length - 2] : null;
  const change = current && previous ? current.c - previous.c : 0;
  const changePercent = current && previous ? (change / previous.c) * 100 : 0;
  const signalAnalysis = useMemo(
    () => (data ? analyzeSignals(data.bars) : null),
    [data],
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
            ) : activeTab === 'calendar' ? (
              <EconomicCalendarPanel
                events={calendarEvents}
                pair={pair}
                updatedAt={calendar?.updatedAt}
                now={now}
              />
            ) : (
              <EaBuilderPanel bars={data.bars} pair={pair} timeframe={timeframe} />
            )
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
