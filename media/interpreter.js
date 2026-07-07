// Piet virtual machine — a faithful port of piet/piet.py, usable from the
// editor webview (globalThis.PietVM) and from Node for testing (module.exports).
// Stack values are BigInt so arithmetic matches Python's unbounded ints.
(function () {
  "use strict";

  const WHITE = 0xffffff;
  const BLACK = 0x000000;
  const DP_VEC = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // right, down, left, up

  const COMMANDS = [
    ["none", "push", "pop"],
    ["add", "subtract", "multiply"],
    ["divide", "mod", "not"],
    ["greater", "pointer", "switch"],
    ["duplicate", "roll", "in(num)"],
    ["in(char)", "out(num)", "out(char)"],
  ];

  const COLOR_INFO = new Map(); // rgb int -> {hue, light}
  const HUES = [
    [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255],
  ];
  HUES.forEach(([r, g, b], hue) => {
    const shades = [
      ((r || 192) << 16) | ((g || 192) << 8) | (b || 192),
      (r << 16) | (g << 8) | b,
      ((r && 192) << 16) | ((g && 192) << 8) | (b && 192),
    ];
    shades.forEach((c, light) => COLOR_INFO.set(c, { hue, light }));
  });

  const pmod = (a, b) => ((a % b) + b) % b;

  class PietVM {
    /**
     * grid: {width, height, pixels: number[]} at one pixel per codel.
     * With interactive=true, an input command finding the buffer empty sets
     * vm.needsInput instead of being ignored; append to vm.input, clear
     * needsInput, and step again to resume.
     */
    constructor(grid, input = "", interactive = false) {
      this.w = grid.width;
      this.h = grid.height;
      this.px = grid.pixels;
      this.input = input;
      this.inputPos = 0;
      this.interactive = interactive;
      this.needsInput = null;
      this.stack = []; // BigInt values, last element = top
      this.output = "";
      this.x = 0;
      this.y = 0;
      this.dp = 0;
      this.cc = 0;
      this.steps = 0;
      this.done = false;
      this.status = "ready";
      this.lastCommand = null;
      this.labelBlocks();
      if (this.colorAt(0, 0) === BLACK) {
        this.done = true;
        this.status = "error: top-left codel is black";
      }
    }

    colorAt(x, y) {
      return this.px[y * this.w + x];
    }

    inside(x, y) {
      return x >= 0 && x < this.w && y >= 0 && y < this.h;
    }

    labelBlocks() {
      this.blockId = new Int32Array(this.w * this.h).fill(-1);
      this.blockCells = [];
      for (let i = 0; i < this.w * this.h; i++) {
        if (this.blockId[i] !== -1) {
          continue;
        }
        const color = this.px[i];
        const id = this.blockCells.length;
        const cells = [];
        const todo = [i];
        this.blockId[i] = id;
        while (todo.length) {
          const j = todo.pop();
          const cx = j % this.w;
          const cy = Math.floor(j / this.w);
          cells.push([cx, cy]);
          for (const [dx, dy] of DP_VEC) {
            const nx = cx + dx;
            const ny = cy + dy;
            const k = ny * this.w + nx;
            if (this.inside(nx, ny) && this.blockId[k] === -1 && this.px[k] === color) {
              this.blockId[k] = id;
              todo.push(k);
            }
          }
        }
        this.blockCells.push(cells);
      }
    }

    currentBlockCells() {
      const color = this.colorAt(this.x, this.y);
      if (color === WHITE || color === BLACK) {
        return [[this.x, this.y]];
      }
      return this.blockCells[this.blockId[this.y * this.w + this.x]];
    }

    exitCodel() {
      const cells = this.blockCells[this.blockId[this.y * this.w + this.x]];
      const [dx, dy] = DP_VEC[this.dp];
      let best = -Infinity;
      for (const [cx, cy] of cells) {
        best = Math.max(best, cx * dx + cy * dy);
      }
      const edge = cells.filter(([cx, cy]) => cx * dx + cy * dy === best);
      const [cdx, cdy] = DP_VEC[(this.dp + (this.cc === 0 ? 3 : 1)) % 4];
      let bestCell = edge[0];
      let bestVal = -Infinity;
      for (const cell of edge) {
        const v = cell[0] * cdx + cell[1] * cdy;
        if (v > bestVal) {
          bestVal = v;
          bestCell = cell;
        }
      }
      return bestCell;
    }

    /** Execute one transition (or one white slide). Mirrors one iteration of piet.py's run loop. */
    step() {
      if (this.done || this.needsInput) {
        return;
      }
      this.steps++;
      if (this.colorAt(this.x, this.y) === WHITE) {
        const moved = this.slideWhite();
        if (!moved) {
          this.done = true;
          this.status = "finished (trapped in white)";
          return;
        }
        [this.x, this.y] = moved;
        this.lastCommand = "slide";
        return;
      }
      let nx = 0;
      let ny = 0;
      let found = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const [ex, ey] = this.exitCodel();
        nx = ex + DP_VEC[this.dp][0];
        ny = ey + DP_VEC[this.dp][1];
        if (this.inside(nx, ny) && this.colorAt(nx, ny) !== BLACK) {
          found = true;
          break;
        }
        if (attempt % 2 === 0) {
          this.cc ^= 1;
        } else {
          this.dp = (this.dp + 1) % 4;
        }
      }
      if (!found) {
        this.done = true;
        this.status = "finished";
        return;
      }
      if (this.colorAt(nx, ny) === WHITE) {
        this.lastCommand = "none (into white)";
        this.x = nx;
        this.y = ny;
        return;
      }
      const name = this.commandFor(this.colorAt(this.x, this.y), this.colorAt(nx, ny));
      if (
        this.interactive &&
        (name === "in(num)" || name === "in(char)") &&
        !this.hasInputFor(name)
      ) {
        this.needsInput = name;
        this.steps--; // the transition has not happened yet
        return;
      }
      const blockSize = this.blockCells[this.blockId[this.y * this.w + this.x]].length;
      this.doCommand(name, blockSize);
      this.x = nx;
      this.y = ny;
    }

    commandFor(from, to) {
      const a = COLOR_INFO.get(from);
      const b = COLOR_INFO.get(to);
      return COMMANDS[pmod(b.hue - a.hue, 6)][pmod(b.light - a.light, 3)];
    }

    hasInputFor(name) {
      if (name === "in(char)") {
        return this.inputPos < this.input.length;
      }
      return /\S/.test(this.input.slice(this.inputPos));
    }

    slideWhite() {
      const seen = new Set();
      let [x, y] = [this.x, this.y];
      while (true) {
        const state = `${x},${y},${this.dp},${this.cc}`;
        if (seen.has(state)) {
          return null;
        }
        seen.add(state);
        const nx = x + DP_VEC[this.dp][0];
        const ny = y + DP_VEC[this.dp][1];
        if (!this.inside(nx, ny) || this.colorAt(nx, ny) === BLACK) {
          this.cc ^= 1;
          this.dp = (this.dp + 1) % 4;
          continue;
        }
        x = nx;
        y = ny;
        if (this.colorAt(x, y) !== WHITE) {
          return [x, y];
        }
      }
    }

    doCommand(name, blockSize) {
      this.lastCommand = name;
      const s = this.stack;
      switch (name) {
        case "push":
          s.push(BigInt(blockSize));
          break;
        case "pop":
          if (s.length) {
            s.pop();
          }
          break;
        case "add":
        case "subtract":
        case "multiply":
        case "divide":
        case "mod":
        case "greater": {
          if (s.length < 2) {
            break;
          }
          const y = s.pop();
          const x = s.pop();
          if (name === "add") {
            s.push(x + y);
          } else if (name === "subtract") {
            s.push(x - y);
          } else if (name === "multiply") {
            s.push(x * y);
          } else if (name === "divide") {
            if (y === 0n) {
              s.push(x, y); // ignore division by zero
            } else {
              s.push(x / y); // BigInt division truncates toward zero, like piet.py
            }
          } else if (name === "mod") {
            if (y === 0n) {
              s.push(x, y);
            } else {
              s.push(((x % y) + y) % y); // result takes the divisor's sign
            }
          } else {
            s.push(x > y ? 1n : 0n);
          }
          break;
        }
        case "not":
          if (s.length) {
            s.push(s.pop() === 0n ? 1n : 0n);
          }
          break;
        case "pointer":
          if (s.length) {
            this.dp = (this.dp + Number(pmod(s.pop(), 4n))) % 4;
          }
          break;
        case "switch":
          if (s.length) {
            this.cc ^= Number(pmod(s.pop(), 2n));
          }
          break;
        case "duplicate":
          if (s.length) {
            s.push(s[s.length - 1]);
          }
          break;
        case "roll": {
          if (s.length < 2) {
            break;
          }
          const rollsBig = s.pop();
          const depthBig = s.pop();
          const depth = Number(depthBig);
          if (depthBig < 0n || depth > s.length) {
            s.push(depthBig, rollsBig); // ignore invalid roll
          } else if (depth > 0) {
            const rolls = Number(pmod(rollsBig, depthBig));
            if (rolls) {
              const top = s.splice(s.length - depth, depth);
              s.push(...top.slice(depth - rolls), ...top.slice(0, depth - rolls));
            }
          }
          break;
        }
        case "in(num)": {
          const value = this.readNumberToken();
          if (value !== null) {
            s.push(value);
          }
          break;
        }
        case "in(char)": {
          if (this.inputPos < this.input.length) {
            const code = this.input.codePointAt(this.inputPos);
            this.inputPos += String.fromCodePoint(code).length;
            s.push(BigInt(code));
          }
          break;
        }
        case "out(num)":
          if (s.length) {
            this.output += s.pop().toString();
          }
          break;
        case "out(char)":
          if (s.length) {
            const v = s.pop();
            if (v >= 0n && v <= 0x10ffffn) {
              this.output += String.fromCodePoint(Number(v)); // out of range: ignored
            }
          }
          break;
      }
    }

    readNumberToken() {
      while (this.inputPos < this.input.length && /\s/.test(this.input[this.inputPos])) {
        this.inputPos++;
      }
      let token = "";
      while (this.inputPos < this.input.length && !/\s/.test(this.input[this.inputPos])) {
        token += this.input[this.inputPos++];
      }
      try {
        return token ? BigInt(token) : null;
      } catch {
        return null;
      }
    }
  }

  PietVM.WHITE = WHITE;
  PietVM.BLACK = BLACK;
  PietVM.COMMANDS = COMMANDS;
  globalThis.PietVM = PietVM;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PietVM };
  }
})();
