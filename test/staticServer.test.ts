import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { injectReloadScript, isAllowedHost, parseRange, resolveRequestPath, startStaticServer, type StaticServer } from '../src/staticServer.ts';

test('injectReloadScript goes before </body>, or at the end without one', () => {
  const page = injectReloadScript('<html><body><p>Hi</p></BODY></html>');
  assert.match(page, /<p>Hi<\/p><script>[\s\S]*EventSource[\s\S]*<\/script><\/BODY><\/html>$/);
  assert.match(injectReloadScript('<p>Hi</p>'), /^<p>Hi<\/p><script>[\s\S]*<\/script>$/);
});

test('resolveRequestPath stays inside the folder and skips hidden files', () => {
  const root = path.resolve('/site');
  assert.strictEqual(resolveRequestPath(root, '/css/app.css?v=2'), path.join(root, 'css', 'app.css'));
  assert.strictEqual(resolveRequestPath(root, '/My%20Page.html'), path.join(root, 'My Page.html'));
  // URL parsing resolves "..", encoded or not, against the folder's root.
  assert.strictEqual(resolveRequestPath(root, '/%2e%2e/secret'), path.join(root, 'secret'));
  for (const url of ['/.env', '/.git/config', '/..%2fsecret', '/sub/%2E%2E%5C..%5Csecret', '/a%00.html', '/%E0%A4%A']) {
    assert.strictEqual(resolveRequestPath(root, url), undefined, url);
  }
});

test('isAllowedHost accepts IP addresses and localhost, not other names', () => {
  for (const host of ['192.168.1.20:5600', '127.0.0.1', '[::1]:5600', '[fe80::1]', 'localhost:5600', 'LOCALHOST']) {
    assert.strictEqual(isAllowedHost(host), true, host);
  }
  for (const host of [undefined, '', 'evil.example', 'evil.example:5600', 'my-mac.local:5600', 'evil.example@127.0.0.1', '127.0.0.1/x', '[evil.example]']) {
    assert.strictEqual(isAllowedHost(host), false, String(host));
  }
});

test('parseRange reads one byte range, and ignores what it can\'t handle', () => {
  assert.deepStrictEqual(parseRange('bytes=0-1', 10), { start: 0, end: 1 });
  assert.deepStrictEqual(parseRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepStrictEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  // Safari asks past the end to learn the size.
  assert.deepStrictEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.deepStrictEqual(parseRange('bytes=-100', 10), { start: 0, end: 9 });
  for (const header of ['bytes=10-', 'bytes=-0']) assert.strictEqual(parseRange(header, 10), 'unsatisfiable', header);
  assert.strictEqual(parseRange('bytes=0-', 0), 'unsatisfiable');
  for (const header of [undefined, '', 'bytes=-', 'bytes=5-3', 'bytes=0-1,4-5', 'items=0-1']) {
    assert.strictEqual(parseRange(header, 10), undefined, String(header));
  }
});

// The folder a plain HTML project would have, plus a file next to it that must not be reachable.
async function site(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-serve-')));
  const root = path.join(parent, 'site');
  await fs.mkdir(path.join(root, 'blog'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<html><body><h1>Home</h1></body></html>');
  await fs.writeFile(path.join(root, 'style.css'), 'h1 { color: red }');
  await fs.writeFile(path.join(root, 'blog', 'index.html'), '<h1>Blog</h1>');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1');
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.git', 'config'), 'SECRET=2');
  await fs.symlink(path.join(root, '.git'), path.join(root, 'public'));
  await fs.writeFile(path.join(parent, 'outside.txt'), 'outside');
  await fs.symlink(path.join(parent, 'outside.txt'), path.join(root, 'link.txt'));
  return { root, cleanup: () => fs.rm(parent, { recursive: true, force: true }) };
}

// Sends the path exactly as given, without the normalising a browser or fetch would do.
function get(server: StaticServer, urlPath: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.port, path: urlPath, headers }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => body += chunk).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('serves the folder, adding live reload to HTML pages', async () => {
  const { root, cleanup } = await site();
  const server = await startStaticServer(root, 0);
  try {
    const home = await get(server, '/');
    assert.strictEqual(home.status, 200);
    assert.match(home.body, /<h1>Home<\/h1><script>/);
    assert.strictEqual(home.headers['cache-control'], 'no-store');

    const css = await get(server, '/style.css');
    assert.strictEqual(css.body, 'h1 { color: red }');
    assert.match(css.headers['content-type']!, /^text\/css/);

    // Relative links in blog/index.html only work with the trailing slash.
    const blog = await get(server, '/blog?x=1');
    assert.deepStrictEqual([blog.status, blog.headers.location], [301, '/blog/?x=1']);
    assert.match((await get(server, '/blog/')).body, /<h1>Blog<\/h1>/);

    // How iOS Safari loads a video.
    assert.strictEqual(css.headers['accept-ranges'], 'bytes');
    const part = await get(server, '/style.css', { Range: 'bytes=5-9' });
    assert.deepStrictEqual([part.status, part.body, part.headers['content-range']], [206, 'color', 'bytes 5-9/17']);
    const past = await get(server, '/style.css', { Range: 'bytes=17-' });
    assert.deepStrictEqual([past.status, past.headers['content-range']], [416, 'bytes */17']);
  } finally {
    await server.close();
    await cleanup();
  }
});

test('never serves hidden files, or files outside the folder', async () => {
  const { root, cleanup } = await site();
  const server = await startStaticServer(root, 0);
  try {
    for (const url of ['/.env', '/%2e%2e/outside.txt', '/../outside.txt', '/link.txt', '/public/config', '/missing.html']) {
      const res = await get(server, url);
      assert.strictEqual(res.status, 404, url);
      assert.ok(!/SECRET|outside/.test(res.body), url);
    }
    // Reached through another site's name, as DNS rebinding would.
    const rebound = await get(server, '/', { Host: 'evil.example:' + server.port });
    assert.strictEqual(rebound.status, 403);
    assert.ok(!/Home/.test(rebound.body));
  } finally {
    await server.close();
    await cleanup();
  }
});

test('tells open pages to reload, or only to swap the CSS when only CSS changed', async () => {
  const { root, cleanup } = await site();
  const server = await startStaticServer(root, 0);
  try {
    const messages: string[] = [];
    const connected = new Promise<void>(resolve => {
      http.get({ host: '127.0.0.1', port: server.port, path: '/__mobile-serve/reload' }, res => {
        res.setEncoding('utf8').on('data', (chunk: string) => {
          messages.push(...[...chunk.matchAll(/^data: (\w+)$/gm)].map(m => m[1]));
          resolve();
        });
      });
    });
    await connected;
    const nextMessage = async () => {
      const count = messages.length;
      while (messages.length === count) await new Promise(resolve => setTimeout(resolve, 20));
      return messages.at(-1);
    };

    server.fileChanged('style.css');
    assert.strictEqual(await nextMessage(), 'css');
    // Saved together: one reload for both.
    server.fileChanged('style.css');
    server.fileChanged('index.html');
    assert.strictEqual(await nextMessage(), 'reload');
    assert.deepStrictEqual(messages, ['css', 'reload']);
    // Changes to hidden files are ignored.
    server.fileChanged(path.join('.git', 'index'));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepStrictEqual(messages, ['css', 'reload']);
  } finally {
    // Also ends the open reload connection.
    await server.close();
    await cleanup();
  }
});

test('fails to start on a port that is taken', async () => {
  const { root, cleanup } = await site();
  const server = await startStaticServer(root, 0);
  try {
    await assert.rejects(startStaticServer(root, server.port), { code: 'EADDRINUSE' });
  } finally {
    await server.close();
    await cleanup();
  }
});
