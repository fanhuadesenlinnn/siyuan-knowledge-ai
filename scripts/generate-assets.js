"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const crcTable = new Uint32Array(256);

for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writePng(file, width, height, paint) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = a;
  };
  const blend = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    const alpha = a / 255;
    pixels[offset] = Math.round(r * alpha + pixels[offset] * (1 - alpha));
    pixels[offset + 1] = Math.round(g * alpha + pixels[offset + 1] * (1 - alpha));
    pixels[offset + 2] = Math.round(b * alpha + pixels[offset + 2] * (1 - alpha));
    pixels[offset + 3] = 255;
  };
  paint({ width, height, set, blend });

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = rowStart + 1 + x * 4;
      raw[target] = pixels[source];
      raw[target + 1] = pixels[source + 1];
      raw[target + 2] = pixels[source + 2];
      raw[target + 3] = pixels[source + 3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(root, file), png);
}

function rect(api, x, y, w, h, color, alpha) {
  const [r, g, b] = color;
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) api.blend(xx, yy, r, g, b, alpha);
  }
}

function circle(api, cx, cy, radius, color, alpha) {
  const [r, g, b] = color;
  const rr = radius * radius;
  for (let y = Math.floor(cy - radius); y <= cy + radius; y += 1) {
    for (let x = Math.floor(cx - radius); x <= cx + radius; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= rr) api.blend(x, y, r, g, b, alpha);
    }
  }
}

function line(api, x1, y1, x2, y2, thickness, color, alpha) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps ? i / steps : 0;
    const x = Math.round(x1 + (x2 - x1) * t);
    const y = Math.round(y1 + (y2 - y1) * t);
    circle(api, x, y, thickness, color, alpha);
  }
}

writePng("icon.png", 160, 160, (api) => {
  for (let y = 0; y < api.height; y += 1) {
    for (let x = 0; x < api.width; x += 1) {
      const shade = Math.round(18 + y * 0.22);
      api.set(x, y, 18, 110 + Math.round(x * 0.18), 122 + shade, 255);
    }
  }
  circle(api, 80, 78, 48, [255, 255, 255], 34);
  line(api, 54, 88, 80, 58, 5, [255, 255, 255], 220);
  line(api, 80, 58, 108, 88, 5, [255, 255, 255], 220);
  line(api, 54, 88, 108, 88, 5, [255, 255, 255], 170);
  circle(api, 54, 88, 13, [255, 255, 255], 245);
  circle(api, 80, 58, 13, [255, 255, 255], 245);
  circle(api, 108, 88, 13, [255, 255, 255], 245);
  rect(api, 47, 116, 66, 8, [255, 255, 255], 220);
});

writePng("preview.png", 1024, 768, (api) => {
  rect(api, 0, 0, 1024, 768, [246, 248, 250], 255);
  rect(api, 0, 0, 1024, 54, [31, 42, 55], 255);
  rect(api, 0, 54, 292, 714, [236, 242, 246], 255);
  rect(api, 26, 82, 240, 46, [255, 255, 255], 255);
  rect(api, 26, 150, 240, 148, [255, 255, 255], 255);
  rect(api, 26, 318, 240, 132, [255, 255, 255], 255);
  rect(api, 322, 84, 662, 236, [255, 255, 255], 255);
  rect(api, 322, 342, 662, 162, [255, 255, 255], 255);
  rect(api, 322, 526, 662, 176, [255, 255, 255], 255);
  rect(api, 348, 132, 610, 96, [246, 248, 250], 255);
  rect(api, 348, 244, 112, 34, [25, 132, 122], 255);
  rect(api, 474, 244, 158, 34, [236, 242, 246], 255);
  rect(api, 348, 374, 470, 32, [246, 248, 250], 255);
  rect(api, 348, 420, 590, 52, [246, 248, 250], 255);
  rect(api, 348, 564, 260, 30, [246, 248, 250], 255);
  rect(api, 348, 608, 590, 58, [246, 248, 250], 255);
  circle(api, 52, 105, 16, [25, 132, 122], 255);
  line(api, 44, 110, 52, 96, 2, [255, 255, 255], 230);
  line(api, 52, 96, 64, 112, 2, [255, 255, 255], 230);
});
