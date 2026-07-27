import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataRoot = path.resolve(__dirname, '../public/data');
const healthFile = path.join(dataRoot, 'health.json');

// Fail-visible thresholds and constants.
const FRESHNESS_LIMIT_HOURS = 96;
// ignoreFlats can legitimately omit a few trailing candles for quiet cross pairs.
// Three hours leaves room for that while still exposing abnormal divergence between
// pairs on the same timeframe.
const PEER_LAG_WARN_HOURS = 3;
const HOUR_MS = 3_600_000;
const PAIR_PATTERN = /^[A-Z]{6}$/; // pair dirs like USDJPY; skips stats/forward.
const DATA_BRANCH = 'data/daily-update';
// Dukascopy can legitimately have no success for up to 72h from Friday close
// (21:00 UTC) to Monday open (21:00 UTC). 120h also absorbs one isolated weekday
// outage, so the gate only fails after 2+ consecutive business days without primary data.
const PRIMARY_STALE_LIMIT_HOURS = 120;
// This asks "did THIS run write health.json", so the limit must sit between the in-job gap and the
// gap between runs. The fetch step writes it and the gate reads it minutes later in the same job
// (0.1h in run 30309308282), while the cron fires daily — so 24h, being the sampling period itself,
// let a stale file pass whenever scheduling drift or a workflow_dispatch landed under 24h apart.
const HEALTH_STALE_LIMIT_HOURS = 6;
const SOURCE_HEALTH_TIMEFRAMES = ['m15', 'm30', 'h1', 'h4', 'd1'];
// An auto-merge PR that stays open past this is a stuck required check (never merging),
// not a healthy same-run PR. Healthy runs create a fresh PR daily (< ~24h old).
const OPEN_PR_MAX_AGE_HOURS = 26;

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));
const formatError = (error) => (error instanceof Error ? error.message : String(error));

// One decimal reads best during an incident, but at the boundary it rounds to the limit itself
// ("120.0h ago, exceeding the 120h limit") and looks like an off-by-one in the gate. Only when
// that happens, widen until the excess is actually visible.
const formatAgeHours = (ageHours, limitHours) =>
  Number(ageHours.toFixed(1)) > limitHours
    ? ageHours.toFixed(1)
    : ageHours.toFixed(7).replace(/0+$/, '').replace(/\.$/, '.0');

export const collectDatasetLatest = async () => {
  const entries = await readdir(dataRoot, { withFileTypes: true });
  const pairs = entries
    .filter((entry) => entry.isDirectory() && PAIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const datasets = [];
  for (const pair of pairs) {
    const pairDir = path.join(dataRoot, pair);
    const files = (await readdir(pairDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      const payload = await readJson(path.join(pairDir, file));
      let latestMs = null;
      if (Array.isArray(payload.bars)) {
        for (const bar of payload.bars) {
          if (bar?.t == null) continue;
          const ms = Number(bar.t) * 1000;
          if (Number.isFinite(ms) && (latestMs === null || ms > latestMs)) {
            latestMs = ms;
          }
        }
      }
      datasets.push({
        name: `${pair}/${file}`,
        pair,
        tf: path.basename(file, path.extname(file)),
        latestMs,
      });
    }
  }
  return { datasets, pairCount: pairs.length };
};

export const evaluateDatasetFreshness = ({
  datasets,
  nowMs = Date.now(),
  freshnessLimitHours = FRESHNESS_LIMIT_HOURS,
  peerLagWarnHours = PEER_LAG_WARN_HOURS,
}) => {
  const failures = [];
  const warnings = [];

  if (datasets.length === 0) {
    failures.push('No candle datasets found.');
  }

  const validDatasets = [];
  for (const dataset of datasets) {
    if (!Number.isFinite(dataset.latestMs)) {
      failures.push(`Dataset ${dataset.name} has no finite candle timestamp.`);
      continue;
    }

    validDatasets.push(dataset);
    const ageHours = (nowMs - dataset.latestMs) / HOUR_MS;
    if (ageHours > freshnessLimitHours) {
      failures.push(
        `Stale dataset ${dataset.name}: latest candle ${new Date(dataset.latestMs).toISOString()} ` +
          `is ${formatAgeHours(ageHours, freshnessLimitHours)}h old, exceeding the ` +
          `${freshnessLimitHours}h freshness limit.`,
      );
    }
  }

  const latestByTimeframe = new Map();
  for (const dataset of validDatasets) {
    const peerLatestMs = latestByTimeframe.get(dataset.tf);
    if (peerLatestMs === undefined || dataset.latestMs > peerLatestMs) {
      latestByTimeframe.set(dataset.tf, dataset.latestMs);
    }
  }
  for (const dataset of validDatasets) {
    const peerLatestMs = latestByTimeframe.get(dataset.tf);
    const peerLagHours = (peerLatestMs - dataset.latestMs) / HOUR_MS;
    if (peerLagHours >= peerLagWarnHours) {
      warnings.push(
        `Dataset ${dataset.name} trails the latest ${dataset.tf} peer by ` +
          `${peerLagHours.toFixed(1)}h (latest candle ${new Date(dataset.latestMs).toISOString()}, ` +
          `peer latest ${new Date(peerLatestMs).toISOString()}, warning threshold ` +
          `${peerLagWarnHours}h).`,
      );
    }
  }

  let summary = 'Dataset freshness: no datasets with finite candle timestamps.';
  if (validDatasets.length > 0) {
    const latest = validDatasets.reduce((candidate, dataset) =>
      dataset.latestMs > candidate.latestMs ? dataset : candidate,
    );
    const slowest = validDatasets.reduce((candidate, dataset) =>
      dataset.latestMs < candidate.latestMs ? dataset : candidate,
    );
    summary =
      `Dataset freshness: latest ${latest.name} at ${new Date(latest.latestMs).toISOString()}; ` +
      `slowest ${slowest.name} at ${new Date(slowest.latestMs).toISOString()}.`;
  }

  return { failures, warnings, summary };
};

export const evaluateSourceHealth = ({
  health,
  healthFileExists = health != null,
  healthReadError = null,
  nowMs = Date.now(),
  staleLimitHours = PRIMARY_STALE_LIMIT_HOURS,
}) => {
  if (healthReadError) {
    return {
      level: 'warn',
      message: `Source health file is invalid or unreadable: ${healthReadError}`,
    };
  }
  if (!healthFileExists) {
    return {
      level: 'warn',
      message: 'Source health file not found; the fetch step did not write health.json.',
    };
  }
  if (health === null) {
    return {
      level: 'warn',
      message: 'Source health file contains the JSON literal null instead of a health object.',
    };
  }
  if (typeof health !== 'object' || Array.isArray(health)) {
    return {
      level: 'warn',
      message: 'Source health file must contain a JSON object.',
    };
  }

  const updatedAtMs = Date.parse(health.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return {
      level: 'warn',
      message: 'Source health updatedAt is missing or invalid; this run cannot be verified.',
    };
  }
  const healthAgeHours = (nowMs - updatedAtMs) / HOUR_MS;
  if (healthAgeHours > HEALTH_STALE_LIMIT_HOURS) {
    return {
      level: 'warn',
      message:
        `Source health was updated ${formatAgeHours(healthAgeHours, HEALTH_STALE_LIMIT_HOURS)}h ago, over the ` +
        `${HEALTH_STALE_LIMIT_HOURS}h limit; it was not written by this run.`,
    };
  }

  if (typeof health.primaryOkThisRun !== 'boolean') {
    return {
      level: 'warn',
      message: 'Source health primaryOkThisRun must be a boolean.',
    };
  }

  const lastPrimarySuccessAt = health.lastPrimarySuccessAt;
  const lastPrimarySuccessMs = lastPrimarySuccessAt == null ? NaN : Date.parse(lastPrimarySuccessAt);
  if (!Number.isFinite(lastPrimarySuccessMs)) {
    return {
      level: 'warn',
      message: 'Last Dukascopy success is unknown; primary-source staleness cannot be determined yet.',
    };
  }

  const ageHours = (nowMs - lastPrimarySuccessMs) / HOUR_MS;
  if (ageHours > staleLimitHours) {
    return {
      level: 'fail',
      message:
        `Dukascopy last succeeded ${formatAgeHours(ageHours, staleLimitHours)}h ago, ` +
        `exceeding the ${staleLimitHours}h primary-source stale limit.`,
    };
  }

  const staleTimeframes = [];
  const trackingSinceValue = health.timeframeTrackingSince;
  const trackingSinceMs =
    trackingSinceValue == null ? NaN : Date.parse(trackingSinceValue);
  for (const timeframe of SOURCE_HEALTH_TIMEFRAMES) {
    const value = health.lastPrimarySuccessByTimeframe?.[timeframe];
    const successMs = value == null ? NaN : Date.parse(value);
    if (Number.isFinite(successMs)) {
      const timeframeAgeHours = (nowMs - successMs) / HOUR_MS;
      if (timeframeAgeHours > staleLimitHours) {
        staleTimeframes.push(
          `${timeframe} (last succeeded ${formatAgeHours(timeframeAgeHours, staleLimitHours)}h ago)`,
        );
      }
      continue;
    }
    if (Number.isFinite(trackingSinceMs)) {
      const trackingAgeHours = (nowMs - trackingSinceMs) / HOUR_MS;
      if (trackingAgeHours <= staleLimitHours) continue;
      staleTimeframes.push(
        `${timeframe} (never succeeded; tracked for ` +
          `${formatAgeHours(trackingAgeHours, staleLimitHours)}h)`,
      );
    }
  }
  if (staleTimeframes.length > 0) {
    // This must fail, not warn: warnings keep the workflow green and recreate the exact
    // "nobody looks because it is green" blind spot this gate closes. The 120h limit already
    // absorbs the 72h weekend gap plus one weekday outage, and this post-deploy gate cannot
    // interrupt data delivery.
    return {
      level: 'fail',
      message:
        `Dukascopy is stale for timeframes ${staleTimeframes.join(', ')}, ` +
        `exceeding the ${staleLimitHours}h primary-source stale limit.`,
    };
  }

  if (health.primaryOkThisRun === false) {
    return {
      level: 'warn',
      message:
        `Dukascopy returned no successful timeframes this run; ` +
        `the last success was ${ageHours.toFixed(1)}h ago (limit ${staleLimitHours}h).`,
    };
  }
  return {
    level: 'ok',
    message: `Primary-source health OK: Dukascopy last succeeded ${ageHours.toFixed(1)}h ago.`,
  };
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

  let health = null;
  let healthFileExists = true;
  let healthReadError = null;
  try {
    health = await readJson(healthFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      healthFileExists = false;
    } else {
      healthReadError = formatError(error);
    }
  }
  const dukascopyCount = Number(health?.sources?.dukascopy) || 0;
  const yahooFallbackCount = Number(health?.sources?.['yahoo-fallback']) || 0;
  const lastPrimarySuccessMs = health?.lastPrimarySuccessAt == null
    ? NaN
    : Date.parse(health.lastPrimarySuccessAt);
  const lastPrimarySummary = Number.isFinite(lastPrimarySuccessMs)
    ? `${health.lastPrimarySuccessAt}, ${((now - lastPrimarySuccessMs) / HOUR_MS).toFixed(1)}h ago`
    : 'unknown';
  console.log(
    `Source breakdown: dukascopy=${dukascopyCount}, yahoo-fallback=${yahooFallbackCount} ` +
      `(last primary success ${lastPrimarySummary}).`,
  );

  const sourceHealth = evaluateSourceHealth({
    health,
    healthFileExists,
    healthReadError,
    nowMs: now,
  });
  if (sourceHealth.level === 'warn') {
    console.log(`::warning::${sourceHealth.message}`);
  } else {
    console.log(sourceHealth.message);
  }
  if (sourceHealth.level === 'fail') {
    failures.push(sourceHealth.message);
  }

  const { datasets, pairCount } = await collectDatasetLatest();
  const datasetFreshness = evaluateDatasetFreshness({ datasets, nowMs: now });
  console.log(`${datasetFreshness.summary} Scanned ${pairCount} pair directories.`);
  for (const warning of datasetFreshness.warnings) {
    console.log(`::warning::${warning}`);
  }
  failures.push(...datasetFreshness.failures);

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
