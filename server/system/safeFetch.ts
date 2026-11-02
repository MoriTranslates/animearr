/**
 * fetch() for every outbound call that carries a credential (an API key header, a token, a password, a key in the query
 * string, a session cookie). Plain fetch follows redirects by itself and re-sends custom headers such as X-Api-Key or
 * X-Plex-Token to wherever the server points, another host or a cloud-metadata address included; it also turns a
 * POST answered with 301/302/303 into a GET without saying so. Here redirects are followed by hand:
 *
 * - only to the same origin (scheme + host + port) as the first request; a redirect elsewhere is refused with an error
 *   naming the new address, so the user can update the saved URL;
 * - (`crossOrigin: "strip"`, for a call site that needs it and says why) or followed elsewhere with no headers and no
 *   body: only a GET/HEAD, only the URL the server itself handed out;
 * - every hop is checked again against the outbound address rules (no link-local or cloud-metadata hosts);
 * - a write (anything but GET/HEAD) answered with 301/302/303 is refused rather than silently turned into a read;
 *   307/308 repeat the same method and body (same origin only);
 * - at most `maxRedirects` hops.
 */
import { blockedOutboundHost } from "./outbound.js";

export class OutboundRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRefused";
  }
}

export interface SafeFetchOpts {
  /** The fetch to use (tests inject one). Defaults to the global fetch at call time. */
  fetch?: typeof fetch;
  /** Hops followed before giving up (default 5). */
  maxRedirects?: number;
  /** "refuse" (default): no redirect off the first origin. "strip": follow it with no headers or body (GET/HEAD only). */
  crossOrigin?: "refuse" | "strip";
  /** Extra rule for every hop (an image fetch only goes to known image hosts). False refuses the hop. */
  allowHop?: (u: URL) => boolean;
  /** Return this redirect unfollowed (a download link that redirects to a magnet: link). */
  stopAt?: (u: URL) => boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Headers kept on a cross-origin hop: none of them can carry a credential. */
const SAFE_HEADERS = new Set(["accept", "accept-encoding", "accept-language", "user-agent"]);

const where = (u: URL) => `${u.protocol}//${u.host}`;

function checkTarget(u: URL, opts: SafeFetchOpts, first: boolean) {
  const what = first ? "That address" : `The redirect to ${where(u)}`;
  if (!/^https?:$/.test(u.protocol)) throw new OutboundRefused(`${what} isn't http(s); not followed`);
  if (!first && (u.username || u.password)) throw new OutboundRefused(`${what} carries a username or password; not followed`);
  if (blockedOutboundHost(u.hostname)) throw new OutboundRefused(`${what} points at a link-local or cloud-metadata host; not allowed`);
  if (opts.allowHop && !opts.allowHop(u)) throw new OutboundRefused(`${what} isn't an allowed host; not followed`);
}

function safeHeaders(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    if (SAFE_HEADERS.has(k.toLowerCase())) out[k] = v;
  });
  return out;
}

export async function safeFetch(url: string | URL, init: RequestInit = {}, opts: SafeFetchOpts = {}): Promise<Response> {
  const f = opts.fetch ?? globalThis.fetch;
  const max = opts.maxRedirects ?? 5;
  const method = (init.method ?? "GET").toUpperCase();
  const start = new URL(String(url));
  checkTarget(start, opts, true);
  let cur = start;
  let req: RequestInit = { ...init, redirect: "manual" };
  let stripped = false;
  for (let hop = 0; ; hop++) {
    const res = await f(cur.href, req);
    const loc = REDIRECTS.has(res.status) ? res.headers?.get("location") : null;
    if (!loc) return res;
    let next: URL;
    try {
      next = new URL(loc, cur);
    } catch {
      throw new OutboundRefused(`${where(cur)} redirected to an address that isn't a valid URL`);
    }
    if (opts.stopAt?.(next)) return res;
    // The redirect's own body is never read: release the connection. Losing an error here is harmless (it only frees a socket).
    await res.body?.cancel().catch(() => undefined);
    if (hop >= max) throw new OutboundRefused(`${where(start)} redirected more than ${max} times; giving up`);
    if (method !== "GET" && method !== "HEAD" && res.status !== 307 && res.status !== 308)
      throw new OutboundRefused(
        `${where(cur)} answered a ${method} with a redirect (HTTP ${res.status}); not followed, so the request isn't silently turned into a GET`,
      );
    checkTarget(next, opts, false);
    if (!stripped && next.origin !== start.origin) {
      if (opts.crossOrigin !== "strip")
        throw new OutboundRefused(
          `${where(start)} redirected to another address (${where(next)}); credentials are never sent there. If the service moved, update its address in AnimeArr`,
        );
      if (method !== "GET" && method !== "HEAD")
        throw new OutboundRefused(`${where(cur)} redirected a ${method} to another address (${where(next)}); not followed`);
      // From here on (this hop and every later one, even back to the first origin) nothing but harmless headers is sent.
      req = { method, headers: safeHeaders(init.headers), signal: init.signal, redirect: "manual" };
      stripped = true;
    }
    cur = next;
  }
}
