require("./helpers/stubVscode.js"); // must be installed before loading the runner

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { gridFromImage, PietRunTerminal } = require("../out-test/runner.cjs");
const { encodePng, decodePng } = require("../out-test/png.cjs");
const { commandStrip } = require("./helpers/pietBuild.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(20);
  }
}

function startTerminal(grid, name) {
  const term = new PietRunTerminal(grid, name);
  const state = { output: "", closed: false };
  term.onDidWrite((s) => { state.output += s; });
  term.onDidClose(() => { state.closed = true; });
  term.open();
  return { term, state };
}

test("gridFromImage: .piet files are one pixel per codel", () => {
  const grid = gridFromImage(fixture("hi.piet"), "hi.piet");
  assert.equal(grid.width, 10);
  assert.equal(grid.height, 10);
});

test("gridFromImage: scaled PNGs get codel-size detection", () => {
  const base = decodePng(fixture("hi.piet"));
  const scaled = encodePng(base.width, base.height, base.pixels, 5);
  const grid = gridFromImage(scaled, "hi.png");
  assert.equal(grid.width, 10);
  assert.equal(grid.height, 10);
  assert.deepEqual(grid.pixels, base.pixels);
});

test("terminal run: hi.piet prints Hi and reports completion", async () => {
  const { term, state } = startTerminal(gridFromImage(fixture("hi.piet"), "hi.piet"), "hi.piet");
  await until(() => /finished/.test(state.output));
  term.close();
  assert.match(state.output, /Hi\r\n/);
  assert.match(state.output, /finished after [\d,.]+ steps/);
});

test("terminal run: fibonnaci.piet streams output without flooding", async () => {
  const grid = gridFromImage(fixture("fibonnaci.piet"), "fibonnaci.piet");
  const { term, state } = startTerminal(grid, "fibonnaci.piet");
  await until(() => state.output.includes("13\r\n"));
  await sleep(500);
  term.close();
  assert.match(state.output, /1\r\n1\r\n2\r\n3\r\n5\r\n8\r\n13\r\n/);
  // throttled: an unthrottled run produced tens of MB in this window
  assert.ok(state.output.length < 1_000_000, `output too large: ${state.output.length}`);
});

test("terminal run: interactive input is echoed and consumed", async () => {
  const grid = commandStrip(["inNum", "outNum"]);
  const { term, state } = startTerminal(grid, "echo.piet");
  // wait for the VM to block on input, then type 42<enter>
  await until(() => term["vm"] && term["vm"].needsInput);
  term.handleInput("4");
  term.handleInput("2");
  term.handleInput("\r");
  await until(() => /42\r\n42/.test(state.output)); // echo, then program output
  term.close();
});

test("terminal run: Ctrl+C stops and closes", async () => {
  const grid = gridFromImage(fixture("fibonnaci.piet"), "fibonnaci.piet");
  const { term, state } = startTerminal(grid, "fibonnaci.piet");
  await until(() => state.output.includes("1\r\n"));
  term.handleInput("\x03");
  assert.equal(state.closed, true);
  assert.match(state.output, /\^C/);
});
