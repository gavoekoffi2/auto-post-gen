import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Addresses a fetch made on a user's behalf must never reach, whatever name
// resolved to them: loopback, private, link-local (cloud metadata), CGNAT,
// multicast and reserved ranges, in IPv4 and IPv6 (IPv4-mapped included).
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv6");
}

/** True for any address that is not a public unicast one. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NON_PUBLIC.check(address, "ipv4");
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d), including the hex spelling the URL
    // parser normalises it to (::ffff:7f00:1): judged as the IPv4 it is.
    const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (dotted) return NON_PUBLIC.check(dotted[1]!, "ipv4");
    const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return NON_PUBLIC.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
    }
    return NON_PUBLIC.check(address, "ipv6");
  }
  return true;
}

/**
 * A DNS lookup that refuses non-public answers. Used as the socket's own
 * resolver, so the address checked is the address connected to: a name that
 * resolves to a public address when validated and to 127.0.0.1 when fetched
 * (DNS rebinding) cannot slip between the two.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as LookupAddress[];
    const blocked = list.find((a) => isNonPublicAddress(a.address));
    if (blocked || list.length === 0) {
      const error = Object.assign(new Error(`refused non-public address for ${hostname}`), {
        code: "ENONPUBLIC",
      });
      return callback(error, "", 4);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    }
    callback(null, list[0]!.address, list[0]!.family);
  });
};

