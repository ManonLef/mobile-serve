// HTML for the Mobile Serve webview.

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
    ? '<p class="ok">✓ The server is listening on this address.</p>'
    : '<p class="warn">⚠ Couldn\'t connect on this address. Is the server running and bound to 0.0.0.0?</p>';
  const https = primary.url.startsWith('https:')
    ? '<p class="hint">The server uses HTTPS. If its certificate is self-signed, your phone will ask you to accept it.</p>'
    : '';
  const remoteWarning = remoteName
    ? `<p class="warn">⚠ VS Code is connected to a remote environment (${escapeHtml(remoteName)}). ` +
      'These addresses belong to that machine, which your phone may not be able to reach.</p>'
    : '';
  const sharing = sharedBy === 'mobileServe'
    ? '<p class="warn">⚠ Every device on this network can open this server while it\'s shared.</p>' +
      '<button id="stop" class="secondary">Stop Sharing</button>'
    : sharedBy === 'other'
      ? '<p class="warn">⚠ Every device on this network can open this server. Mobile Serve didn\'t set that up, ' +
        'so stop the server yourself when you\'re done.</p>'
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
  <img src="${escapeHtml(qr)}" alt="QR code for ${escapeHtml(primary.url)}">
  <div class="url">${escapeHtml(primary.url)}</div>
  <button id="copy">Copy URL</button>
  ${status}
  ${sharing}
  ${remoteWarning}
  <p class="hint">Scan with your phone's camera. Your phone must be on the same Wi-Fi network.
    If the page doesn't load, allow incoming connections in your computer's firewall, and avoid guest
    networks, which often block devices from reaching each other.</p>
  ${https}
  ${otherList ? `<p class="dim">Other addresses:</p><ul>${otherList}</ul>` : ''}
  <script nonce="${nonce}">
    // acquireVsCodeApi() may only be called once per webview.
    const vscodeApi = acquireVsCodeApi();
    document.getElementById('copy').addEventListener('click', () => vscodeApi.postMessage({ type: 'copy' }));
    document.getElementById('stop')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'stop' }));
  </script>
</body></html>`;
}
