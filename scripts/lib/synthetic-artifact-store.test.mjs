import { it, expect, vi } from 'vitest';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
import { mkdtempSync, rmSync, symlinkSync, linkSync, writeFileSync, mkdirSync, renameSync, fsyncSync, fstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from './virtual-autonomy.mjs';
import { createLocalSyntheticArtifactStore, SyntheticArtifactPersistenceError } from './synthetic-artifact-store.mjs';
const fixture = async fn => { const directory = mkdtempSync(join(tmpdir(), 'synthetic-cache-')); try { await fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); } };
it('persists immutable canonical artifacts across fresh instances, without overwrite', async () => fixture(async directory => {
  const artifact = { syntheticOnly: true, result: [1, 2] }, hash = fingerprint(artifact);
  const store = createLocalSyntheticArtifactStore({ directory });
  await store.put(hash, artifact);
  expect(await createLocalSyntheticArtifactStore({ directory }).read(hash)).toEqual(artifact);
  await expect(store.put(hash, artifact)).rejects.toThrow();
  await expect(store.put(hash, { other: true })).rejects.toThrow('mismatch');
  await expect(store.read('../escape')).rejects.toThrow('invalid');
  await expect(store.read(fingerprint('missing'))).rejects.toThrow();
}));
it('rejects corrupt, noncanonical and oversized files', async () => fixture(async directory => {
  const store = createLocalSyntheticArtifactStore({ directory }), hash = fingerprint({ a: 1 }), path = join(directory, `${hash}.json`);
  for (const bytes of ['{', '{"a":2}', '{ "a": 1 }', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    writeFileSync(path, bytes); await expect(store.read(hash)).rejects.toThrow();
  }
}));
it('rejects symbolic and hard-linked artifacts and directory traversal', async () => fixture(async directory => {
  const target = join(directory, 'target'); writeFileSync(target, '{}');
  const store = createLocalSyntheticArtifactStore({ directory }), hash = fingerprint({}), path = join(directory, `${hash}.json`);
  symlinkSync(target, path); await expect(store.read(hash)).rejects.toThrow(); await expect(store.put(hash, {})).rejects.toThrow();
  rmSync(path); linkSync(target, path); await expect(store.read(hash)).rejects.toThrow('hardlink');
  const alias = join(directory, 'alias'); symlinkSync(directory, alias);
  expect(() => createLocalSyntheticArtifactStore({ directory: alias })).toThrow();
  expect(() => createLocalSyntheticArtifactStore({ directory: alias + '/nested' })).toThrow();
  for (const unsafe of ['relative', directory + '/../escape', directory + '//nested', directory + '/']) {
    expect(() => createLocalSyntheticArtifactStore({ directory: unsafe })).toThrow();
  }
}));
it('rejects replacing an established directory', async () => fixture(async root => {
  const directory = join(root, 'cache'); mkdirSync(directory);
  const store = createLocalSyntheticArtifactStore({ directory }); renameSync(directory, join(root, 'old')); mkdirSync(directory);
  await expect(store.put(fingerprint({}), {})).rejects.toThrow('directory changed');
}));


import { reservationGenesis } from './research-reservations.mjs';
import { createSyntheticOuterPlan } from './synthetic-outer-replay.mjs';
import { syntheticWitnessGenesis, runWitnessedSyntheticOuterReplay } from './witnessed-synthetic-outer-replay.mjs';
const actualFs = await vi.importActual('node:fs');
const localAuthority = (document, identity) => {
  let version = 0;
  return { ...identity, syntheticOnly: true,
    async read() { return { version: `v${version}`, document: structuredClone(document) }; },
    async compareAndSwap(expected, next) {
      if (expected !== `v${version}`) throw new Error('stale');
      document = structuredClone(next); version++;
    },
  };
};
it.each(['file', 'directory'])('treats explicit %s fsync failure as fatal despite readable cache bytes', async kind => fixture(async directory => {
  const ledgerId = 'synthetic-fsync-ledger', scopeHash = fingerprint('synthetic-fsync-scope');
  const reservationStore = localAuthority(reservationGenesis(ledgerId), {
    ledgerId, scopeHash, authorityId: 'synthetic-ledger-authority',
  });
  const genesis = await syntheticWitnessGenesis({ witnessId: 'synthetic-witness-authority', ledgerScopeHash: scopeHash,
    baseline: await reservationStore.read() });
  const witnessStore = localAuthority(genesis.document, { witnessId: genesis.document.witnessId,
    ledgerScopeHash: scopeHash, authorityId: 'synthetic-witness-authority' });
  const originalStore = createLocalSyntheticArtifactStore({ directory });
  const artifactStore = { ...originalStore, read: vi.fn(originalStore.read) };
  const cause = Object.assign(new Error(`injected ${kind} fsync failure`), { code: 'EIO' });
  vi.mocked(fsyncSync).mockImplementation(fd => {
    if (fstatSync(fd).isDirectory() === (kind === 'directory')) throw cause;
    return actualFs.fsyncSync(fd);
  });
  try {
    await expect(runWitnessedSyntheticOuterReplay({ reservationStore, witnessStore, artifactStore,
      trustedCheckpoint: genesis.checkpoint,
      plan: createSyntheticOuterPlan({ foldCount: 2, trainQuotes: 25, selectionQuotes: 25, testQuotes: 26, maxTrials: 4 }),
    })).rejects.toMatchObject({ name: 'SyntheticArtifactPersistenceError', cause });
    // A valid, fully readable artifact exists. The runner must not mistake this
    // for confirmed persistence and must not even try readback reconciliation.
    expect(artifactStore.read).not.toHaveBeenCalled();
    const [file] = readdirSync(directory);
    expect((await originalStore.read(file.slice(0, -5))).mode).toBe('write-ahead-synthetic-only');
    expect((await reservationStore.read()).document.reservations.every(r => r.status === 'reserved')).toBe(true);
    expect((await witnessStore.read()).document.events.map(e => e.phase)).toEqual(['intent', 'reserved']);
    const artifact = { syntheticOnly: true }, hash = fingerprint(artifact);
    await expect(originalStore.put(hash, artifact)).rejects.toBeInstanceOf(SyntheticArtifactPersistenceError);
  } finally { vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync); }
}));
