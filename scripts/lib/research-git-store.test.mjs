import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResearchCycle, syntheticResearchRequest } from './virtual-research-cycle.mjs';
import { createHash } from 'node:crypto';
import { createGitCommitReservationStore } from './research-git-store.mjs';
import { reservationGenesis, reserveHoldout, readReservations, ReservationConflict } from './research-reservations.mjs';
import { fingerprint } from './virtual-autonomy.mjs';
const location = { ledgerId: 'synthetic-git-ledger', repository: 'fixture/isolated', branch: 'synthetic', path: 'state.json' };
const hash = s => createHash('sha1').update(s).digest('hex');
const blobHash = s => hash(`blob ${Buffer.byteLength(s)}\0${s}`);
const identity = (n = 0) => ({ cycleId: fingerprint(['cycle', n]), requestHash: fingerprint(['request', n]),
  engineHash: fingerprint('engine'), testHash: fingerprint(['test', n]), start: 100 + n, end: 200 + n });
function fixture() {
  const blobs = new Map(), trees = new Map(), commits = new Map(); let counter = 0, writes = 0;
  const content = JSON.stringify(reservationGenesis(location.ledgerId));
  const blob = blobHash(content), tree = hash('tree0'), genesis = hash('commit0');
  blobs.set(blob, content); trees.set(tree, [{ path: location.path, type: 'blob', mode: '100644', sha: blob }]);
  commits.set(genesis, { sha: genesis, tree: { sha: tree }, parents: [] }); let head = genesis;
  const response = x => ({ repository: location.repository, ...structuredClone(x) });
  const ref = () => response({ ref: `refs/heads/${location.branch}`, object: { type: 'commit', sha: head } });
  const connector = {
    getRef: vi.fn(async () => ref()),
    getTree: vi.fn(async ({ sha }) => response({ sha, truncated: false, tree: trees.get(sha) })),
    getCommit: vi.fn(async ({ sha }) => response(commits.get(sha))),
    readFile: vi.fn(async ({ ref, path }) => {
      const treeSha = commits.get(ref).tree.sha, e = trees.get(treeSha).find(x => x.path === path), content = blobs.get(e.sha);
      return response({ commitSha: ref, treeSha, ...e, type: 'file', content, size: Buffer.byteLength(content) });
    }),
    createBlob: vi.fn(async ({ content }) => { const sha = blobHash(content); blobs.set(sha, content); return response({ sha }); }),
    createTree: vi.fn(async ({ tree_elements }) => { const sha = hash(`tree${++counter}`); trees.set(sha, tree_elements); return response({ sha, truncated: false, tree: tree_elements }); }),
    createCommit: vi.fn(async ({ tree_sha, parent_sha }) => { const sha = hash(`commit${++counter}`); commits.set(sha, { sha, tree: { sha: tree_sha }, parents: [{ sha: parent_sha }] }); return response({ sha }); }),
    updateRef: vi.fn(async ({ sha, force, expected_sha }) => {
      // Independent service-side fast-forward check, not a client lock.
      if (force !== false || head !== expected_sha || commits.get(sha).parents[0].sha !== head) throw new Error('non-fast-forward');
      head = sha; writes++; return ref();
    }),
  };
  return { connector, genesis, commits, trees, state: () => ({ head, writes }), rollback: () => { head = genesis; },
    make: (minimumCommit = genesis) => createGitCommitReservationStore({ ...location, minimumCommit, connector }) };
}
describe('inactive synthetic Git commit/ref transport', () => {
  it('pins coherent immutable content and freezes synthetic status', async () => {
    const f = fixture(), s = f.make(), before = await s.read();
    expect(Object.isFrozen(s)).toBe(true); expect(s.syntheticOnly).toBe(true);
    const receipt = await reserveHoldout(s, identity(), before);
    expect(receipt.snapshot.version).toBe(f.state().head);
    expect(f.connector.updateRef).toHaveBeenCalledWith(expect.objectContaining({ expected_sha: before.version, force: false }));
    expect(f.connector.createCommit).toHaveBeenCalledTimes(1);
    for (const [arg] of f.connector.readFile.mock.calls) expect(arg.ref).toMatch(/^[a-f0-9]{40}$/);
  });
  it('cannot regress the high-water pin when immutable ancestry reads overlap', async () => {
    const f = fixture(), a = hash('A'), b = hash('B'), tree = f.commits.get(f.genesis).tree;
    f.commits.set(a, { sha: a, tree, parents: [{ sha: f.genesis }] });
    f.commits.set(b, { sha: b, tree, parents: [{ sha: a }] });
    let tip = a, count = 0, release, paused;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { paused = resolve; });
    f.connector.getRef.mockImplementation(async () => ({ repository: location.repository,
      ref: `refs/heads/${location.branch}`, object: { type: 'commit', sha: tip } }));
    const original = f.connector.getCommit;
    f.connector.getCommit = vi.fn(async args => {
      if (args.sha === a && ++count === 3) { paused(); await gate; }
      return original(args);
    });
    const store = f.make(), older = store.read();
    // Attach rejection handling before releasing the paused operation.
    const rejection = expect(older).rejects.toThrow('rollback');
    await waiting; tip = b; expect((await store.read()).version).toBe(b);
    release(); await rejection; tip = a;
    await expect(store.read()).rejects.toThrow('rollback');
  });
  it('refuses observed-data research before any transport writes', async () => {
    const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'synthetic-git-'));
    const request = syntheticResearchRequest(); request.dataset.provenance.kind = 'observed';
    try {
      await expect(runResearchCycle({ stateDir: dir, request, reservationStore: f.make() })).rejects.toThrow('synthetic-only');
      expect(f.connector.createBlob).not.toHaveBeenCalled();
      expect(f.connector.updateRef).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('allows only one of two independent concurrent same-holdout clients', async () => {
    const f = fixture(), a = f.make(), b = f.make();
    const results = await Promise.allSettled([reserveHoldout(a, identity()), reserveHoldout(b, identity())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(f.state().writes).toBe(1);
    expect(f.connector.createCommit).toHaveBeenCalledTimes(2);
    const parents = [...f.commits.values()].filter(c => c.parents.length).map(c => c.parents[0].sha);
    expect(parents).toEqual([f.genesis, f.genesis]);
  });
  it('reconciles a lost update acknowledgement without retry', async () => {
    const f = fixture(), update = f.connector.updateRef;
    f.connector.updateRef = vi.fn(async args => { await update(args); throw new Error('lost ack'); });
    await expect(reserveHoldout(f.make(), identity())).resolves.toHaveProperty('reservation');
    expect(f.state().writes).toBe(1); expect(f.connector.updateRef).toHaveBeenCalledTimes(1);
  });
  it.each(['throw', 'error-envelope', 'false-success'])('never retries uncertain update: %s', async kind => {
    const f = fixture(); f.connector.updateRef.mockImplementation(async () => {
      if (kind === 'throw') throw Object.assign(new Error('unknown'), { status: 409 });
      return kind === 'error-envelope' ? { isError: true } : { repository: location.repository, ref: 'wrong' };
    });
    await expect(reserveHoldout(f.make(), identity())).rejects.toThrow('unconfirmed');
    expect(f.connector.updateRef).toHaveBeenCalledTimes(1);
  });
  it('restart pins high-water commit, retains consumed holdout, rejects rollback', async () => {
    const f = fixture(), receipt = await reserveHoldout(f.make(), identity()), restarted = f.make(receipt.snapshot.version);
    await expect(reserveHoldout(restarted, identity())).rejects.toThrow('consumed');
    f.rollback(); await expect(restarted.read()).rejects.toThrow('rollback');
    await expect(f.make(receipt.snapshot.version).read()).rejects.toThrow('rollback');
  });
  it('rejects a stale expected commit before creating detached objects', async () => {
    const f = fixture(), a = f.make(), before = await a.read(); await reserveHoldout(f.make(), identity());
    await expect(a.compareAndSwap(before.version, { ...before.document, revision: 1 })).rejects.toBeInstanceOf(ReservationConflict);
    expect(f.connector.createCommit).toHaveBeenCalledTimes(1);
  });
  it('does not resume detached objects after a crash', async () => {
    const f = fixture(); f.connector.updateRef.mockRejectedValueOnce(new Error('offline'));
    await expect(reserveHoldout(f.make(), identity())).rejects.toThrow('unconfirmed');
    const detached = [...f.commits.keys()].at(-1);
    await reserveHoldout(f.make(), identity());
    expect(f.state().head).not.toBe(detached); expect(f.connector.createCommit).toHaveBeenCalledTimes(2);
  });
  it.each(['repository', 'ref', 'commit', 'tree', 'path', 'blob', 'size', 'json', 'ledger', 'encoding'])('rejects invalid read %s', async kind => {
    const f = fixture(); const method = kind === 'ref' ? 'getRef' : kind === 'commit' ? 'getCommit' : 'readFile';
    const original = f.connector[method]; f.connector[method] = vi.fn(async args => {
      const r = await original(args);
      if (kind === 'repository') r.repository = 'other/repo';
      if (kind === 'ref') r.ref = 'refs/heads/other';
      if (kind === 'commit') r.sha = hash('other');
      if (kind === 'tree') r.treeSha = hash('other');
      if (kind === 'path') r.path = 'other.json';
      if (kind === 'blob') r.sha = hash('other');
      if (kind === 'size') r.size = 1024 * 1024 + 1;
      if (['json', 'ledger', 'encoding'].includes(kind)) {
        r.content = kind === 'json' ? '{bad' : kind === 'encoding' ? '\ud800' : '{"ledgerId":"wrong"}';
        r.size = Buffer.byteLength(r.content); r.sha = blobHash(r.content);
      }
      return r;
    });
    await expect(f.make().read()).rejects.toThrow(); expect(f.connector.updateRef).not.toHaveBeenCalled();
  });
  it('refuses a candidate tree that removes unrelated files', async () => {
    const f = fixture(), tree = f.trees.get(f.commits.get(f.genesis).tree.sha);
    tree.push({ path: 'README.md', mode: '100644', type: 'blob', sha: hash('readme') });
    // Malformed fixture createTree ignores base_tree_sha and drops README.
    await expect(reserveHoldout(f.make(), identity())).rejects.toThrow('unconfirmed');
    expect(f.connector.updateRef).not.toHaveBeenCalled();
  });
  it.each(['merge', 'wrong-parent', 'wrong-tree', 'wrong-path'])('validates created objects before updating ref: %s', async kind => {
    const f = fixture(), create = f.connector.createCommit, tree = f.connector.createTree;
    if (kind === 'wrong-path') f.connector.createTree = vi.fn(async args => { args.tree_elements[0].path = 'other.json'; const r = await tree(args); r.tree[0].path = 'other.json'; return r; });
    else f.connector.createCommit = vi.fn(async args => {
      const r = await create(args), c = f.commits.get(r.sha);
      if (kind === 'merge') c.parents.push({ sha: hash('other') });
      if (kind === 'wrong-parent') c.parents[0].sha = hash('other');
      if (kind === 'wrong-tree') c.tree.sha = f.commits.get(f.genesis).tree.sha;
      return r;
    });
    await expect(reserveHoldout(f.make(), identity())).rejects.toThrow(); expect(f.connector.updateRef).not.toHaveBeenCalled();
  });
  it('requires observed version, bounded valid content and monotonic revision before writes', async () => {
    const f = fixture(), s = f.make(), doc = reservationGenesis(location.ledgerId);
    await expect(s.compareAndSwap(f.genesis, doc)).rejects.toThrow('read by'); await s.read();
    for (const next of [doc, { ...doc, revision: 2 }, { ...doc, ledgerId: 'wrong' }, { ...doc, pad: 'x'.repeat(1024 * 1024) }]) {
      await expect(s.compareAndSwap(f.genesis, next)).rejects.toThrow();
    }
    expect(f.connector.createBlob).not.toHaveBeenCalled();
  });
  it.each([{ repository: '../x' }, { branch: 'refs/heads/a' }, { branch: 'a.lock' }, { path: '../x.json' }, { path: '/x.json' }, { path: 'x//a.json' }, { minimumCommit: 'main' }])('rejects unsafe locations %j', overrides => {
    const f = fixture(); expect(() => createGitCommitReservationStore({ ...location, minimumCommit: f.genesis, connector: f.connector, ...overrides })).toThrow();
  });
});
