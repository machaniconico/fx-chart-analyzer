import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalJson, fingerprint } from './virtual-autonomy.mjs';
import { runResearchCycle, syntheticResearchRequest } from './virtual-research-cycle.mjs';
import { reservationGenesis, readReservations, reserveHoldout, completeReservation, ReservationConflict,
  createSyntheticFileStore, createGitHubReservationStore, createGitHubHttpStore } from './research-reservations.mjs';

const ledgerId = 'isolated-reservation-test';
const clone = value => JSON.parse(JSON.stringify(value));
const temp = async fn => { const path = mkdtempSync(join(tmpdir(), 'shared-research-')); try { return await fn(path); } finally { rmSync(path, { recursive: true, force: true }); } };
const memory = (document = reservationGenesis(ledgerId)) => {
  let value = clone(document), writes = 0;
  return {
    ledgerId, get writes() { return writes; },
    read: async () => ({ version: `v${value.revision}`, document: clone(value) }),
    compareAndSwap: async (version, next) => {
      if (version !== `v${value.revision}`) throw new ReservationConflict('stale');
      value = clone(next); writes++;
    },
  };
};
const identity = (offset = 0) => ({ cycleId: fingerprint(['cycle', offset]), requestHash: fingerprint(['request', offset]),
  engineHash: fingerprint('engine'), testHash: fingerprint(['test', offset]), start: offset + 100, end: offset + 200 });
const events = path => readFileSync(join(path, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const run = (stateDir, reservationStore, request = syntheticResearchRequest()) => runResearchCycle({ stateDir, reservationStore, request });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

describe('shared holdout authority', () => {
  it('requires an authority and forbids observed inputs on the synthetic backend', async () => temp(async dir => {
    await expect(run(dir)).rejects.toThrow('shared reservation store required');
    const request = syntheticResearchRequest(); request.dataset.provenance.kind = 'observed';
    await expect(run(dir, createSyntheticFileStore(join(dir, 'demo')), request)).rejects.toThrow('synthetic-only');
  }));
  it('races independent working directories: only one can fit the same holdout', async () => temp(async root => {
    const store = memory(), a = join(root, 'a'), b = join(root, 'b');
    const results = await Promise.allSettled([run(a, store), run(b, store)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? a : b, loser = winner === a ? b : a;
    expect(events(winner).filter(e => e.type === 'trial-recorded')).toHaveLength(12);
    expect(readdirSync(loser)).toEqual([]);
    const snapshot = await readReservations(store);
    expect(snapshot.document.reservations).toHaveLength(1);
    expect(snapshot.document.reservations[0].status).toBe('completed');
  }));
  it('rejects renamed and overlapping requests across independent directories', async () => temp(async root => {
    const store = memory(); await run(join(root, 'a'), store);
    const renamed = syntheticResearchRequest(); renamed.dataset.provenance.source = 'renamed';
    await expect(run(join(root, 'b'), store, renamed)).rejects.toThrow('reused or overlapping');
    await expect(run(join(root, 'c'), store, syntheticResearchRequest(300000))).rejects.toThrow('reused or overlapping');
    await expect(run(join(root, 'd'), store, syntheticResearchRequest(1200000))).resolves.toMatchObject({ action: 'hold' });
  }));
  it('reconciles CAS conflicts while preserving independent later reservations', async () => {
    const store = memory();
    const [first, later] = await Promise.all([reserveHoldout(store, identity()), reserveHoldout(store, identity(300))]);
    await completeReservation(store, first, fingerprint('one'));
    await completeReservation(store, later, fingerprint('two'));
    const state = await readReservations(store);
    expect(state.document.reservations.map(r => r.status)).toEqual(['completed', 'completed']);
    expect(state.document.reservations.map(r => r.resultHash)).toEqual([fingerprint('one'), fingerprint('two')]);
  });
  it('allows only exact reconciliation of a lost successful write response', async () => {
    const store = memory(), write = store.compareAndSwap;
    store.compareAndSwap = async (...args) => { await write(...args); throw new Error('response lost'); };
    const receipt = await reserveHoldout(store, identity());
    expect(receipt.reservation.status).toBe('reserved');
    const completed = await completeReservation(store, receipt, fingerprint('result'));
    expect(completed.reservation.status).toBe('completed');
    expect(store.writes).toBe(2);
  });
  it('does not retry unknown/uncommitted writes or pretend a no-op CAS succeeded', async () => {
    for (const throwError of [true, false]) {
      const store = memory(); let calls = 0;
      store.compareAndSwap = async () => { calls++; if (throwError) throw new Error('timeout'); };
      await expect(reserveHoldout(store, identity())).rejects.toThrow('unconfirmed');
      expect(calls).toBe(1);
    }
  });
  it('stops when a post-write read is unavailable and permanently consumes the reservation', async () => temp(async root => {
    const store = memory(), read = store.read; let readCalls = 0;
    store.read = async () => { if (++readCalls === 2) throw new Error('unavailable'); return read(); };
    await expect(run(join(root, 'a'), store)).rejects.toThrow('unavailable');
    expect(readdirSync(join(root, 'a'))).toEqual([]);
    store.read = read;
    await expect(run(join(root, 'b'), store)).rejects.toThrow('consumed');
    expect((await read()).document.reservations[0].status).toBe('reserved');
  }));
  it('bounds explicit conflicts without fitting', async () => {
    const store = memory(); let calls = 0;
    store.compareAndSwap = async () => { calls++; throw new ReservationConflict('busy'); };
    await expect(reserveHoldout(store, identity())).rejects.toThrow('retry limit'); expect(calls).toBe(8);
  });
  it('rejects corrupt, wrong-identity, regressed and rewritten authority snapshots', async () => {
    const store = memory(), before = await readReservations(store);
    for (const document of [{}, { ...before.document, ledgerId: 'different-ledger-name' }, { ...before.document, revision: -1 }]) {
      await expect(readReservations({ ...store, read: async () => ({ version: 'x', document }) })).rejects.toThrow();
    }
    const receipt = await reserveHoldout(store, identity());
    await expect(readReservations({ ...store, read: async () => before }, receipt.snapshot)).rejects.toThrow('regressed');
    const changed = clone(receipt.snapshot); changed.document.reservations[0].attemptId = 'rewritten-attempt-id'; changed.document.revision++;
    await expect(readReservations({ ...store, read: async () => changed }, receipt.snapshot)).rejects.toThrow('rewritten');
    const duplicate = clone(receipt.snapshot); duplicate.document.reservations.push(duplicate.document.reservations[0]);
    await expect(readReservations({ ...store, read: async () => duplicate })).rejects.toThrow();
  });
  it('guards completion by exact owner, unchanged reservation and result hash', async () => {
    const store = memory(), receipt = await reserveHoldout(store, identity());
    const stolen = clone(receipt); stolen.reservation.attemptId = 'different-owner-attempt';
    await expect(completeReservation(store, stolen, fingerprint('x'))).rejects.toThrow('ownership');
    await completeReservation(store, receipt, fingerprint('original'));
    await expect(completeReservation(store, receipt, fingerprint('replacement'))).rejects.toThrow('ownership');
    expect(store.writes).toBe(2);
  });
  it('imports legacy consumed intervals and conservative consumed-through cutoff', async () => {
    const legacy = { ...identity(), attemptId: 'legacy-imported-attempt', reservedAt: 1, status: 'reserved' };
    const store = memory(reservationGenesis(ledgerId, [legacy], 500));
    await expect(reserveHoldout(store, identity(10))).rejects.toThrow('cutoff');
    await expect(reserveHoldout(store, identity(300))).rejects.toThrow('cutoff');
    await expect(reserveHoldout(store, identity(500))).resolves.toHaveProperty('reservation');
    expect((await readReservations(store)).document.reservations[0]).toEqual(legacy);
  });
  it('snapshots the caller request before awaiting shared persistence', async () => temp(async dir => {
    const store = memory(), read = store.read, request = syntheticResearchRequest(), expectedHash = fingerprint(request);
    let release, entered; const reached = new Promise(resolve => { entered = resolve; });
    const pause = new Promise(resolve => { release = resolve; }); let calls = 0;
    store.read = async () => { if (++calls === 1) { entered(); await pause; } return read(); };
    const running = run(dir, store, request); await reached;
    request.dataset.quotes[0].bid = -100; request.seed.lookback = 100000; request.portfolio.config.initialEquity = 1;
    release();
    const result = await running; expect(result.frozen.requestHash).toBe(expectedHash);
    expect((await read()).document.reservations[0].requestHash).toBe(expectedHash);
  }));
  it('never returns a prepared local result when shared completion is unconfirmed', async () => temp(async root => {
    const store = memory(), write = store.compareAndSwap, a = join(root, 'a');
    store.compareAndSwap = async (version, doc) => {
      if (doc.reservations.some(r => r.status === 'completed')) throw new Error('completion timed out');
      return write(version, doc);
    };
    await expect(run(a, store)).rejects.toThrow('unconfirmed');
    expect(events(a).at(-1).type).toBe('result-prepared');
    await expect(run(a, store)).rejects.toThrow('interrupted cycle');
    await expect(run(join(root, 'b'), store)).rejects.toThrow('consumed');
  }));
  it('recovers confirmed completion without a final local marker and without fitting', async () => temp(async dir => {
    const store = memory(), result = await run(dir, store), journal = join(dir, 'audit.jsonl');
    const complete = events(dir), partial = complete.slice(0, -1);
    expect(complete.at(-1).type).toBe('cycle-completed'); expect(partial.at(-1).type).toBe('result-prepared');
    writeFileSync(journal, partial.map(canonicalJson).join('\n') + '\n');
    const before = readFileSync(journal, 'utf8'), writes = store.writes;
    expect(await run(dir, store)).toEqual(result);
    expect(readFileSync(journal, 'utf8')).toBe(before); expect(store.writes).toBe(writes);
  }));
  it('requires authoritative confirmation for cache reads and refuses a different authority', async () => temp(async root => {
    const dir = join(root, 'a'), store = memory(); await run(dir, store);
    await expect(run(dir, memory())).rejects.toThrow('absent from shared ledger');
    await expect(run(join(root, 'b'), store)).rejects.toThrow('lacks matching local');
    store.read = async () => { throw new Error('offline'); };
    await expect(run(dir, store)).rejects.toThrow('offline');
  }));
});

describe('durable synthetic backend process interruption', () => {
  const child = (root, mode, name) => new Promise((resolve, reject) => {
    const code = `import { createSyntheticFileStore } from './scripts/lib/research-reservations.mjs';
      import { runResearchCycle, syntheticResearchRequest } from './scripts/lib/virtual-research-cycle.mjs';
      const store = createSyntheticFileStore(${JSON.stringify(join(root, 'authority'))});
      const write = store.compareAndSwap; let writes = 0;
      store.compareAndSwap = async (...args) => {
        writes++;
        if (${JSON.stringify(mode)} === 'before-complete' && writes === 2) process.kill(process.pid, 'SIGKILL');
        await write(...args);
        if (${JSON.stringify(mode)} === 'after-reserve' && writes === 1) process.kill(process.pid, 'SIGKILL');
        if (${JSON.stringify(mode)} === 'after-complete' && writes === 2) process.kill(process.pid, 'SIGKILL');
      };
      try { await runResearchCycle({ request: syntheticResearchRequest(), stateDir: ${JSON.stringify(join(root, name))}, reservationStore: store }); }
      catch (error) { console.error(error.message); process.exitCode = 2; }`;
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; processChild.stderr.on('data', chunk => { stderr += chunk; });
    processChild.on('error', reject); processChild.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  it.each(['after-reserve', 'before-complete'])('SIGKILL %s never permits a fresh directory to reuse the holdout', async mode => temp(async root => {
    const store = createSyntheticFileStore(join(root, 'authority'));
    const killed = await child(root, mode, 'killed'); expect(killed.signal).toBe('SIGKILL');
    expect((await readReservations(store)).document.reservations[0].status).toBe('reserved');
    const restarted = await child(root, 'normal', 'restart'); expect(restarted.code).toBe(2); expect(restarted.stderr).toContain('consumed');
    expect(readdirSync(join(root, 'restart'))).toEqual([]);
    if (mode === 'before-complete') expect(events(join(root, 'killed')).at(-1).type).toBe('result-prepared');
  }));
  it('keeps a durable completed receipt when killed before the local completion marker', async () => temp(async root => {
    const store = createSyntheticFileStore(join(root, 'authority'));
    expect((await child(root, 'after-complete', 'killed')).signal).toBe('SIGKILL');
    const entry = (await readReservations(store)).document.reservations[0], local = events(join(root, 'killed')).at(-1);
    expect(entry.status).toBe('completed'); expect(local.type).toBe('result-prepared');
    expect(sha(readFileSync(join(root, 'killed', local.artifact)))).toBe(entry.resultHash);
    // Crash leaves the artifact lock. Do not silently clear it or rerun anywhere.
    await expect(run(join(root, 'killed'), store)).rejects.toThrow('EEXIST');
    await expect(run(join(root, 'fresh'), store)).rejects.toThrow('lacks matching local');
  }));
  it('races two actual processes and allows exactly one successful experiment', async () => temp(async root => {
    createSyntheticFileStore(join(root, 'authority'));
    const results = await Promise.all([child(root, 'normal', 'a'), child(root, 'normal', 'b')]);
    expect(results.map(r => r.code).sort()).toEqual([0, 2]);
    const snapshot = await readReservations(createSyntheticFileStore(join(root, 'authority')));
    expect(snapshot.document.reservations).toHaveLength(1); expect(snapshot.document.reservations[0].status).toBe('completed');
  }));
});

describe('GitHub conditional connector transport (mocked, no remote writes)', () => {
  const location = { ledgerId, repository: 'owner/private-research', branch: 'research-state', path: 'ledger/reservations.json' };
  const connector = () => {
    let content = canonicalJson(reservationGenesis(ledgerId)), version = 'a'.repeat(40);
    const readFile = vi.fn(async () => ({ structuredContent: { content, sha: version } }));
    const updateFile = vi.fn(async args => {
      if (args.sha !== version) { const error = new Error('conflict'); error.status = 409; throw error; }
      content = args.content; version = createHash('sha1').update(content).digest('hex');
      return { structuredContent: { content_sha: version } };
    });
    return { readFile, updateFile, store: createGitHubReservationStore({ ...location, readFile, updateFile }) };
  };
  it('pins branch/path/identity and writes only with the observed blob SHA', async () => {
    const { store, readFile, updateFile } = connector(); await reserveHoldout(store, identity());
    expect(readFile).toHaveBeenCalledWith({ repository_full_name: location.repository, path: location.path, ref: location.branch });
    expect(updateFile.mock.calls[0][0]).toMatchObject({ repository_full_name: location.repository, branch: location.branch, path: location.path, sha: 'a'.repeat(40) });
    expect(readFile).toHaveBeenCalledTimes(2);
  });
  it('reconciles explicitly rejected stale blob versions', async () => {
    const { store } = connector();
    const [one, two] = await Promise.all([reserveHoldout(store, identity()), reserveHoldout(store, identity(300))]);
    expect(one.reservation.start).toBe(100); expect(two.snapshot.document.reservations).toHaveLength(2);
  });
  it('fails closed on missing/read-error/invalid files; never bootstraps', async () => {
    for (const response of [{ isError: true }, { structuredContent: { content: '{}', sha: 'a'.repeat(40) } }, { structuredContent: { content: '{', sha: 'a'.repeat(40) } }]) {
      const updateFile = vi.fn(), store = createGitHubReservationStore({ ...location, readFile: async () => response, updateFile });
      await expect(reserveHoldout(store, identity())).rejects.toThrow(); expect(updateFile).not.toHaveBeenCalled();
    }
  });
  it('does not infer successful persistence from a connector success response alone', async () => {
    const { readFile } = connector(), updateFile = vi.fn(async () => ({ content: [{ text: 'Action completed.' }] }));
    const store = createGitHubReservationStore({ ...location, readFile, updateFile });
    await expect(reserveHoldout(store, identity())).rejects.toThrow('unconfirmed'); expect(updateFile).toHaveBeenCalledTimes(1);
  });
  it('requires an existing credential and verifies a private destination without writing', async () => {
    expect(() => createGitHubHttpStore(location)).toThrow('existing authorized');
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ private: false, full_name: location.repository }) }));
    const store = createGitHubHttpStore({ ...location, token: 'test-only-not-a-credential', fetchImpl });
    await expect(store.verifyPrivateDestination()).rejects.toThrow('private ledger'); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error'); expect(fetchImpl.mock.calls[0][1].method).toBeUndefined();
  });
});
