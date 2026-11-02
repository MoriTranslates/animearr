/**
 * Every route (server/index.ts and server/routes/*.ts) against the auth guard, over HTTP (Fastify inject, no socket): nothing under /api/
 * answers without a login except the routes explicitly flagged public/setup, and every change (POST/PUT/PATCH/DELETE)
 * from a logged-in browser needs AnimeArr's CSRF header. A new route that forgets either fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-routes-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount, getSettings } = await import("../server/settings.js");
await setAccount("captain", "pw-test-1");
const { app, registeredRoutes } = await import("../server/index.js");

/** The only /api routes reachable without a login (each checks its own preconditions). */
const OPEN = new Set(["GET /api/status", "POST /api/auth/login"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const api = registeredRoutes.filter((r) => r.url.startsWith("/api/") && r.method !== "HEAD" && r.method !== "OPTIONS");
const concrete = (url: string) => url.replace(/:[A-Za-z_]+/g, "1").replace(/\*/g, "x");

test("the route list is complete enough to mean something", () => {
  assert.ok(api.length > 200, `found ${api.length} /api routes`);
  assert.ok(
    api.some((r) => r.url === "/api/v3/series"),
    "the Sonarr-compatible API is included",
  );
});

test("exactly the expected routes are flagged public/setup", () => {
  const flagged = api.filter((r) => r.config.public || r.config.setup).map((r) => `${r.method} ${r.url}`);
  assert.deepEqual(flagged.sort(), [...OPEN].sort());
});

test("every other /api route answers 401 without a login", async () => {
  const leaks: string[] = [];
  for (const r of api) {
    if (OPEN.has(`${r.method} ${r.url}`)) continue;
    const res = await app.inject({
      method: r.method as never,
      url: concrete(r.url),
      headers: { "x-animearr": "1", "content-type": "application/json" },
      payload: MUTATING.has(r.method) ? "{}" : undefined,
    });
    if (res.statusCode !== 401) leaks.push(`${r.method} ${r.url} → ${res.statusCode}`);
  }
  assert.deepEqual(leaks, []);
});

test("with a session, every change needs the X-AnimeArr header (CSRF); the API key doesn't", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = [login.headers["set-cookie"]]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .join("; ");
  assert.ok(cookie, "a session cookie");
  const open: string[] = [];
  for (const r of api) {
    if (!MUTATING.has(r.method) || OPEN.has(`${r.method} ${r.url}`)) continue;
    const res = await app.inject({
      method: r.method as never,
      url: concrete(r.url),
      headers: { cookie, "content-type": "application/json" },
      payload: "{}",
    });
    if (res.statusCode !== 403 || !/Cross-site/.test(res.body)) open.push(`${r.method} ${r.url} → ${res.statusCode}`);
  }
  assert.deepEqual(open, []);
  // A cross-site origin is refused even with the header.
  const r = await app.inject({
    method: "POST",
    url: "/api/system/backup",
    headers: { cookie, "x-animearr": "1", origin: "http://evil.example", host: "animearr.lan" },
  });
  assert.equal(r.statusCode, 403);
  // The API key (Sonarr-style clients) needs no CSRF header: it isn't sent by a browser on its own.
  const k = await app.inject({ method: "GET", url: "/api/v3/system/status", headers: { "x-api-key": getSettings().apiKey } });
  assert.equal(k.statusCode, 200);
});

test("backup download: never through the home-network bypass alone, never with the API key", async () => {
  const key = await app.inject({ method: "GET", url: "/api/system/backup/download", headers: { "x-api-key": getSettings().apiKey } });
  assert.equal(key.statusCode, 403);
  const keyPost = await app.inject({
    method: "POST",
    url: "/api/system/backup/download",
    headers: { "x-api-key": getSettings().apiKey },
    payload: { password: "pw-test-1" },
  });
  assert.equal(keyPost.statusCode, 403);
  // The home-network bypass: a request that counts as "local" (a 192.168 peer, no proxy headers).
  const { patchSettings } = await import("../server/settings.js");
  patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: true } }));
  try {
    const local = {
      remoteAddress: "192.168.1.20",
      headers: { host: "192.168.1.5:8484", "x-animearr": "1", "content-type": "application/json" },
    };
    const st = await app.inject({ method: "GET", url: "/api/settings", ...local });
    assert.equal(st.statusCode, 200, "the bypass itself works for normal routes");
    const get = await app.inject({ method: "GET", url: "/api/system/backup/download", ...local });
    assert.equal(get.statusCode, 403, "GET needs a real session");
    const wrong = await app.inject({ method: "POST", url: "/api/system/backup/download", ...local, payload: { password: "nope" } });
    assert.equal(wrong.statusCode, 403, "wrong password");
    const ok = await app.inject({ method: "POST", url: "/api/system/backup/download", ...local, payload: { password: "pw-test-1" } });
    assert.equal(ok.statusCode, 200, ok.body.slice(0, 200));
    assert.equal(ok.headers["content-type"], "application/gzip");
  } finally {
    patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: false } }));
  }
});
