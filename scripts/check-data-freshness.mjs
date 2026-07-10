import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataRoot = path.resolve(__dirname, '../public/data');

// Fail-visible thresholds and constants.
const FRESHNESS_LIMIT_HOURS = 96;
const HOUR_MS = 3_600_000;
const PAIR_PATTERN = /^[A-Z]{6}$/; // pair dirs like USDJPY; skips stats/forward.
const DATA_BRANCH = 'data/daily-update';

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const findLatestCandleMs = async () => {
  const entries = await readdir(dataRoot, { withFileTypes: true });
  const pairs = entries
    .filter((entry) => entry.isDirectory() && PAIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  let latestMs = 0;
  let latestSource = null;
  for (const pair of pairs) {
    const pairDir = path.join(dataRoot, pair);
    const files = (await readdir(pairDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      const payload = await readJson(path.join(pairDir, file));
      if (!Array.isArray(payload.bars)) continue;
      for (const bar of payload.bars) {
        const ms = Number(bar.t) * 1000;
        if (Number.isFinite(ms) && ms > latestMs) {
          latestMs = ms;
          latestSource = `${pair}/${file}`;
        }
      }
    }
  }
  return { latestMs, latestSource, pairCount: pairs.length };
};

const verifyDataPr = () => {
  let raw;
  try {
    raw = execFileSync(
      'gh',
      ['pr', 'view', DATA_BRANCH, '--json', 'state,autoMergeRequest,number,url'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim();
    return {
      ok: false,
      message: `Data changed this run but no usable PR found for ${DATA_BRANCH} (gh pr view failed: ${detail}).`,
    };
  }

  let pr;
  try {
    pr = JSON.parse(raw);
  } catch {
    return { ok: false, message: `Could not parse gh pr view output for ${DATA_BRANCH}.` };
  }

  const label = `PR #${pr.number} (${pr.url})`;
  if (pr.state === 'MERGED') {
    return { ok: true, message: `Data persistence OK: ${label} already merged into main.` };
  }
  if (pr.state === 'OPEN') {
    if (pr.autoMergeRequest) {
      return { ok: true, message: `Data persistence OK: ${label} open with auto-merge enabled.` };
    }
    return {
      ok: false,
      message: `${label} is open but auto-merge is NOT enabled; data would not persist to main.`,
    };
  }
  return {
    ok: false,
    message: `${label} is in state ${pr.state}; expected OPEN (with auto-merge) or MERGED.`,
  };
};

const isTruthy = (value) => /^(1|true|yes)$/i.test((value ?? '').trim());

const main = async () => {
  const now = Date.now();
  const failures = [];

  const { latestMs, latestSource, pairCount } = await findLatestCandleMs();
  if (latestMs === 0) {
    failures.push(`No candle data found under ${dataRoot} (scanned ${pairCount} pair directories).`);
  } else {
    const ageHours = (now - latestMs) / HOUR_MS;
    const latestIso = new Date(latestMs).toISOString();
    console.log(
      `Latest candle: ${latestIso} (${latestSource}), age ${ageHours.toFixed(1)}h, limit ${FRESHNESS_LIMIT_HOURS}h.`,
    );
    if (ageHours > FRESHNESS_LIMIT_HOURS) {
      failures.push(
        `Stale data: latest candle ${latestIso} is ${ageHours.toFixed(1)}h old, ` +
          `exceeding the ${FRESHNESS_LIMIT_HOURS}h freshness limit.`,
      );
    }
  }

  const dataChanged = isTruthy(process.env.DATA_CHANGED) || process.argv.includes('--data-changed');
  if (dataChanged) {
    const prCheck = verifyDataPr();
    console.log(prCheck.message);
    if (!prCheck.ok) failures.push(prCheck.message);
  } else {
    console.log('DATA_CHANGED not set: skipping PR persistence check (no data change this run).');
  }

  if (failures.length > 0) {
    console.error('\nData freshness gate FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nData freshness gate passed.');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
