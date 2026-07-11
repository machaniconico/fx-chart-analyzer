import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const sources = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
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
  // nextweek は週境界などで404を返すことがあるため、ソース単位で失敗を許容し成功分だけマージする
  const settled = await Promise.allSettled(sources.map(loadSource));
  for (const result of settled) {
    if (result.status === 'rejected') {
      console.warn(`skipped source: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
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
