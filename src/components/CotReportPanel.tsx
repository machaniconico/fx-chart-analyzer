import {
  ColorType,
  createChart,
  type HistogramData,
  type IChartApi,
  LineStyle,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cotCurrencies,
  defaultCotCurrencyForPair,
  describeCotContext,
  formatCotContracts,
  formatCotDate,
  type CotCurrency,
  type CotFile,
} from '../lib/cot';
import type { Pair } from '../types';

interface CotReportPanelProps {
  cot: CotFile | null;
  error?: string | null;
  pair: Pair;
}

const createCotChart = (container: HTMLDivElement): IChartApi =>
  createChart(container, {
    height: 430,
    layout: {
      background: { type: ColorType.Solid, color: '#10151f' },
      textColor: '#b9c2d0',
      fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(142,155,179,0.12)' },
      horzLines: { color: 'rgba(142,155,179,0.12)' },
    },
    crosshair: { mode: 1 },
    rightPriceScale: {
      borderColor: 'rgba(142,155,179,0.24)',
    },
    timeScale: {
      borderColor: 'rgba(142,155,179,0.24)',
      timeVisible: true,
      secondsVisible: false,
    },
  });

const formatUpdatedAt = (value: string | null | undefined): string => {
  if (!value) {
    return '未取得';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '未取得';
  }
  return date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
};

export function CotReportPanel({ cot, error, pair }: CotReportPanelProps) {
  const [currency, setCurrency] = useState<CotCurrency>(() => defaultCotCurrencyForPair(pair));
  const chartRef = useRef<HTMLDivElement | null>(null);
  const currencyData = cot?.currencies[currency] ?? null;
  const reports = useMemo(() => currencyData?.reports ?? [], [currencyData]);
  const latest = reports.length > 0 ? reports[reports.length - 1] : null;
  const previous = reports.length > 1 ? reports[reports.length - 2] : null;
  const weeklyChange = latest && previous ? latest.noncommNet - previous.noncommNet : null;
  const contextLine = latest ? describeCotContext(currency, latest, pair) : '';

  useEffect(() => {
    if (!chartRef.current || reports.length === 0) {
      return;
    }

    const chart = createCotChart(chartRef.current);
    const resizeObserver = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width > 0) {
        chart.applyOptions({ width });
      }
    });
    resizeObserver.observe(chartRef.current);

    const series = chart.addHistogramSeries({
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
      priceScaleId: '',
    });
    series.setData(
      reports.map<HistogramData>((report) => ({
        time: report.date as Time,
        value: report.noncommNet,
        color: report.noncommNet >= 0 ? 'rgba(32,201,151,0.7)' : 'rgba(255,91,120,0.7)',
      })),
    );
    series.createPriceLine({
      price: 0,
      color: 'rgba(236,242,255,0.52)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '0',
    });
    chart.timeScale().fitContent();

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [reports]);

  if (error) {
    return <div className="state-message state-error">{error}</div>;
  }

  if (!cot) {
    return <div className="state-message">COTデータを読み込んでいます...</div>;
  }

  if (!currencyData || reports.length === 0 || !latest) {
    return <div className="state-message">COTデータがありません。</div>;
  }

  return (
    <div className="cot-stack">
      <section className="calendar-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Commitments of Traders</p>
            <h2>COTレポート</h2>
          </div>
          <div className="rating-badge">更新: {formatUpdatedAt(cot.updatedAt)}</div>
        </div>

        <div className="cot-toolbar" aria-label="COT通貨選択">
          {cotCurrencies.map((item) => (
            <button
              key={item}
              className={currency === item ? 'segment segment-active' : 'segment'}
              type="button"
              onClick={() => setCurrency(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      <section className="chart-card">
        <div className="chart-heading">
          <span>大口投機筋ネットポジション</span>
          <span>{currencyData.market}</span>
        </div>
        <div ref={chartRef} className="chart-area cot-chart" />
      </section>

      <section className="calendar-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">最新スナップショット</p>
            <h2>{currency} {formatCotDate(latest.date)}</h2>
          </div>
          <div className={latest.noncommNet >= 0 ? 'rating-badge rating-buy' : 'rating-badge rating-sell'}>
            {latest.noncommNet >= 0 ? '買い越し' : '売り越し'}
          </div>
        </div>

        <div className="metric-grid cot-metrics">
          <div className="metric-card">
            <span>ネット</span>
            <strong className={latest.noncommNet >= 0 ? 'metric-up' : 'metric-down'}>
              {formatCotContracts(latest.noncommNet)}
            </strong>
            <small>noncomm long - short</small>
          </div>
          <div className="metric-card">
            <span>前週比</span>
            <strong className={(weeklyChange ?? 0) >= 0 ? 'metric-up' : 'metric-down'}>
              {weeklyChange === null ? '-' : formatCotContracts(weeklyChange)}
            </strong>
            <small>ネットポジション変化</small>
          </div>
          <div className="metric-card">
            <span>ロング</span>
            <strong>{formatCotContracts(latest.noncommLong)}</strong>
            <small>大口投機筋</small>
          </div>
          <div className="metric-card">
            <span>ショート</span>
            <strong>{formatCotContracts(latest.noncommShort)}</strong>
            <small>大口投機筋</small>
          </div>
          <div className="metric-card">
            <span>Open Interest</span>
            <strong>{formatCotContracts(latest.oi)}</strong>
            <small>全建玉</small>
          </div>
        </div>

        <p className="cot-context">{contextLine}</p>
      </section>

      <section className="calendar-panel">
        <div className="chart-heading cot-note-heading">
          <span>注記</span>
          <span>CFTC COT</span>
        </div>
        <ul className="cot-note-list">
          <li>週次データです。火曜時点の建玉が金曜に公表されるため、通常は約3日遅れの情報です。</li>
          <li>一般的には、極端な買い越し・売り越しに注目する逆張り指標として使われます。</li>
        </ul>
      </section>
    </div>
  );
}
