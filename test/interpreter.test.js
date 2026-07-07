const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { PietVM } = require("../media/interpreter.js");
const { decodePng } = require("../out-test/png.cjs");
const { WHITE, BLACK, colorFor, commandStrip, runVM } = require("./helpers/pietBuild.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));

// ---------------------------------------------------------------- arithmetic
// operands are loaded through in(num) so tests control exact values
const binaryCases = [
  ["add", "7 3", "10"],
  ["subtract", "7 3", "4"],
  ["multiply", "7 3", "21"],
  ["divide", "7 3", "2"],
  ["divide", "-7 3", "-2"], // truncates toward zero, like Python's piet.py
  ["mod", "7 3", "1"],
  ["mod", "-7 3", "2"], // result takes the divisor's sign
  ["greater", "7 3", "1"],
  ["greater", "3 7", "0"],
];

for (const [op, input, expected] of binaryCases) {
  test(`${op}: ${input} -> ${expected}`, () => {
    const grid = commandStrip(["inNum", "inNum", op, "outNum"]);
    const vm = runVM(new PietVM(grid, input), { minOutput: expected.length });
    assert.equal(vm.output, expected);
  });
}

test("divide by zero is ignored, stack preserved", () => {
  // 7 / 0 ignored -> stack still [7, 0]; pop the 0, then out prints 7
  const grid = commandStrip(["inNum", "inNum", "divide", "pop", "outNum"]);
  const vm = runVM(new PietVM(grid, "7 0"), { minOutput: 1 });
  assert.equal(vm.output, "7");
});

test("not: 0 -> 1 and nonzero -> 0", () => {
  let vm = runVM(new PietVM(commandStrip(["inNum", "not", "outNum"]), "0"), { minOutput: 1 });
  assert.equal(vm.output, "1");
  vm = runVM(new PietVM(commandStrip(["inNum", "not", "outNum"]), "17"), { minOutput: 1 });
  assert.equal(vm.output, "0");
});

test("duplicate", () => {
  const grid = commandStrip(["inNum", "duplicate", "outNum", "outNum"]);
  const vm = runVM(new PietVM(grid, "9"), { minOutput: 2 });
  assert.equal(vm.output, "99");
});

test("push pushes the block size (1 for strip codels)", () => {
  const grid = commandStrip(["push", "outNum"]);
  const vm = runVM(new PietVM(grid, ""), { minOutput: 1 });
  assert.equal(vm.output, "1");
});

test("roll: [1,2,3] roll depth 3 once -> outputs 2 1 3", () => {
  const grid = commandStrip([
    "inNum", "inNum", "inNum", "inNum", "inNum", "roll", "outNum", "outNum", "outNum",
  ]);
  const vm = runVM(new PietVM(grid, "1 2 3 3 1"), { minOutput: 3 });
  assert.equal(vm.output, "213");
});

test("out(char) emits the code point; out-of-range is ignored", () => {
  const grid = commandStrip(["inNum", "outChar", "inNum", "outChar"]);
  const vm = runVM(new PietVM(grid, "72 2000000"), { maxSteps: 1000 });
  assert.equal(vm.output, "H"); // 2,000,000 is beyond Unicode and prints nothing
});

test("in(char) reads one character", () => {
  const grid = commandStrip(["inChar", "outNum"]);
  const vm = runVM(new PietVM(grid, "A"), { minOutput: 2 });
  assert.equal(vm.output, "65");
});

// ---------------------------------------------------------------- BigInt
test("stack values are BigInt (no precision loss beyond 2^53)", () => {
  const grid = commandStrip(["inNum", "inNum", "multiply", "outNum"]);
  const vm = runVM(new PietVM(grid, "123456789123456789 1000000007"), { minOutput: 5 });
  assert.equal(vm.output, (123456789123456789n * 1000000007n).toString());
});

// ---------------------------------------------------------------- termination
test("a block with no exits terminates after the 8-attempt rule", () => {
  const grid = { width: 2, height: 1, pixels: [colorFor(0, 1), BLACK] };
  const vm = runVM(new PietVM(grid, ""));
  assert.equal(vm.done, true);
  assert.equal(vm.output, "");
});

test("sliding forever through white terminates", () => {
  // an all-white program can never reach a colored block: the slide cycles
  // through every (pos, dp, cc) state and must be detected as an infinite loop
  const grid = { width: 3, height: 1, pixels: [WHITE, WHITE, WHITE] };
  const vm = runVM(new PietVM(grid, ""));
  assert.equal(vm.done, true);
  assert.match(vm.status, /white/);
});

test("a black top-left codel is an immediate error", () => {
  const vm = new PietVM({ width: 1, height: 1, pixels: [BLACK] }, "");
  assert.equal(vm.done, true);
  assert.match(vm.status, /error/);
});

// ---------------------------------------------------------------- interactive input
test("interactive mode pauses on input and resumes when fed", () => {
  const grid = commandStrip(["inNum", "outNum"]);
  const vm = new PietVM(grid, "", true);
  runVM(vm);
  assert.equal(vm.needsInput, "in(num)");
  assert.equal(vm.output, "");
  vm.input += "42\n";
  vm.needsInput = null;
  runVM(vm, { minOutput: 2 });
  assert.equal(vm.output, "42");
});

test("non-interactive mode ignores input commands on empty buffer", () => {
  const grid = commandStrip(["inNum", "push", "outNum"]);
  const vm = runVM(new PietVM(grid, ""), { minOutput: 1 });
  assert.equal(vm.output, "1"); // in(num) ignored; push 1 then out
});

// ---------------------------------------------------------------- programs
test("hi.piet prints Hi and finishes", () => {
  const grid = decodePng(fixture("hi.piet"));
  const vm = runVM(new PietVM(grid, ""));
  assert.equal(vm.output, "Hi\n");
  assert.equal(vm.done, true);
});

test("fibonnaci.piet streams the fibonacci sequence (checked through fib(100))", () => {
  const grid = decodePng(fixture("fibonnaci.piet"));
  const vm = new PietVM(grid, "");
  while (!vm.done && vm.output.split("\n").length <= 101 && vm.steps < 200000) {
    vm.step();
  }
  const lines = vm.output.split("\n");
  let a = 0n, b = 1n;
  for (let i = 0; i < 100; i++) {
    [a, b] = [b, a + b];
    assert.equal(lines[i], a.toString(), `fib(${i + 1})`);
  }
});
