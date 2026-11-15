import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import * as outer from './synthetic-outer-replay.mjs';
import { runReservedSyntheticOuterReplay } from './reserved-synthetic-outer-replay.mjs';
import { createSyntheticFileStore, reservationGenesis, ReservationConflict, readReservations } from './research-reservations.mjs';
import { fingerprint } from './virtual-autonomy.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const plan = () => outer.createSyntheticOuterPlan({ maxTrials: 2 });
const memory = () => {
  const ledgerId = 'reserved-synthetic-outer-test'; let document = reservationGenesis(ledgerId), writes = 0;
  return { ledgerId, syntheticOnly: true, get writes() { return writes; },
    read: async () => ({ version: `v${document.revision}`, document: copy(document) }),
    compareAndSwap: async (version, next) => {
      if (version !== `v${document.revision}`) throw new ReservationConflict('stale');
      document = copy(next); writes++;
    } };
};
afterEach(() => vi.restoreAllMocks());

describe('inactive reserved synthetic outer orchestration', () => {
  it('verifies every outer reservation before any fitting and binds the full source/result artifact', async () => {
    const reservationStore = memory(), replay = vi.spyOn(outer, 'replaySyntheticOuterPlan');
    const read = reservationStore.read, write = reservationStore.compareAndSwap;
    // Completion's preflight read is after fitting, so only guard the first two reads.
    let reads = 0;
    reservationStore.read = async () => { if (++reads <= 2) expect(replay).not.toHaveBeenCalled(); return read(); };
    reservationStore.compareAndSwap = async (version, next) => {
      expect(next.reservations).toHaveLength(3);
      expect(replay).toHaveBeenCalledTimes(reservationStore.writes === 0 ? 0 : 1);
      return write(version, next);
    };
    const result = await runReservedSyntheticOuterReplay({ plan: plan(), reservationStore });
    expect(replay).toHaveBeenCalledTimes(1);
    expect(reservationStore.writes).toBe(2);
    expect(result.artifact).toMatchObject({ action: 'hold', eligible: false, activationReady: false });
    expect(result.artifact.engineSources.map(x => x.name)).toContain('reserved-synthetic-outer-replay.mjs');
    expect(result.artifact.reservations.map(r => r.testHash)).toEqual(result.artifact.replay.folds.map(f => f.testHash));
    expect(result.resultHash).toBe(fingerprint(result.artifact));
    expect(result.completion.reservations.every(r => r.status === 'completed' && r.resultHash === result.resultHash)).toBe(true);
  });
  it('keeps decisions and scores identical to the original pure fixture', async () => {
    const p = plan(), result = await runReservedSyntheticOuterReplay({ plan: p, reservationStore: memory() });
    expect(result.artifact.replay).toEqual(outer.replaySyntheticOuterPlan(p));
  });
  it('rejects observed backends, external input, and edited plans before writing', async () => {
    const store = memory();
    await expect(runReservedSyntheticOuterReplay({ plan: plan(), reservationStore: { ...store, syntheticOnly: false } })).rejects.toThrow('synthetic-only');
    await expect(runReservedSyntheticOuterReplay({ plan: plan(), reservationStore: store, dataset: { kind: 'observed' } })).rejects.toThrow('unsupported');
    const altered = copy(plan()); altered.folds[0].windows.test.start = 0;
    const { planHash: ignored, ...body } = altered; altered.planHash = fingerprint(body);
    await expect(runReservedSyntheticOuterReplay({ plan: altered, reservationStore: store })).rejects.toThrow('plan changed');
    expect(store.writes).toBe(0);
  });
  it('does not fit after uncertain reserve writes or unavailable receipt verification', async () => {
    for (const mode of ['write', 'read']) {
      const store = memory(), replay = vi.spyOn(outer, 'replaySyntheticOuterPlan'), read = store.read;
      if (mode === 'write') store.compareAndSwap = async () => {};
      else { let reads = 0; store.read = async () => { if (++reads === 2) throw new Error('offline'); return read(); }; }
      await expect(runReservedSyntheticOuterReplay({ plan: plan(), reservationStore: store })).rejects.toThrow();
      expect(replay).not.toHaveBeenCalled(); replay.mockRestore();
    }
  });
  it('never returns an artifact as success when batch completion is uncertain', async () => {
    const store = memory(), write = store.compareAndSwap;
    store.compareAndSwap = async (...args) => { if (store.writes === 1) return; return write(...args); };
    await expect(runReservedSyntheticOuterReplay({ plan: plan(), reservationStore: store })).rejects.toThrow('unconfirmed');
    expect((await store.read()).document.reservations.every(r => r.status === 'reserved')).toBe(true);
    const replay = vi.spyOn(outer, 'replaySyntheticOuterPlan');
    await expect(runReservedSyntheticOuterReplay({ plan: plan(), reservationStore: store })).rejects.toThrow('consumed');
    expect(replay).not.toHaveBeenCalled();
  });
  it('never recomputes a completed or renamed overlapping plan', async () => {
    const store = memory(); await runReservedSyntheticOuterReplay({ plan: plan(), reservationStore: store });
    const replay = vi.spyOn(outer, 'replaySyntheticOuterPlan');
    await expect(runReservedSyntheticOuterReplay({ plan: plan(), reservationStore: store })).rejects.toThrow('consumed');
    await expect(runReservedSyntheticOuterReplay({ plan: outer.createSyntheticOuterPlan({ maxTrials: 3 }), reservationStore: store })).rejects.toThrow('overlapping');
    expect(replay).not.toHaveBeenCalled(); expect(store.writes).toBe(2);
  });
  it('snapshots the plan before awaiting authority and preserves causal plan identity', async () => {
    const store = memory(), p = copy(plan()), expected = copy(p), read = store.read;
    store.read = async () => { p.config.maxTrials = 20; p.folds[1].windows.test.start = 0; return read(); };
    const result = await runReservedSyntheticOuterReplay({ plan: p, reservationStore: store });
    expect(result.artifact.plan).toEqual(expected);
  });
});

describe('whole-plan process interruption', () => {
  const temp = async fn => { const root = mkdtempSync(join(tmpdir(), 'reserved-outer-')); try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); } };
  const child = (root, mode) => new Promise((resolve, reject) => {
    const code = `import { createSyntheticFileStore } from './scripts/lib/research-reservations.mjs';
      import { createSyntheticOuterPlan } from './scripts/lib/synthetic-outer-replay.mjs';
      import { runReservedSyntheticOuterReplay } from './scripts/lib/reserved-synthetic-outer-replay.mjs';
      const store = createSyntheticFileStore(${JSON.stringify(root)});
      const write = store.compareAndSwap; let writes = 0;
      store.compareAndSwap = async (...args) => {
        writes++;
        if (${JSON.stringify(mode)} === 'before-complete' && writes === 2) process.kill(process.pid, 'SIGKILL');
        await write(...args);
        if (${JSON.stringify(mode)} === 'after-reserve' && writes === 1) process.kill(process.pid, 'SIGKILL');
        if (${JSON.stringify(mode)} === 'after-complete' && writes === 2) process.kill(process.pid, 'SIGKILL');
      };
      try { await runReservedSyntheticOuterReplay({ plan: createSyntheticOuterPlan({ maxTrials: 2 }), reservationStore: store }); }
      catch (error) { console.error(error.message); process.exitCode = 2; }`;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject); proc.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  it.each(['after-reserve', 'before-complete', 'after-complete'])('retains every consumed interval after SIGKILL %s', async mode => temp(async root => {
    const store = createSyntheticFileStore(root);
    expect((await child(root, mode)).signal).toBe('SIGKILL');
    const saved = await readReservations(store);
    expect(saved.document.reservations).toHaveLength(3);
    expect(saved.document.reservations.every(r => r.status === (mode === 'after-complete' ? 'completed' : 'reserved'))).toBe(true);
    const restart = await child(root, 'normal');
    expect(restart.code).toBe(2); expect(restart.stderr).toContain('consumed');
    expect(await readReservations(store)).toEqual(saved);
  }));
  it('allows one replay when two separate processes race the whole plan', async () => temp(async root => {
    const store = createSyntheticFileStore(root);
    const outcomes = await Promise.all([child(root, 'normal'), child(root, 'normal')]);
    expect(outcomes.map(x => x.code).sort()).toEqual([0, 2]);
    const state = await readReservations(store);
    expect(state.document.revision).toBe(2);
    expect(state.document.reservations).toHaveLength(3);
    expect(state.document.reservations.every(r => r.status === 'completed')).toBe(true);
  }));
});
