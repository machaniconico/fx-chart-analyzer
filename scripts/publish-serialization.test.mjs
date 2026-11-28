import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const read = name => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
describe('production publishing contract', () => {
  for (const name of ['update-data', 'deploy']) {
    it(`${name} shares a non-cancelling production lock`, () => {
      const source = read(name);
      expect(source).toMatch(/^concurrency:\n  group: fx-production-publish\n  cancel-in-progress: false\n  queue: max$/m);
      expect(source).not.toMatch(/cancel-in-progress: true/);
    });
    it(`${name} checks out current main only after entering its guarded job`, () => {
      const source = read(name);
      expect(source).toContain("if: ${{ github.ref == 'refs/heads/main' }}");
      expect(source).toMatch(/uses: actions\/checkout@v5\n        with:\n(?:          #[^\n]*\n)*          ref: main/);
    });
  }
  it('does not add retry dispatches or extra schedules', () => {
    expect(read('deploy')).toContain('timeout-minutes: 30');
    expect(read('deploy')).not.toMatch(/schedule:|gh workflow run|\/dispatches/);
    expect(read('update-data').match(/- cron:/g)).toHaveLength(1);
  });
});
