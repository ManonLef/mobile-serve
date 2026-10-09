import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { choosePort, isPortFree, planStart, portFor, scriptArgs, type StartPlan } from '../src/projectStart.ts';

// A temporary project folder with the given files; `package.json` may be an object.
async function project(files: Record<string, unknown>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-serve-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const scripts = (s: Record<string, string>) => ({ 'package.json': { scripts: s } });
// What the plan runs, as the package manager and its arguments.
const commandFor = (plan: StartPlan | undefined, port: number) =>
  plan?.kind === 'script' ? [plan.packageManager, ...scriptArgs(plan, port)].join(' ') : plan?.kind;

test('runs the dev script with the tool\'s host and port flags', async () => {
  await project({ ...scripts({ dev: 'vite', build: 'vite build' }), 'package-lock.json': '{}' }, async dir => {
    assert.strictEqual(commandFor(await planStart(dir), 5174), 'npm run dev -- --host --port 5174 --strictPort');
  });
  await project({ ...scripts({ dev: 'next dev' }), 'pnpm-lock.yaml': '' }, async dir => {
    assert.strictEqual(commandFor(await planStart(dir), 3000), 'pnpm run dev -H 0.0.0.0 -p 3000');
  });
});

test('only adds the port when the script already listens on every interface', async () => {
  await project(scripts({ dev: 'vite --host' }), async dir => {
    assert.strictEqual(commandFor(await planStart(dir), 5173), 'npm run dev -- --port 5173 --strictPort');
  });
  // Nothing left to add.
  await project(scripts({ dev: 'next dev -H 0.0.0.0 -p 4000' }), async dir => {
    assert.strictEqual(commandFor(await planStart(dir), 4000), 'npm run dev');
  });
  await project(scripts({ dev: 'vite --host localhost' }), async dir => {
    assert.strictEqual(await planStart(dir), undefined);
  });
});

test('falls back to start or serve when dev isn\'t a server it knows', async () => {
  await project(scripts({ dev: 'vite build --watch', start: 'ng serve' }), async dir => {
    assert.strictEqual(commandFor(await planStart(dir), 4200), 'npm run start -- --host 0.0.0.0 --port 4200');
  });
});

test('skips scripts that run a production server or only build', async () => {
  await project(scripts({ start: 'next start' }), async dir => {
    assert.strictEqual(await planStart(dir), undefined);
  });
  await project(scripts({ dev: 'webpack --mode development --watch', serve: 'webpack serve' }), async dir => {
    assert.strictEqual(commandFor(await planStart(dir), 8080), 'npm run serve -- --host 0.0.0.0 --port 8080');
  });
});

test('keeps a port the script sets, and skips one it can\'t read', async () => {
  await project(scripts({ dev: 'next dev -p 4000' }), async dir => {
    const plan = await planStart(dir);
    assert.deepStrictEqual(plan?.kind === 'script' && plan.fixedPort, 4000);
    assert.strictEqual(commandFor(plan, 4000), 'npm run dev -- -H 0.0.0.0');
  });
  await project(scripts({ dev: 'vite --port=abc' }), async dir => {
    assert.strictEqual(await planStart(dir), undefined);
  });
});

test('serves a plain HTML folder itself', async () => {
  await project({ 'index.html': '<h1>Hi</h1>' }, async dir => {
    assert.deepStrictEqual(await planStart(dir), { kind: 'static', dir });
  });
  // package.json for tooling only, or with a static file server Mobile Serve replaces.
  await project({ 'index.html': '', ...scripts({ lint: 'eslint .' }) }, async dir => {
    assert.strictEqual((await planStart(dir))?.kind, 'static');
  });
  await project({ 'index.html': '', ...scripts({ start: 'npx live-server --port=8081' }) }, async dir => {
    assert.strictEqual((await planStart(dir))?.kind, 'static');
  });
});

test('offers nothing for servers it doesn\'t know, or a folder without a page', async () => {
  // Serving the folder raw would skip whatever the server does.
  await project({ 'index.html': '', ...scripts({ dev: 'node server.js' }) }, async dir => {
    assert.strictEqual(await planStart(dir), undefined);
  });
  await project({ 'index.html': '', ...scripts({ dev: 'concurrently "vite" "node api.js"' }) }, async dir => {
    assert.strictEqual(await planStart(dir), undefined);
  });
  await project({ 'README.md': '' }, async dir => {
    assert.strictEqual(await planStart(dir), undefined);
  });
});

test('choosePort skips a port that only listens on localhost', async () => {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const taken = (server.address() as net.AddressInfo).port;
  try {
    assert.strictEqual(await isPortFree(taken), false);
    assert.notStrictEqual(await choosePort(taken), taken);
    // A script that insists on the taken port can't start.
    const plan = { kind: 'script', dir: '/app', script: 'dev', packageManager: 'npm', fixedPort: taken } as StartPlan;
    await assert.rejects(portFor(plan), /already taken/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
