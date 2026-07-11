import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataRoot = path.resolve(__dirname, '../public/data');

// Fail-visible thresholds and constants.
const FRESHNESS_LIMIT_HOURS = 96;
const HOUR_MS = 3_600_000;
const PAIR_PATTERN = /^[A-Z]{6}$/; // pair dirs like USDJPY; skips stats/forward.
const DATA_BRANCH = 'data/daily-update';
// An auto-merge PR that stays open past this is a stuck required check (never merging),
// not a healthy same-run PR. Healthy runs create a fresh PR daily (< ~24h old).
const OPEN_PR_MAX_AGE_HOURS = 26;

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

export const findLatestCandleMs = async () => {
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

const gitHeadSha = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const readDataPr = () => {
  try {
    const raw = execFileSync(
      'gh',
      ['pr', 'view', DATA_BRANCH, '--json', 'state,autoMergeRequest,number,url,headRefOid,createdAt'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { raw };
  } catch (error) {
    return { error: (error.stderr || error.message || '').toString().trim() };
  }
};

// Pure so it can be unit-tested with mocked gh/git output. The gate must confirm THIS
// run's commit actually persisted, not just that *some* PR exists on the branch:
//   - `gh pr view` falls back to the most recent PR when none is open, so yesterday's
//     MERGED PR (different head SHA) must NOT pass — hence the headRefOid match.
//   - A required check stuck red keeps a PR open with auto-merge forever; a fresh SHA is
//     force-pushed onto it daily, so SHA match alone can't catch it — hence the age gate.
export const verifyDataPr = ({ pr, headSha, nowMs = Date.now(), maxOpenAgeHours = OPEN_PR_MAX_AGE_HOURS }) => {
  if (!pr) {
    return { ok: false, message: `Data changed this run but no usable PR was found for ${DATA_BRANCH}.` };
  }
  const label = `PR #${pr.number} (${pr.url})`;
  if (!headSha) {
    return { ok: false, message: `Could not determine the current HEAD sha to match against ${label}.` };
  }
  if (pr.headRefOid !== headSha) {
    return {
      ok: false,
      message:
        `${label} head ${String(pr.headRefOid).slice(0, 12)} does not match this run's commit ` +
        `${headSha.slice(0, 12)}; today's data was not persisted through this PR.`,
    };
  }
  if (pr.state === 'MERGED') {
    return { ok: true, message: `Data persistence OK: ${label} (this run's commit) merged into main.` };
  }
  if (pr.state === 'OPEN') {
    if (!pr.autoMergeRequest) {
      return {
        ok: false,
        message: `${label} is open but auto-merge is NOT enabled; data would not persist to main.`,
      };
    }
    const createdMs = Date.parse(pr.createdAt);
    if (Number.isFinite(createdMs) && nowMs - createdMs > maxOpenAgeHours * HOUR_MS) {
      const ageHours = ((nowMs - createdMs) / HOUR_MS).toFixed(1);
      return {
        ok: false,
        message:
          `${label} has been open with auto-merge for ${ageHours}h (> ${maxOpenAgeHours}h); ` +
          `the required check is likely stuck, so this data is not persisting to main.`,
      };
    }
    return { ok: true, message: `Data persistence OK: ${label} open with auto-merge, head matches this run.` };
  }
  return {
    ok: false,
    message: `${label} is in state ${pr.state}; expected OPEN (with auto-merge) or MERGED.`,
  };
};

const checkDataPr = () => {
  const { raw, error } = readDataPr();
  if (error) {
    return {
      ok: false,
      message: `Data changed this run but no usable PR found for ${DATA_BRANCH} (gh pr view failed: ${error}).`,
    };
  }
  let pr;
  try {
    pr = JSON.parse(raw);
  } catch {
    return { ok: false, message: `Could not parse gh pr view output for ${DATA_BRANCH}.` };
  }
  return verifyDataPr({ pr, headSha: gitHeadSha() });
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
    const prCheck = checkDataPr();
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

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
