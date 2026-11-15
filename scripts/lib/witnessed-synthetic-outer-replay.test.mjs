import { describe, it, expect, vi, afterEach } from 'vitest';
import * as outer from './synthetic-outer-replay.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createSyntheticOuterPlan, replaySyntheticOuterPlan } from './synthetic-outer-replay.mjs';
import { canonicalJson, fingerprint } from './virtual-autonomy.mjs';
import { reservationGenesis, ReservationConflict } from './research-reservations.mjs';
import { syntheticWitnessGenesis, inspectSyntheticWitness, runWitnessedSyntheticOuterReplay } from './witnessed-synthetic-outer-replay.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const ledgerId = 'synthetic-witness-ledger';
const plan = () => createSyntheticOuterPlan({ foldCount: 2, trainQuotes: 25, selectionQuotes: 25, testQuotes: 26, maxTrials: 4 });
function memory(initial, identity) {
  let document = copy(initial), version = 0, writes = 0;
  return { ...identity, syntheticOnly: true, get writes() { return writes; },
    async read() { return { version: `v${version}`, document: copy(document) }; },
    async compareAndSwap(expected, next) {
      if (expected !== `v${version}`) throw new ReservationConflict('stale');
      document = copy(next); version++; writes++;
    },
    replace(next, newVersion = version + 1) { document = copy(next); version = newVersion; },
  };
}
async function setup(baseline = reservationGenesis(ledgerId)) {
  const scopeHash = fingerprint('fixed synthetic ledger destination');
  const reservationStore = memory(baseline, { ledgerId, scopeHash, authorityId: 'synthetic-ledger-authority' });
  const genesis = await syntheticWitnessGenesis({ witnessId: 'synthetic-witness-authority', ledgerScopeHash: scopeHash,
    baseline: await reservationStore.read() });
  const witnessStore = memory(genesis.document, { witnessId: genesis.document.witnessId, ledgerScopeHash: scopeHash,
    authorityId: 'synthetic-witness-authority' });
  return { reservationStore, witnessStore, trustedCheckpoint: copy(genesis.checkpoint) };
}
const inspect = options => inspectSyntheticWitness(options);
const run = (options, fixedPlan = plan()) => runWitnessedSyntheticOuterReplay({ ...options, plan: fixedPlan });
const tamper = (document, change) => {
  change(document);
  let previousHash = document.genesisHash;
  document.events = document.events.map(event => {
    const { hash, ...body } = { ...event, previousHash };
    const next = { ...body, hash: fingerprint(body) }; previousHash = next.hash; return next;
  });
  return document;
};

afterEach(() => vi.restoreAllMocks());

describe('inactive synthetic write-ahead witness barrier', () => {
  it('consumes intent before all reservations, binds before fitting, and completes both authorities', async () => {
    const options = await setup(), order = [], replay = vi.spyOn(outer, 'replaySyntheticOuterPlan');
    for (const [name, store] of Object.entries({ ledger: options.reservationStore, witness: options.witnessStore })) {
      const write = store.compareAndSwap.bind(store);
      store.compareAndSwap = async (version, next) => { order.push(`${name}:${next.events?.at(-1).phase ?? next.reservations[0].status}`);
        expect(replay).toHaveBeenCalledTimes(order.length <= 3 ? 0 : 1); await write(version, next); };
    }
    const fixedPlan = plan(), result = await run(options, fixedPlan);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['witness:intent', 'ledger:reserved', 'witness:reserved', 'ledger:completed', 'witness:completed']);
    expect(result.artifact.replay).toEqual(replaySyntheticOuterPlan(fixedPlan));
    expect(result.artifact.activationReady).toBe(false); expect(result.artifact.eligible).toBe(false);
    expect(result.artifact.action).toBe('hold'); expect(result.checkpoint.sequence).toBe(3);
    expect(result.resultHash).toBe(fingerprint(result.artifact));
    expect((await inspect({ ...options, trustedCheckpoint: result.checkpoint })).state).toBe('consistent');
    expect(result.completion.reservations.every(r => r.resultHash === result.resultHash)).toBe(true);
    await expect(run({ ...options, trustedCheckpoint: result.checkpoint })).rejects.toThrow('consumed');
    expect(options.witnessStore.writes).toBe(3); expect(options.reservationStore.writes).toBe(2);
  });
  it('never initializes missing witnesses or ledgers', async () => {
    for (const name of ['witnessStore', 'reservationStore']) {
      const options = await setup(); options[name].read = async () => { throw new Error('missing'); };
      await expect(run(options)).rejects.toThrow('missing');
      expect(options.witnessStore.writes).toBe(0); expect(options.reservationStore.writes).toBe(0);
    }
  });
  it.each(['observed-ledger', 'observed-witness', 'same-authority', 'wrong-scope', 'wrong-pin', 'missing-pin'])('rejects %s before any write', async kind => {
    const options = await setup();
    if (kind === 'observed-ledger') options.reservationStore.syntheticOnly = false;
    if (kind === 'observed-witness') options.witnessStore.syntheticOnly = false;
    if (kind === 'same-authority') options.witnessStore.authorityId = options.reservationStore.authorityId;
    if (kind === 'wrong-scope') options.witnessStore.ledgerScopeHash = fingerprint('other');
    if (kind === 'wrong-pin') options.trustedCheckpoint.hash = fingerprint('other');
    if (kind === 'missing-pin') options.trustedCheckpoint = null;
    await expect(run(options)).rejects.toThrow();
    expect(options.witnessStore.writes).toBe(0); expect(options.reservationStore.writes).toBe(0);
  });
  it('accepts no quotes, callback, scenario override or partial plan', async () => {
    const options = await setup();
    for (const extra of [{ quotes: [] }, { evaluate() {} }, { scenario: {} }, { completedFoldCount: 1 }]) {
      await expect(runWitnessedSyntheticOuterReplay({ ...options, plan: plan(), ...extra })).rejects.toThrow('fields');
    }
    const altered = copy(plan()); altered.folds.pop();
    await expect(run(options, altered)).rejects.toThrow('plan changed');
    expect(options.witnessStore.writes).toBe(0);
  });
  it('preserves conservative baseline cutoff without inventing new unused history', async () => {
    const options = await setup(reservationGenesis(ledgerId, [], 1000000));
    await expect(run(options)).rejects.toThrow('consumed');
    expect(options.witnessStore.writes).toBe(0); expect(options.reservationStore.writes).toBe(0);
  });
  it('allows only one of two independent contenders for the same plan', async () => {
    const options = await setup();
    const results = await Promise.allSettled([run(options), run({ ...options })]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(options.witnessStore.writes).toBe(3); expect(options.reservationStore.writes).toBe(2);
  });
  it('reconciles lost acknowledgements at every write using exact readback', async () => {
    const options = await setup();
    for (const store of [options.witnessStore, options.reservationStore]) {
      const write = store.compareAndSwap.bind(store);
      store.compareAndSwap = async (...args) => { await write(...args); throw new Error('response lost'); };
    }
    expect((await run(options)).checkpoint.sequence).toBe(3);
    expect(options.witnessStore.writes).toBe(3); expect(options.reservationStore.writes).toBe(2);
  });
  it.each(['noop', 'uncertain-error', 'explicit-conflict'])('never retries an unconfirmed witness %s', async mode => {
    const options = await setup(); let calls = 0;
    options.witnessStore.compareAndSwap = async () => {
      calls++;
      if (mode === 'uncertain-error') throw new Error('timeout');
      if (mode === 'explicit-conflict') throw new ReservationConflict('stale');
    };
    await expect(run(options)).rejects.toThrow('unconfirmed');
    expect(calls).toBe(1); expect(options.reservationStore.writes).toBe(0);
  });
  it('keeps every interval consumed when the witness intent lands but its readback is unavailable', async () => {
    const options = await setup(), read = options.witnessStore.read.bind(options.witnessStore); let reads = 0;
    options.witnessStore.read = async () => { if (++reads === 2) throw new Error('unavailable'); return read(); };
    await expect(run(options)).rejects.toThrow('unavailable');
    options.witnessStore.read = read;
    const state = await inspect(options);
    expect(state.state).toBe('unresolved-intent'); expect(state.pendingIntervals).toHaveLength(2);
    expect(options.reservationStore.writes).toBe(0);
    await expect(run(options)).rejects.toThrow('unresolved intent');
    expect(options.witnessStore.writes).toBe(1);
  });
  it('leaves an unresolved intent after a failed ledger reservation and refuses restart/takeover', async () => {
    const options = await setup(), write = options.reservationStore.compareAndSwap;
    options.reservationStore.compareAndSwap = async () => { throw new Error('offline'); };
    await expect(run(options)).rejects.toThrow('unconfirmed');
    options.reservationStore.compareAndSwap = write;
    expect((await inspect(options)).pendingIntervals).toHaveLength(2);
    await expect(run(options)).rejects.toThrow('unresolved intent');
  });
  it.each(['reserved', 'completed'])('fails closed on a missing witness %s acknowledgement', async phase => {
    const options = await setup(), write = options.witnessStore.compareAndSwap.bind(options.witnessStore);
    options.witnessStore.compareAndSwap = async (version, next) => {
      if (next.events.at(-1).phase !== phase) await write(version, next);
    };
    await expect(run(options)).rejects.toThrow('unconfirmed');
    expect(options.reservationStore.writes).toBe(phase === 'reserved' ? 1 : 2);
    await expect(run(options)).rejects.toThrow('differs from witnessed');
    expect(options.witnessStore.writes).toBe(phase === 'reserved' ? 1 : 2);
  });
  it('retains the reserved witness when ledger completion fails', async () => {
    const options = await setup(), write = options.reservationStore.compareAndSwap.bind(options.reservationStore);
    options.reservationStore.compareAndSwap = async (version, next) => {
      if (next.reservations[0].status === 'reserved') await write(version, next);
    };
    await expect(run(options)).rejects.toThrow('unconfirmed');
    expect((await inspect(options)).state).toBe('unresolved-intent');
    await expect(run(options)).rejects.toThrow('unresolved intent');
  });
  it('detects ledger rollback just before fitting after the witness reservation lands', async () => {
    const options = await setup(), baseline = await options.reservationStore.read(), write = options.witnessStore.compareAndSwap.bind(options.witnessStore);
    const replay = vi.spyOn(outer, 'replaySyntheticOuterPlan');
    options.witnessStore.compareAndSwap = async (version, next) => {
      await write(version, next);
      if (next.events.at(-1).phase === 'reserved') options.reservationStore.replace(baseline.document, 0);
    };
    await expect(run(options)).rejects.toThrow('differs from witnessed');
    expect(options.reservationStore.writes).toBe(1); expect(options.witnessStore.writes).toBe(2);
    expect(replay).not.toHaveBeenCalled();
  });
  it('detects witness rollback between reservation binding and fitting using the new checkpoint', async () => {
    const options = await setup(), genesis = await options.witnessStore.read(), read = options.witnessStore.read.bind(options.witnessStore); let reads = 0;
    options.witnessStore.read = async () => ++reads === 4 ? genesis : read();
    await expect(run(options)).rejects.toThrow('rolled back');
    expect(options.reservationStore.writes).toBe(1);
  });
  it('detects completed ledger rollback on a fresh reader even with the old genesis pin', async () => {
    const options = await setup(), baseline = await options.reservationStore.read(); await run(options);
    options.reservationStore.replace(baseline.document, 0);
    await expect(inspect(options)).rejects.toThrow('differs from witnessed');
  });
  it('detects witness-only rollback using ledger disagreement, and dual rollback using an independently retained pin', async () => {
    const options = await setup(), baseline = await options.reservationStore.read(), genesis = await options.witnessStore.read();
    const result = await run(options);
    options.witnessStore.replace(genesis.document, 0);
    await expect(inspect(options)).rejects.toThrow('differs from witnessed');
    options.reservationStore.replace(baseline.document, 0);
    await expect(inspect({ ...options, trustedCheckpoint: result.checkpoint })).rejects.toThrow('rolled back');
    // This is the trust boundary, not an impossible guarantee: a stale old pin
    // cannot detect a jointly reverted self-consistent pair of authorities.
    expect((await inspect(options)).state).toBe('consistent');
  });
  it('rejects untracked ledger changes rather than adopting them as a new baseline', async () => {
    const options = await setup(), snapshot = await options.reservationStore.read();
    snapshot.document.consumedBefore = 10; snapshot.document.revision++;
    options.reservationStore.replace(snapshot.document);
    await expect(run(options)).rejects.toThrow('differs from witnessed');
    expect(options.witnessStore.writes).toBe(0);
  });
  it.each(['truncated-batch', 'renamed-test', 'wrong-owner', 'wrong-result', 'skipped-intent', 'duplicate-intent', 'wrong-checkpoint', 'rewritten-baseline', 'bad-hash', 'unknown-field', 'unknown-phase', 'changed-version'])('rejects a %s history even when an attacker rehashes its events', async mode => {
    const options = await setup(); await run(options);
    const snapshot = await options.witnessStore.read();
    const document = tamper(snapshot.document, doc => {
      if (mode === 'truncated-batch') doc.events[1].payload.reservations.pop();
      if (mode === 'renamed-test') doc.events[0].payload.identities[0].testHash = fingerprint('renamed');
      if (mode === 'wrong-owner') doc.events[2].payload.reservations[0].attemptId = 'other-owner-attempt';
      if (mode === 'wrong-result') doc.events[2].payload.resultHash = fingerprint('changed');
      if (mode === 'skipped-intent') doc.events.shift();
      if (mode === 'duplicate-intent') doc.events[1].phase = 'intent';
      if (mode === 'wrong-checkpoint') doc.events[0].payload.ledgerCheckpoint.version = 'other';
      if (mode === 'rewritten-baseline') doc.baseline.document.consumedBefore = 123;
      if (mode === 'bad-hash') doc.genesisHash = fingerprint('not genesis');
      if (mode === 'unknown-field') doc.events[0].override = true;
      if (mode === 'unknown-phase') doc.events[1].phase = 'released';
      if (mode === 'changed-version') doc.events[1].payload.snapshot.version = doc.baseline.version;
    });
    options.witnessStore.replace(document);
    await expect(inspect(options)).rejects.toThrow();
  });
  it('snapshots plan, checkpoint and store methods before the first await', async () => {
    const options = await setup(), fixedPlan = copy(plan()), read = options.witnessStore.read.bind(options.witnessStore);
    options.witnessStore.read = async () => {
      fixedPlan.folds.length = 0; options.trustedCheckpoint.hash = fingerprint('mutated');
      options.witnessStore.compareAndSwap = async () => { throw new Error('mutated'); };
      options.reservationStore.read = async () => { throw new Error('mutated'); };
      return read();
    };
    const result = await run(options, fixedPlan);
    expect(result.artifact.plan.folds).toHaveLength(2); expect(result.checkpoint.sequence).toBe(3);
  });
  it('rejects oversized witness histories before any write', async () => {
    const options = await setup(), snapshot = await options.witnessStore.read();
    snapshot.document.padding = 'x'.repeat(2 * 1024 * 1024); options.witnessStore.replace(snapshot.document);
    await expect(run(options)).rejects.toThrow('size limit');
    expect(options.witnessStore.writes).toBe(0);
  });
});

// The following fixture is deliberately test-only, using two local files to
// model protocol crashes. It does not establish independent remote custody or
// distributed locking, retention, filesystem power-loss durability, or access.
const fileStoreModule = `
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fingerprint, canonicalJson } from './scripts/lib/virtual-autonomy.mjs';
import { ReservationConflict } from './scripts/lib/research-reservations.mjs';
function fileStore(path, identity) {
  return { ...identity, syntheticOnly: true,
    async read() { const content = readFileSync(path, 'utf8'); return { version: fingerprint(content), document: JSON.parse(content) }; },
    async compareAndSwap(version, next) {
      const lockPath = path + '.lock', fd = openSync(lockPath, 'wx', 0o600);
      try {
        const content = readFileSync(path, 'utf8');
        if (version !== fingerprint(content)) throw new ReservationConflict('stale');
        const temp = path + '-' + randomUUID(), out = openSync(temp, 'wx', 0o600);
        try { writeFileSync(out, canonicalJson(next)); fsyncSync(out); } finally { closeSync(out); }
        renameSync(temp, path);
      } finally { closeSync(fd); unlinkSync(lockPath); }
    }
  };
}`;
async function diskSetup(root) {
  const config = await setup(), baseline = await config.reservationStore.read();
  const ledgerBytes = canonicalJson(baseline.document);
  writeFileSync(join(root, 'ledger.json'), ledgerBytes, { mode: 0o600 });
  const genesis = await syntheticWitnessGenesis({ witnessId: config.witnessStore.witnessId,
    ledgerScopeHash: config.reservationStore.scopeHash,
    baseline: { version: fingerprint(ledgerBytes), document: baseline.document } });
  writeFileSync(join(root, 'witness.json'), canonicalJson(genesis.document), { mode: 0o600 });
  writeFileSync(join(root, 'pin.json'), canonicalJson(genesis.checkpoint), { mode: 0o600 });
  return { ledger: { ledgerId, scopeHash: config.reservationStore.scopeHash, authorityId: config.reservationStore.authorityId },
    witness: { witnessId: config.witnessStore.witnessId, ledgerScopeHash: config.witnessStore.ledgerScopeHash,
      authorityId: config.witnessStore.authorityId } };
}
function child(root, binding, crash = 'none', cache = false, cwd = globalThis.process.cwd()) {
  return new Promise((resolve, reject) => {
    const code = `${fileStoreModule}
import { createSyntheticOuterPlan } from './scripts/lib/synthetic-outer-replay.mjs';
import { runWitnessedSyntheticOuterReplay } from './scripts/lib/witnessed-synthetic-outer-replay.mjs';
import { createLocalSyntheticArtifactStore } from './scripts/lib/synthetic-artifact-store.mjs';
const originalCache = createLocalSyntheticArtifactStore({ directory: ${JSON.stringify(root)} });
const artifactStore = { syntheticOnly: true, read: originalCache.read, async put(hash, artifact) {
  if (${JSON.stringify(crash)} === 'before-cache') process.kill(process.pid, 'SIGKILL');
  await originalCache.put(hash, artifact);
  if (${JSON.stringify(crash)} === 'after-cache') process.kill(process.pid, 'SIGKILL');
} };
const reservationStore = fileStore(${JSON.stringify(join(root, 'ledger.json'))}, ${JSON.stringify(binding.ledger)});
const witnessStore = fileStore(${JSON.stringify(join(root, 'witness.json'))}, ${JSON.stringify(binding.witness)});
for (const [name, store] of Object.entries({ ledger: reservationStore, witness: witnessStore })) {
  const write = store.compareAndSwap.bind(store);
  store.compareAndSwap = async (version, next) => {
    const phase = next.events?.at(-1).phase ?? next.reservations[0].status;
    if (${JSON.stringify(crash)} === 'before-' + name + '-' + phase) process.kill(process.pid, 'SIGKILL');
    await write(version, next);
    if (${JSON.stringify(crash)} === 'after-' + name + '-' + phase) process.kill(process.pid, 'SIGKILL');
  };
}
try {
  await runWitnessedSyntheticOuterReplay({ reservationStore, witnessStore,
    ...(${JSON.stringify(cache)} ? { artifactStore } : {}),
    trustedCheckpoint: JSON.parse(readFileSync(${JSON.stringify(join(root, 'pin.json'))}, 'utf8')),
    plan: createSyntheticOuterPlan({ foldCount: 2, trainQuotes: 25, selectionQuotes: 25, testQuotes: 26, maxTrials: 4 }) });
} catch (error) { console.error(error.message); process.exitCode = 2; }
`;
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; process.stderr.on('data', chunk => { stderr += chunk; });
    process.on('error', reject); process.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}
const temporary = async fn => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-witness-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

describe('two-authority process interruption', () => {
  const points = ['witness-intent', 'ledger-reserved', 'witness-reserved', 'ledger-completed', 'witness-completed'];
  it.each(points.flatMap(point => [`before-${point}`, `after-${point}`]))('fails closed across SIGKILL %s', async crash => temporary(async root => {
    const binding = await diskSetup(root);
    const killed = await child(root, binding, crash);
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const before = ['ledger.json', 'witness.json'].map(name => readFileSync(join(root, name), 'utf8'));
    const retry = await child(root, binding);
    if (crash === 'before-witness-intent') {
      // Nothing consumed and no fitting took place. A completely new attempt is safe.
      expect(retry.code, retry.stderr).toBe(0);
    } else {
      expect(retry.code, retry.stderr).toBe(2);
      expect(retry.stderr).toMatch(/unresolved intent|differs from witnessed|already consumed/);
      const after = ['ledger.json', 'witness.json'].map(name => readFileSync(join(root, name), 'utf8'));
      expect(after).toEqual(before);
      const witness = JSON.parse(before[1]);
      expect(witness.events[0].phase).toBe('intent');
      expect(witness.events[0].payload.identities).toHaveLength(2);
    }
  }));
  it('allows at most one writer across independent processes', async () => temporary(async root => {
    const binding = await diskSetup(root);
    const results = await Promise.all([child(root, binding), child(root, binding)]);
    expect(results.filter(r => r.code === 0)).toHaveLength(1);
    expect(results.filter(r => r.code === 2)).toHaveLength(1);
    const witness = JSON.parse(readFileSync(join(root, 'witness.json'), 'utf8'));
    expect(witness.events.map(e => e.phase)).toEqual(['intent', 'reserved', 'completed']);
    expect(witness.events[0].payload.identities).toHaveLength(2);
  }));
});

function artifactMemory() {
  const saved = new Map();
  return { syntheticOnly: true, saved,
    async put(hash, artifact) { if (saved.has(hash)) throw new Error('exists'); saved.set(hash, copy(artifact)); },
    async read(hash) { if (!saved.has(hash)) throw new Error('missing artifact'); return copy(saved.get(hash)); },
  };
}
describe('bounded completed synthetic artifact recovery', () => {
  it('saves and verifies before completion, then recovers exact bytes without replay or writes', async () => {
    const options = { ...await setup(), artifactStore: artifactMemory() }, replay = vi.spyOn(outer, 'replaySyntheticOuterPlan');
    const write = options.reservationStore.compareAndSwap.bind(options.reservationStore);
    options.reservationStore.compareAndSwap = async (version, next) => {
      if (next.reservations[0].status === 'completed') expect(options.artifactStore.saved.has(next.reservations[0].resultHash)).toBe(true);
      await write(version, next);
    };
    const first = await run(options), recovered = await run(options);
    expect(recovered).toEqual(first); expect(replay).toHaveBeenCalledTimes(1);
    expect(options.reservationStore.writes).toBe(2); expect(options.witnessStore.writes).toBe(3);
    expect(first.artifact.engineSources.map(s => s.name)).toContain('synthetic-artifact-store.mjs');
  });
  it.each(['missing', 'corrupt', 'cross-attempt', 'wrong-result'])('fails closed on completed %s cache', async mode => {
    const options = { ...await setup(), artifactStore: artifactMemory() }, result = await run(options);
    if (mode === 'missing') options.artifactStore.saved.clear();
    else {
      const artifact = options.artifactStore.saved.get(result.resultHash);
      if (mode === 'corrupt') artifact.plan.folds.pop();
      if (mode === 'cross-attempt') artifact.attemptId = 'different-attempt';
      if (mode === 'wrong-result') artifact.replay = {};
    }
    const replay = vi.spyOn(outer, 'replaySyntheticOuterPlan');
    await expect(run(options)).rejects.toThrow(); expect(replay).not.toHaveBeenCalled();
    expect(options.reservationStore.writes).toBe(2); expect(options.witnessStore.writes).toBe(3);
  });
  it('rejects a completed legacy attempt without a saved artifact', async () => {
    const options = await setup(); await run(options);
    await expect(run({ ...options, artifactStore: artifactMemory() })).rejects.toThrow('missing artifact');
  });
  it.each(['missing', 'mutated', 'lost-ack'])('requires exact cache readback on %s write', async mode => {
    const options = { ...await setup(), artifactStore: artifactMemory() }, put = options.artifactStore.put;
    options.artifactStore.put = async (hash, artifact) => {
      if (mode === 'missing') throw new Error('offline');
      if (mode === 'mutated') artifact.replay = {};
      await put(hash, artifact); if (mode === 'lost-ack') throw new Error('lost ack');
    };
    if (mode === 'lost-ack') expect((await run(options)).checkpoint.sequence).toBe(3);
    else {
      await expect(run(options)).rejects.toThrow();
      expect(options.reservationStore.writes).toBe(1); expect(options.witnessStore.writes).toBe(2);
      await expect(run(options)).rejects.toThrow('unresolved intent');
    }
  });
  it('snapshots artifact store methods before awaiting and rejects non-synthetic stores', async () => {
    const options = { ...await setup(), artifactStore: artifactMemory() }, read = options.witnessStore.read;
    options.witnessStore.read = async () => { options.artifactStore.read = async () => { throw new Error('mutated'); }; return read(); };
    expect((await run(options)).checkpoint.sequence).toBe(3);
    await expect(run({ ...await setup(), artifactStore: { ...artifactMemory(), syntheticOnly: false } })).rejects.toThrow('synthetic-only');
  });
});


describe('durable cache process interruption', () => {
  it.each(['before-cache', 'after-cache', 'before-ledger-completed', 'after-ledger-completed', 'before-witness-completed', 'after-witness-completed'])(
    'recovers only dual completion across SIGKILL %s', async crash => temporary(async root => {
      const binding = await diskSetup(root), killed = await child(root, binding, crash, true);
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const before = ['ledger.json', 'witness.json'].map(name => readFileSync(join(root, name), 'utf8'));
      const retry = await child(root, binding, 'none', true);
      expect(retry.code, retry.stderr).toBe(crash === 'after-witness-completed' ? 0 : 2);
      expect(['ledger.json', 'witness.json'].map(name => readFileSync(join(root, name), 'utf8'))).toEqual(before);
    }));
});

it('rejects changed helper source after restart without changing either authority', async () => temporary(async root => {
  cpSync(new URL('.', import.meta.url), join(root, 'scripts/lib'), { recursive: true });
  const binding = await diskSetup(root);
  const first = await child(root, binding, 'none', true, root);
  expect(first.code, first.stderr).toBe(0);
  const before = ['ledger.json', 'witness.json'].map(name => readFileSync(join(root, name), 'utf8'));
  const helper = join(root, 'scripts/lib/synthetic-artifact-store.mjs');
  writeFileSync(helper, readFileSync(helper, 'utf8') + '\n// changed helper implementation identity\n');
  const retry = await child(root, binding, 'none', true, root);
  expect(retry.code, retry.stderr).toBe(2); expect(retry.stderr).toMatch(/consumed/);
  expect(['ledger.json', 'witness.json'].map(name => readFileSync(join(root, name), 'utf8'))).toEqual(before);
}));
it('rejects overlapping changed plans without replaying or reading cache', async () => {
  const options = { ...await setup(), artifactStore: artifactMemory() }; await run(options);
  const replay = vi.spyOn(outer, 'replaySyntheticOuterPlan'), read = vi.spyOn(options.artifactStore, 'read');
  await expect(run(options, createSyntheticOuterPlan({ ...plan().config, maxTrials: 3 }))).rejects.toThrow('consumed');
  expect(replay).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it('bounds injected cache responses', async () => {
  const options = { ...await setup(), artifactStore: artifactMemory() }; await run(options);
  options.artifactStore.read = async () => ({ padding: 'x'.repeat(8 * 1024 * 1024 + 1) });
  await expect(run(options)).rejects.toThrow('artifact size limit');
});

it.each(['reservationStore', 'witnessStore'])('rejects changed %s authority identity on cache recovery', async name => {
  const options = { ...await setup(), artifactStore: artifactMemory() }; await run(options);
  options[name].authorityId = 'different-synthetic-authority';
  const replay = vi.spyOn(outer, 'replaySyntheticOuterPlan');
  await expect(run(options)).rejects.toThrow('cached artifact identity');
  expect(replay).not.toHaveBeenCalled();
});
