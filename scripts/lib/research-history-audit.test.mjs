import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { appendAudit, canonicalJson, fingerprint } from './virtual-autonomy.mjs';
import { auditResearchHistory } from './research-history-audit.mjs';
import { main } from '../audit-research-history.mjs';

const ledgerId = 'history-audit-test-ledger';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const temp = fn => {
  const root = mkdtempSync(join(tmpdir(), 'history-audit-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const put = (root, path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const reservation = (suffix = 'a', start = 10, end = 20) => ({ type: 'holdout-reserved', at: 200,
  cycleId: fingerprint(`cycle-${suffix}`), requestHash: fingerprint(`request-${suffix}`), engineHash: fingerprint('engine'),
  testHash: fingerprint(`test-${suffix}`), start, end });
const manifest = root => {
  const files = {};
  const walk = (path = '') => {
    for (const dirent of readdirSync(join(root, path), { withFileTypes: true })) {
      const name = path ? `${path}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) walk(name);
      else if (name !== 'CHECKPOINT-MANIFEST.json') files[name] = digest(readFileSync(join(root, name)));
    }
  };
  walk(); const body = canonicalJson({ format: 1, files });
  writeFileSync(join(root, 'CHECKPOINT-MANIFEST.json'), body);
  return digest(body);
};
const fixture = root => {
  const r = reservation(), artifact = { mode: 'synthetic-test-fixture', value: 1 };
  const events = appendAudit(appendAudit([], r), { type: 'request-snapshotted', cycleId: r.cycleId,
    at: 201, artifact: `${r.cycleId}/request.json`, artifactHash: fingerprint(artifact) });
  put(root, 'reports/state/audit.jsonl', events.map(e => canonicalJson(e)).join('\n') + '\n');
  put(root, `reports/state/${r.cycleId}/request.json`, canonicalJson(artifact));
  put(root, 'README.md', 'No observed data.\n');
  return { checkpointRoot: root, ledgerId, expectedManifestHash: manifest(root) };
};
const rewriteAudit = (root, records) => {
  const events = records.reduce((all, record) => appendAudit(all, record), []);
  put(root, 'reports/state/audit.jsonl', events.map(e => canonicalJson(e)).join('\n') + (events.length ? '\n' : ''));
  manifest(root); return events;
};

describe('read-only checkpoint history audit', () => {
  it('checks exact inventory, file hashes, journals and artifacts without certifying activation', () => temp(root => {
    const args = fixture(root);
    const result = auditResearchHistory(args);
    expect(result).toMatchObject({ verifiedFileCount: 3, referencedArtifactCount: 1, exactReservations: 1,
      manifestPinMatched: true, historicalCompletenessProven: false, anchorCustodyVerified: false, activationReady: false });
    expect(result.journals[0]).toMatchObject({ eventCount: 2, artifactCount: 1 });
    const { type, at, ...identity } = reservation();
    expect(result.proposedLedger.reservations[0]).toMatchObject({ ...identity, reservedAt: at, status: 'reserved' });
  }));
  it('does not infer a trusted external anchor from the manifest stored beside the files', () => temp(root => {
    const args = fixture(root), result = auditResearchHistory({ ...args, expectedManifestHash: null });
    expect(result.manifestPinMatched).toBe(null);
    expect(result.blockers).toContain('checkpoint_manifest_not_externally_pinned');
    expect(result.blockers).toContain('full_historical_source_inventory_not_proven');
  }));
  it('rejects a changed file even without a separate manifest pin', () => temp(root => {
    const args = fixture(root); put(root, 'README.md', 'modified');
    expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow('file hash mismatch');
  }));
  it('accepts the existing retired-strategy filename convention', () => temp(root => {
    const args = fixture(root); put(root, 'strategies/retired/example-v1@123.json', '{}');
    args.expectedManifestHash = manifest(root);
    expect(auditResearchHistory(args).verifiedFileCount).toBe(4);
  }));
  it('rejects a rehashed valid journal prefix when an older external manifest pin is supplied', () => temp(root => {
    const args = fixture(root); rewriteAudit(root, [reservation()]);
    expect(() => auditResearchHistory(args)).toThrow('manifest pin mismatch');
    const result = auditResearchHistory({ ...args, expectedManifestHash: null });
    expect(result.activationReady).toBe(false); expect(result.historicalCompletenessProven).toBe(false);
  }));
  it('rejects a fully removed source even when the remaining manifest is self-consistent', () => temp(root => {
    const args = fixture(root);
    put(root, 'reports/second/audit.jsonl', canonicalJson(appendAudit([], reservation('b', 30, 40))[0]) + '\n');
    args.expectedManifestHash = manifest(root);
    rmSync(join(root, 'reports/second'), { recursive: true }); manifest(root);
    expect(() => auditResearchHistory(args)).toThrow('manifest pin mismatch');
  }));
  it('rejects missing files and unlisted added journals', () => temp(root => {
    const args = fixture(root); rmSync(join(root, 'README.md'));
    expect(() => auditResearchHistory(args)).toThrow('inventory differs');
    put(root, 'README.md', 'No observed data.\n'); put(root, 'reports/other/audit.jsonl', '');
    expect(() => auditResearchHistory(args)).toThrow('inventory differs');
  }));
  it('rejects empty file inventory and malformed manifest pins', () => temp(root => {
    const args = fixture(root);
    for (const pin of ['bad', 123, false]) expect(() => auditResearchHistory({ ...args, expectedManifestHash: pin })).toThrow('manifest pin');
    put(root, 'CHECKPOINT-MANIFEST.json', '{"format":1,"files":{}}');
    expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow('manifest file');
  }));
  it('rejects path traversal, absolute paths and manifest self-inclusion', () => temp(root => {
    const args = fixture(root);
    for (const path of ['../outside', '/outside', 'a//b', 'a/./b', 'a\\b', 'CHECKPOINT-MANIFEST.json']) {
      put(root, 'CHECKPOINT-MANIFEST.json', JSON.stringify({ format: 1, files: { [path]: 'a'.repeat(64) } }));
      expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow('manifest file');
    }
  }));
  it('rejects symlink files, symlink directories and a symlink checkpoint root', () => temp(root => {
    const args = fixture(join(root, 'checkpoint'));
    symlinkSync(join(root, 'checkpoint'), join(root, 'alias'));
    expect(() => auditResearchHistory({ ...args, checkpointRoot: join(root, 'alias') })).toThrow('root');
    symlinkSync(join(root, 'checkpoint/README.md'), join(root, 'checkpoint/link.md'));
    expect(() => auditResearchHistory(args)).toThrow('symlinks');
    rmSync(join(root, 'checkpoint/link.md'));
    symlinkSync(join(root, 'checkpoint/reports'), join(root, 'checkpoint/linked-dir'));
    expect(() => auditResearchHistory(args)).toThrow('symlinks');
  }));
  it('rejects hardlinks rather than treating outside-linked files as a private snapshot', () => temp(root => {
    const args = fixture(root); linkSync(join(root, 'README.md'), join(root, 'duplicate.md'));
    expect(() => auditResearchHistory(args)).toThrow('hardlinked');
  }));
  it('rejects partial final journal lines and blank lines', () => temp(root => {
    const args = fixture(root);
    for (const text of [canonicalJson(appendAudit([], reservation())[0]), '{}\n\n']) {
      put(root, 'reports/state/audit.jsonl', text); manifest(root);
      expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow(/incomplete audit|blank audit/);
    }
  }));
  it('rejects an invalid audit chain despite a matching manifest', () => temp(root => {
    const args = fixture(root), record = appendAudit([], reservation())[0]; record.end++;
    put(root, 'reports/state/audit.jsonl', canonicalJson(record) + '\n'); manifest(root);
    expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow(/audit/i);
  }));
  it('rejects an altered JSON artifact even when the manifest was regenerated', () => temp(root => {
    const args = fixture(root); put(root, `reports/state/${reservation().cycleId}/request.json`, '{}'); manifest(root);
    expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow('artifact hash mismatch');
  }));
  it('checks exact artifact bytes, including the legacy trailing newline', () => temp(root => {
    const args = fixture(root), r = reservation(), content = '{\n  "value": 1\n}\n';
    put(root, `reports/state/${r.cycleId}/request.json`, content);
    rewriteAudit(root, [r, { type: 'request-snapshotted', cycleId: r.cycleId, at: 201,
      artifact: `${r.cycleId}/request.json`, artifactHash: digest(content) }]);
    expect(auditResearchHistory({ ...args, expectedManifestHash: null }).referencedArtifactCount).toBe(1);
    put(root, `reports/state/${r.cycleId}/request.json`, '{"value":1}'); manifest(root);
    expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow('artifact hash mismatch');
  }));
  it('rejects missing artifacts, artifact traversal and other-cycle references', () => temp(root => {
    const args = fixture(root), r = reservation();
    for (const artifact of [`${r.cycleId}/missing.json`, `${r.cycleId}/../request.json`, `${'b'.repeat(64)}/request.json`]) {
      rewriteAudit(root, [r, { type: 'request-snapshotted', cycleId: r.cycleId, at: 201, artifact, artifactHash: fingerprint({}) }]);
      expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow(/artifact/);
    }
  }));
  it('does not silently ignore an unknown event or missing artifact identity', () => temp(root => {
    const args = fixture(root), r = reservation();
    for (const type of ['new-evaluation', 'cycle-completed']) {
      rewriteAudit(root, [r, { type, cycleId: r.cycleId, at: 201 }]);
      expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow(/unsupported|artifact/);
    }
  }));
  it('does not rebuild shared reservations from a local journal', () => temp(root => {
    const args = fixture(root); rewriteAudit(root, [{ ...reservation(), ledgerId }]);
    expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow('authoritative ledger');
  }));
  it('refuses to interpret no journals as an empty history', () => temp(root => {
    const args = fixture(root); rmSync(join(root, 'reports/state/audit.jsonl')); manifest(root);
    expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow('no legacy audit');
  }));
  it('accepts a pinned empty journal but does not claim other experiments never existed', () => temp(root => {
    const args = fixture(root); rewriteAudit(root, []); args.expectedManifestHash = manifest(root);
    const result = auditResearchHistory(args);
    expect(result.exactReservations).toBe(0); expect(result.journals[0].auditHeadHash).toBe(null);
    expect(result.historicalCompletenessProven).toBe(false);
  }));
  it('preserves multiple interrupted reservations and detects cross-source overlaps', () => temp(root => {
    const args = fixture(root);
    const add = r => { put(root, 'reports/second/audit.jsonl', canonicalJson(appendAudit([], r)[0]) + '\n'); manifest(root); };
    add(reservation('b', 30, 40));
    expect(auditResearchHistory({ ...args, expectedManifestHash: null }).exactReservations).toBe(2);
    add(reservation('b', 15, 25));
    expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow('nonmonotonic');
  }));
  it('reports selected extracts as incomplete evidence, not full historical validation', () => temp(root => {
    const args = fixture(root), full = '{"full":"report"}';
    const selected = { source: { sha256: digest(full) }, candidates: [{ id: 'synthetic' }], summary: { combinationCount: 5 } };
    put(root, 'evidence/tune-virtual-strategies-example.selected.json', canonicalJson(selected)); manifest(root);
    let result = auditResearchHistory({ ...args, expectedManifestHash: null });
    expect(result.selectedReports[0]).toMatchObject({ fullSourcePresent: false, selectedCandidateCount: 1, evaluatedCombinationCount: 5 });
    expect(result.blockers).toContain('selected_legacy_reports_missing_full_sources');
    put(root, 'reports/full.json', full); manifest(root);
    result = auditResearchHistory({ ...args, expectedManifestHash: null });
    expect(result.selectedReports[0].fullSourcePresent).toBe(true);
    expect(result.historicalCompletenessProven).toBe(false);
  }));
  it('rejects corrupt JSON, invalid UTF-8 and byte-order marks', () => temp(root => {
    const args = fixture(root);
    for (const content of [Buffer.from([0xc0, 0x80]), Buffer.from('\ufeff{}'), Buffer.from('{')]) {
      put(root, 'reports/state/audit.jsonl', content); manifest(root);
      expect(() => auditResearchHistory({ ...args, expectedManifestHash: null })).toThrow();
    }
  }));
  it('can read a read-only snapshot without creating, changing or deleting files', () => temp(root => {
    const args = fixture(root), before = readFileSync(join(root, 'CHECKPOINT-MANIFEST.json'));
    chmodSync(root, 0o500);
    try { expect(auditResearchHistory(args).verifiedFileCount).toBe(3); }
    finally { chmodSync(root, 0o700); }
    expect(readFileSync(join(root, 'CHECKPOINT-MANIFEST.json'))).toEqual(before);
    expect(manifest(root)).toBe(args.expectedManifestHash);
  }));
});

describe('history audit command line', () => {
  it('validates arguments and provides help without side effects', () => {
    expect(main([]).help).toContain('Read-only'); expect(main(['--help']).help).toContain('Keep output private');
    for (const args of [['--checkpoint=x'], ['--checkpoint=x', '--checkpoint=y'], ['--token=x'], ['--help', '--checkpoint=x']]) {
      expect(() => main(args)).toThrow();
    }
  });
  it('returns exit 3 for intact-but-blocked history and exit 2 for failed inspection', () => temp(root => {
    const args = fixture(root), command = ['scripts/audit-research-history.mjs', `--checkpoint=${root}`, `--ledger-id=${ledgerId}`,
      `--manifest-sha256=${args.expectedManifestHash}`];
    const good = spawnSync(process.execPath, command, { encoding: 'utf8' });
    expect(good.status).toBe(3); expect(good.stderr).toBe('');
    expect(JSON.parse(good.stdout).activationReady).toBe(false);
    put(root, 'README.md', 'changed');
    expect(spawnSync(process.execPath, command, { encoding: 'utf8' }).status).toBe(2);
  }));
});
