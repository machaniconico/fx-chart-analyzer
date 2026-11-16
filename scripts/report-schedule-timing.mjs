#!/usr/bin/env node
/** Read-only scheduling telemetry. No retries, dispatches, data writes or trades.
 * GitHub does not expose the intended nominal occurrence for a delayed schedule.
 * The nearest occurrence before run creation is therefore a lower bound, not an SLA.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const assert = (ok, message) => { if (!ok) throw new Error(`schedule-timing: ${message}`); };
const date = (value, label) => {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), `invalid ${label}`);
  const parsed = Date.parse(value);
  assert(Number.isSafeInteger(parsed) && parsed >= 0 && new Date(parsed).toISOString().replace('.000Z','Z') === value.replace('.000Z','Z'), `invalid ${label}`);
  return parsed;
};
export function dailyCronMinute(cron) {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron ?? '');
  assert(match && Number(match[1]) <= 59 && Number(match[2]) <= 23, 'only a fixed daily UTC cron is supported');
  return Number(match[2]) * 60 + Number(match[1]);
}
export function summarizeScheduleTiming({ run, eventName, cron, observedAt, expectedRunId }) {
  assert(run && String(run.id) === String(expectedRunId) && /^[1-9]\d*$/.test(String(expectedRunId)), 'run identity mismatch');
  assert(['schedule','workflow_dispatch'].includes(eventName) && run.event === eventName, 'event mismatch');
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt >= 1, 'invalid run attempt');
  const created = date(run.created_at, 'run creation time'), started = date(run.run_started_at, 'attempt start time');
  assert(Number.isSafeInteger(observedAt) && observedAt >= started && started >= created, 'invalid observation clock');
  const common = { schemaVersion: 1, event: eventName, runId: String(run.id), attempt: run.run_attempt,
    createdAt: new Date(created).toISOString(), attemptStartedAt: new Date(started).toISOString(),
    observedAt: new Date(observedAt).toISOString(), elapsedSinceCreationMs: observedAt-created,
    elapsedSinceAttemptStartMs: observedAt-started };
  if (eventName === 'workflow_dispatch') return { ...common, cron: null, latestNominalOccurrenceAt: null,
    creationDelayLowerBoundMs: null, warning: null, timingScope: 'manual run; no scheduled deadline inferred' };
  const minute = dailyCronMinute(cron), day = 86400000;
  let occurrence = Math.floor(created/day)*day + minute*60000;
  if (occurrence > created) occurrence -= day;
  const delay = created-occurrence;
  return { ...common, cron, latestNominalOccurrenceAt: new Date(occurrence).toISOString(),
    creationDelayLowerBoundMs: delay, warning: delay >= 30*60000 ? 'scheduled_creation_delayed_at_least_30_minutes' : null,
    timingScope: 'Nearest daily occurrence before original run creation. Lower bound only: missed/dropped or >24h delayed occurrences cannot be identified. Reruns retain original creation timing.' };
}
export function timingSummary(report) {
  const lines = ['## Daily FX scheduling timing', '', `- Event: ${report.event}; attempt: ${report.attempt}`,
    `- Original workflow created: ${report.createdAt}`, `- Current attempt started: ${report.attemptStartedAt}`,
    `- Timing observed after checkout/setup: ${report.observedAt}`];
  if (report.event === 'schedule') lines.push(`- UTC cron: ${report.cron}`,
    `- Nearest nominal occurrence before creation: ${report.latestNominalOccurrenceAt}`,
    `- Creation delay lower bound: ${(report.creationDelayLowerBoundMs/60000).toFixed(2)} minutes`);
  lines.push('', report.timingScope, '', 'Telemetry only. No extra run is dispatched, and a delay does not stop data refresh.');
  return lines.join('\n')+'\n';
}
export function readWorkflowRun(repository, runId) {
  assert(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'invalid repository');
  assert(/^[1-9]\d*$/.test(String(runId)), 'invalid run ID');
  return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs/${runId}`],
    { encoding:'utf8', timeout:15000, maxBuffer:1024*1024, stdio:['ignore','pipe','pipe'] }));
}
export function main({ env = process.env, readRun = readWorkflowRun, now = Date.now,
  appendSummary = appendFileSync, log = console.log } = {}) {
  const report = summarizeScheduleTiming({ run: readRun(env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID),
    eventName: env.GITHUB_EVENT_NAME, cron: env.EVENT_SCHEDULE, observedAt: now(), expectedRunId: env.GITHUB_RUN_ID });
  if (env.GITHUB_STEP_SUMMARY) appendSummary(env.GITHUB_STEP_SUMMARY, timingSummary(report));
  log(JSON.stringify(report));
  if (report.warning) log('::warning title=Daily FX schedule delayed::Workflow creation was at least 30 minutes after the nearest scheduled time. Data refresh continues; no duplicate run was started.');
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch {
    console.warn('::warning title=Daily FX scheduling telemetry unavailable::Timing could not be verified. The workflow continues its data refresh; no retry or extra run was started.');
    process.exitCode = 1;
  }
}
