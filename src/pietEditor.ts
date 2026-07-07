import * as crypto from "crypto";
import * as vscode from "vscode";
import { encodePng } from "./png";

export interface Grid {
  width: number;
  height: number;
  pixels: number[]; // 24-bit RGB ints, row-major
}

export class PietDocument implements vscode.CustomDocument {
  grid: Grid | undefined;
  constructor(
    public readonly uri: vscode.Uri,
    public bytes: Uint8Array,
    private readonly onDispose: () => void
  ) {}
  dispose(): void {
    this.onDispose();
  }
}

export class PietEditorProvider implements vscode.CustomEditorProvider<PietDocument> {
  public static readonly viewType = "piet.editor";

  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PietDocument>>();
  public readonly onDidChangeCustomDocument = this.changeEmitter.event;

  private readonly documents = new Map<string, PietDocument>();
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  public activeUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getGrid(uri: vscode.Uri | undefined): Grid | undefined {
    return uri ? this.documents.get(uri.toString())?.grid : undefined;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext
  ): Promise<PietDocument> {
    const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    let bytes: Uint8Array = new Uint8Array();
    try {
      bytes = await vscode.workspace.fs.readFile(source);
    } catch {
      // brand-new or unreadable file: webview falls back to a blank grid
    }
    const key = uri.toString();
    const document = new PietDocument(uri, bytes, () => this.documents.delete(key));
    this.documents.set(key, document);
    return document;
  }

  async resolveCustomEditor(document: PietDocument, panel: vscode.WebviewPanel): Promise<void> {
    const key = document.uri.toString();
    this.panels.set(key, panel);
    this.activeUri = document.uri;
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activeUri = document.uri;
      }
    });
    panel.onDidDispose(() => this.panels.delete(key));
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(document, panel, msg));
  }

  private onMessage(document: PietDocument, panel: vscode.WebviewPanel, msg: any): void {
    switch (msg.type) {
      case "ready":
        panel.webview.postMessage({ type: "init", bytes: Array.from(document.bytes) });
        break;
      case "loaded":
        document.grid = msg.grid;
        if (msg.normalized) {
          // legacy/imported image (multi-pixel codels, off-palette colors, or
          // padding): record the normalization as an edit and canonicalize the
          // file to one pixel per codel right away
          this.fireEdit(document, panel, msg.grid, msg.grid, "Normalize");
          void vscode.workspace.save(document.uri);
        }
        break;
      case "edit": {
        const before = document.grid ?? msg.grid;
        document.grid = msg.grid;
        this.fireEdit(document, panel, before, msg.grid, msg.label ?? "Paint");
        break;
      }
      case "run":
        void vscode.commands.executeCommand("piet.run", document.uri);
        break;
      case "exportRequest":
        void vscode.commands.executeCommand("piet.exportPng");
        break;
      case "importRequest":
        void (async () => {
          const picked = await vscode.window.showOpenDialog({
            filters: { Images: ["png", "gif", "bmp", "piet"] },
            canSelectMany: false,
            title: "Select an image to load into the grid",
          });
          if (picked && picked.length > 0) {
            const bytes = await vscode.workspace.fs.readFile(picked[0]);
            void panel.webview.postMessage({ type: "importBytes", bytes: Array.from(bytes) });
          }
        })();
        break;
    }
  }

  private fireEdit(
    document: PietDocument,
    panel: vscode.WebviewPanel,
    before: Grid,
    after: Grid,
    label: string
  ): void {
    this.changeEmitter.fire({
      document,
      label,
      undo: () => {
        document.grid = before;
        void panel.webview.postMessage({ type: "setGrid", grid: before });
      },
      redo: () => {
        document.grid = after;
        void panel.webview.postMessage({ type: "setGrid", grid: after });
      },
    });
  }

  private async writeTo(document: PietDocument, target: vscode.Uri): Promise<void> {
    if (!document.grid) {
      return;
    }
    const bytes = encodePng(document.grid.width, document.grid.height, document.grid.pixels);
    if (target.toString() === document.uri.toString()) {
      document.bytes = bytes;
    }
    await vscode.workspace.fs.writeFile(target, bytes);
  }

  saveCustomDocument(document: PietDocument): Thenable<void> {
    return this.writeTo(document, document.uri);
  }

  saveCustomDocumentAs(document: PietDocument, destination: vscode.Uri): Thenable<void> {
    return this.writeTo(document, destination);
  }

  async revertCustomDocument(document: PietDocument): Promise<void> {
    document.bytes = await vscode.workspace.fs.readFile(document.uri);
    document.grid = undefined;
    void this.panels
      .get(document.uri.toString())
      ?.webview.postMessage({ type: "init", bytes: Array.from(document.bytes) });
  }

  async backupCustomDocument(
    document: PietDocument,
    context: vscode.CustomDocumentBackupContext
  ): Promise<vscode.CustomDocumentBackup> {
    await this.writeTo(document, context.destination);
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // already gone
        }
      },
    };
  }

  private html(webview: vscode.Webview): string {
    const vmJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "interpreter.js")
    );
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "editor.js")
    );
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "editor.css")
    );
    const nonce = crypto.randomBytes(16).toString("hex");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}">
  <title>Piet Editor</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${vmJs}"></script>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
