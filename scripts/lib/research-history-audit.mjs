/** Offline, read-only checkpoint inspection. This does not certify a complete
 * research universe, initialize a ledger, repair files, fit, or execute trades. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { canonicalJson, fingerprint, verifyAudit } from './virtual-autonomy.mjs';
import { planLegacyReservationMigration } from './research-migration.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(`research-history: ${message}`); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1000
  && value.split('/').every(p => /^[a-zA-Z0-9_.@-]+$/.test(p) && p !== '.' && p !== '..');
const signature = s => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
const MANIFEST = 'CHECKPOINT-MANIFEST.json';
const MAX_FILES = 10000, MAX_FILE_BYTES = 128 * 1024 * 1024, MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function fileInventory(root) {
  const files = new Map(); let total = 0, nodes = 0;
  const walk = (directory, prefix = '', depth = 0) => {
    assert(depth <= 32, 'directory depth limit');
    for (const entry of readdirSync(directory).sort()) {
      assert(++nodes <= 20000, 'directory entry limit');
      const relative = prefix ? `${prefix}/${entry}` : entry;
      assert(safePath(relative), 'unsafe checkpoint path');
      const path = join(directory, entry), s = lstatSync(path, { bigint: true });
      assert(!s.isSymbolicLink(), 'symlinks are not permitted');
      if (s.isDirectory()) walk(path, relative, depth + 1);
      else {
        assert(s.isFile() && s.nlink === 1n, 'only regular, non-hardlinked files are permitted');
        assert(s.size <= BigInt(MAX_FILE_BYTES), 'file size limit');
        total += Number(s.size);
        assert(files.size < MAX_FILES && total <= MAX_TOTAL_BYTES, 'checkpoint size limit');
        files.set(relative, signature(s));
      }
    }
  };
  walk(root); return files;
}

function readStable(root, relative, expectedSignature) {
  const path = join(root, ...relative.split('/'));
  assert(realpathSync(path) === path, 'symlink path changed during inspection');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile() && signature(before) === expectedSignature, 'file changed during inspection');
    const bytes = readFileSync(fd);
    assert(signature(fstatSync(fd, { bigint: true })) === expectedSignature && realpathSync(path) === path,
      'file changed during inspection');
    return bytes;
  } finally { closeSync(fd); }
}

const decode = bytes => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(Buffer.from(text).equals(bytes), 'noncanonical UTF-8 or byte-order mark');
  return text;
};
const parse = bytes => JSON.parse(decode(bytes));

/** expectedManifestHash must come from separately trusted custody if used as an
 * anchor. Matching a caller-supplied digest never proves that custody or excludes
 * other experiments. Omitting it checks only this checkpoint's internal integrity.
 * Operate on a quiescent copy. Stat checks detect ordinary concurrent changes,
 * not a hostile OS or a privileged actor racing filesystem reads. */
export function auditResearchHistory({ checkpointRoot, ledgerId, expectedManifestHash = null }) {
  assert(typeof checkpointRoot === 'string' && checkpointRoot.length > 0, 'checkpoint root required');
  assert(expectedManifestHash === null || hash(expectedManifestHash), 'invalid manifest pin');
  const root = resolve(checkpointRoot);
  assert(realpathSync(root) === root && lstatSync(root).isDirectory(), 'root must be a real directory, not a symlink');
  const inventory = fileInventory(root);
  assert(inventory.has(MANIFEST), 'checkpoint manifest required');
  const manifestBytes = readStable(root, MANIFEST, inventory.get(MANIFEST)), manifestHash = digest(manifestBytes);
  assert(expectedManifestHash === null || manifestHash === expectedManifestHash, 'manifest pin mismatch');
  const manifest = parse(manifestBytes);
  assert(manifest?.format === 1 && manifest.files && Object.getPrototypeOf(manifest.files) === Object.prototype,
    'invalid checkpoint manifest');
  const paths = Object.keys(manifest.files).sort();
  assert(paths.length > 0 && paths.every(p => p !== MANIFEST && safePath(p) && hash(manifest.files[p])),
    'invalid manifest file path/hash');
  assert(canonicalJson([...inventory.keys()].sort()) === canonicalJson([...paths, MANIFEST].sort()),
    'checkpoint inventory differs from manifest; missing or unlisted file');
  const bytes = new Map();
  for (const path of paths) {
    const content = readStable(root, path, inventory.get(path));
    assert(digest(content) === manifest.files[path], 'checkpoint file hash mismatch');
    bytes.set(path, content);
  }

  const sources = [], journals = [], referencedArtifacts = new Set();
  for (const path of paths.filter(p => p.split('/').at(-1) === 'audit.jsonl')) {
    const text = decode(bytes.get(path));
    assert(text === '' || text.endsWith('\n'), 'incomplete audit line');
    const lines = text === '' ? [] : text.slice(0, -1).split('\n');
    assert(lines.every(line => line.trim().length > 0), 'blank audit line');
    const events = lines.map(JSON.parse);
    verifyAudit(events);
    const artifacts = new Set();
    for (const event of events) {
      if (event.type === 'holdout-reserved') {
        assert(event.artifact === undefined && event.artifactHash === undefined, 'reservation cannot contain an artifact');
        continue;
      }
      assert(['request-snapshotted', 'engine-snapshotted', 'trial-recorded', 'selection-frozen',
        'holdout-recorded', 'result-prepared', 'cycle-completed'].includes(event.type), 'unsupported legacy audit event');
      assert(hash(event.cycleId) && safePath(event.artifact) && hash(event.artifactHash)
        && event.artifact.startsWith(`${event.cycleId}/`), 'invalid audit artifact reference');
      const artifact = (dirname(path) === '.' ? '' : `${dirname(path).split(sep).join('/')}/`) + event.artifact;
      assert(bytes.has(artifact), 'referenced artifact not in checkpoint');
      assert(digest(bytes.get(artifact)) === event.artifactHash, 'audit artifact hash mismatch');
      parse(bytes.get(artifact)); // Legacy artifacts are JSON, but their identity is the exact byte hash.
      artifacts.add(artifact); referencedArtifacts.add(artifact);
    }
    sources.push({ sourceId: `checkpoint-audit-${String(sources.length + 1).padStart(4, '0')}`, events });
    journals.push({ path, eventCount: events.length, sourceHash: fingerprint(events),
      auditHeadHash: events.at(-1)?.hash ?? null, artifactCount: artifacts.size });
  }
  assert(sources.length > 0, 'no legacy audit source; absence is not empty research history');
  const migration = planLegacyReservationMigration({ ledgerId, sources });

  // These are selected extracts, not all-trial history. Span lengths alone do
  // not identify exact historical intervals or justify a consumedBefore cutoff.
  const selectedReports = paths.filter(p => /(^|\/)tune-virtual-strategies-[^/]+\.selected\.json$/.test(p)).map(path => {
    const report = parse(bytes.get(path));
    const sourceHash = report?.source?.sha256;
    assert(hash(sourceHash), 'selected report lacks source hash');
    return { path, sourceHash, fullSourcePresent: paths.some(p => manifest.files[p] === sourceHash),
      selectedCandidateCount: Array.isArray(report.candidates) ? report.candidates.length : null,
      evaluatedCombinationCount: Number.isSafeInteger(report.summary?.combinationCount) && report.summary.combinationCount >= 0
        ? report.summary.combinationCount : null };
  });
  assert(canonicalJson([...fileInventory(root)]) === canonicalJson([...inventory]), 'checkpoint changed during inspection');

  return { schemaVersion: 1, mode: 'read-only-history-audit', activationReady: false,
    manifestHash, manifestPinMatched: expectedManifestHash === null ? null : true,
    anchorCustodyVerified: false, historicalCompletenessProven: false,
    verifiedFileCount: paths.length, journals, referencedArtifactCount: referencedArtifacts.size,
    selectedReports, exactReservations: migration.exactReservations, proposedLedger: migration.proposedLedger,
    // This is a lower bound from known records, never a globally fresh-data certificate.
    knownReservationEnd: migration.earliestNewHoldoutStart,
    blockers: [...(expectedManifestHash === null ? ['checkpoint_manifest_not_externally_pinned'] : []),
      'independent_anchor_custody_not_verified', 'full_historical_source_inventory_not_proven',
      ...(selectedReports.some(r => !r.fullSourcePresent) ? ['selected_legacy_reports_missing_full_sources'] : []),
      'no_ledger_or_activation_changes_performed'] };
}
