import { test } from 'node:test';
import assert from 'node:assert';
import { renderPage } from '../src/page.ts';

test('escapes values and only allows scripts with the nonce', () => {
  const html = renderPage({
    urls: [{ name: 'en0', url: 'http://192.168.1.5:5173' }, { name: '<img onerror=x>', url: 'http://10.0.0.2:5173' }],
    qr: 'data:image/png;base64,AAAA',
    listening: true,
  }, 'abc123');
  assert.ok(!html.includes('<img onerror'));
  assert.ok(html.includes('&#60;img onerror=x&#62;'));
  assert.ok(html.includes("script-src 'nonce-abc123'"));
  assert.ok(!html.includes('unsafe-inline'));
});

test('mentions self-signed certificates only for HTTPS', () => {
  const page = (url: string) => renderPage({ urls: [{ name: 'en0', url }], qr: 'data:,', listening: true }, 'n');
  assert.ok(page('https://192.168.1.5:5173').includes('self-signed'));
  assert.ok(!page('http://192.168.1.5:5173').includes('self-signed'));
});
