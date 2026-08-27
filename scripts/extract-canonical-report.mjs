// 正典チューニングレポート(reports/*.json, 実測69MB)は .gitignore 対象で1台の
// ローカルディスクにしか存在しない。一方 docs/ea-selection-log.md の
// 「事前登録の判定プロトコル(2026-08-19固定)」は、2027-02-15 以降の再現判定を
// この特定IDのレポートの値で行うと定め、他のランでの補完を明示的に禁じている。
// レポートを失うと判定が実行不能になるため、判定に必要な部分だけを抽出して
// リポジトリに固定する。巨大な combinations 配列は件数(順位の分母)だけ残す。
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export const CANONICAL_REPORT_ID = 'tune-virtual-strategies-2026-08-18T22-32-23-991Z';
export const extractPath = path.join(
  projectRoot,
  'evidence',
  `${CANONICAL_REPORT_ID}.selected.json`,
);

export const buildExtract = (report, { sourceSha256, sourceBytes }) => ({
  schemaVersion: 1,
  note: '正典レポートから再現判定に必要な部分のみを抽出したもの。数値は逐語コピーで丸めない。',
  source: {
    reportId: CANONICAL_REPORT_ID,
    generatedAt: report.generatedAt,
    schemaVersion: report.schemaVersion,
    sha256: sourceSha256,
    bytes: sourceBytes,
  },
  selectionPolicy: report.selectionPolicy,
  filters: report.filters,
  matrix: report.matrix,
  summary: report.summary,
  provenance: report.provenance,
  candidates: report.candidates.map((candidate) => ({
    id: candidate.id,
    pair: candidate.pair,
    entryType: candidate.entryType,
    timeframe: candidate.timeframe,
    status: candidate.status,
    dataWindow: candidate.dataWindow,
    warnings: candidate.warnings,
    provenance: candidate.provenance,
    rejectionReasons: candidate.rejectionReasons,
    // 順位の分母は候補ごとの評価組合せ数。combinations 本体は落とすが件数は残す。
    combinationCount: Array.isArray(candidate.combinations) ? candidate.combinations.length : null,
    selectedCandidate: candidate.selectedCandidate,
  })),
});

const main = async () => {
  const sourcePath = process.argv[2]
    ?? path.join(projectRoot, 'reports', `${CANONICAL_REPORT_ID}.json`);
  const raw = await readFile(sourcePath);
  const sourceSha256 = createHash('sha256').update(raw).digest('hex');
  const report = JSON.parse(raw.toString('utf8'));

  if (report.generatedAt !== '2026-08-18T22:32:23.991Z') {
    throw new Error(
      `Refusing to extract: generatedAt ${report.generatedAt} is not the canonical report.`,
    );
  }

  const extract = buildExtract(report, { sourceSha256, sourceBytes: raw.length });
  await mkdir(path.dirname(extractPath), { recursive: true });
  await writeFile(extractPath, `${JSON.stringify(extract, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${extractPath} (${extract.candidates.length} candidates, ` +
      `source sha256=${sourceSha256.slice(0, 12)}…, ${(raw.length / 1024 / 1024).toFixed(0)}MB source).`,
  );
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
