import * as os from 'node:os';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { execQuiet } from './exec.ts';

// Loopback, VPN, virtual machine, container, Hyper-V/WSL and Apple peer-to-peer interfaces.
const SKIP_INTERFACE = /^(lo|utun|tun|tap|wg|tailscale|zt|bridge|br-|virbr|docker|veth|cni|flannel|podman|vmnet|vboxnet|vEthernet|VirtualBox|VMware|llw|awdl|anpi|ap\d)/i;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Self-assigned when there's no DHCP server; a phone can't use it.
const LINK_LOCAL_IP = /^169\.254\./;
const PROBE_TIMEOUT_MS = 1000;

export interface LanAddress {
  // Network interface, e.g. en0.
  name: string;
  address: string;
}

// Orders addresses so the most likely one comes first: the interface the default route uses,
// then private (home/office LAN) addresses.
export function rankAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, defaultInterface?: string,
): LanAddress[] {
  const addresses: LanAddress[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (SKIP_INTERFACE.test(name)) continue;
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal && !LINK_LOCAL_IP.test(info.address)) {
        addresses.push({ name, address: info.address });
      }
    }
  }
  const rank = (a: LanAddress) => (a.name === defaultInterface ? 0 : 1) * 2 + (PRIVATE_IP.test(a.address) ? 0 : 1);
  return addresses.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// The interface the default route goes through, when it can be found.
async function defaultRouteInterface(): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    return /interface:\s*(\S+)/.exec((await execQuiet('route', ['-n', 'get', 'default'])) ?? '')?.[1];
  }
  if (process.platform === 'linux') {
    return /\bdev\s+(\S+)/.exec((await execQuiet('ip', ['route', 'show', 'default'])) ?? '')?.[1];
  }
  return undefined;
}

// IPv4 addresses a phone on the same network could use, the most likely one first.
export async function getLanAddresses(): Promise<LanAddress[]> {
  return rankAddresses(os.networkInterfaces(), await defaultRouteInterface());
}

// Whether something accepts TCP connections on host:port.
export function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Whether the server on host:port completes a TLS handshake. Dev certificates are usually self-signed.
export function speaksTls(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, timeout: PROBE_TIMEOUT_MS });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.once('secureConnect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
}

/**
 * Checks the server from this computer: whether it accepts connections on `host` (which doesn't
 * prove a phone can, since the firewall doesn't filter local connections), and whether it serves HTTPS.
 * The protocol is checked on loopback when `host` doesn't answer, so it's right even for a
 * server that only listens on localhost.
 */
export async function probe(host: string, port: number): Promise<{ listening: boolean; https: boolean }> {
  const listening = await canConnect(host, port);
  for (const candidate of listening ? [host] : ['127.0.0.1', '::1']) {
    if (candidate === host || await canConnect(candidate, port)) {
      return { listening, https: await speaksTls(candidate, port) };
    }
  }
  return { listening, https: false };
}
