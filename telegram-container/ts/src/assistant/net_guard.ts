import { lookup } from "node:dns/promises";

let hostLookup: typeof lookup = lookup;

/** Tests: swap the DNS lookup so public-host checks work offline (sandbox). */
export function setHostLookupForTests(fn: typeof lookup | null): void {
  hostLookup = fn ?? lookup;
}
import { isIP } from "node:net";

type Cidr = { base: number; bits: number };

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function cidr(base: string, bits: number): Cidr {
  return { base: ipv4ToInt(base), bits };
}

const PRIVATE_V4_CIDRS: Cidr[] = [
  cidr("0.0.0.0", 8),
  cidr("10.0.0.0", 8),
  cidr("100.64.0.0", 10), // shared address space (carrier-grade NAT)
  cidr("127.0.0.0", 8),
  cidr("169.254.0.0", 16), // link-local, covers the 169.254.169.254 cloud metadata address
  cidr("172.16.0.0", 12),
  cidr("192.0.0.0", 24),
  cidr("192.168.0.0", 16),
  cidr("198.18.0.0", 15),
  cidr("224.0.0.0", 4), // multicast
  cidr("240.0.0.0", 4), // reserved
];

function inCidr(ipInt: number, range: Cidr): boolean {
  const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
  return (ipInt & mask) === (range.base & mask);
}

function isDisallowedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return PRIVATE_V4_CIDRS.some((range) => inCidr(value, range));
}

function isDisallowedIpv6(ip: string): boolean {
  const lowered = ip.toLowerCase();
  if (lowered === "::1" || lowered === "::") {
    return true;
  }
  if (lowered.startsWith("fe80:") || lowered.startsWith("fc") || lowered.startsWith("fd")) {
    return true; // link-local and unique-local
  }
  if (lowered.startsWith("::ffff:")) {
    const mapped = lowered.slice("::ffff:".length);
    return isIP(mapped) === 4 && isDisallowedIpv4(mapped);
  }
  return false;
}

export function isDisallowedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isDisallowedIpv4(ip);
  }
  if (version === 6) {
    return isDisallowedIpv6(ip);
  }
  return true; // not a parseable IP; treat as disallowed
}

/**
 * Resolves a hostname (or passes through an already-literal IP) and refuses
 * loopback, link-local, cloud-metadata and other private-range addresses.
 * Called again after every redirect hop, not just the first URL.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      throw new Error(`refusing to fetch a private address: ${hostname}`);
    }
    return;
  }
  const records = await hostLookup(hostname, { all: true });
  if (records.length === 0) {
    throw new Error(`could not resolve host: ${hostname}`);
  }
  for (const record of records) {
    if (isDisallowedIp(record.address)) {
      throw new Error(`refusing to fetch a private address: ${hostname} -> ${record.address}`);
    }
  }
}

export function assertFetchableUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }
}
