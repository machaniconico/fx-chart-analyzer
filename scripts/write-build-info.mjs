// update-data.yml は永続化ゲート(check-data-freshness.mjs)より前にデプロイする。
// 障害時にサイトが更新され続ける利点がある一方、main に入らなかったデータが公開され
// うる(2026-08-20〜08-27 に実際に起きた: サイトは毎日更新されたが main は 08-19 で凍結)。
// どのコミット・どの run から出たビルドかを成果物自身に持たせ、公開物と履歴の乖離を
// 後から確認できるようにする。ビルドごとに変わるため .gitignore 対象。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const outputPath = resolve('public/data/build-info.json');

const gitHeadSha = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

export const buildInfo = (env = process.env, { headSha = gitHeadSha(), builtAt } = {}) => ({
  schemaVersion: 1,
  builtAt: builtAt ?? new Date().toISOString(),
  // GITHUB_SHA はワークフローが起動した ref の SHA。headSha は実際にビルドした作業ツリーの
  // HEAD。日次データ更新では作業ツリーに未コミットのデータ差分が乗るため、この2つが同じでも
  // 「公開された内容がそのコミットに含まれる」ことは意味しない。dataDirty がその印。
  commitSha: env.GITHUB_SHA ?? headSha,
  headSha,
  ref: env.GITHUB_REF ?? null,
  runId: env.GITHUB_RUN_ID ?? null,
  runUrl: env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : null,
  // このビルドが「まだコミットされていないデータ」を含むか。true の間は、公開されている
  // 数値が git 履歴のどこにも存在しない可能性がある。
  dataDirty: env.DATA_CHANGED === 'true',
});

const main = async () => {
  const info = buildInfo();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote build info: commit=${info.commitSha ?? 'unknown'} dataDirty=${info.dataDirty} -> ${outputPath}`,
  );
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
