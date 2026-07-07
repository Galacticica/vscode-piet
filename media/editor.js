// Piet grid editor + debugger webview. The extension host owns the document;
// this script decodes PNG bytes into a 1px-per-codel grid, lets the user paint,
// posts whole-grid snapshots back as edits, and runs programs in-editor via
// PietVM (interpreter.js, loaded before this script).
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();

  // ---------------------------------------------------------------- colors
  const HUES = [
    [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255],
  ];
  const rgbInt = (r, g, b) => (r << 16) | (g << 8) | b;
  const WHITE = 0xffffff;
  const BLACK = 0x000000;
  const colorInfo = new Map(); // int -> {hue, light}
  const PALETTE_ROWS = [[], [], []]; // light, normal, dark
  HUES.forEach(([r, g, b], hue) => {
    const shades = [
      rgbInt(r || 192, g || 192, b || 192), // light
      rgbInt(r, g, b), // normal
      rgbInt(r && 192, g && 192, b && 192), // dark
    ];
    shades.forEach((c, light) => {
      colorInfo.set(c, { hue, light });
      PALETTE_ROWS[light][hue] = c;
    });
  });
  const ALL_COLORS = [...PALETTE_ROWS.flat(), WHITE, BLACK];
  const COMMANDS = PietVM.COMMANDS;
  const hex = (c) => "#" + c.toString(16).padStart(6, "0");

  function commandName(from, to) {
    const a = colorInfo.get(from);
    const b = colorInfo.get(to);
    if (!a || !b) {
      return from === to ? null : from === WHITE || to === WHITE ? "none" : null;
    }
    return COMMANDS[(b.hue - a.hue + 6) % 6][(b.light - a.light + 3) % 3];
  }

  function nearestColor(c) {
    if (colorInfo.has(c) || c === WHITE || c === BLACK) {
      return c;
    }
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    let best = WHITE, bestDist = Infinity;
    for (const p of ALL_COLORS) {
      const dr = r - ((p >> 16) & 0xff), dg = g - ((p >> 8) & 0xff), db = b - (p & 0xff);
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- state
  let grid = { width: 10, height: 10, pixels: new Array(100).fill(WHITE) };
  let zoom = 28;
  let brush = PALETTE_ROWS[1][0]; // normal red
  let tool = "pencil"; // pencil | bucket | break
  let showCmds = false;
  let painting = false;
  let strokeChanged = false;
  let hover = null;
  const breakpoints = new Set(); // "x,y" — session-local, not saved

  // debugger state
  let vm = null;
  let runTimer = null;
  let runToEndActive = false;
  const STEP_CAP = 2_000_000;

  // slider position 0..100 -> steps per second, exponential from 1 to 2000
  function stepsPerSecond(sliderValue) {
    return Math.round(Math.pow(2000, sliderValue / 100));
  }

  function speedParams(sliderValue) {
    const sps = stepsPerSecond(sliderValue);
    const interval = Math.min(1000, Math.max(16, Math.round(1000 / sps)));
    const batch = Math.max(1, Math.round((sps * interval) / 1000));
    return { interval, batch };
  }

  const snapshot = () => ({ width: grid.width, height: grid.height, pixels: [...grid.pixels] });

  // ---------------------------------------------------------------- DOM
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, attrs || {});
    node.append(...children);
    return node;
  }

  const canvas = el("canvas", { id: "canvas" });
  const ctx = canvas.getContext("2d");
  const canvasWrap = el("div", { id: "canvasWrap" }, canvas);
  const wInput = el("input", { id: "w", type: "number", min: 1, max: 512 });
  const hInput = el("input", { id: "h", type: "number", min: 1, max: 512 });
  const resizeBtn = el("button", { textContent: "Resize" });
  const clearBtn = el("button", { textContent: "Clear" });
  const importBtn = el("button", { textContent: "Import" });
  const exportBtn = el("button", { textContent: "Export PNG" });
  const pencilBtn = el("button", { textContent: "✏️", title: "Pencil — click/drag to paint", className: "tool active" });
  const bucketBtn = el("button", { textContent: "🪣", title: "Paint bucket — fill a color block", className: "tool" });
  const breakBtn = el("button", { textContent: "📌", title: "Breakpoints — click cells to toggle", className: "tool" });
  const eyeBtn = el("button", { textContent: "👁", title: "Show command each cell gives relative to the selected color", className: "tool" });
  const runBtn = el("button", { textContent: "▶ Run", className: "run", title: "Run in the debugger" });
  const zoomInput = el("input", { type: "range", min: 6, max: 48, value: zoom });
  const status = el("div", { id: "status" });
  const paletteDiv = el("div", { id: "palette" });

  // debugger panel
  const dbgOut = el("pre", { id: "dbgOut" });
  const dbgRunBtn = el("button", { textContent: "▶", className: "dbg green", title: "Run (animated)" });
  const dbgSpeed = el("input", { type: "range", min: 0, max: 100, value: 50, className: "dbgSpeed", title: "Speed" });
  const dbgSpeedLabel = el("span", { id: "dbgSpeedLabel" }, "45/s");
  const dbgPauseBtn = el("button", { textContent: "⏸", className: "dbg orange", title: "Pause" });
  const dbgStepBtn = el("button", { textContent: "⏭", className: "dbg blue", title: "Step one transition" });
  const dbgFastBtn = el("button", { textContent: "⏩", className: "dbg blue", title: "Run to completion" });
  const dbgStopBtn = el("button", { textContent: "⏹", className: "dbg red", title: "Stop / reset" });
  const dbgLocateBtn = el("button", { textContent: "📍", className: "dbg", title: "Scroll to current codel" });
  const dbgDp = el("span", { id: "dbgDp" }, "→");
  const dbgCc = el("span", { id: "dbgCc" }, "←");
  const dbgLast = el("span", { id: "dbgLast" }, "—");
  const dbgStack = el("div", { id: "dbgStack" });
  const dbgIn = el("textarea", { id: "dbgIn", placeholder: "Enter input before running program", rows: 3 });
  const dbgStatus = el("div", { id: "dbgStatus" }, "ready");
  const debugPanel = el("div", { id: "debugPanel" },
    el("div", { className: "dbgTitle" }, "Output"),
    dbgOut,
    el("div", { id: "dbgControls" }, dbgRunBtn, dbgPauseBtn, dbgStepBtn, dbgFastBtn, dbgStopBtn, dbgLocateBtn),
    el("div", { id: "dbgSpeedRow" }, el("span", {}, "Speed "), dbgSpeed, dbgSpeedLabel),
    el("div", { id: "dbgReadout" },
      el("span", {}, "DP: "), dbgDp,
      el("span", {}, "  CC: "), dbgCc,
      el("span", {}, "  last: "), dbgLast
    ),
    el("div", { className: "dbgTitle" }, "Stack"),
    dbgStack,
    el("div", { className: "dbgTitle" }, "Input"),
    dbgIn,
    dbgStatus
  );
  debugPanel.style.display = "none";
  const debugTab = el("div", { id: "debugTab", title: "Toggle debugger" }, "DEBUGGER");

  document.getElementById("root").append(
    el("div", { id: "toolbar" },
      importBtn, exportBtn,
      el("span", { className: "sep" }),
      el("label", {}, "Grid "), wInput, el("span", {}, "×"), hInput, resizeBtn,
      el("span", { className: "sep" }),
      el("label", {}, "Zoom "), zoomInput,
      el("span", { className: "sep" }),
      clearBtn,
      el("span", { className: "sep" }),
      pencilBtn, bucketBtn, breakBtn, eyeBtn,
      el("span", { className: "spacer" }),
      runBtn
    ),
    el("div", { id: "main" },
      canvasWrap,
      el("div", { id: "side" },
        el("div", { className: "sideTitle" }, "Palette"),
        paletteDiv,
        el("div", { className: "hint" },
          "Labels show the command that runs when program flow steps from a block of the selected color into that color. Left-click paints, right-click picks up a color.")
      ),
      debugPanel,
      debugTab
    ),
    status
  );

  // ---------------------------------------------------------------- palette
  const swatches = [];
  function buildPalette() {
    for (const row of PALETTE_ROWS) {
      for (const color of row) {
        addSwatch(color);
      }
    }
    addSwatch(WHITE);
    addSwatch(BLACK);
  }

  function addSwatch(color) {
    const chip = el("div", { className: "chip" });
    chip.style.background = hex(color);
    const label = el("div", { className: "cmd" });
    const swatch = el("div", { className: "swatch" }, chip, label);
    swatch.addEventListener("click", () => {
      brush = color;
      updatePalette();
      draw();
      updateStatus();
    });
    swatches.push({ swatch, label, color });
    paletteDiv.append(swatch);
  }

  function updatePalette() {
    for (const { swatch, label, color } of swatches) {
      swatch.classList.toggle("selected", color === brush);
      if (color === WHITE) {
        label.textContent = "white";
      } else if (color === BLACK) {
        label.textContent = "black";
      } else {
        label.textContent = commandName(brush, color) || " ";
      }
    }
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    // resizing a canvas clears it and forces relayout; only do it when needed
    if (canvas.width !== grid.width * zoom || canvas.height !== grid.height * zoom) {
      canvas.width = grid.width * zoom;
      canvas.height = grid.height * zoom;
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        ctx.fillStyle = hex(grid.pixels[y * grid.width + x]);
        ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
      }
    }
    if (zoom >= 8) {
      ctx.strokeStyle = "rgba(128,128,128,0.35)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= grid.width; x++) {
        ctx.beginPath();
        ctx.moveTo(x * zoom + 0.5, 0);
        ctx.lineTo(x * zoom + 0.5, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y <= grid.height; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * zoom + 0.5);
        ctx.lineTo(canvas.width, y * zoom + 0.5);
        ctx.stroke();
      }
    }
    if (showCmds && zoom >= 14) {
      ctx.font = `${Math.max(8, Math.floor(zoom / 3.2))}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          const c = grid.pixels[y * grid.width + x];
          if (c === WHITE || c === BLACK) {
            continue;
          }
          const cmd = commandName(brush, c);
          if (!cmd || cmd === "none") {
            continue;
          }
          const cx = x * zoom + zoom / 2, cy = y * zoom + zoom / 2;
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(0,0,0,0.8)";
          ctx.strokeText(cmd, cx, cy, zoom - 2);
          ctx.fillStyle = "#fff";
          ctx.fillText(cmd, cx, cy, zoom - 2);
        }
      }
    }
    for (const bp of breakpoints) {
      const [x, y] = bp.split(",").map(Number);
      if (x >= grid.width || y >= grid.height) {
        continue;
      }
      ctx.fillStyle = "#e51400";
      ctx.beginPath();
      ctx.arc(x * zoom + zoom - zoom / 5, y * zoom + zoom / 5, Math.max(2, zoom / 6), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (vm) {
      ctx.fillStyle = "rgba(255,136,0,0.30)";
      for (const [x, y] of vm.currentBlockCells()) {
        ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
      }
      ctx.strokeStyle = "#ff8800";
      ctx.lineWidth = 3;
      ctx.strokeRect(vm.x * zoom + 1.5, vm.y * zoom + 1.5, zoom - 3, zoom - 3);
    }
    if (hover) {
      ctx.strokeStyle = "rgba(255,136,0,0.8)";
      ctx.lineWidth = 2;
      ctx.strokeRect(hover.x * zoom + 1, hover.y * zoom + 1, zoom - 2, zoom - 2);
    }
  }

  function syncInputs() {
    wInput.value = grid.width;
    hInput.value = grid.height;
  }

  // ---------------------------------------------------------------- status
  function blockCells(x, y) {
    const color = grid.pixels[y * grid.width + x];
    const seen = new Set([y * grid.width + x]);
    const todo = [[x, y]];
    while (todo.length) {
      const [cx, cy] = todo.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        const i = ny * grid.width + nx;
        if (nx >= 0 && nx < grid.width && ny >= 0 && ny < grid.height &&
            !seen.has(i) && grid.pixels[i] === color) {
          seen.add(i);
          todo.push([nx, ny]);
        }
      }
    }
    return seen;
  }

  function updateStatus() {
    let text = `${grid.width}×${grid.height}  |  tool: ${tool}`;
    if (hover) {
      const color = grid.pixels[hover.y * grid.width + hover.x];
      text += `  |  (${hover.x}, ${hover.y})`;
      if (color !== WHITE && color !== BLACK) {
        text += `  block size ${blockCells(hover.x, hover.y).size}`;
      }
      const cmd = commandName(color, brush);
      if (cmd && color !== brush) {
        text += `  |  painting here after this block runs: ${cmd}`;
      }
    }
    status.textContent = text;
  }

  // ---------------------------------------------------------------- editing
  function sendEdit(label) {
    dbgStop();
    vscode.postMessage({ type: "edit", grid: snapshot(), label });
  }

  function cellFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / zoom);
    const y = Math.floor((e.clientY - rect.top) / zoom);
    if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) {
      return null;
    }
    return { x, y };
  }

  canvas.addEventListener("mousedown", (e) => {
    const cell = cellFromEvent(e);
    if (!cell) {
      return;
    }
    if (e.button === 2) {
      brush = grid.pixels[cell.y * grid.width + cell.x];
      updatePalette();
      draw();
      updateStatus();
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (tool === "break") {
      const key = `${cell.x},${cell.y}`;
      if (breakpoints.has(key)) {
        breakpoints.delete(key);
      } else {
        breakpoints.add(key);
      }
      draw();
      return;
    }
    if (tool === "bucket") {
      const target = grid.pixels[cell.y * grid.width + cell.x];
      if (target !== brush) {
        for (const i of blockCells(cell.x, cell.y)) {
          grid.pixels[i] = brush;
        }
        draw();
        sendEdit("Fill");
      }
      return;
    }
    painting = true;
    strokeChanged = false;
    paintCell(cell);
  });
  canvas.addEventListener("mousemove", (e) => {
    hover = cellFromEvent(e);
    if (painting && hover) {
      paintCell(hover);
    } else {
      draw();
    }
    updateStatus();
  });
  canvas.addEventListener("mouseleave", () => {
    hover = null;
    draw();
    updateStatus();
  });
  window.addEventListener("mouseup", () => {
    if (painting && strokeChanged) {
      sendEdit("Paint");
    }
    painting = false;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  function paintCell({ x, y }) {
    const i = y * grid.width + x;
    if (grid.pixels[i] !== brush) {
      grid.pixels[i] = brush;
      strokeChanged = true;
    }
    draw();
  }

  resizeBtn.addEventListener("click", () => {
    const w = Math.min(512, Math.max(1, parseInt(wInput.value, 10) || grid.width));
    const h = Math.min(512, Math.max(1, parseInt(hInput.value, 10) || grid.height));
    if (w === grid.width && h === grid.height) {
      return;
    }
    const pixels = new Array(w * h).fill(WHITE);
    for (let y = 0; y < Math.min(h, grid.height); y++) {
      for (let x = 0; x < Math.min(w, grid.width); x++) {
        pixels[y * w + x] = grid.pixels[y * grid.width + x];
      }
    }
    grid = { width: w, height: h, pixels };
    syncInputs();
    draw();
    updateStatus();
    sendEdit("Resize");
  });

  clearBtn.addEventListener("click", () => {
    grid.pixels.fill(WHITE);
    draw();
    sendEdit("Clear");
  });

  importBtn.addEventListener("click", () => vscode.postMessage({ type: "importRequest" }));
  exportBtn.addEventListener("click", () => vscode.postMessage({ type: "exportRequest" }));

  const toolButtons = { pencil: pencilBtn, bucket: bucketBtn, break: breakBtn };
  for (const [name, btn] of Object.entries(toolButtons)) {
    btn.addEventListener("click", () => {
      tool = name;
      for (const b of Object.values(toolButtons)) {
        b.classList.toggle("active", b === btn);
      }
      updateStatus();
    });
  }

  eyeBtn.addEventListener("click", () => {
    showCmds = !showCmds;
    eyeBtn.classList.toggle("active", showCmds);
    draw();
  });

  zoomInput.addEventListener("input", () => {
    zoom = parseInt(zoomInput.value, 10);
    draw();
  });

  // ---------------------------------------------------------------- debugger
  function togglePanel(open) {
    const show = open !== undefined ? open : debugPanel.style.display === "none";
    debugPanel.style.display = show ? "flex" : "none";
  }
  debugTab.addEventListener("click", () => togglePanel());

  function vmEnsure() {
    if (!vm) {
      vm = new PietVM(snapshot(), dbgIn.value);
    }
  }

  function stopTimers() {
    if (runTimer) {
      clearInterval(runTimer);
      runTimer = null;
    }
    runToEndActive = false;
  }

  function atBreakpoint() {
    if (!vm || !breakpoints.size) {
      return false;
    }
    for (const [x, y] of vm.currentBlockCells()) {
      if (breakpoints.has(`${x},${y}`)) {
        return true;
      }
    }
    return false;
  }

  // coalesce refreshes to one per animation frame, and only touch DOM that changed
  let refreshQueued = false;
  let shownOutput = null;
  let shownStackSig = null;

  function vmRefresh() {
    if (refreshQueued) {
      return;
    }
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      vmRefreshNow();
    });
  }

  function setText(node, text) {
    if (node.textContent !== text) {
      node.textContent = text;
    }
  }

  function vmRefreshNow() {
    const arrows = ["→", "↓", "←", "↑"];
    if (vm) {
      setText(dbgDp, arrows[vm.dp]);
      setText(dbgCc, vm.cc === 0 ? "←" : "→");
      setText(dbgLast, vm.lastCommand || "—");
      if (vm.output.length > 100000) {
        vm.output = vm.output.slice(-20000); // keep memory bounded on endless programs
      }
      const out = vm.output;
      const shown = out.length > 20000 ? "…" + out.slice(-20000) : out;
      if (shown !== shownOutput) {
        // keep the view pinned to the bottom only if it already was
        const pinned =
          dbgOut.scrollTop + dbgOut.clientHeight >= dbgOut.scrollHeight - 4;
        dbgOut.textContent = shown;
        shownOutput = shown;
        if (pinned) {
          dbgOut.scrollTop = dbgOut.scrollHeight;
        }
      }
      const items = [...vm.stack].reverse().slice(0, 200);
      const sig = items.length + ":" + items.map(String).join(",");
      if (sig !== shownStackSig) {
        shownStackSig = sig;
        dbgStack.replaceChildren(
          ...items.map((v, i) => el("div", { className: "stackItem" + (i === 0 ? " top" : "") }, v.toString()))
        );
      }
      setText(dbgStatus, `${vm.status} — step ${vm.steps}`);
    } else {
      setText(dbgDp, "→");
      setText(dbgCc, "←");
      setText(dbgLast, "—");
      dbgOut.textContent = "";
      shownOutput = null;
      dbgStack.replaceChildren();
      shownStackSig = null;
      setText(dbgStatus, "ready");
    }
    draw();
  }

  function dbgStep() {
    stopTimers();
    vmEnsure();
    vm.step();
    vmRefresh();
  }

  function dbgRun() {
    vmEnsure();
    stopTimers();
    togglePanel(true);
    const sp = speedParams(parseInt(dbgSpeed.value, 10));
    runTimer = setInterval(() => {
      let hitBp = false;
      for (let i = 0; i < sp.batch && !vm.done; i++) {
        vm.step();
        if (atBreakpoint()) {
          hitBp = true;
          break;
        }
      }
      vmRefresh();
      if (vm.done || hitBp) {
        stopTimers();
        if (hitBp) {
          dbgStatus.textContent = `breakpoint — step ${vm.steps}`;
        }
      }
    }, sp.interval);
  }

  function dbgRunToEnd() {
    vmEnsure();
    stopTimers();
    togglePanel(true);
    runToEndActive = true;
    const chunk = () => {
      if (!runToEndActive || !vm) {
        return;
      }
      let hitBp = false;
      let n = 0;
      while (!vm.done && n++ < 20000) {
        vm.step();
        if (atBreakpoint()) {
          hitBp = true;
          break;
        }
        if (vm.steps >= STEP_CAP) {
          vm.status = `paused: step cap (${STEP_CAP.toLocaleString()}) reached`;
          runToEndActive = false;
          break;
        }
      }
      vmRefresh();
      if (hitBp) {
        runToEndActive = false;
        dbgStatus.textContent = `breakpoint — step ${vm.steps}`;
      } else if (!vm.done && runToEndActive) {
        setTimeout(chunk, 0);
      } else {
        runToEndActive = false;
      }
    };
    chunk();
  }

  function dbgStop() {
    stopTimers();
    if (vm) {
      vm = null;
      vmRefresh();
    }
  }

  dbgSpeed.addEventListener("input", () => {
    dbgSpeedLabel.textContent = `${stepsPerSecond(parseInt(dbgSpeed.value, 10))}/s`;
    if (runTimer) {
      dbgRun(); // restart the timer with the new speed, mid-run
    }
  });
  dbgRunBtn.addEventListener("click", dbgRun);
  dbgPauseBtn.addEventListener("click", stopTimers);
  dbgStepBtn.addEventListener("click", dbgStep);
  dbgFastBtn.addEventListener("click", dbgRunToEnd);
  dbgStopBtn.addEventListener("click", dbgStop);
  dbgLocateBtn.addEventListener("click", () => {
    if (vm) {
      canvasWrap.scrollLeft = vm.x * zoom - canvasWrap.clientWidth / 2;
      canvasWrap.scrollTop = vm.y * zoom - canvasWrap.clientHeight / 2;
    }
  });
  runBtn.addEventListener("click", () => {
    togglePanel(true);
    dbgRun();
  });

  // ---------------------------------------------------------------- decode
  async function decode(bytes) {
    if (!bytes.length) {
      return { g: { width: 10, height: 10, pixels: new Array(100).fill(WHITE) }, normalized: true };
    }
    let data, w, h;
    try {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      w = bitmap.width;
      h = bitmap.height;
      const off = new OffscreenCanvas(w, h);
      const octx = off.getContext("2d");
      octx.drawImage(bitmap, 0, 0);
      data = octx.getImageData(0, 0, w, h).data;
    } catch (err) {
      return { g: { width: 10, height: 10, pixels: new Array(100).fill(WHITE) }, normalized: true };
    }
    let snapped = false;
    const raw = new Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const c = rgbInt(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      raw[i] = nearestColor(c);
      if (raw[i] !== c) {
        snapped = true;
      }
    }
    const codel = detectCodelSize(raw, w, h);
    const gw = Math.floor(w / codel);
    const gh = Math.floor(h / codel);
    const half = Math.floor(codel / 2);
    const pixels = new Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        pixels[y * gw + x] = raw[(y * codel + half) * w + x * codel + half];
      }
    }
    const normalized = snapped || codel > 1 || gw * codel !== w || gh * codel !== h;
    return { g: { width: gw, height: gh, pixels }, normalized };
  }

  function detectCodelSize(px, w, h) {
    // largest size at which every complete cell is one solid color
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

  // ---------------------------------------------------------------- host messages
  window.addEventListener("message", async (e) => {
    const msg = e.data;
    if (msg.type === "init") {
      dbgStop();
      const { g, normalized } = await decode(msg.bytes);
      grid = g;
      syncInputs();
      draw();
      updateStatus();
      vscode.postMessage({ type: "loaded", grid: snapshot(), normalized });
    } else if (msg.type === "setGrid") {
      dbgStop();
      grid = { width: msg.grid.width, height: msg.grid.height, pixels: [...msg.grid.pixels] };
      syncInputs();
      draw();
      updateStatus();
    } else if (msg.type === "importBytes") {
      const { g } = await decode(msg.bytes);
      grid = g;
      syncInputs();
      draw();
      updateStatus();
      sendEdit("Import");
    }
  });

  buildPalette();
  updatePalette();
  syncInputs();
  draw();
  updateStatus();
  vmRefresh();
  vscode.postMessage({ type: "ready" });
})();
