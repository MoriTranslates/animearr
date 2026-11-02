/**
 * Which hosts AnimeArr refuses to call for a user-entered service address. The LAN (10/8, 172.16/12, 192.168/16,
 * localhost) stays allowed on purpose: Sonarr, qBittorrent and SABnzbd live there. What's refused is link-local and
 * cloud metadata, in every spelling a URL can carry: IPv4, IPv6 link-local, and IPv4 embedded in IPv6
 * ([::ffff:169.254.169.254] arrives as [::ffff:a9fe:a9fe]; also IPv4-compatible and NAT64 forms).
 */
import net from "node:net";

const METADATA_NAMES = new Set(["metadata.google.internal", "metadata.goog", "metadata.azure.internal"]);

function v4Blocked(ip: string) {
  const [a, b, c, d] = ip.split(".").map(Number);
  return a === 0 || (a === 169 && b === 254) || (a === 100 && b === 100 && c === 100 && d === 200); // 0/8, link-local, Alibaba metadata
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail included), or null. */
export function hextets(ip: string): number[] | null {
  let s = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!net.isIPv4(tail[1])) return null;
    const [a, b, c, d] = tail[1].split(".").map(Number);
    s = s.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined ? (rest ? rest.split(":") : []) : null;
  const groups = r === null ? h : [...h, ...Array(8 - h.length - r.length).fill("0"), ...r];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => parseInt(g, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}

export function blockedOutboundHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .replace(/\.$/, "");
  if (METADATA_NAMES.has(h)) return true;
  if (net.isIPv4(h)) return v4Blocked(h);
  if (!net.isIPv6(h)) return false;
  const g = hextets(h);
  if (!g) return true; // an IPv6 literal we can't read: refuse rather than guess
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return true; // AWS IPv6 metadata
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // "::", like 0.0.0.0
  if (zeros(5) && g[5] === 0xffff && v4Blocked(v4(g[6], g[7]))) return true; // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeros(6) && g[6] >= 0x100 && v4Blocked(v4(g[6], g[7]))) return true; // ::a.b.c.d (IPv4-compatible; ::1 is loopback, allowed)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0) && v4Blocked(v4(g[6], g[7]))) return true; // NAT64
  return false;
}
