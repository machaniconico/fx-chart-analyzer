/** Synthetic-only local immutable cache. No network, credentials or cleanup.
 * Linux directory-descriptor anchoring avoids pathname traversal races. This is
 * not independent custody or a power-loss/provider durability guarantee.
 */
import { constants as C, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync, fsyncSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { canonicalJson, fingerprint } from './virtual-autonomy.mjs';
const assert = (ok, message) => { if (!ok) throw new Error(`synthetic-artifact: ${message}`); };
export const SYNTHETIC_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
/** An explicit local persistence failure is never a lost acknowledgement.
 * Readable page-cache bytes cannot establish that file/directory fsync succeeded.
 */
export class SyntheticArtifactPersistenceError extends Error {
  constructor(cause) {
    super(`synthetic-artifact: local persistence failed: ${cause.message}`, { cause });
    this.name = 'SyntheticArtifactPersistenceError';
  }
}
const validHash = hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
export function createLocalSyntheticArtifactStore({ directory }) {
  assert(process.platform === 'linux' && C.O_NOFOLLOW && C.O_DIRECTORY, 'Linux no-follow descriptors required');
  assert(typeof directory === 'string' && isAbsolute(directory) && directory.length <= 4096
    && directory.split('/').slice(1).every(part => part && part !== '.' && part !== '..' && !/[\0\\]/.test(part)), 'unsafe directory');
  // Existing directories only, never initialize or repair paths. Each descent
  // uses a pinned descriptor and O_NOFOLLOW, including every ancestor.
  const withDirectory = fn => {
    let fd = openSync('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try {
      for (const part of directory.split('/').slice(1)) {
        const next = openSync(`/proc/self/fd/${fd}/${part}`, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
        closeSync(fd); fd = next;
      }
      const stat = fstatSync(fd);
      assert(stat.isDirectory(), 'not a directory');
      return fn(fd, stat);
    } finally { closeSync(fd); }
  };
  const identity = withDirectory((fd, stat) => ({ dev: stat.dev, ino: stat.ino }));
  const access = (hash, fn) => {
    assert(validHash(hash), 'invalid result hash');
    return withDirectory((dir, stat) => {
      assert(stat.dev === identity.dev && stat.ino === identity.ino, 'directory changed');
      return fn(`/proc/self/fd/${dir}/${hash}.json`, dir);
    });
  };
  const verify = (fd, path) => {
    const stat = fstatSync(fd), named = lstatSync(path);
    assert(stat.isFile() && stat.nlink === 1 && named.isFile() && named.nlink === 1
      && stat.ino === named.ino && stat.dev === named.dev, 'unsafe file or hardlink');
    assert(stat.size > 0 && stat.size <= SYNTHETIC_ARTIFACT_MAX_BYTES, 'artifact size limit');
  };
  return Object.freeze({ syntheticOnly: true,
    async put(hash, artifact) {
      const bytes = canonicalJson(artifact);
      assert(Buffer.byteLength(bytes) <= SYNTHETIC_ARTIFACT_MAX_BYTES && fingerprint(artifact) === hash, 'artifact hash/size mismatch');
      try { access(hash, (path, dir) => {
        // O_EXCL: no overwrite, repair, delete, or automatic retry, even for an
        // identical existing artifact. A partial write remains as fail-closed evidence.
        const fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); verify(fd, path); fsyncSync(dir); }
        finally { closeSync(fd); }
      }); } catch (cause) { throw new SyntheticArtifactPersistenceError(cause); }
    },
    async read(hash) {
      return access(hash, path => {
        const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
        try {
          verify(fd, path);
          const buffer = Buffer.alloc(SYNTHETIC_ARTIFACT_MAX_BYTES + 1);
          let length = 0, count;
          do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count && length < buffer.length);
          assert(length <= SYNTHETIC_ARTIFACT_MAX_BYTES, 'artifact size limit');
          const bytes = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); verify(fd, path);
          assert(Buffer.byteLength(bytes) <= SYNTHETIC_ARTIFACT_MAX_BYTES, 'artifact size limit');
          const artifact = JSON.parse(bytes);
          assert(bytes === canonicalJson(artifact) && fingerprint(artifact) === hash, 'artifact bytes/hash mismatch');
          return artifact;
        } finally { closeSync(fd); }
      });
    },
  });
}
