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
