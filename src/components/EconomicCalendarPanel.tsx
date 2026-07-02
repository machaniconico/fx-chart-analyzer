import { useMemo, useState } from 'react';
import {
  calendarImpactLabels,
  formatCalendarTimeJst,
  pairCurrencies,
  type CalendarEvent,
} from '../lib/calendar';
import type { Pair } from '../types';

interface EconomicCalendarPanelProps {
  events: CalendarEvent[];
  pair: Pair;
  updatedAt?: string | null;
  now?: number;
}

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

const valueOrDash = (value: string): string => value.trim() || '-';

function EventRows({ events }: { events: CalendarEvent[] }) {
  if (events.length === 0) {
    return <p className="empty-copy">該当する指標はありません。</p>;
  }
  return (
    <div className="calendar-table-wrap">
      <table className="calendar-table">
        <thead>
          <tr>
            <th>時刻(JST)</th>
            <th>通貨</th>
            <th>重要度</th>
            <th>指標</th>
            <th>予想</th>
            <th>前回</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={`${event.currency}-${event.time}-${event.title}`}>
              <td>{formatCalendarTimeJst(event.time)}</td>
              <td>{event.currency}</td>
              <td>
                <span className={`impact-pill impact-${event.impact}`}>
                  {calendarImpactLabels[event.impact]}
                </span>
              </td>
              <td>{event.title}</td>
              <td>{valueOrDash(event.forecast)}</td>
              <td>{valueOrDash(event.previous)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EconomicCalendarPanel({
  events,
  pair,
  updatedAt,
  now = Math.floor(Date.now() / 1000),
}: EconomicCalendarPanelProps) {
  const [currencyFilter, setCurrencyFilter] = useState<string>('all');
  const quickCurrencies = pairCurrencies(pair);
  const filteredEvents = useMemo(
    () =>
      events.filter((event) => currencyFilter === 'all' || event.currency === currencyFilter),
    [currencyFilter, events],
  );
  const upcoming = filteredEvents
    .filter((event) => event.time >= now)
    .sort((a, b) => a.time - b.time);
  const past = filteredEvents
    .filter((event) => event.time < now)
    .sort((a, b) => b.time - a.time);

  return (
    <div className="calendar-stack">
      <section className="calendar-panel calendar-table-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">経済指標</p>
            <h2>イベント一覧</h2>
          </div>
          <div className="rating-badge">更新: {formatUpdatedAt(updatedAt)}</div>
        </div>

        <div className="calendar-filter-row" aria-label="通貨フィルタ">
          <button
            className={currencyFilter === 'all' ? 'segment segment-active' : 'segment'}
            type="button"
            onClick={() => setCurrencyFilter('all')}
          >
            全通貨
          </button>
          {quickCurrencies.map((currency) => (
            <button
              key={currency}
              className={currencyFilter === currency ? 'segment segment-active' : 'segment'}
              type="button"
              onClick={() => setCurrencyFilter(currency)}
            >
              {currency}
            </button>
          ))}
        </div>
      </section>

      <section className="calendar-panel calendar-table-panel">
        <div className="chart-heading">
          <span>今後</span>
          <span>{upcoming.length.toLocaleString('ja-JP')}件</span>
        </div>
        <EventRows events={upcoming} />
      </section>

      <section className="calendar-panel">
        <div className="chart-heading">
          <span>過去</span>
          <span>{past.length.toLocaleString('ja-JP')}件</span>
        </div>
        <EventRows events={past} />
      </section>
    </div>
  );
}
