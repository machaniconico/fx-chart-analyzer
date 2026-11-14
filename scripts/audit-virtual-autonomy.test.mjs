import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildAutonomyAudit, writeAutonomyAudit } from './audit-virtual-autonomy.mjs';

describe('offline virtual-autonomy audit', () => {
  it('audits existing strategies without claiming performance or silently promoting legacy results', async () => {
    const report = await buildAutonomyAudit({ asOf: Date.parse('2026-11-11T14:00:00Z') / 1000 });
    expect(report.summary.strategies).toBeGreaterThan(0);
    expect(report.summary.approvedForNewPortfolio).toBe(0);
    expect(report.summary.historicalPerformanceCalculated).toBe(false);
    expect(report.strategies.every((s) => s.admission === 'hold' && !s.regime.eligible)).toBe(true);
    expect(report.strategies.some((s) => s.blockers.includes('insufficient_research_history'))).toBe(true);
    const again = await buildAutonomyAudit({ asOf: report.asOf });
    expect(again.reportId).toBe(report.reportId);
  });
  it('writes idempotently and refuses to overwrite conflicting prior evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fx-autonomy-audit-'));
    try {
      const report = { reportId: 'test', result: 'hold' };
      const output = await writeAutonomyAudit(report, directory);
      expect(await writeAutonomyAudit(report, directory)).toBe(output);
      await expect(writeAutonomyAudit({ ...report, result: 'approved' }, directory)).rejects.toThrow();
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(report);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects invalid evaluation clocks', async () => {
    await expect(buildAutonomyAudit({ asOf: NaN })).rejects.toThrow('Invalid asOf');
  });
});
