// The single Mobile Serve webview panel, reused across runs of the command.
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { renderPage, type Page } from './page.ts';

let panel: vscode.WebviewPanel | undefined;
// The URL the Copy button copies. Kept here rather than trusting what the webview sends.
let currentUrl = '';

export function showPanel(page: Page): void {
  if (panel) {
    // Keep the panel in whichever column it's in now.
    panel.reveal(undefined, true);
  } else {
    const created = vscode.window.createWebviewPanel('mobileServe', 'Mobile Serve',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [] });
    const messages = created.webview.onDidReceiveMessage(async message => {
      if (message?.type !== 'copy' || !currentUrl) return;
      await vscode.env.clipboard.writeText(currentUrl);
      vscode.window.setStatusBarMessage(`Copied ${currentUrl}`, 3000);
    });
    created.onDidDispose(() => {
      messages.dispose();
      panel = undefined;
    });
    panel = created;
  }
  currentUrl = page.urls[0].url;
  panel.webview.html = renderPage(page, crypto.randomBytes(16).toString('base64'));
}

export function disposePanel(): void {
  panel?.dispose();
}
