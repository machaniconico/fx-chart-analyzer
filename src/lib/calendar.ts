import type { Pair } from '../types';

export type CalendarImpact = 'high' | 'medium' | 'low' | 'holiday';

export interface CalendarEvent {
  title: string;
  currency: string;
  time: number;
  impact: CalendarImpact;
  forecast: string;
  previous: string;
}

export interface CalendarFile {
  updatedAt: string;
  events: CalendarEvent[];
}

export const loadCalendar = async (): Promise<CalendarFile> => {
  const response = await fetch('/data/calendar.json', { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error('経済指標カレンダーを読み込めませんでした');
  }
  return (await response.json()) as CalendarFile;
};

export const pairCurrencies = (pair: Pair): [string, string] => [
  pair.slice(0, 3),
  pair.slice(3, 6),
];

export const eventMatchesPair = (event: CalendarEvent, pair: Pair): boolean =>
  pairCurrencies(pair).includes(event.currency);

export const calendarImpactLabels: Record<CalendarImpact, string> = {
  high: '高',
  medium: '中',
  low: '低',
  holiday: '休場',
};

export const relevantChartEvents = (
  events: readonly CalendarEvent[],
  pair: Pair,
): CalendarEvent[] =>
  events.filter(
    (event) =>
      eventMatchesPair(event, pair) &&
      (event.impact === 'high' || event.impact === 'medium'),
  );

export const upcomingEventsWithin = (
  events: readonly CalendarEvent[],
  pair: Pair,
  seconds: number,
  now = Math.floor(Date.now() / 1000),
): CalendarEvent[] =>
  events
    .filter(
      (event) =>
        eventMatchesPair(event, pair) &&
        event.time > now &&
        event.time <= now + seconds,
    )
    .sort((a, b) => a.time - b.time);

export const formatCalendarTimeJst = (time: number): string =>
  new Date(time * 1000).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
