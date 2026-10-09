import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import * as path from 'node:path';
import { canConnect, probe, rankAddresses } from '../src/network.ts';

const ipv4 = (address: string): NetworkInterfaceInfo[] =>
  [{ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }];

test('skips Hyper-V, WSL and VirtualBox adapters', () => {
  const windows = rankAddresses({ 'vEthernet (WSL)': ipv4('172.20.0.1'), 'Wi-Fi': ipv4('192.168.1.20'), Ethernet: ipv4('10.0.0.5') });
  assert.deepStrictEqual(windows.map(a => a.name), ['Ethernet', 'Wi-Fi']);
  const linux = rankAddresses({ vboxnet0: ipv4('192.168.56.1'), wg0: ipv4('10.8.0.2'), wlp2s0: ipv4('192.168.1.20') });
  assert.deepStrictEqual(linux.map(a => a.name), ['wlp2s0']);
  // Only skipped as loopback when it's called just that.
  const loopback = rankAddresses({ lo: ipv4('192.168.9.9'), lo0: ipv4('192.168.9.8'), 'Local Area Connection': ipv4('192.168.1.20') });
  assert.deepStrictEqual(loopback.map(a => a.name), ['Local Area Connection']);
});

test('puts the default route interface first, then private addresses', () => {
  const interfaces = { en0: ipv4('192.168.1.20'), en5: ipv4('10.0.0.5'), en7: ipv4('8.8.4.4'), en9: ipv4('169.254.3.3') };
  assert.deepStrictEqual(rankAddresses(interfaces, 'en5').map(a => a.name), ['en5', 'en0', 'en7']);
  assert.deepStrictEqual(rankAddresses(interfaces).map(a => a.name), ['en0', 'en5', 'en7']);
});

// A server on 127.0.0.1 only, like a dev server that hasn't been told to listen on the network.
async function listenLocally(server: net.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

// A self-signed certificate, made with openssl; undefined when openssl isn't installed.
async function selfSigned(): Promise<{ key: Buffer; cert: Buffer } | undefined> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-serve-'));
  try {
    const ok = await new Promise<boolean>(resolve => execFile('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ], err => resolve(!err)));
    if (!ok) return undefined;
    return { key: await fs.readFile(path.join(dir, 'key.pem')), cert: await fs.readFile(path.join(dir, 'cert.pem')) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('canConnect tells a listening port from a closed one', async () => {
  const server = net.createServer(socket => socket.end());
  const port = await listenLocally(server);
  try {
    assert.strictEqual(await canConnect('127.0.0.1', port), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.strictEqual(await canConnect('127.0.0.1', port), false);
});

test('probe reports an HTTP server that only listens on localhost', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const port = await listenLocally(server);
  try {
    // Nothing answers on the "network" address, but the protocol is still checked on loopback.
    assert.deepStrictEqual(await probe('192.0.2.1', port), { listening: false, https: false });
    assert.deepStrictEqual(await probe('127.0.0.1', port), { listening: true, https: false });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('probe detects HTTPS with a self-signed certificate', async t => {
  const credentials = await selfSigned();
  if (!credentials) return t.skip('openssl is not installed');
  const server = https.createServer(credentials, (_req, res) => res.end('ok'));
  const port = await listenLocally(server);
  try {
    assert.deepStrictEqual(await probe('192.0.2.1', port), { listening: false, https: true });
    assert.deepStrictEqual(await probe('127.0.0.1', port), { listening: true, https: true });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
