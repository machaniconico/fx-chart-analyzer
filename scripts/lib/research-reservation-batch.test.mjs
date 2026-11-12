import { describe, it, expect } from 'vitest';
import { fingerprint } from './virtual-autonomy.mjs';
import { reservationGenesis, readReservations, reserveHoldout, reserveHoldoutBatch, completeReservationBatch,
  completeReservation, ReservationConflict } from './research-reservations.mjs';

const ledgerId = 'synthetic-batch-test-ledger';
const copy = value => JSON.parse(JSON.stringify(value));
const identity = offset => ({ cycleId: fingerprint(['cycle', offset]), requestHash: fingerprint('request'),
  engineHash: fingerprint('engine'), testHash: fingerprint(['test', offset]), start: offset + 100, end: offset + 200 });
const identities = () => [identity(0), identity(300), identity(600)];
const memory = (initial = reservationGenesis(ledgerId)) => {
  let document = copy(initial), writes = 0;
  return { ledgerId, syntheticOnly: true, get writes() { return writes; },
    read: async () => ({ version: `v${document.revision}`, document: copy(document) }),
    compareAndSwap: async (version, next) => {
      if (version !== `v${document.revision}`) throw new ReservationConflict('stale');
      document = copy(next); writes++;
    } };
};

describe('atomic planned outer holdout batches', () => {
  it('reserves and completes the whole plan in two revisions without partial states', async () => {
    const store = memory(), receipt = await reserveHoldoutBatch(store, identities());
    expect(store.writes).toBe(1);
    expect(receipt.snapshot.document.revision).toBe(1);
    expect(receipt.reservations).toHaveLength(3);
    expect(new Set(receipt.reservations.map(r => r.attemptId)).size).toBe(3);
    const result = await completeReservationBatch(store, receipt, fingerprint('full artifact'));
    expect(store.writes).toBe(2);
    expect(result.snapshot.document.revision).toBe(2);
    expect(result.reservations.every(r => r.status === 'completed' && r.resultHash === fingerprint('full artifact'))).toBe(true);
  });
  it.each([[], [identity(0), identity(0)], [identity(300), identity(0)], [identity(0), identity(50)],
    Array.from({ length: 7 }, (_, i) => identity(i * 300)),
    [identity(0), { ...identity(300), requestHash: fingerprint('other request') }],
    [identity(0), { ...identity(300), engineHash: fingerprint('other engine') }],
    [{ ...identity(0), end: NaN }]])('rejects malformed batches before writing (%#)', async batch => {
    const store = memory();
    await expect(reserveHoldoutBatch(store, batch)).rejects.toThrow();
    expect(store.writes).toBe(0);
  });
  it('refuses the whole batch when only one later fold is already consumed', async () => {
    const store = memory(); await reserveHoldout(store, identity(600));
    await expect(reserveHoldoutBatch(store, identities())).rejects.toThrow('consumed');
    expect(store.writes).toBe(1);
    expect((await store.read()).document.reservations).toHaveLength(1);
  });
  it('retains the legacy cutoff and append-only chronology', async () => {
    const store = memory(reservationGenesis(ledgerId, [], 101));
    await expect(reserveHoldoutBatch(store, identities())).rejects.toThrow('cutoff');
    await reserveHoldoutBatch(store, [identity(900), identity(1200)]);
    await expect(reserveHoldoutBatch(store, [identity(300)])).rejects.toThrow('later untouched');
    expect(store.writes).toBe(1);
  });
  it('allows one winner when independent clients race the same multi-fold plan', async () => {
    const store = memory();
    const outcomes = await Promise.allSettled([reserveHoldoutBatch({ ...store }, identities()), reserveHoldoutBatch({ ...store }, identities())]);
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(store.writes).toBe(1);
    expect((await store.read()).document.reservations).toHaveLength(3);
  });
  it('preserves an independent later single reservation during batch completion', async () => {
    const store = memory(), receipt = await reserveHoldoutBatch(store, identities());
    const later = await reserveHoldout(store, identity(1000));
    await Promise.all([completeReservationBatch(store, receipt, fingerprint('batch')), completeReservation(store, later, fingerprint('later'))]);
    const snapshot = await readReservations(store);
    expect(snapshot.document.reservations.map(r => r.resultHash)).toEqual([fingerprint('batch'), fingerprint('batch'), fingerprint('batch'), fingerprint('later')]);
  });
  it('reconciles lost reserve and complete acknowledgements only with every exact receipt', async () => {
    const store = memory(), write = store.compareAndSwap;
    store.compareAndSwap = async (...args) => { await write(...args); throw new Error('lost response'); };
    const receipt = await reserveHoldoutBatch(store, identities());
    await completeReservationBatch(store, receipt, fingerprint('result'));
    expect(store.writes).toBe(2);
  });
  it.each(['timeout', 'noop', 'partial', 'different-owner'])('does not retry or accept %s outcomes', async mode => {
    const store = memory(), write = store.compareAndSwap; let calls = 0;
    store.compareAndSwap = async (version, document) => {
      calls++;
      if (mode === 'timeout') throw new Error('timeout');
      if (mode === 'partial') await write(version, { ...document, reservations: document.reservations.slice(0, 1) });
      if (mode === 'different-owner') {
        document.reservations[1].attemptId = 'another-owner-attempt'; await write(version, document);
      }
    };
    await expect(reserveHoldoutBatch(store, identities())).rejects.toThrow(mode === 'partial' ? 'incomplete or inconsistent batch' : 'unconfirmed');
    expect(calls).toBe(1);
  });
  it('stops on unavailable confirmation and retains all consumed windows', async () => {
    const store = memory(), read = store.read; let reads = 0;
    store.read = async () => { if (++reads === 2) throw new Error('offline'); return read(); };
    await expect(reserveHoldoutBatch(store, identities())).rejects.toThrow('offline');
    store.read = read;
    expect((await read()).document.reservations).toHaveLength(3);
    await expect(reserveHoldoutBatch(store, identities())).rejects.toThrow('consumed');
  });
  it('snapshots identities before the initial asynchronous read', async () => {
    const store = memory(), read = store.read, input = identities(); let release, entered;
    const reached = new Promise(resolve => { entered = resolve; }), pause = new Promise(resolve => { release = resolve; });
    store.read = async () => { entered(); await pause; return read(); };
    const run = reserveHoldoutBatch(store, input); await reached;
    input[0].start = 999999; input[1].testHash = fingerprint('changed'); input.pop(); release();
    expect((await run).reservations.map(({ cycleId, requestHash, engineHash, testHash, start, end }) =>
      ({ cycleId, requestHash, engineHash, testHash, start, end }))).toEqual(identities());
  });
  it('also snapshots a single reservation identity before its initial read', async () => {
    const store = memory(), read = store.read, input = identity(0);
    store.read = async () => { input.start = 99999; return read(); };
    expect((await reserveHoldout(store, input)).reservation.start).toBe(100);
  });
  it('rejects modified owners, duplicate receipts, and a second completion without writing', async () => {
    const store = memory(), receipt = await reserveHoldoutBatch(store, identities());
    const altered = copy(receipt); altered.reservations[1].attemptId = 'other-owner-attempt';
    await expect(completeReservationBatch(store, altered, fingerprint('x'))).rejects.toThrow('snapshot mismatch');
    const duplicate = copy(receipt); duplicate.reservations[1] = duplicate.reservations[0];
    await expect(completeReservationBatch(store, duplicate, fingerprint('x'))).rejects.toThrow();
    expect(store.writes).toBe(1);
    await completeReservationBatch(store, receipt, fingerprint('first'));
    await expect(completeReservationBatch(store, receipt, fingerprint('second'))).rejects.toThrow('ownership');
    expect(store.writes).toBe(2);
  });
  it('never reports success on partial completion or overwritten results', async () => {
    for (const mode of ['partial', 'wrong-hash']) {
      const store = memory(), receipt = await reserveHoldoutBatch(store, identities()), write = store.compareAndSwap;
      store.compareAndSwap = async (version, next) => {
        if (mode === 'partial') next.reservations[1] = receipt.reservations[1];
        else next.reservations[1].resultHash = fingerprint('wrong');
        await write(version, next);
      };
      await expect(completeReservationBatch(store, receipt, fingerprint('result'))).rejects.toThrow('incomplete or inconsistent batch');
      expect(store.writes).toBe(2);
    }
  });
  it('refuses truncated receipts and single-fold completion of an atomic batch', async () => {
    const store = memory(), receipt = await reserveHoldoutBatch(store, identities());
    const subset = copy(receipt); subset.reservations = subset.reservations.slice(0, 1);
    await expect(completeReservationBatch(store, subset, fingerprint('partial'))).rejects.toThrow('incomplete or inconsistent batch');
    await expect(completeReservation(store, { snapshot: receipt.snapshot, reservation: receipt.reservations[0] }, fingerprint('partial'))).rejects.toThrow('whole-batch');
    const rewritten = copy(subset); rewritten.reservations[0].batchSize = 1;
    await expect(completeReservationBatch(store, rewritten, fingerprint('partial'))).rejects.toThrow('snapshot mismatch');
    expect(store.writes).toBe(1);
  });
  it('bounds explicit pre-write conflicts without consuming or fitting', async () => {
    const store = memory(); let calls = 0;
    store.compareAndSwap = async () => { calls++; throw new ReservationConflict('busy'); };
    await expect(reserveHoldoutBatch(store, identities())).rejects.toThrow('retry limit');
    expect(calls).toBe(8); expect(store.writes).toBe(0);
  });
});
