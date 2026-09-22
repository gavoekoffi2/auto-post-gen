#!/usr/bin/env node
//
// Renders public/og-image.svg to public/og-image.png at exactly 1200x630.
//
// Why a PNG at all: Facebook, LinkedIn, WhatsApp and X all ignore an SVG
// og:image. The site shipped only an SVG, so every share of the link showed no
// preview — on a product whose entire promise is social media. Edit the SVG,
// run this, commit both.
//
// Uses the Chromium that Playwright installs (PLAYWRIGHT_BROWSERS_PATH), with
// no extra dependency. Chromium's --window-size includes browser chrome, so we
// render taller than needed and crop the top 630 rows back off.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1200;
const HEIGHT = 630;
// Extra height to absorb the non-content part of the Chromium window.
const CHROME_OVERHEAD = 120;

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(base)) return null;
  for (const entry of readdirSync(base)) {
    if (!entry.startsWith("chromium-")) continue;
    const candidate = join(base, entry, "chrome-linux", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// --- Minimal PNG crop (8-bit RGB/RGBA, non-interlaced) ---------------------

function readPng(path) {
  const data = readFileSync(path);
  let pos = 8;
  let header = null;
  const idat = [];
  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString("ascii");
    const body = data.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9] };
    } else if (type === "IDAT") {
      idat.push(body);
    }
    pos += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");
  if (header.depth !== 8) throw new Error(`Unsupported bit depth ${header.depth}`);
  return { header, raw: inflateSync(Buffer.concat(idat)) };
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++];
    const line = Buffer.from(raw.subarray(offset, offset + stride));
    offset += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return out;
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), body]);
  out.writeInt32BE(crc32(crcInput), body.length + 8);
  return out;
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function writePng(path, width, height, colorType, bpp, pixels) {
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// --- Main -------------------------------------------------------------------

const chromium = findChromium();
if (!chromium) {
  console.error(
    "Chromium not found. Set PLAYWRIGHT_BROWSERS_PATH, or regenerate the PNG\n" +
      "elsewhere and commit it — public/og-image.png must stay 1200x630.",
  );
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "og-"));
const svg = readFileSync(join(ROOT, "public/og-image.svg"), "utf8");
writeFileSync(
  join(work, "og.svg"),
  svg.replace("<svg ", `<svg width="${WIDTH}" height="${HEIGHT}" `),
);
writeFileSync(
  join(work, "og.html"),
  `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}` +
    `html,body{background:#0F172A}img{display:block;width:${WIDTH}px;height:${HEIGHT}px}` +
    `</style></head><body><img src="og.svg"></body></html>`,
);

const shot = join(work, "shot.png");
execFileSync(
  chromium,
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${WIDTH},${HEIGHT + CHROME_OVERHEAD}`,
    `--screenshot=${shot}`,
    `file://${join(work, "og.html")}`,
  ],
  { stdio: "ignore" },
);

const { header, raw } = readPng(shot);
const bpp = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : null;
if (!bpp) throw new Error(`Unsupported colour type ${header.colorType}`);
if (header.width !== WIDTH || header.height < HEIGHT) {
  throw new Error(`Unexpected screenshot size ${header.width}x${header.height}`);
}
const pixels = unfilter(raw, header.width, header.height, bpp);
const out = join(ROOT, "public/og-image.png");
writePng(out, WIDTH, HEIGHT, header.colorType, bpp, pixels.subarray(0, WIDTH * bpp * HEIGHT));
console.log(`Wrote public/og-image.png (${WIDTH}x${HEIGHT}).`);
