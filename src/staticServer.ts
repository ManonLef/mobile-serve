// Serves a plain HTML/CSS/JS folder to the network, reloading the page when a file changes, like
// Live Server. Files and folders starting with "." (.env, .git…) are never served.
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { isInside } from './servers.ts';

// Reserved for the reload connection. Can't clash with a file, since the folder is served as it is.
const RELOAD_PATH = '/__mobile-serve/reload';
// Saving several files at once sends one reload.
const RELOAD_DELAY_MS = 100;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};

// Added to every HTML page. A CSS change swaps the stylesheets in place; anything else reloads the page.
const RELOAD_SCRIPT = `<script>(() => {
  const events = new EventSource(${JSON.stringify(RELOAD_PATH)});
  events.onmessage = event => {
    if (event.data !== 'css') return location.reload();
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href);
      if (url.origin !== location.origin) continue;
      url.searchParams.set('mobile-serve', Date.now());
      link.href = url.href;
    }
  };
})();</script>`;

export interface StaticServer {
  port: number;
  // Tells open pages a file changed. `file` is relative to the folder, so only hidden files and
  // folders inside it are ignored, not a hidden folder the project itself sits in.
  fileChanged(file: string): void;
  close(): Promise<void>;
}

// Adds the reload script to an HTML page: before </body>, or at the end when there's none.
export function injectReloadScript(html: string): string {
  const end = html.search(/<\/body\s*>/i);
  return end === -1 ? html + RELOAD_SCRIPT : html.slice(0, end) + RELOAD_SCRIPT + html.slice(end);
}

// The file a request path refers to, or undefined when it's outside `root` or hidden.
export function resolveRequestPath(root: string, urlPath: string): string | undefined {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return undefined;
  }
  // Backslashes too, which Windows reads as separators.
  if (pathname.includes('\0') || pathname.split(/[\\/]/).some(part => part.startsWith('.'))) return undefined;
  const file = path.join(root, pathname);
  return isInside(file, root) ? file : undefined;
}

function send(res: http.ServerResponse, status: number, text: string, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

/**
 * Serves `root` on `port`, on all interfaces. `root` should be a real path (see realPath), so files
 * reached through a symlink can be checked against it.
 */
export function startStaticServer(root: string, port: number): Promise<StaticServer> {
  const reloadClients = new Set<http.ServerResponse>();
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let onlyCss = true;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const urlPath = req.url ?? '/';
    if (urlPath.split('?')[0] === RELOAD_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': connected\n\n');
      reloadClients.add(res);
      res.on('close', () => reloadClients.delete(res));
      return;
    }

    let file = resolveRequestPath(root, urlPath);
    if (!file) return send(res, 404, 'Not found');
    let stat: fs.Stats;
    try {
      // A symlink pointing out of the folder isn't served either.
      file = await fs.promises.realpath(file);
      if (!isInside(file, root)) return send(res, 404, 'Not found');
      stat = await fs.promises.stat(file);
      if (stat.isDirectory()) {
        // Relative links in the folder's index.html need the trailing slash.
        const { pathname, search } = new URL(urlPath, 'http://localhost');
        if (!pathname.endsWith('/')) return send(res, 301, 'Moved', { Location: pathname + '/' + search });
        file = path.join(file, 'index.html');
        stat = await fs.promises.stat(file);
      }
    } catch {
      return send(res, 404, 'Not found');
    }
    if (!stat.isFile()) return send(res, 404, 'Not found');

    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    // The phone should always get the file as it is now.
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (type.startsWith('text/html')) {
      const html = injectReloadScript(await fs.promises.readFile(file, 'utf8'));
      res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(html) });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Could not read the file');
      else res.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve({
        // The port asked for, or the one picked when that was 0.
        port: (server.address() as AddressInfo).port,
        fileChanged(file) {
          if (file.split(/[\\/]/).some(part => part.startsWith('.'))) return;
          onlyCss &&= path.extname(file).toLowerCase() === '.css';
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            const message = `data: ${onlyCss ? 'css' : 'reload'}\n\n`;
            onlyCss = true;
            for (const client of reloadClients) client.write(message);
          }, RELOAD_DELAY_MS);
        },
        close() {
          clearTimeout(reloadTimer);
          return new Promise(done => {
            server.close(() => done());
            // Open pages keep their reload connection, which would hold the server open.
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
