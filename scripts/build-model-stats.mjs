import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAdaptiveStats, defaultPredictionHorizons } from '../src/lib/adaptive-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataRoot = path.resolve(__dirname, '../public/data');
const statsRoot = path.join(dataRoot, 'stats');
const timeframes = ['h1', 'h4', 'd1'];

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const main = async () => {
  const entries = await readdir(dataRoot, { withFileTypes: true });
  const pairs = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'stats')
    .map((entry) => entry.name)
    .sort();

  let generated = 0;
  for (const pair of pairs) {
    for (const tf of timeframes) {
      const sourcePath = path.join(dataRoot, pair, `${tf}.json`);
      const payload = await readJson(sourcePath);
      const stats = {
        pair: payload.pair ?? pair,
        tf: payload.tf ?? tf,
        sourceUpdatedAt: payload.updatedAt,
        ...buildAdaptiveStats(payload.bars, defaultPredictionHorizons),
      };
      const targetDir = path.join(statsRoot, pair);
      await mkdir(targetDir, { recursive: true });
      await writeFile(path.join(targetDir, `${tf}.json`), `${JSON.stringify(stats, null, 2)}\n`);
      generated += 1;
    }
  }

  console.log(`Generated ${generated} adaptive model stats files in ${path.relative(process.cwd(), statsRoot)}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
