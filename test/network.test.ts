import { test } from 'node:test';
import assert from 'node:assert';
import type { NetworkInterfaceInfo } from 'node:os';
import { rankAddresses } from '../src/network.ts';

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
