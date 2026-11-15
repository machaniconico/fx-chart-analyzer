/** Inactive synthetic-only Git transport. Inject authorized connector wrappers;
 * no credentials, bootstrap, scheduling, force updates or automatic retries. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './virtual-autonomy.mjs';
import { readReservations, ReservationConflict } from './research-reservations.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(`research-git: ${message}`); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const MAX_BYTES = 1024 * 1024;
const segment = value => typeof value === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(value)
  && !value.includes('..') && !value.endsWith('.') && !value.endsWith('.lock');
const blobHash = content => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');

export function createGitCommitReservationStore({ ledgerId, repository, branch, path, minimumCommit, connector }) {
  assert(typeof ledgerId === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(ledgerId), 'invalid ledger identity');
  assert(typeof repository === 'string' && repository.split('/').length === 2 && repository.split('/').every(segment), 'invalid repository');
  assert(typeof branch === 'string' && branch.length <= 200 && branch.split('/').every(segment)
    && !branch.startsWith('refs/'), 'invalid branch');
  assert(typeof path === 'string' && path.length <= 950 && path.split('/').every(segment) && path.endsWith('.json'), 'invalid path');
  assert(sha(minimumCommit), 'pinned high-water commit required');
  const methods = ['getRef', 'getCommit', 'getTree', 'readFile', 'createBlob', 'createTree', 'createCommit', 'updateRef'];
  const api = {};
  for (const method of methods) {
    assert(typeof connector?.[method] === 'function', `missing connector ${method}`);
    api[method] = connector[method].bind(connector);
  }
  const call = async (method, args) => {
    const result = await api[method]({ repository_full_name: repository, ...args });
    assert(result && !result.isError && result.repository === repository, `${method} failed or repository mismatch`);
    // Snapshot connector-owned objects before any later await.
    return JSON.parse(canonicalJson(result));
  };
  let highWater = minimumCommit;
  const observed = new Set();
  const getCommit = async version => {
    const c = await call('getCommit', { sha: version });
    assert(c.sha === version && sha(c.tree?.sha) && Array.isArray(c.parents)
      && c.parents.length <= 1 && c.parents.every(p => sha(p.sha)), 'commit identity/tree/parents mismatch');
    return c;
  };
  const readAt = async version => {
    const c = await getCommit(version);
    const tree = await call('getTree', { sha: c.tree.sha, recursive: true });
    assert(tree.sha === c.tree.sha && tree.truncated === false && Array.isArray(tree.tree)
      && tree.tree.length <= 10000 && new Set(tree.tree.map(e => e.path)).size === tree.tree.length
      && tree.tree.filter(e => e.path === path).length === 1, 'immutable tree/path mismatch');
    const entry = tree.tree.find(e => e.path === path);
    const file = await call('readFile', { path, ref: version });
    assert(entry.mode === '100644' && entry.type === 'blob' && entry.sha === file.sha, 'immutable tree entry mismatch');
    assert(file.commitSha === version && file.treeSha === c.tree.sha && file.path === path
      && file.type === 'file' && file.mode === '100644' && sha(file.sha), 'file commit/tree/path mismatch');
    assert(typeof file.content === 'string' && Number.isSafeInteger(file.size) && file.size >= 0
      && file.size <= MAX_BYTES && Buffer.byteLength(file.content) === file.size, 'invalid content size');
    assert(Buffer.from(file.content).toString('utf8') === file.content && blobHash(file.content) === file.sha, 'content encoding/blob mismatch');
    const document = JSON.parse(file.content);
    // Reuse controller validation rather than a second divergent ledger schema.
    await readReservations({ ledgerId, read: async () => ({ version, document }), compareAndSwap() {} });
    return { version, document, tree: c.tree.sha, entries: tree.tree };
  };
  const assertDescendant = async (tip, floor) => {
    const seen = new Set(); let cursor = tip;
    for (let depth = 0; depth < 1024; depth++) {
      if (cursor === floor) return;
      assert(!seen.has(cursor), 'cyclic commit history'); seen.add(cursor);
      const c = await getCommit(cursor);
      assert(c.parents.length === 1, 'rollback or unrelated history');
      cursor = c.parents[0].sha;
    }
    throw new Error('research-git: ancestry verification limit; manual checkpoint required');
  };
  const read = async () => {
    const ref = await call('getRef', { branch_name: branch });
    assert(ref.ref === `refs/heads/${branch}` && ref.object?.type === 'commit' && sha(ref.object.sha), 'ref identity mismatch');
    const version = ref.object.sha;
    await assertDescendant(version, highWater);
    const snapshot = await readAt(version);
    // Recheck after awaits: overlapping reads cannot move this instance backwards.
    for (;;) {
      const floor = highWater;
      await assertDescendant(version, floor);
      if (highWater !== floor) continue;
      // No await between checking the pin and replacing it.
      highWater = version; break;
    }
    observed.add(version);
    return { version, document: snapshot.document };
  };
  return Object.freeze({ ledgerId, syntheticOnly: true, read,
    async compareAndSwap(version, document) {
      assert(sha(version) && observed.has(version), 'version must be read by this instance');
      const content = canonicalJson(document) + '\n';
      assert(Buffer.byteLength(content) <= MAX_BYTES, 'content exceeds size limit');
      await readReservations({ ledgerId, read: async () => ({ version, document: JSON.parse(content) }), compareAndSwap() {} });
      const before = await readAt(version);
      // Controller owns transitions; reject regressions even for direct adapter use.
      await readReservations({ ledgerId, read: async () => ({ version, document: JSON.parse(content) }), compareAndSwap() {} }, before);
      assert(document.revision === before.document.revision + 1, 'write must increment revision once');
      const ref = await call('getRef', { branch_name: branch });
      assert(ref.ref === `refs/heads/${branch}` && ref.object?.type === 'commit' && sha(ref.object.sha), 'ref identity mismatch');
      await assertDescendant(ref.object.sha, highWater);
      if (ref.object.sha !== version) throw new ReservationConflict('Git ref changed before object creation');
      const blob = await call('createBlob', { content, encoding: 'utf-8' });
      assert(blob.sha === blobHash(content), 'created blob mismatch');
      const tree = await call('createTree', { base_tree_sha: before.tree,
        tree_elements: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
      assert(sha(tree.sha), 'created tree identity mismatch');
      const commit = await call('createCommit', { tree_sha: tree.sha, parent_sha: version,
        additional_parent_shas: [], message: 'research: persist synthetic holdout reservation state' });
      assert(sha(commit.sha) && commit.sha !== version, 'created commit identity mismatch');
      const verify = await readAt(commit.sha);
      const immutableCommit = await getCommit(commit.sha);
      const untouched = entries => entries.filter(e => e.path !== path)
        .map(e => ({ path: e.path, mode: e.mode, type: e.type,
          sha: path.startsWith(`${e.path}/`) && e.type === 'tree' ? null : e.sha }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      assert(canonicalJson(untouched(before.entries)) === canonicalJson(untouched(verify.entries)), 'unrelated tree entries changed');
      assert(immutableCommit.parents.length === 1 && immutableCommit.parents[0].sha === version
        && verify.tree === tree.sha && canonicalJson(verify.document) === canonicalJson(document), 'created immutable commit mismatch');
      // No error (including status 409/422) is guessed retryable here. A lost
      // acknowledgement is reconciled by the controller's mandatory reread.
      const updated = await call('updateRef', { branch_name: branch, sha: commit.sha, force: false, expected_sha: version });
      assert(updated.ref === `refs/heads/${branch}` && updated.object?.type === 'commit'
        && updated.object.sha === commit.sha, 'update acknowledgement uncertain');
    },
  });
}
