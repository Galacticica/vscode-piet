// Helpers for constructing Piet programs in tests.
const WHITE = 0xffffff;
const BLACK = 0x000000;
const HUES = [
  [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255],
];

function colorFor(hue, light) {
  const [r, g, b] = HUES[((hue % 6) + 6) % 6];
  if (light === 0) {
    return ((r || 192) << 16) | ((g || 192) << 8) | (b || 192);
  }
  if (light === 2) {
    return ((r && 192) << 16) | ((g && 192) << 8) | (b && 192);
  }
  return (r << 16) | (g << 8) | b;
}

// hue/lightness delta for each command, per the Piet command table
const DELTAS = {
  push: [0, 1], pop: [0, 2],
  add: [1, 0], subtract: [1, 1], multiply: [1, 2],
  divide: [2, 0], mod: [2, 1], not: [2, 2],
  greater: [3, 0], pointer: [3, 1], switch: [3, 2],
  duplicate: [4, 0], roll: [4, 1], inNum: [4, 2],
  inChar: [5, 0], outNum: [5, 1], outChar: [5, 2],
};

/**
 * Build a 1-row grid executing the given commands left to right, starting
 * from light red. Each codel is a 1-cell block, so every `push` pushes 1.
 * Execution bounces around silently at the right edge when it runs out of
 * program — callers should stop on expected output, not on done.
 */
function commandStrip(commands) {
  let hue = 0;
  let light = 0;
  const pixels = [colorFor(hue, light)];
  for (const command of commands) {
    const [dh, dl] = DELTAS[command];
    if (dh === 0 && dl === 0) {
      throw new Error("consecutive identical colors would merge");
    }
    hue = (hue + dh) % 6;
    light = (light + dl) % 3;
    pixels.push(colorFor(hue, light));
  }
  return { width: pixels.length, height: 1, pixels };
}

/** Run a VM until it finishes, produces `minOutput` chars, or hits the step limit. */
function runVM(vm, { minOutput = Infinity, maxSteps = 100000 } = {}) {
  while (!vm.done && !vm.needsInput && vm.steps < maxSteps && vm.output.length < minOutput) {
    vm.step();
  }
  return vm;
}

module.exports = { WHITE, BLACK, colorFor, commandStrip, runVM };
