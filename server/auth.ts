import crypto from "node:crypto";
import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getSettings, safeEqual } from "./settings.js";

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
    console.warn("TRUST_PROXY=true is not allowed (anyone could fake their IP). Use a hop count or your proxy's IP/CIDR, e.g. TRUST_PROXY=172.18.0.0/16");
    return false;
  }
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}
export const PROXY_TRUSTED = trustProxyOption() !== false;

const hmac = (data: string) => crypto.createHmac("sha256", getSettings().secret).update(data).digest("base64url");

export function makeSession(username: string) {
  const payload = `${Buffer.from(username).toString("base64url")}.${Date.now() + TTL_MS}`;
  return `${payload}.${hmac(`session:${payload}`)}`;
}

function validSession(token: string | undefined) {
  if (!token) return false;
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), hmac(`session:${payload}`))) return false;
  const [user, exp] = payload.split(".");
  return Number(exp) > Date.now() && Buffer.from(user, "base64url").toString() === getSettings().auth.username;
}

/** Signed, expiring link for one action on one show (used by phone alert buttons). */
export function signAction(action: string, id: number, ttlMs = 14 * 86_400_000) {
  const exp = Date.now() + ttlMs;
  return { exp, sig: hmac(`action:${action}:${id}:${exp}`) };
}

export function verifyAction(action: string, id: number, exp: number, sig: string) {
  return exp > Date.now() && safeEqual(sig, hmac(`action:${action}:${id}:${exp}`));
}

export function isPrivateIp(ip: string) {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

const FORWARD_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-server", "x-client-ip", "via"];

/**
 * "Disabled for local addresses": the request must come from a private IP, and must not have passed through
 * an untrusted proxy (a reverse proxy or tunnel would otherwise make the whole internet look local).
 */
export function isLocalRequest(req: FastifyRequest) {
  if (!PROXY_TRUSTED && FORWARD_HEADERS.some((h) => req.headers[h])) return false;
  // A hop-count TRUST_PROXY trusts whatever is in front blindly: no "local" bypass with it.
  if (typeof trustProxyOption() === "number") return false;
  return isHomeNetwork(req.ip) && !isProxyPeer(req.socket?.remoteAddress ?? "");
}

const v4 = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);
const inCidr = (ip: string, cidr: string) => {
  const [base, bits] = cidr.split("/");
  const a = v4(ip);
  if (!net.isIPv4(a) || !net.isIPv4(base)) return false;
  const n = (x: string) => x.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (n(a) & mask) === (n(base) & mask);
};
/**
 * The home network, for the "no password on my local network" bypass: 10/8, 192.168/16 and IPv6 ULA/link-local by
 * default. 172.16/12 (Docker's own networks, where a reverse proxy or Docker's NAT gateway would make every request
 * look local) and loopback never count, unless ANIMEARR_LOCAL_NETWORKS lists them (comma-separated CIDRs).
 */
export function isHomeNetwork(ip: string) {
  const custom = (process.env.ANIMEARR_LOCAL_NETWORKS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (custom.length) return custom.some((c) => inCidr(ip, c));
  const a = v4(ip);
  if (net.isIPv4(a)) return inCidr(a, "10.0.0.0/8") || inCidr(a, "192.168.0.0/16");
  return /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
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
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  // An IP literal can't be DNS-rebound; a home-network name is fine. (Proxies are ruled out by isLocalRequest.)
  if (net.isIP(host) || host === "localhost" || !host.includes(".") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
  return (process.env.ANIMEARR_ALLOWED_HOSTS ?? "").split(",").map((x) => x.trim().toLowerCase()).includes(host);
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

export function authState(req: FastifyRequest) {
  const a = getSettings().auth;
  const setupRequired = !a.passwordHash;
  if (setupRequired) return { setupRequired, ok: false, via: null };
  if (safeEqual(req.headers["x-api-key"] as string | undefined, getSettings().apiKey)) return { setupRequired, ok: true, via: "apikey" as const };
  if (validSession(req.cookies[COOKIE])) return { setupRequired, ok: true, via: "session" as const };
  if (a.bypassLocal && isLocalRequest(req) && hostAllowed(req)) return { setupRequired, ok: true, via: "local" as const };
  return { setupRequired, ok: false, via: null };
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
  if (st.via !== "apikey" && !csrfOk(req)) return reply.code(403).send({ error: "Cross-site request blocked" });
}

// In-memory login throttle per IP + username, with growing back-off instead of a hard lock-out.
const attempts = new Map<string, { n: number; until: number; seen: number }>();
export function loginAllowed(ip: string, user: string) {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.seen > 30 * 60_000) attempts.delete(k);
  const key = `${ip}|${user.toLowerCase()}`;
  const a = attempts.get(key) ?? { n: 0, until: 0, seen: now };
  if (a.until > now) return false;
  a.n++;
  a.seen = now;
  // 5 free tries, then 2s, 4s, 8s ... capped at 15s. Password hashing (scrypt) is the real brake on guessing; a long
  // lock would let anyone who knows the username keep the owner out (behind a proxy everyone shares one IP).
  if (a.n > 5) a.until = now + Math.min(15_000, 1000 * 2 ** (a.n - 5));
  attempts.set(key, a);
  return true;
}
export function loginSucceeded(ip: string, user: string) {
  attempts.delete(`${ip}|${user.toLowerCase()}`);
}

/** One-time token for claiming a fresh install from outside the local network; printed to the container log. */
export const SETUP_TOKEN = crypto.randomBytes(6).toString("hex");
