#!/usr/bin/env node
/** Local-only migration planning; no network, credentials, writes to source files. */
import { readFileSync, existsSync, realpathSync, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planLegacyReservationMigration } from './lib/research-migration.mjs';
import { canonicalJson } from './lib/virtual-autonomy.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assert = (ok, message) => { if (!ok) throw new Error(`research-migration: ${message}`); };
export function planMigrationFiles({ manifestPath, output }, { repositoryRoot = root } = {}) {
  const manifestFile = resolve(manifestPath), manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  assert(manifest && Object.keys(manifest).sort().join(',') === 'ledgerId,missingSources,sources', 'manifest must contain ledgerId, sources, missingSources');
  assert(Array.isArray(manifest.sources), 'sources must be an array');
  const sources = manifest.sources.map(source => {
    assert(source && Object.keys(source).sort().join(',') === 'auditPath,sourceId' && typeof source.auditPath === 'string', 'source must contain sourceId and auditPath');
    const bytes = readFileSync(resolve(dirname(manifestFile), source.auditPath), 'utf8');
    const lines = bytes.split('\n');
    // A partially written journal is not repaired or silently dropped.
    if (lines.at(-1) === '') lines.pop();
    assert(lines.every(line => line.trim().length > 0), 'blank or partial audit line');
    return { sourceId: source.sourceId, events: lines.map(line => JSON.parse(line)) };
  });
  const plan = planLegacyReservationMigration({ ledgerId: manifest.ledgerId, sources, missingSources: manifest.missingSources });
  const reports = resolve(repositoryRoot, 'reports'), target = resolve(repositoryRoot, output);
  const rel = relative(reports, target);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel) && target.endsWith('.json'), 'output must be a new JSON file under private reports/');
  assert(!existsSync(target), 'output exists; never overwrite a migration plan');
  let ancestor = dirname(target); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  assert(realpathSync(ancestor) === ancestor, 'symlink output ancestors are not permitted');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const fd = openSync(target, 'wx', 0o600);
  try { writeFileSync(fd, canonicalJson(plan) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return { planHash: plan.planHash, activationReady: false, exactReservations: plan.exactReservations,
    unavailableSources: plan.unavailableSources, earliestNewHoldoutStart: plan.earliestNewHoldoutStart, path: target };
}
export function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help')) return { help: 'node scripts/plan-research-migration.mjs --manifest=PRIVATE_MANIFEST.json --output=reports/autonomy/migration-plan.json. Read-only sources, new private plan only, no remote initialization.' };
  const args = {};
  for (const arg of argv) {
    const match = /^--(manifest|output)=(.+)$/.exec(arg);
    assert(match && !Object.hasOwn(args, match[1]), 'invalid or duplicate argument'); args[match[1]] = match[2];
  }
  assert(args.manifest && args.output, 'explicit manifest and output required');
  return planMigrationFiles({ manifestPath: args.manifest, output: args.output });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main())); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
