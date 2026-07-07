import * as vscode from "vscode";
import { decodePng, DecodedImage } from "./png";
import { Grid } from "./pietEditor";

// The same interpreter that powers the webview debugger, bundled into the host.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PietVM } = require("../media/interpreter.js") as { PietVM: any };

const WHITE = 0xffffff;
const BLACK = 0x000000;
const PALETTE: number[] = [WHITE, BLACK];
for (const [r, g, b] of [
  [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255],
] as const) {
  PALETTE.push(
    ((r || 192) << 16) | ((g || 192) << 8) | (b || 192),
    (r << 16) | (g << 8) | b,
    ((r && 192) << 16) | ((g && 192) << 8) | (b && 192)
  );
}

function nearestColor(c: number): number {
  if (PALETTE.includes(c)) {
    return c;
  }
  const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
  let best = WHITE, bestDist = Infinity;
  for (const p of PALETTE) {
    const dr = r - ((p >> 16) & 0xff), dg = g - ((p >> 8) & 0xff), db = b - (p & 0xff);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function detectCodelSize(px: number[], w: number, h: number): number {
  outer: for (let size = Math.min(w, h); size > 1; size--) {
    for (let cy = 0; cy < Math.floor(h / size); cy++) {
      for (let cx = 0; cx < Math.floor(w / size); cx++) {
        const color = px[cy * size * w + cx * size];
        for (let dy = 0; dy < size; dy++) {
          for (let dx = 0; dx < size; dx++) {
            if (px[(cy * size + dy) * w + cx * size + dx] !== color) {
              continue outer;
            }
          }
        }
      }
    }
    return size;
  }
  return 1;
}

/** Decode image bytes into a 1px-per-codel grid (colors snapped to the Piet palette). */
export function gridFromImage(bytes: Uint8Array, fileName: string): Grid {
  const img: DecodedImage = decodePng(bytes);
  const raw = img.pixels.map(nearestColor);
  const codel = fileName.toLowerCase().endsWith(".piet") ? 1 : detectCodelSize(raw, img.width, img.height);
  const w = Math.floor(img.width / codel);
  const h = Math.floor(img.height / codel);
  const half = Math.floor(codel / 2);
  const pixels = new Array<number>(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      pixels[y * w + x] = raw[(y * codel + half) * img.width + x * codel + half];
    }
  }
  return { width: w, height: h, pixels };
}

/** Runs a Piet program in an integrated-terminal tab with interactive input. */
export class PietRunTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closeEmitter.event;

  private vm: any;
  private running = false;
  private finished = false;
  private lineBuf = "";

  constructor(private readonly grid: Grid, private readonly name: string) {}

  open(): void {
    this.writeEmitter.fire(`\x1b[1mpiet\x1b[0m running ${this.name} (Ctrl+C to stop)\r\n`);
    this.vm = new PietVM(this.grid, "", true);
    this.running = true;
    this.pump();
  }

  close(): void {
    this.running = false;
  }

  private flushOutput(): void {
    if (this.vm.output) {
      this.writeEmitter.fire(this.vm.output.replace(/\n/g, "\r\n"));
      this.vm.output = "";
    }
  }

  private pump(): void {
    if (!this.running) {
      return;
    }
    // Cap both steps and output per tick: unthrottled, an output-heavy program
    // (e.g. an endless fibonacci printer) floods the terminal renderer with
    // tens of MB/s and freezes the window.
    let n = 0;
    while (
      this.running &&
      !this.vm.done &&
      !this.vm.needsInput &&
      n++ < 50000 &&
      this.vm.output.length < 4096
    ) {
      this.vm.step();
    }
    this.flushOutput();
    if (this.vm.done) {
      this.running = false;
      this.finished = true;
      this.writeEmitter.fire(
        `\r\n\x1b[90m${this.vm.status} after ${this.vm.steps.toLocaleString()} steps — press any key to close\x1b[0m\r\n`
      );
      return;
    }
    if (this.vm.needsInput) {
      return; // wait for handleInput to feed a line
    }
    setTimeout(() => this.pump(), 10);
  }

  handleInput(data: string): void {
    if (this.finished) {
      this.closeEmitter.fire(0);
      return;
    }
    if (data === "\x03") { // Ctrl+C
      this.writeEmitter.fire("^C\r\n");
      this.running = false;
      this.finished = true;
      this.closeEmitter.fire(0);
      return;
    }
    if (!this.vm?.needsInput) {
      return; // program is not asking for input
    }
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.writeEmitter.fire("\r\n");
        this.vm.input += this.lineBuf + "\n";
        this.lineBuf = "";
        this.vm.needsInput = null;
        this.pump();
      } else if (ch === "\x7f") { // backspace
        if (this.lineBuf) {
          this.lineBuf = this.lineBuf.slice(0, -1);
          this.writeEmitter.fire("\b \b");
        }
      } else if (ch >= " ") {
        this.lineBuf += ch;
        this.writeEmitter.fire(ch);
      }
    }
  }
}
