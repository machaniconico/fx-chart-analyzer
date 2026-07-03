import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

export const loadEsbuild = () => {
  const require = createRequire(import.meta.url);
  const candidates = [
    'esbuild',
    path.join(projectRoot, 'node_modules/vitest/node_modules/esbuild/lib/main.js'),
    path.join(projectRoot, 'node_modules/vite-node/node_modules/esbuild/lib/main.js'),
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const resolvedPath = require.resolve(candidate);
      const esbuild = require(resolvedPath);
      console.log(`Using esbuild from ${resolvedPath}`);
      return esbuild;
    } catch (error) {
      errors.push(`${candidate}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(`esbuild を読み込めませんでした。\n${errors.join('\n')}`);
};
