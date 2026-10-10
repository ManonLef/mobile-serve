// HTML for the Mobile Serve webview.
import { strings } from './strings.ts';

export interface PageUrl {
  // Network interface, e.g. en0.
  name: string;
  url: string;
}

export interface Page {
  // The first one is shown as a QR code.
  urls: [PageUrl, ...PageUrl[]];
  // QR code image as a data: URL.
  qr: string;
  // Whether the server accepted a connection on the first URL from this computer.
  listening: boolean;
  // Set when VS Code is connected to a remote machine.
  remoteName?: string;
  // Who made the server reachable from the network: Mobile Serve, which can undo it, or
  // someone else. Unset when it isn't reachable.
  sharedBy?: 'mobileServe' | 'other';
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

// `nonce` allows only this page's own <style> and <script>.
export function renderPage({ urls, qr, listening, remoteName, sharedBy }: Page, nonce: string): string {
  const [primary, ...others] = urls;
  // A connection from this computer doesn't go through the firewall or the Wi-Fi network,
  // so it can't confirm the phone will get through.
  const status = listening
    ? `<p class="ok">${strings.page.listening}</p>`
    : `<p class="warn">${strings.page.notListening}</p>`;
  const https = primary.url.startsWith('https:')
    ? `<p class="hint">${strings.page.https}</p>`
    : '';
  const remoteWarning = remoteName
    ? `<p class="warn">${strings.page.remote(escapeHtml(remoteName))}</p>`
    : '';
  const sharing = sharedBy === 'mobileServe'
    ? `<p class="warn">${strings.page.sharedByMobileServe}</p>` +
      `<button id="stop" class="secondary">${strings.page.stopSharing}</button>`
    : sharedBy === 'other'
      ? `<p class="warn">${strings.page.sharedByOther}</p>`
      : '';
  const otherList = others.map(u =>
    `<li><code>${escapeHtml(u.url)}</code> <span class="dim">(${escapeHtml(u.name)})</span></li>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; text-align: center; }
  img { background: #fff; padding: 12px; border-radius: 8px; }
  .url { font-size: 1.4em; font-family: var(--vscode-editor-font-family); margin: 16px 0 8px; user-select: all; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 6px 14px; border-radius: 3px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .ok { color: var(--vscode-testing-iconPassed); }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .dim { opacity: .6; }
  ul { list-style: none; padding: 0; }
  p.hint { opacity: .7; font-size: .9em; }
</style></head>
<body>
  <img src="${escapeHtml(qr)}" alt="${strings.page.qrAlt(escapeHtml(primary.url))}">
  <div class="url">${escapeHtml(primary.url)}</div>
  <button id="copy">${strings.page.copyUrl}</button>
  ${status}
  ${sharing}
  ${remoteWarning}
  <p class="hint">${strings.page.hint}</p>
  ${https}
  ${otherList ? `<p class="dim">${strings.page.otherAddresses}</p><ul>${otherList}</ul>` : ''}
  <script nonce="${nonce}">
    // acquireVsCodeApi() may only be called once per webview.
    const vscodeApi = acquireVsCodeApi();
    document.getElementById('copy').addEventListener('click', () => vscodeApi.postMessage({ type: 'copy' }));
    document.getElementById('stop')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'stop' }));
  </script>
</body></html>`;
}
