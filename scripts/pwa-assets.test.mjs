import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const readPngSize = (buffer) => ({
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

describe('PWA assets', () => {
  it.each([
    ['public/icons/icon-192.png', 192],
    ['public/icons/icon-512.png', 512],
  ])('%s is a valid PNG with the expected size', async (filePath, size) => {
    const buffer = await readFile(filePath);

    expect([...buffer.subarray(0, pngSignature.length)]).toEqual(pngSignature);
    expect(readPngSize(buffer)).toEqual({ width: size, height: size });
  });

  it('has a valid web manifest with required PWA fields', async () => {
    const manifest = JSON.parse(await readFile('public/manifest.webmanifest', 'utf8'));

    expect(manifest).toMatchObject({
      name: 'FXチャート分析',
      short_name: 'FX分析',
      display: 'standalone',
      theme_color: '#131722',
      background_color: '#131722',
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }),
        expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }),
        expect.objectContaining({ src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }),
      ]),
    );
  });
});
