import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const size = 1024;
const pixels = Buffer.alloc(size * size * 4);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function setPixel(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = (y * size + x) * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawSegment(ax, ay, bx, by, width, color) {
  const minX = Math.floor(Math.min(ax, bx) - width);
  const maxX = Math.ceil(Math.max(ax, bx) + width);
  const minY = Math.floor(Math.min(ay, by) - width);
  const maxY = Math.ceil(Math.max(ay, by) + width);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by) <= width / 2) setPixel(x, y, color);
    }
  }
}

for (let y = 88; y < 936; y += 1) {
  for (let x = 88; x < 936; x += 1) {
    if (!insideRoundedRect(x + 0.5, y + 0.5, 88, 88, 936, 936, 232)) continue;
    const t = Math.max(0, Math.min(1, ((x - 144) + (y - 96)) / 1472));
    setPixel(x, y, [Math.round(238 + (200 - 238) * t), Math.round(155 + (95 - 155) * t), Math.round(125 + (67 - 125) * t), 255]);
  }
}

const white = [255, 249, 245, 255];
drawSegment(390, 330, 238, 482, 70, white);
drawSegment(238, 482, 390, 634, 70, white);
drawSegment(634, 330, 786, 482, 70, white);
drawSegment(786, 482, 634, 634, 70, white);
drawSegment(572, 248, 452, 776, 62, white);

for (let y = 172; y <= 300; y += 1) {
  for (let x = 724; x <= 852; x += 1) {
    const distance = Math.hypot(x - 788, y - 236);
    if (distance <= 64) setPixel(x, y, distance >= 40 ? white : [116, 214, 164, 255]);
  }
}

const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) {
  const row = y * (size * 4 + 1);
  raw[row] = 0;
  pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(path.resolve("build", "icon.png"), png);
console.log(`Rendered build/icon.png (${size}x${size}, ${png.length} bytes)`);
