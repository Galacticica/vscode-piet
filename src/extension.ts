import * as vscode from "vscode";
import { PietEditorProvider } from "./pietEditor";
import { encodePng } from "./png";
import { gridFromImage, PietRunTerminal } from "./runner";

const WHITE = 0xffffff;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PietEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PietEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("piet.new", async () => {
      const size = await vscode.window.showInputBox({
        prompt: "Grid size (width x height)",
        value: "10x10",
        validateInput: (v) =>
          /^\s*\d+\s*[xX]\s*\d+\s*$/.test(v) ? undefined : "Use WIDTHxHEIGHT, e.g. 10x10",
      });
      if (!size) {
        return;
      }
      const [w, h] = size.toLowerCase().split("x").map((s) => parseInt(s.trim(), 10));
      if (w < 1 || h < 1 || w > 512 || h > 512) {
        void vscode.window.showErrorMessage("Grid dimensions must be between 1 and 512.");
        return;
      }
      const target = await vscode.window.showSaveDialog({
        filters: { "Piet program": ["piet"] },
        defaultUri: inWorkspace("untitled.piet"),
      });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(target, encodePng(w, h, new Array(w * h).fill(WHITE)));
      await vscode.commands.executeCommand("vscode.openWith", target, PietEditorProvider.viewType);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("piet.run", async (uri?: vscode.Uri) => {
      const target = uri ?? provider.activeUri;
      if (!target) {
        void vscode.window.showErrorMessage("Open a .piet file first.");
        return;
      }
      await vscode.workspace.save(target);
      const template = (vscode.workspace.getConfiguration("piet").get<string>("runCommand") ?? "").trim();
      if (template) {
        // user-configured external interpreter
        const folder = vscode.workspace.getWorkspaceFolder(target);
        const filePath = folder ? vscode.workspace.asRelativePath(target, false) : target.fsPath;
        const command = template.replace("{file}", quote(filePath));
        const terminal =
          vscode.window.terminals.find((t) => t.name === "Piet") ??
          vscode.window.createTerminal({ name: "Piet", cwd: folder?.uri });
        terminal.show();
        terminal.sendText(command);
        return;
      }
      const fileName = target.path.split("/").pop() ?? "program.piet";
      let grid;
      try {
        grid = gridFromImage(await vscode.workspace.fs.readFile(target), fileName);
      } catch (e) {
        void vscode.window.showErrorMessage(`Piet: cannot read ${fileName}: ${(e as Error).message}`);
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: `Piet: ${fileName}`,
        pty: new PietRunTerminal(grid, fileName),
      });
      terminal.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("piet.exportPng", async () => {
      const uri = provider.activeUri;
      const grid = provider.getGrid(uri);
      if (!uri || !grid) {
        void vscode.window.showErrorMessage("Open a .piet file in the Piet editor first.");
        return;
      }
      const sizeStr = await vscode.window.showInputBox({
        prompt: "Codel size in pixels for the exported PNG",
        value: "10",
        validateInput: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 100 ? undefined : "1-100"),
      });
      if (!sizeStr) {
        return;
      }
      const target = await vscode.window.showSaveDialog({
        filters: { "PNG image": ["png"] },
        defaultUri: uri.with({ path: uri.path.replace(/\.piet$/i, ".png") }),
      });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(
        target,
        encodePng(grid.width, grid.height, grid.pixels, parseInt(sizeStr, 10))
      );
      void vscode.window.showInformationMessage(`Exported ${vscode.workspace.asRelativePath(target)}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("piet.importPng", async () => {
      const picked = await vscode.window.showOpenDialog({
        filters: { Images: ["png", "gif", "bmp"] },
        canSelectMany: false,
        title: "Select a Piet image to import",
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const source = picked[0];
      const target = await vscode.window.showSaveDialog({
        filters: { "Piet program": ["piet"] },
        defaultUri: inWorkspace(
          source.path.split("/").pop()!.replace(/\.[^.]+$/, "") + ".piet"
        ),
      });
      if (!target) {
        return;
      }
      // raw copy; the editor detects the codel size, normalizes to one pixel
      // per codel, and saves the canonical form on open
      await vscode.workspace.fs.writeFile(target, await vscode.workspace.fs.readFile(source));
      await vscode.commands.executeCommand("vscode.openWith", target, PietEditorProvider.viewType);
    })
  );
}

function inWorkspace(fileName: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, fileName) : undefined;
}

function quote(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

export function deactivate(): void {}
