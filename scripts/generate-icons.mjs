import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const colors = {
  background: [0x13, 0x17, 0x22, 0xff],
  green: [0x22, 0xc5, 0x5e, 0xff],
  red: [0xef, 0x44, 0x44, 0xff],
  line: [0x7d, 0xff, 0xb2, 0xff],
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
};

const createChunk = (type, data) => {
  const typeBuffer = Buffer.from(type, 'ascii');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
};

const setPixel = (pixels, size, x, y, color) => {
  if (x < 0 || y < 0 || x >= size || y >= size) {
    return;
  }
  const offset = (y * size + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
};

const fillRect = (pixels, size, x, y, width, height, color) => {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(size, Math.ceil(x + width));
  const bottom = Math.min(size, Math.ceil(y + height));

  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      setPixel(pixels, size, column, row, color);
    }
  }
};

const drawCircle = (pixels, size, centerX, centerY, radius, color) => {
  const minX = Math.floor(centerX - radius);
  const maxX = Math.ceil(centerX + radius);
  const minY = Math.floor(centerY - radius);
  const maxY = Math.ceil(centerY + radius);
  const radiusSquared = radius * radius;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radiusSquared) {
        setPixel(pixels, size, x, y, color);
      }
    }
  }
};

const drawLine = (pixels, size, startX, startY, endX, endY, thickness, color) => {
  const dx = endX - startX;
  const dy = endY - startY;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);

  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    drawCircle(pixels, size, startX + dx * t, startY + dy * t, thickness / 2, color);
  }
};

const drawPolyline = (pixels, size, points, thickness, color) => {
  for (let index = 1; index < points.length; index += 1) {
    const [startX, startY] = points[index - 1];
    const [endX, endY] = points[index];
    drawLine(pixels, size, startX, startY, endX, endY, thickness, color);
  }
};

const createIconPixels = (size) => {
  const pixels = new Uint8Array(size * size * 4);

  for (let index = 0; index < size * size; index += 1) {
    const offset = index * 4;
    pixels[offset] = colors.background[0];
    pixels[offset + 1] = colors.background[1];
    pixels[offset + 2] = colors.background[2];
    pixels[offset + 3] = colors.background[3];
  }

  const scale = size / 512;
  const candleWidth = 74 * scale;
  const wickWidth = Math.max(3, Math.round(9 * scale));
  const lineThickness = Math.max(5, Math.round(18 * scale));

  const greenCenter = 196 * scale;
  const redCenter = 316 * scale;

  fillRect(pixels, size, greenCenter - wickWidth / 2, 158 * scale, wickWidth, 244 * scale, colors.green);
  fillRect(pixels, size, greenCenter - candleWidth / 2, 238 * scale, candleWidth, 116 * scale, colors.green);

  fillRect(pixels, size, redCenter - wickWidth / 2, 112 * scale, wickWidth, 244 * scale, colors.red);
  fillRect(pixels, size, redCenter - candleWidth / 2, 164 * scale, candleWidth, 138 * scale, colors.red);

  drawPolyline(
    pixels,
    size,
    [
      [112 * scale, 344 * scale],
      [184 * scale, 286 * scale],
      [248 * scale, 304 * scale],
      [330 * scale, 198 * scale],
      [414 * scale, 136 * scale],
    ],
    lineThickness,
    colors.line,
  );

  return pixels;
};

const encodePng = (size) => {
  const pixels = createIconPixels(size);
  const rowLength = size * 4 + 1;
  const scanlines = Buffer.alloc(rowLength * size);

  for (let row = 0; row < size; row += 1) {
    const rowStart = row * rowLength;
    scanlines[rowStart] = 0;
    Buffer.from(pixels.subarray(row * size * 4, (row + 1) * size * 4)).copy(scanlines, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    pngSignature,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    createChunk('IEND', Buffer.alloc(0)),
  ]);
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="FXチャート分析">
  <rect width="512" height="512" fill="#131722"/>
  <rect x="191.5" y="158" width="9" height="244" rx="4.5" fill="#22c55e"/>
  <rect x="159" y="238" width="74" height="116" rx="10" fill="#22c55e"/>
  <rect x="311.5" y="112" width="9" height="244" rx="4.5" fill="#ef4444"/>
  <rect x="279" y="164" width="74" height="138" rx="10" fill="#ef4444"/>
  <path d="M112 344L184 286L248 304L330 198L414 136" fill="none" stroke="#7dffb2" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const outputs = [
  ['public/icons/icon-192.png', encodePng(192)],
  ['public/icons/icon-512.png', encodePng(512)],
  ['public/icons/icon.svg', svg],
];

for (const [filePath, content] of outputs) {
  const absolutePath = resolve(filePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  console.log(`Wrote ${filePath}`);
}
