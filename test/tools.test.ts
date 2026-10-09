import { test } from 'node:test';
import assert from 'node:assert';
import { devServerTool } from '../src/tools.ts';

test('devServerTool only accepts scripts that start a dev server', () => {
  const devServers = [
    'vite', 'vite --open', 'vite dev', 'vite serve', 'vite src', 'cross-env NODE_ENV=development vite',
    'astro dev', 'nuxt dev', 'nuxi dev', 'nuxt', 'next', 'next dev', 'next dev --turbo', 'next -p 4000',
    'ng serve', 'ng s --open', 'webpack serve', 'webpack serve --mode development', 'webpack-dev-server',
    'webpack-dev-server --open', 'vue-cli-service serve',
  ];
  // Builds, production servers and other subcommands.
  const others = [
    'vite build', 'vite preview', 'vite optimize', 'astro preview', 'astro', 'astro build', 'nuxt start',
    'nuxt preview', 'nuxt generate', 'nuxi build', 'next start', 'next build', 'next lint', 'ng build',
    'ng test', 'ng', 'webpack', 'webpack --mode development --watch', 'webpack build', 'vue-cli-service build',
  ];
  for (const script of devServers) assert.ok(devServerTool(script), script);
  for (const script of others) assert.strictEqual(devServerTool(script), undefined, script);
});

test('devServerTool accepts a host on every interface, not one that keeps the server local', () => {
  const everyInterface = ['vite --host', 'vite --host --open', 'vite --host 0.0.0.0', 'astro dev --host=0.0.0.0',
    'next dev -H 0.0.0.0', 'ng serve --host ::', 'nuxt dev --hostname 0.0.0.0'];
  for (const script of everyInterface) assert.strictEqual(devServerTool(script)?.setsHost, true, script);
  assert.strictEqual(devServerTool('vite')?.setsHost, false);
  for (const script of ['vite --host localhost', 'vite --host 127.0.0.1', 'next dev -H 192.168.1.20']) {
    assert.strictEqual(devServerTool(script), undefined, script);
  }
});
