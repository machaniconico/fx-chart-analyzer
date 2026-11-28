import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const source = readFileSync(new URL('../.github/workflows/update-data.yml', import.meta.url), 'utf8');
const steps = source.split(/\n      - /);
const step = name => steps.find(s => s.startsWith(`name: ${name}\n`));
const check = step('Verify this run completed EA forward tests');
const shell = check.split('        run: |\n')[1].split('\n\n')[0].replace(/^          /gm, '');
describe('daily forward execution health gate', () => {
  it('preserves availability, but checks raw outcome after deploy and before failure notification', () => {
    expect(step('Run EA forward tests')).toMatch(/id: forward-tests\n        continue-on-error: true/);
    expect(check).toContain('if: ${{ !cancelled() }}');
    expect(check).toContain('FORWARD_OUTCOME: ${{ steps.forward-tests.outcome }}');
    expect(check).not.toContain('continue-on-error');
    expect(source.indexOf('name: Verify this run completed EA forward tests')).toBeGreaterThan(source.indexOf('name: Verify data freshness and persistence'));
    expect(source.indexOf('name: Verify this run completed EA forward tests')).toBeLessThan(source.indexOf('name: Open or update the failure issue'));
    expect(step('Open or update the failure issue')).toContain('FORWARD_OUTCOME: ${{ steps.forward-tests.outcome }}');
    expect(step('Open or update the failure issue')).toContain('${FORWARD_OUTCOME:-unknown}');
    expect(step('Close the failure issue on recovery')).toContain("success() && steps.commit-data.outcome != 'failure'");
    for (const name of ['Verify data freshness before commit', 'Verify data freshness and persistence']) {
      expect(step(name)).not.toContain('continue-on-error');
    }
  });
  it.each(['failure', 'skipped', 'cancelled', '', 'unexpected'])('fails closed for outcome %j', outcome => {
    const result = spawnSync('bash', ['-c', shell], { env: { ...process.env, FORWARD_OUTCOME: outcome }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::EA forward refresh did not succeed');
  });
  it('accepts only success', () => {
    const result = spawnSync('bash', ['-c', shell], { env: { ...process.env, FORWARD_OUTCOME: 'success' }, encoding: 'utf8' });
    expect(result.status).toBe(0); expect(result.stdout).toBe('');
  });
});
