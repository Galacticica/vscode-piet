import * as zlib from "zlib";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export interface DecodedImage {
  width: number;
  height: number;
  pixels: number[]; // 24-bit RGB ints, row-major
}

/**
 * Decode a PNG into an RGB pixel grid. Supports the flavors Piet files are
 * found in: 8-bit grayscale/RGB/RGBA and palette images at bit depth 1/2/4/8,
 * all filter types, no interlacing. Alpha is ignored.
 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) {
    throw new Error("not a PNG file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 2;
  let palette: number[] = [];
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) {
        throw new Error("interlaced PNGs are not supported");
      }
    } else if (type === "PLTE") {
      palette = [];
      for (let i = 0; i + 2 < data.length; i += 3) {
        palette.push((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || (colorType !== 3 && bitDepth !== 8) || ![1, 2, 4, 8].includes(bitDepth)) {
    throw new Error(`unsupported PNG format (color type ${colorType}, bit depth ${bitDepth})`);
  }
  const raw = new Uint8Array(zlib.inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d)))));
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  // undo per-scanline filters in place
  const lines = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const src = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const out = lines.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? lines.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let value = src[i];
      if (filter === 1) {
        value += a;
      } else if (filter === 2) {
        value += b;
      } else if (filter === 3) {
        value += (a + b) >> 1;
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter ${filter}`);
      }
      out[i] = value & 0xff;
    }
  }
  const pixels = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    const row = lines.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      let rgb: number;
      if (colorType === 3 || (colorType === 0 && bitDepth < 8)) {
        const bitPos = x * bitDepth;
        const sample = (row[bitPos >> 3] >> (8 - bitDepth - (bitPos & 7))) & ((1 << bitDepth) - 1);
        if (colorType === 3) {
          rgb = palette[sample] ?? 0;
        } else {
          const v = Math.round((sample * 255) / ((1 << bitDepth) - 1));
          rgb = (v << 16) | (v << 8) | v;
        }
      } else if (colorType === 0 || colorType === 4) {
        const v = row[x * channels];
        rgb = (v << 16) | (v << 8) | v;
      } else {
        const i = x * channels;
        rgb = (row[i] << 16) | (row[i + 1] << 8) | row[i + 2];
      }
      pixels[y * width + x] = rgb;
    }
  }
  return { width, height, pixels };
}

/**
 * Encode an RGB pixel grid as a PNG. `pixels` holds 24-bit ints, row-major.
 * `scale` repeats each pixel into a scale x scale square (codel size).
 */
export function encodePng(width: number, height: number, pixels: number[], scale = 1): Uint8Array {
  const w = width * scale;
  const h = height * scale;
  const raw = new Uint8Array(h * (1 + w * 3));
  let off = 0;
  for (let y = 0; y < h; y++) {
    raw[off++] = 0; // filter type: none
    const srcRow = Math.floor(y / scale) * width;
    for (let x = 0; x < w; x++) {
      const rgb = pixels[srcRow + Math.floor(x / scale)];
      raw[off++] = (rgb >> 16) & 0xff;
      raw[off++] = (rgb >> 8) & 0xff;
      raw[off++] = rgb & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(zlib.deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    png.set(part, pos);
    pos += part.length;
  }
  return png;
}
