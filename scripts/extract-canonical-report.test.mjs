import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CANONICAL_REPORT_ID, buildExtract, extractPath } from './extract-canonical-report.mjs';
import { loadObservationStrategies } from './run-forward-test.mjs';

const readExtract = async () => JSON.parse(await readFile(extractPath, 'utf8'));

describe('canonical report extract', () => {
  it('pins the canonical report identity so a re-run cannot silently replace it', async () => {
    const extract = await readExtract();

    expect(extract.source.reportId).toBe(CANONICAL_REPORT_ID);
    expect(extract.source.generatedAt).toBe('2026-08-18T22:32:23.991Z');
    expect(extract.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extract.source.bytes).toBeGreaterThan(0);
  });

  it('carries every judgment input the 2027-02-15 protocol reads', async () => {
    const extract = await readExtract();
    const byId = new Map(extract.candidates.map((candidate) => [candidate.id, candidate]));
    const observations = await loadObservationStrategies();

    expect(observations.length).toBeGreaterThan(0);
    for (const strategy of observations) {
      const candidate = byId.get(strategy.meta.id.replace(/^obs-/, 'tune-'));
      expect(candidate, `no canonical candidate for ${strategy.meta.id}`).toBeDefined();
      expect(candidate.status).toBe('passed');

      // 判定基準3〜5が読む値。丸めず逐語で保持されていること。
      const metrics = candidate.selectedCandidate.validationMetrics;
      expect(typeof metrics.profitFactor).toBe('number');
      expect(typeof metrics.netProfitYen).toBe('number');
      expect(typeof metrics.maxDrawdownYen).toBe('number');
      expect(typeof metrics.maxDrawdownPct).toBe('number');
      expect(typeof candidate.dataWindow.validationSpanDays).toBe('number');

      // 順位とその分母(候補ごとの評価組合せ数)。
      expect(Number.isInteger(candidate.selectedCandidate.rank)).toBe(true);
      expect(Number.isInteger(candidate.combinationCount)).toBe(true);
      expect(candidate.combinationCount).toBeGreaterThanOrEqual(candidate.selectedCandidate.rank);
    }
  });

  it('agrees with the registered strategy definitions on the exit parameters', async () => {
    const extract = await readExtract();
    const byId = new Map(extract.candidates.map((candidate) => [candidate.id, candidate]));

    for (const strategy of await loadObservationStrategies()) {
      const parameters = byId.get(strategy.meta.id.replace(/^obs-/, 'tune-'))
        .selectedCandidate.parameters;
      expect(parameters.stopLossPips).toBe(strategy.exit.stopLossPips);
      expect(parameters.takeProfitPips).toBe(strategy.exit.takeProfitPips);
    }
  });

  it('drops the combinations payload but keeps its count', async () => {
    const extract = await readExtract();

    expect(extract.candidates.every((candidate) => !('combinations' in candidate))).toBe(true);
    expect(extract.candidates.every((candidate) => candidate.combinationCount === null
      || Number.isInteger(candidate.combinationCount))).toBe(true);
  });

  it('buildExtract is deterministic for a given source report', () => {
    const report = {
      schemaVersion: 1,
      generatedAt: '2026-08-18T22:32:23.991Z',
      selectionPolicy: {},
      filters: {},
      matrix: {},
      summary: {},
      provenance: {},
      candidates: [{
        id: 'tune-macross-usdjpy-h1-v1',
        pair: 'USDJPY',
        entryType: 'maCross',
        timeframe: 'h1',
        status: 'passed',
        dataWindow: { validationSpanDays: 222.66666666666666 },
        warnings: [],
        provenance: {},
        rejectionReasons: [],
        combinations: [{}, {}, {}],
        selectedCandidate: { rank: 2, parameters: {}, validationMetrics: {} },
      }],
    };
    const source = { sourceSha256: createHash('sha256').update('x').digest('hex'), sourceBytes: 1 };

    expect(buildExtract(report, source)).toEqual(buildExtract(report, source));
    expect(buildExtract(report, source).candidates[0].combinationCount).toBe(3);
  });
});
