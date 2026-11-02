import crypto from "node:crypto";
import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getSettings, safeEqual } from "./settings.js";
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
const inCidr = (ip: string, cidr: string) => {
  const [base, bits] = cidr.split("/");
  const a = v4(ip);
  if (net.isIPv4(base)) {
    if (!net.isIPv4(a)) return false;
    const n = (x: string) => x.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (n(a) & mask) === (n(base) & mask);
  }
  // An IPv6 range (ANIMEARR_LOCAL_NETWORKS may list e.g. a home ULA prefix or Tailscale's fd7a:115c:a1e0::/48).
  const g = groups6(ip);
  const b = groups6(base);
  const len = bits === undefined ? 128 : Number(bits);
  if (!g || !b || !Number.isInteger(len) || len < 0 || len > 128) return false;
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
/** The socket peer is a loopback or a trusted proxy: then it isn't the user's device. */
function isProxyPeer(peer: string) {
  const p = v4(peer);
  if (p === "127.0.0.1" || p.startsWith("127.") || peer === "::1") return true;
  const t = trustProxyOption();
  return Array.isArray(t) && t.some((c) => (c.includes("/") ? inCidr(p, c) : c === p));
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
 * Browser-only routes the API key may not call (403): they change settings, sign-in or connection secrets, or delete
 * files. The key is for the Sonarr-compatible API and automation (docs/API.md marks those routes stable); none of these
 * are, so a leaked or over-shared key can't rewire AnimeArr or delete a library. A few more routes refuse it in their
 * own handler (API key regenerate, local-network mode, backups, cache rebuild). Keyed by method + route pattern.
 */
export const API_KEY_REFUSED: ReadonlySet<string> = new Set([
  "PUT /api/settings",
  "PUT /api/auth/account",
  "PUT /api/notify/channels",
  "POST /api/indexers",
  "PUT /api/indexers/:id",
  "DELETE /api/indexers/:id",
  "POST /api/jackett/add",
  "POST /api/clients",
  "PUT /api/clients/:id",
  "DELETE /api/clients/:id",
  "PUT /api/clients/:id/prefs",
  "PUT /api/wizard",
  "POST /api/wizard/arr-apply",
  "PUT /api/downloads/allow-delete",
  "POST /api/episodes/delete",
  "POST /api/series/:tvdbId/seasons/:season/delete",
  "POST /api/recycle/animearr/empty",
]);

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
  if (st.via === "apikey" && API_KEY_REFUSED.has(`${req.method} ${route}`))
    return reply.code(403).send({ error: "Log in to do this: the API key can't change settings or delete files" });
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
 * attacker's count; if every entry is past them, the new key is refused until some expire (fail closed).
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
export function loginAllowed(rawIp: string, user: string) {
  const ip = throttleAddr(rawIp);
  const now = Date.now();
  if (now - swept > 60_000) sweep(now);
  let key = throttleKey(ip, user);
  if (!attempts.has(key) && (perIp.get(ip) ?? 0) >= NAMES_PER_IP) key = sharedKey(ip);
  let a = attempts.get(key);
  if (!a) {
    if (attempts.size >= LOGIN_THROTTLE_MAX && !makeRoom(now)) return false;
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
export function loginSucceeded(ip: string, user: string) {
  drop(throttleKey(throttleAddr(ip), user));
}
/** For tests: how many throttle entries are held. */
export const throttleSize = () => attempts.size;

export const DEFAULT_REMOTE_REFUSED = "The default password only works from your home network. Log in from home and change it first.";

const HOST_HINT = " Behind a reverse proxy: open AnimeArr by its IP or LAN name, or add the address you use to ANIMEARR_ALLOWED_HOSTS.";

/** A peer that can be the user's own reverse proxy: loopback or a private address (Docker networks included). */
function nearPeer(peer: string) {
  return ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7", "fe80::/10"].some((c) => inCidr(peer, c));
}

/**
 * The safety rule for the default login (captain/morebooty): while the password is still the default, a login is only
 * accepted from the home network (the same check as "No password on my local network": ANIMEARR_LOCAL_NETWORKS or
 * 10/8 + 192.168/16 + IPv6 link-local, never through an untrusted proxy, addressed by IP or a LAN name).
 * With a hop-count TRUST_PROXY that check is always off, which made the default login impossible everywhere and the
 * password unchangeable (review L2). There the client is the one the trusted proxy reports in X-Forwarded-For,
 * accepted when it is on the home network and the proxy itself is a nearby peer: a direct internet peer can't claim a
 * LAN address, and a proxy reports the real client. The no-password bypass stays off with a hop count.
 * Returns the refusal message, or null when the login may go ahead.
 */
export function defaultLoginRefusal(req: FastifyRequest, usingDefault: boolean) {
  if (!usingDefault) return null;
  if (isLocalRequest(req)) return hostAllowed(req) ? null : DEFAULT_REMOTE_REFUSED;
  const hops = trustProxyOption();
  if (typeof hops !== "number" || hops < 1) return DEFAULT_REMOTE_REFUSED;
  // Fastify ignores a hop count (it can't verify the peer), so req.ip is the proxy: read the client the way the hop
  // count describes it, the hops-th address from the right of X-Forwarded-For, and only from a nearby peer.
  const xff = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const client = xff.length >= hops ? xff[xff.length - hops] : "";
  if (!nearPeer(req.socket?.remoteAddress ?? "") || !net.isIP(client.replace(/%.*$/, "")) || !isHomeNetwork(client))
    return DEFAULT_REMOTE_REFUSED;
  return hostAllowed(req) ? null : DEFAULT_REMOTE_REFUSED + HOST_HINT;
}
