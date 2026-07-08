# Piet Editor

by Galacticica

Repository: https://github.com/Galacticica/vscode-piet

Marketplace: https://marketplace.visualstudio.com/items?itemName=Galacticica.piet-editor

Create, edit, debug, and run [Piet](https://www.dangermouse.net/esoteric/piet.html) programs inside VS Code.

A `.piet` file is a PNG image stored at one pixel per codel. Opening one shows a paintable
color grid instead of an image preview.

## Features

- **Grid editor** for `.piet` files: pencil (click/drag) and paint-bucket (fill a block)
  tools with the 20 Piet colors; right-click picks up a color from the grid.
- **Configurable grid size** — resize the grid at any time from the toolbar (content is preserved).
- **Authoring aids** — palette swatches are labeled with the command each color gives
  relative to the selected color; the 👁 toggle draws those labels on the grid itself;
  the status bar shows the hovered block's size (the value `push` would push).
- **Built-in debugger** (DEBUGGER tab on the right edge): run animated at three speeds,
  pause, single-step, run to completion, stop; live view of the DP/CC, the stack,
  the last command, and program output; input can be entered before running; the current
  color block and codel are highlighted on the canvas. Set breakpoints with the 📌 tool —
  execution pauses when flow enters a marked cell's block. Arithmetic uses BigInt, so
  values never overflow.
- **Import / Export** toolbar buttons: load any Piet image into the grid (any codel size —
  it is normalized to one pixel per codel), or export a scaled PNG for sharing.
- **▶ Run in terminal** via the editor title bar — programs run in a terminal tab on the
  extension's own interpreter (no Python or other tools needed), with interactive input:
  when the program executes `in(num)`/`in(char)` you type the value right in the terminal.
  Ctrl+C stops endless programs. Set `piet.runCommand` (e.g.
  `uv run python piet/piet.py {file}`) to use an external interpreter instead.
- **Piet: New Piet File** — create a blank grid of any size.
- **Piet: Import PNG as .piet** — convert an existing Piet image to a `.piet` file.

## Building

```
npm install
npm run compile
npm run package        # produces piet-editor-<version>.vsix
code --install-extension piet-editor-0.3.3.vsix
```

Or open this folder in VS Code and press F5 for a development host.

## Tests

```
npm test
```

Runs the suite under Node's built-in test runner (no extra dependencies):

- `test/interpreter.test.js` — PietVM semantics: every arithmetic/stack command
  (with sign edge cases), BigInt precision, termination rules, interactive input,
  and full runs of the bundled `hi`/`fibonnaci` programs (checked through fib(100)).
- `test/png.test.js` — PNG codec: encode/decode round trips at several codel sizes,
  plus decoding of Pillow-generated fixtures (filtered RGB, 8-bit and 4-bit palette,
  grayscale) verified pixel-for-pixel against Pillow's own output.
- `test/runner.test.js` — the terminal runner with a stubbed VS Code API:
  codel-size detection, program completion, output throttling, interactive
  input echo, and Ctrl+C handling.
