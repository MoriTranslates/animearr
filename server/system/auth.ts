import crypto from "node:crypto";
import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { checkPassword, getSettings, safeEqual } from "./settings.js";
import { hextets } from "./outbound.js";

export const COOKIE = "animearr_session";
const TTL_MS = 30 * 86_400_000;

declare module "fastify" {
  interface FastifyContextConfig {
    /** Route checks its own credentials (webhooks, signed action links). */
    public?: boolean;
    /** Reachable before an account exists. */
    setup?: boolean;
  }
}

/** TRUST_PROXY: a hop count or a comma-separated list of proxy IPs/CIDRs. "true" is refused (it trusts any X-Forwarded-For). */
export function trustProxyOption(): number | string[] | false {
  const v = (process.env.TRUST_PROXY ?? "").trim();
  if (!v || v === "false") return false;
  if (v === "true") {
    console.warn(
      "TRUST_PROXY=true is not allowed (anyone could fake their IP). Use a hop count or your proxy's IP/CIDR, e.g. TRUST_PROXY=172.18.0.0/16",
    );
    return false;
  }
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

const hmac = (data: string) => crypto.createHmac("sha256", getSettings().secret).update(data).digest("base64url");

/** The account's session generation: a token is only valid for the current one (logout bumps it; review L1). */
const sessionGen = () => Number(getSettings().auth.sessionGen) || 0;

export function makeSession(username: string) {
  const payload = `${Buffer.from(username).toString("base64url")}.${Date.now() + TTL_MS}.${sessionGen()}`;
  return `${payload}.${hmac(`session:${payload}`)}`;
}

function validSession(token: string | undefined) {
  if (!token) return false;
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), hmac(`session:${payload}`))) return false;
  // Tokens from before generations existed have two parts; they count as generation 0.
  const [user, exp, gen = "0"] = payload.split(".");
  return (
    Number(exp) > Date.now() && Number(gen) === sessionGen() && Buffer.from(user, "base64url").toString() === getSettings().auth.username
  );
}

/** Signed, expiring link for one action on one show (used by phone alert buttons). */
export function signAction(action: string, id: number, ttlMs = 14 * 86_400_000) {
  const exp = Date.now() + ttlMs;
  return { exp, sig: hmac(`action:${action}:${id}:${exp}`) };
}

export function verifyAction(action: string, id: number, exp: number, sig: string) {
  return exp > Date.now() && safeEqual(sig, hmac(`action:${action}:${id}:${exp}`));
}

const FORWARD_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-client-ip",
  "via",
];

/**
 * "Disabled for local addresses": judged on the real socket peer, never on a header. The peer must be on the home
 * network, must not be a proxy (loopback or a TRUST_PROXY entry), and the request must carry no forwarded headers at
 * all: a LAN peer sending them is a proxy or tunnel we weren't told about (cloudflared, a second reverse proxy), which
 * would otherwise make the whole internet look local. This holds with a TRUST_PROXY list too (review M1); requests
 * through a listed proxy use its headers for the client IP in logs, but never get the bypass.
 */
export function isLocalRequest(req: FastifyRequest) {
  if (FORWARD_HEADERS.some((h) => req.headers[h])) return false;
  // A hop-count TRUST_PROXY trusts whatever is in front blindly: no "local" bypass with it.
  if (typeof trustProxyOption() === "number") return false;
  const peer = req.socket?.remoteAddress ?? "";
  return isHomeNetwork(peer) && !isProxyPeer(peer);
}

/** The IPv6 groups of an address without its zone (fe80::1%eth0), or null. */
const groups6 = (ip: string) => (net.isIPv6(ip.replace(/%.*$/, "")) ? hextets(ip.replace(/%.*$/, "")) : null);
/** IPv4 for an IPv4 address or an IPv4-mapped IPv6 one (::ffff:a.b.c.d, in either spelling), else the input. */
const v4 = (ip: string) => {
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) return ip.slice(7);
  const g = groups6(ip);
  if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  return ip;
};
/**
 * A CIDR prefix length: none means a single address (max), otherwise 0..max in plain digits. Anything else is null, and
 * the entry then matches nothing (blind review A10: "/33" became a mask covering half the internet).
 */
const prefixLen = (bits: string | undefined, max: number) =>
  bits === undefined ? max : /^\d{1,3}$/.test(bits) && Number(bits) <= max ? Number(bits) : null;
/** An address or CIDR range inCidr can use. */
const validRange = (entry: string) => {
  const [base, bits, extra] = entry.split("/");
  return extra === undefined && net.isIP(base) !== 0 && prefixLen(bits, net.isIPv4(base) ? 32 : 128) !== null;
};
const warnedRanges = new Set<string>();
/** At startup: names each malformed ANIMEARR_LOCAL_NETWORKS / TRUST_PROXY entry once (it matches nothing). */
export function warnNetworkSettings(log: (msg: string) => void = console.warn) {
  const lists: [string, string[]][] = [
    [
      "ANIMEARR_LOCAL_NETWORKS",
      (process.env.ANIMEARR_LOCAL_NETWORKS ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ],
    ["TRUST_PROXY", [trustProxyOption()].flat().filter((x): x is string => typeof x === "string")],
  ];
  for (const [name, entries] of lists)
    for (const e of entries) {
      if (validRange(e) || warnedRanges.has(`${name} ${e}`)) continue;
      warnedRanges.add(`${name} ${e}`);
      log(`${name}: "${e}" isn't an IP address or range (like 192.168.0.0/16); it is ignored and matches nothing.`);
    }
}
const inCidr = (ip: string, cidr: string) => {
  const [base, bits, extra] = cidr.split("/");
  if (extra !== undefined) return false;
  const a = v4(ip);
  if (net.isIPv4(base)) {
    const len = prefixLen(bits, 32);
    if (len === null || !net.isIPv4(a)) return false;
    const n = (x: string) => x.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
    return (n(a) & mask) === (n(base) & mask);
  }
  // An IPv6 range (ANIMEARR_LOCAL_NETWORKS may list e.g. a home ULA prefix or Tailscale's fd7a:115c:a1e0::/48).
  const g = groups6(ip);
  const b = groups6(base);
  const len = prefixLen(bits, 128);
  if (!g || !b || len === null) return false;
  for (let i = 0, left = len; left > 0; i++, left -= 16) {
    const m = left >= 16 ? 0xffff : (0xffff << (16 - left)) & 0xffff;
    if ((g[i] & m) !== (b[i] & m)) return false;
  }
  return true;
};
/**
 * The home network, for the "no password on my local network" bypass: 10/8, 192.168/16 and IPv6 link-local by
 * default. 172.16/12 (Docker's own networks, where a reverse proxy or Docker's NAT gateway would make every request
 * look local), IPv6 ULA fc00::/7 (for the same reason: Docker's IPv6 networks are ULA; review L4) and loopback never
 * count, unless ANIMEARR_LOCAL_NETWORKS lists them (comma-separated IPv4 or IPv6 CIDRs, replacing the defaults).
 */
export function isHomeNetwork(ip: string) {
  const custom = (process.env.ANIMEARR_LOCAL_NETWORKS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (custom.length) return custom.some((c) => inCidr(ip, c));
  const a = v4(ip);
  if (net.isIPv4(a)) return inCidr(a, "10.0.0.0/8") || inCidr(a, "192.168.0.0/16");
  return /^fe80:/i.test(ip);
}
/**
 * Who a login-throttle entry is kept for: an IPv4 address (IPv4-mapped IPv6 included) as it is, an IPv6 one by its
 * /64, since one home or one server is handed a whole /64 and could otherwise rotate through it.
 */
export function throttleAddr(ip: string) {
  const a = v4(ip);
  if (net.isIPv4(a)) return a;
  const g = groups6(ip);
  return g
    ? `${g
        .slice(0, 4)
        .map((x) => x.toString(16))
        .join(":")}::/64`
    : ip;
}
/** The socket peer is one of the proxies listed in TRUST_PROXY (an IP or CIDR list). */
function isListedProxy(peer: string) {
  const p = v4(peer);
  const t = trustProxyOption();
  return Array.isArray(t) && t.some((c) => (c.includes("/") ? inCidr(p, c) : c === p));
}
/** The socket peer is a loopback or a trusted proxy: then it isn't the user's device. */
function isProxyPeer(peer: string) {
  const p = v4(peer);
  if (p === "127.0.0.1" || p.startsWith("127.") || peer === "::1") return true;
  return isListedProxy(peer);
}

/**
 * Guards against DNS rebinding: a local bypass only counts when the browser addressed us by IP or a LAN name.
 * The public externalUrl deliberately does NOT qualify: requests for it usually came through a proxy.
 */
export function hostAllowed(req: FastifyRequest) {
  const host = (req.headers.host ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!host) return false;
  // An IP literal can't be DNS-rebound; a home-network name is fine. (Proxies are ruled out by isLocalRequest.)
  if (
    net.isIP(host) ||
    host === "localhost" ||
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa")
  )
    return true;
  return (process.env.ANIMEARR_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .includes(host);
}

/** Blocks cross-site form posts: state-changing browser requests must carry our header and a same-origin Origin. */
export function csrfOk(req: FastifyRequest) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers["x-animearr"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * A browser request sent by some other page (review M12): Sec-Fetch-Site says so on every modern browser, also for
 * <img> and plain links; a foreign Origin covers older ones. "same-origin" (our own UI) and "none" (a typed URL or
 * bookmark) are fine, and so is a request without these headers (curl, scripts).
 */
export function fromOtherSite(req: FastifyRequest) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // an Origin we can't read ("null" from a sandboxed frame or a redirect): treat it as foreign
  }
}

export function authState(req: FastifyRequest) {
  const a = getSettings().auth;
  const setupRequired = !a.passwordHash;
  if (setupRequired) return { setupRequired, ok: false, via: null };
  // The API key as Sonarr takes it: an X-Api-Key header or an ?apikey= parameter (Jellyseerr/Overseerr send the latter;
  // logged URLs never include the query string).
  const key = (req.headers["x-api-key"] as string | undefined) ?? (req.query as { apikey?: unknown } | undefined)?.apikey;
  if (typeof key === "string" && safeEqual(key, getSettings().apiKey)) return { setupRequired, ok: true, via: "apikey" as const };
  if (validSession(req.cookies[COOKIE])) return { setupRequired, ok: true, via: "session" as const };
  if (a.bypassLocal && isLocalRequest(req) && hostAllowed(req)) return { setupRequired, ok: true, via: "local" as const };
  return { setupRequired, ok: false, via: null };
}

/**
 * What the API key may call besides the Sonarr-compatible API (/api/v3/*, which refuses file deletes itself): exactly
 * the operations docs/openapi.yaml marks `x-stability: stable`, the documented automation contract (a test keeps the
 * two equal). Everything else needs a browser session (403), so a key shared with a request app can't change settings,
 * profiles, rules or the cutover switch, rename or delete files (blind review A2: a denylist kept missing routes).
 * Keyed by method + route pattern; HEAD counts as GET.
 */
export const API_KEY_ALLOWED: ReadonlySet<string> = new Set([
  "GET /api/status",
  "GET /api/connections",
  "GET /api/rootfolders",
  "GET /api/shows",
  "GET /api/series",
  "GET /api/series/:tvdbId",
  "GET /api/add/search",
  "POST /api/add",
  "POST /api/autosearch",
  "GET /api/autosearch/jobs",
  "POST /api/search",
  "POST /api/grab",
  "GET /api/queue",
  "GET /api/history",
  "POST /api/queue/:id/remove",
  "GET /api/calendar",
  "GET /api/wanted",
  "GET /api/activity",
  "GET /api/blocklist",
  "DELETE /api/blocklist/:id",
  "GET /api/tags",
  "POST /api/tags",
  "PUT /api/series/:tvdbId/tags",
]);
function apiKeyMayCall(method: string, route: string) {
  if (route === "/api/v3" || route.startsWith("/api/v3/")) return true;
  return API_KEY_ALLOWED.has(`${method === "HEAD" ? "GET" : method} ${route}`);
}

/** onRequest hook. Decides on the matched route pattern, never the raw URL, and denies /api by default. */
export async function guard(req: FastifyRequest, reply: FastifyReply) {
  const route = req.routeOptions.url;
  if (!route || !route.startsWith("/api/")) return; // static files / SPA fallback
  const cfg = req.routeOptions.config ?? {};
  if (cfg.public) return;
  if (cfg.setup) return; // status, login and first-run setup check their own preconditions
  const st = authState(req);
  if (st.setupRequired) return reply.code(401).send({ error: "Create an account first", setupRequired: true });
  if (!st.ok) return reply.code(401).send({ error: "Login required" });
  if (st.via === "apikey" && !apiKeyMayCall(req.method, route))
    return reply.code(403).send({
      error: "Log in to do this: the API key only works for the Sonarr-compatible API and the stable automation routes",
    });
  if (st.via !== "apikey" && !csrfOk(req)) return reply.code(403).send({ error: "Cross-site request blocked" });
  // The home-network bypass has no cookie for SameSite to hold back, so a page elsewhere could make the browser send
  // requests that count as "local" (GETs included: e.g. an indexer search through GET /api/v3/release).
  if (st.via === "local" && fromOtherSite(req)) return reply.code(403).send({ error: "Cross-site request blocked" });
}

// In-memory login throttle per IP + username, with growing back-off instead of a hard lock-out.
const attempts = new Map<string, { n: number; until: number; seen: number; ip: string }>();
/** Entries per IP (not counting its shared bucket), so one address can't fill the map by rotating user names. */
const perIp = new Map<string, number>();
const FREE_TRIES = 5;
const FORGET_MS = 30 * 60_000;
/** At most this many entries (review M3: a flood of addresses or user names must not grow memory without limit). */
export const LOGIN_THROTTLE_MAX = 10_000;
/** User names one IP gets its own entry for; further names from it share one bucket per IP. */
const NAMES_PER_IP = 10;
let swept = 0;
// "u:" keys are per IP + user name, "s:" keys the IP's shared bucket; no user name can turn one into the other.
const throttleKey = (ip: string, user: string) => `u:${ip}|${user.toLowerCase().slice(0, 64)}`;
const sharedKey = (ip: string) => `s:${ip}`;
const drop = (k: string) => {
  const v = attempts.get(k);
  if (!v) return;
  attempts.delete(k);
  if (k.startsWith("s:")) return;
  const c = (perIp.get(v.ip) ?? 1) - 1;
  if (c > 0) perIp.set(v.ip, c);
  else perIp.delete(v.ip);
};
const sweep = (now: number) => {
  swept = now;
  for (const [k, v] of attempts) if (now - v.seen > FORGET_MS) drop(k);
};
/**
 * Room for a new entry when the map is full: forget expired ones, else the entry with the fewest failures, but only one
 * still within its free tries (it carries no back-off). An entry past them is never evicted, so a flood can't reset an
 * attacker's count. If every entry is past them, the new key is let through untracked (blind review A3: refusing it
 * let anyone who filled the table, easy over IPv6, lock every newcomer out, the owner included).
 */
function makeRoom(now: number) {
  sweep(now);
  if (attempts.size < LOGIN_THROTTLE_MAX) return true;
  let victim: string | null = null;
  let best: { n: number; seen: number } | null = null;
  for (const [k, v] of attempts)
    if (v.n <= FREE_TRIES && (!best || v.n < best.n || (v.n === best.n && v.seen < best.seen))) [victim, best] = [k, v];
  if (victim === null) return false;
  drop(victim);
  return true;
}
export function loginAllowed(rawIp: string, user: string, device: string | null = null) {
  const now = Date.now();
  if (device) return deviceAllowed(device, now); // a known device: its own entry, outside the main table
  const ip = throttleAddr(rawIp);
  if (now - swept > 60_000) sweep(now);
  let key = throttleKey(ip, user);
  // The account's own user name always keeps its own entry: junk names from a shared address (everyone behind one
  // proxy) must not push it into that address's throttled shared bucket. Trade-off: while an address floods made-up
  // names, the real name answers 401 where junk names get 429; the password is still throttled on its own entry.
  const own = user.toLowerCase() === getSettings().auth.username.toLowerCase();
  if (!own && !attempts.has(key) && (perIp.get(ip) ?? 0) >= NAMES_PER_IP) key = sharedKey(ip);
  let a = attempts.get(key);
  if (!a) {
    // Full of entries past their free tries: let this attempt through without tracking it. That costs nothing a
    // distributed attacker didn't already have (each new address gets 5 free tries anyway); what bounds guessing is
    // the password-check cap below (a few at a time, shared fairly), and nobody already throttled is forgotten.
    if (attempts.size >= LOGIN_THROTTLE_MAX && !makeRoom(now)) return true;
    a = { n: 0, until: 0, seen: now, ip };
    if (key !== sharedKey(ip)) perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  }
  if (a.until > now) return false;
  a.n++;
  a.seen = now;
  // 5 free tries, then 2s, 4s, 8s ... capped at 15s. Password hashing (scrypt) is the real brake on guessing; a long
  // lock would let anyone who knows the username keep the owner out (behind a proxy everyone shares one IP).
  if (a.n > FREE_TRIES) a.until = now + Math.min(15_000, 1000 * 2 ** (a.n - FREE_TRIES));
  attempts.set(key, a);
  return true;
}
export function loginSucceeded(ip: string, user: string, device: string | null = null) {
  const g = throttleAddr(ip);
  drop(throttleKey(g, user));
  // The address's shared bucket too (blind review A4): after a real login there, others behind it start fresh.
  drop(sharedKey(g));
  if (device) deviceAttempts.delete(device);
}
/** For tests: how many throttle entries are held. */
export const throttleSize = () => attempts.size;

/*
 * Known devices (blind review B4, the design Tastearr uses too): every successful login sets a signed, httpOnly
 * device cookie for a year. It grants nothing (the password is still needed) and survives logout, but it is signed
 * with the settings secret, so a password change voids it. A login carrying a valid one is throttled on that device's
 * own entry in a small separate table and checks its password in its own lane. An attacker can't make one without
 * logging in, so floods naming the real user, junk from a shared address and a full main table can't refuse a
 * browser the owner has used before, whatever its address.
 */
export const DEVICE_COOKIE = "animearr_device";
const DEVICE_TTL_MS = 365 * 86_400_000;
const DEVICE_TABLE_MAX = 256;
const deviceAttempts = new Map<string, { n: number; until: number; seen: number }>();
export function makeDevice(id: string | null = null) {
  const payload = `${id ?? crypto.randomBytes(12).toString("base64url")}.${Date.now() + DEVICE_TTL_MS}`;
  return `${payload}.${hmac(`device:${payload}`)}`;
}
/** The device id of a valid device cookie, or null. */
export function validDevice(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), hmac(`device:${payload}`))) return null;
  const [id, exp] = payload.split(".");
  return id && Number(exp) > Date.now() ? id : null;
}
/** The login throttle for a known device: its own entry, the same back-off as a user name. */
function deviceAllowed(device: string, now: number) {
  const a = deviceAttempts.get(device) ?? { n: 0, until: 0, seen: now };
  if (a.until > now) return false;
  a.n++;
  a.seen = now;
  if (a.n > FREE_TRIES) a.until = now + Math.min(15_000, 1000 * 2 ** (a.n - FREE_TRIES));
  deviceAttempts.delete(device);
  deviceAttempts.set(device, a);
  // Only the owner's own browsers can be in here; past the cap the least recently used one is forgotten.
  if (deviceAttempts.size > DEVICE_TABLE_MAX) deviceAttempts.delete(deviceAttempts.keys().next().value as string);
  return true;
}

/*
 * Password checks (scrypt) are deliberately slow; unbounded parallel checks let a burst of logins tie up the thread
 * pool. At most SCRYPT_SLOTS anonymous checks run at once. Waiting ones are served fairly between address groups
 * (round-robin; IPv6 by /64), each group waiting at most PER_GROUP_WAITING (more get 429), so a flood from many
 * addresses only delays a newcomer by about one round instead of refusing it. Nothing here depends on the user name
 * in the request: it isn't secret, and a lane picked by it was easy to fill (blind review B4). A known device has its
 * own one-slot lane; signed-in requests (the password change) skip the queue entirely (B7).
 */
const SCRYPT_SLOTS = 2;
const PER_GROUP_WAITING = 4;
const MAX_WAITING_GROUPS = 4096;
const DEVICE_LANE_WAITING = 8;
type Lane = { running: number; slots: number; waiting: Map<string, (() => void)[]> }; // insertion order = round-robin
const anonLane: Lane = { running: 0, slots: SCRYPT_SLOTS, waiting: new Map() };
const deviceLane: Lane = { running: 0, slots: 1, waiting: new Map() };
const tooMany = () => Object.assign(new Error("Too many login attempts at once, wait a few seconds and try again"), { statusCode: 429 });

/** Hands a finished check's slot to the next group in turn (which then moves to the back of the round). */
function handOver(lane: Lane) {
  const pick = lane.waiting.keys().next().value;
  if (pick === undefined) {
    lane.running--;
    return;
  }
  const q = lane.waiting.get(pick)!;
  const next = q.shift()!;
  lane.waiting.delete(pick);
  if (q.length) lane.waiting.set(pick, q);
  next();
}

export async function checkPasswordLimited(
  pw: string,
  stored: string,
  rawIp: string,
  opts: { signedIn?: boolean; device?: string | null } = {},
) {
  if (opts.signedIn) return checkPassword(pw, stored); // already authenticated: never queued behind anonymous logins
  const lane = opts.device ? deviceLane : anonLane;
  const g = opts.device ? "device" : throttleAddr(rawIp);
  if (lane.running < lane.slots) lane.running++;
  else {
    let q = lane.waiting.get(g);
    if (!q) {
      if (lane.waiting.size >= MAX_WAITING_GROUPS) throw tooMany();
      q = [];
      lane.waiting.set(g, q);
    }
    if (q.length >= (opts.device ? DEVICE_LANE_WAITING : PER_GROUP_WAITING)) throw tooMany();
    await new Promise<void>((r) => q.push(r)); // a finishing check hands its slot over
  }
  try {
    return await checkPassword(pw, stored);
  } finally {
    handOver(lane);
  }
}

export const DEFAULT_REMOTE_REFUSED = "The default password only works from your home network. Log in from home and change it first.";

const HOST_HINT = " Behind a reverse proxy: open AnimeArr by its IP or LAN name, or add the address you use to ANIMEARR_ALLOWED_HOSTS.";

/**
 * The safety rule for the default login (captain/morebooty): while the password is still the default, a login is only
 * accepted from the home network (the same check as "No password on my local network": ANIMEARR_LOCAL_NETWORKS or
 * 10/8 + 192.168/16 + IPv6 link-local, never through an untrusted proxy, addressed by IP or a LAN name).
 * Through a reverse proxy that check never passes, which made the default login impossible and the password
 * unchangeable (review L2 for a hop-count TRUST_PROXY, blind review A5 for a list). There the client is the one the
 * proxy reports in X-Forwarded-For, but only when the proxy (the socket peer) is trusted (any peer with a hop count,
 * a listed one with a list) and is itself on the home network by the same rule: Docker's 172.16/12, ULA and loopback
 * are where internet traffic arrives through Docker's gateway or docker-proxy, and a listed Docker range holds that
 * gateway too, so they can't vouch for a header unless listed in ANIMEARR_LOCAL_NETWORKS (blind review A1). Only the
 * last entry counts, the one that proxy added: a hop count larger than the real number of proxies would otherwise let
 * the client pick an earlier entry; chained proxies therefore fail closed.
 * The no-password bypass stays off through a proxy. Returns the refusal message, or null when the login may go ahead.
 */
export function defaultLoginRefusal(req: FastifyRequest, usingDefault: boolean) {
  if (!usingDefault) return null;
  if (isLocalRequest(req)) return hostAllowed(req) ? null : DEFAULT_REMOTE_REFUSED;
  const trust = trustProxyOption();
  const peer = req.socket?.remoteAddress ?? "";
  const trustedPeer = typeof trust === "number" ? trust >= 1 : isListedProxy(peer);
  // Fastify ignores a hop count (it can't verify the peer), so req.ip may be the proxy itself: read the header here.
  if (!trustedPeer || !isHomeNetwork(peer)) return DEFAULT_REMOTE_REFUSED;
  const xff = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const client = xff.at(-1) ?? "";
  if (!net.isIP(client.replace(/%.*$/, "")) || !isHomeNetwork(client)) return DEFAULT_REMOTE_REFUSED;
  return hostAllowed(req) ? null : DEFAULT_REMOTE_REFUSED + HOST_HINT;
}
