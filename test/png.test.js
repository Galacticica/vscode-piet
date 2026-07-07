const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { encodePng, decodePng } = require("../out-test/png.cjs");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));
const expected = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `${name}.expected.json`), "utf8"));

test("encode/decode round trip at scale 1", () => {
  const width = 21, height = 13;
  const pixels = Array.from({ length: width * height }, (_, i) => (i * 2654435761) & 0xffffff);
  const decoded = decodePng(encodePng(width, height, pixels));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(decoded.pixels, pixels);
});

test("encode at scale N repeats each pixel into an NxN square", () => {
  const pixels = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff];
  const decoded = decodePng(encodePng(2, 2, pixels, 3));
  assert.equal(decoded.width, 6);
  assert.equal(decoded.height, 6);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      const src = pixels[Math.floor(y / 3) * 2 + Math.floor(x / 3)];
      assert.equal(decoded.pixels[y * 6 + x], src, `pixel (${x},${y})`);
    }
  }
});

// Pillow-generated fixtures with pixel data recorded from Pillow itself
for (const name of ["rgb_gradient.png", "palette8.png", "palette4.png", "gray8.png"]) {
  test(`decodes ${name} identically to Pillow`, () => {
    const truth = expected(name);
    const decoded = decodePng(fixture(name));
    assert.equal(decoded.width, truth.width);
    assert.equal(decoded.height, truth.height);
    assert.deepEqual(decoded.pixels, truth.pixels);
  });
}

test("rejects non-PNG bytes", () => {
  assert.throws(() => decodePng(Buffer.from("GIF89a not a png")), /not a PNG/);
});

test("rejects interlaced PNGs with a clear error", () => {
  const bytes = Buffer.from(encodePng(4, 4, new Array(16).fill(0xffffff)));
  bytes[28] = 1; // IHDR interlace flag (CRC is not validated, so this is enough)
  assert.throws(() => decodePng(bytes), /interlaced/);
});
