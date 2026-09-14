import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_REPORT_ID,
  buildExtract,
  extractPath,
  parseCliArgs,
} from './extract-canonical-report.mjs';
import { loadObservationStrategies } from './run-forward-test.mjs';

// 観察レーンの登録元レポートは正典1本ではない(state型2候補群は2026-09-14の別ラン)。
// 各抽出物は evidence/<reportId>.selected.json に固定する。
const STATE_ENTRY_EXTRACTS = [
  {
    reportId: 'tune-virtual-strategies-2026-09-14T06-03-31-827Z',
    generatedAt: '2026-09-14T06:03:31.827Z',
    sha256: 'ee82a109bcb6881e1e1d3d8b335a2eae471fbf0ef64b911ad2db06fc1d250bb6',
  },
  {
    reportId: 'tune-virtual-strategies-2026-09-14T06-03-32-877Z',
    generatedAt: '2026-09-14T06:03:32.877Z',
    sha256: '5fb15299eae566df8cf42768a42d4be9d74136c08be232aea5a1d87b0679877b',
  },
];
const STATE_ENTRY_REPORT_IDS = STATE_ENTRY_EXTRACTS.map((item) => item.reportId);

const extractPathFor = (reportId) => (reportId === CANONICAL_REPORT_ID
  ? extractPath
  : new URL(`../evidence/${reportId}.selected.json`, import.meta.url).pathname);

const readExtract = async (reportId = CANONICAL_REPORT_ID) => JSON.parse(
  await readFile(extractPathFor(reportId), 'utf8'),
);

// 登録済み戦略と抽出物側の候補行の対応。IDの綴りではなく、戦略が自ら宣言した
// reportId と (entryType, pair, timeframe) の三つ組で引く。
const loadObservationCandidatePairs = async () => {
  const observations = await loadObservationStrategies();
  const extracts = new Map();
  const pairs = [];
  for (const strategy of observations) {
    const { reportId } = strategy.selectionEvidence;
    if (!extracts.has(reportId)) {
      extracts.set(reportId, await readExtract(reportId));
    }
    const candidate = extracts.get(reportId).candidates.find((item) => (
      item.entryType === strategy.entryConditions[0].type
      && item.pair === strategy.meta.pair
      && item.timeframe === strategy.meta.timeframe
    ));
    pairs.push({ strategy, candidate });
  }
  return pairs;
};

describe('canonical report extract', () => {
  it('pins the canonical report identity so a re-run cannot silently replace it', async () => {
    const extract = await readExtract();

    expect(extract.source.reportId).toBe(CANONICAL_REPORT_ID);
    expect(extract.source.generatedAt).toBe('2026-08-18T22:32:23.991Z');
    expect(extract.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extract.source.bytes).toBeGreaterThan(0);
  });

  it('pins the 2026-09-14 state-entry report identities the same way', async () => {
    for (const { reportId, generatedAt, sha256 } of STATE_ENTRY_EXTRACTS) {
      const extract = await readExtract(reportId);

      expect(extract.source.reportId).toBe(reportId);
      expect(extract.source.generatedAt).toBe(generatedAt);
      expect(extract.source.sha256).toBe(sha256);
      expect(extract.source.bytes).toBeGreaterThan(0);
      expect(extract.candidates).toHaveLength(12);
    }
  });

  it('carries every judgment input the 2027-02-15 protocol reads', async () => {
    const pairs = await loadObservationCandidatePairs();

    expect(pairs.length).toBeGreaterThan(0);
    for (const { strategy, candidate } of pairs) {
      expect(candidate, `no extracted candidate for ${strategy.meta.id}`).toBeDefined();
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
      expect(strategy.selectionEvidence.candidatePool).toBe(candidate.combinationCount);
      expect(strategy.selectionEvidence.inSampleRank).toBe(candidate.selectedCandidate.rank);
    }
  });

  it('agrees with the registered strategy definitions on the exit parameters', async () => {
    for (const { strategy, candidate } of await loadObservationCandidatePairs()) {
      const { parameters } = candidate.selectedCandidate;
      expect(parameters.stopLossPips).toBe(strategy.exit.stopLossPips);
      expect(parameters.takeProfitPips).toBe(strategy.exit.takeProfitPips);
      expect(parameters.trailingStopPips ?? null).toBe(strategy.exit.trailingStopPips ?? null);
      // 0は省略と等価。省略側を0として突き合わせる。
      expect(parameters.reentryCooldownBars ?? 0).toBe(strategy.exit.reentryCooldownBars ?? 0);
    }
  });

  it('drops the combinations payload but keeps its count', async () => {
    for (const reportId of [CANONICAL_REPORT_ID, ...STATE_ENTRY_REPORT_IDS]) {
      const extract = await readExtract(reportId);

      expect(extract.candidates.every((candidate) => !('combinations' in candidate))).toBe(true);
      expect(extract.candidates.every((candidate) => candidate.combinationCount === null
        || Number.isInteger(candidate.combinationCount))).toBe(true);
    }
  });

  it('defaults to the canonical report and honours --report/--out', () => {
    const defaults = parseCliArgs([]);

    expect(path.basename(defaults.sourcePath)).toBe(`${CANONICAL_REPORT_ID}.json`);
    expect(defaults.reportId).toBe(CANONICAL_REPORT_ID);
    expect(defaults.outPath).toBe(extractPath);

    const overridden = parseCliArgs([
      '--report',
      `reports/${STATE_ENTRY_REPORT_IDS[0]}.json`,
    ]);

    expect(overridden.reportId).toBe(STATE_ENTRY_REPORT_IDS[0]);
    expect(path.basename(overridden.outPath)).toBe(`${STATE_ENTRY_REPORT_IDS[0]}.selected.json`);
    expect(parseCliArgs(['--report', 'a/b.json', '--out', 'c/d.json']).outPath).toBe('c/d.json');
    expect(() => parseCliArgs(['--report'])).toThrow('Missing value for --report');
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
    expect(buildExtract(report, source).source.reportId).toBe(CANONICAL_REPORT_ID);
    expect(buildExtract(report, { ...source, reportId: 'other-report' }).source.reportId)
      .toBe('other-report');
  });
});
