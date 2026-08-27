import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// ff_calendar_nextweek.json は 2026-08 時点で恒久的に 404(週境界の一時的な404ではない)。
// lastweek / thismonth / nextmonth も同様に 404 で、この配信元に残っているのは thisweek だけ。
// 死んだURLを残すと毎run「skipped source」が出続け、本当に thisweek が落ちた日の警告が
// ノイズに埋もれる。カレンダーの見通しが約1週間しかないのはこの配信元側の制約。
const sources = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
];

const outputPath = resolve('public/data/calendar.json');
const FETCH_TIMEOUT_MS = 30_000;

const impactMap = new Map([
  ['High', 'high'],
  ['Medium', 'medium'],
  ['Low', 'low'],
  ['Holiday', 'holiday'],
]);

const normalizeText = (value) => (typeof value === 'string' ? value : '');

const normalizeEvent = (raw) => {
  const title = normalizeText(raw?.title).trim();
  const currency = normalizeText(raw?.country).trim().toUpperCase();
  const impact = impactMap.get(normalizeText(raw?.impact).trim());
  const time = Math.floor(Date.parse(normalizeText(raw?.date)) / 1000);

  if (!title || !currency || !impact || !Number.isFinite(time)) {
    return null;
  }

  return {
    title,
    currency,
    time,
    impact,
    forecast: normalizeText(raw?.forecast).trim(),
    previous: normalizeText(raw?.previous).trim(),
  };
};

const eventKey = (event) =>
  [event.time, event.currency, event.impact, event.title].join('\u0000');

const loadSource = async (url) => {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`${url} did not return an event array`);
  }
  return payload;
};

try {
  // ソース単位で失敗を許容し成功分だけマージする。設定済みソースの失敗は
  // ::warning:: で run のアノテーションに出す(console.warn だけだとログに埋もれる)。
  const settled = await Promise.allSettled(sources.map(loadSource));
  for (const result of settled) {
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : result.reason;
      console.warn(`::warning::calendar source failed: ${reason}`);
    }
  }
  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  if (fulfilled.length === 0) {
    throw new Error('all calendar sources failed');
  }
  const rawEvents = fulfilled.map((r) => r.value).flat();
  const eventsByKey = new Map();

  for (const rawEvent of rawEvents) {
    const event = normalizeEvent(rawEvent);
    if (!event) {
      continue;
    }
    eventsByKey.set(eventKey(event), event);
  }

  const output = {
    updatedAt: new Date().toISOString(),
    events: [...eventsByKey.values()].sort((a, b) => a.time - b.time),
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const tempPath = `${outputPath}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(tempPath, json, 'utf8');
  await rename(tempPath, outputPath);
  console.log(`Wrote ${output.events.length} calendar events to ${outputPath}`);
} catch (error) {
  try {
    await readFile(outputPath, 'utf8');
    console.warn(`Calendar fetch failed; keeping existing ${outputPath}.`);
  } catch {
    console.warn(`Calendar fetch failed and ${outputPath} does not exist.`);
  }
  console.warn(error instanceof Error ? error.message : String(error));
}
