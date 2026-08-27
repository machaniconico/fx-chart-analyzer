import { describe, expect, it } from 'vitest';
import { buildInfo } from './write-build-info.mjs';

const BUILT_AT = '2026-08-27T23:00:00.000Z';
const HEAD = 'b'.repeat(40);

describe('buildInfo deploy provenance', () => {
  it('records the workflow run so a deployed build can be traced back', () => {
    const info = buildInfo({
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_ID: '123',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'owner/repo',
      DATA_CHANGED: 'true',
    }, { headSha: HEAD, builtAt: BUILT_AT });

    expect(info).toEqual({
      schemaVersion: 1,
      builtAt: BUILT_AT,
      commitSha: 'a'.repeat(40),
      headSha: HEAD,
      ref: 'refs/heads/main',
      runId: '123',
      runUrl: 'https://github.com/owner/repo/actions/runs/123',
      dataDirty: true,
    });
  });

  it('marks dataDirty only when this run carries uncommitted data', () => {
    const dirty = buildInfo({ DATA_CHANGED: 'true' }, { headSha: HEAD, builtAt: BUILT_AT });
    const clean = buildInfo({ DATA_CHANGED: 'false' }, { headSha: HEAD, builtAt: BUILT_AT });
    const unset = buildInfo({}, { headSha: HEAD, builtAt: BUILT_AT });

    expect(dirty.dataDirty).toBe(true);
    expect(clean.dataDirty).toBe(false);
    expect(unset.dataDirty).toBe(false);
  });

  it('falls back to the local HEAD outside Actions and leaves run fields null', () => {
    const info = buildInfo({}, { headSha: HEAD, builtAt: BUILT_AT });

    expect(info.commitSha).toBe(HEAD);
    expect(info.ref).toBeNull();
    expect(info.runId).toBeNull();
    expect(info.runUrl).toBeNull();
  });

  it('omits the run URL when the repository context is incomplete', () => {
    const info = buildInfo(
      { GITHUB_RUN_ID: '123', GITHUB_SERVER_URL: 'https://github.com' },
      { headSha: HEAD, builtAt: BUILT_AT },
    );

    expect(info.runId).toBe('123');
    expect(info.runUrl).toBeNull();
  });
});
