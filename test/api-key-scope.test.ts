/**
 * What the API key and the calendar token can do, over HTTP against the real app (review H4).
 * - The iCal feed takes its own read-only token, never the API key, and that token opens nothing else.
 * - The API key keeps the Sonarr-compatible API and the documented automation routes, but is refused (403) on the
 *   browser-only routes that change settings, sign-in or connection secrets, or delete files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-keyscope-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount, getSettings, regenerateApiKey } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app, registeredRoutes } = await import("../server/index.js");
const { API_KEY_REFUSED } = await import("../server/system/auth.js");

const FEED = "/feed/calendar/animearr.ics";
const concrete = (url: string) => url.replace(/:[A-Za-z_]+/g, "1");
const key = () => ({ "x-api-key": getSettings().apiKey });

async function sessionCookie() {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  assert.equal(login.statusCode, 200, login.body);
  return [login.headers["set-cookie"]]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .join("; ");
}

async function calendarToken(cookie: string) {
  const r = await app.inject({ method: "GET", url: "/api/calendar/ical-token", headers: { cookie } });
  assert.equal(r.statusCode, 200, r.body);
  const { token } = r.json() as { token: string };
  assert.ok(typeof token === "string" && token.length >= 20, "a token");
  return token;
}

test("the calendar feed has its own token, separate from the API key", async () => {
  const cookie = await sessionCookie();
  const token = await calendarToken(cookie);
  assert.notEqual(token, getSettings().apiKey);
  assert.ok(!token.includes(getSettings().apiKey));
  const ok = await app.inject({ method: "GET", url: `${FEED}?token=${token}&unmonitored=true` });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(String(ok.headers["content-type"]), /^text\/calendar/);
  assert.equal((await app.inject({ method: "GET", url: FEED })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: `${FEED}?token=nope` })).statusCode, 401);
});

test("old calendar links with the API key no longer open the feed", async () => {
  const k = getSettings().apiKey;
  assert.equal((await app.inject({ method: "GET", url: `${FEED}?apikey=${k}` })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: FEED, headers: { "x-api-key": k } })).statusCode, 401);
});

test("the calendar token opens nothing but the feed", async () => {
  const token = await calendarToken(await sessionCookie());
  const urls = ["/api/calendar", "/api/settings", "/api/v3/calendar", "/api/v3/system/status", "/api/status"];
  for (const url of urls) {
    for (const r of [
      await app.inject({ method: "GET", url: `${url}?apikey=${token}` }),
      await app.inject({ method: "GET", url, headers: { "x-api-key": token } }),
      await app.inject({ method: "GET", url: `${url}?token=${token}` }),
    ]) {
      if (url === "/api/status") assert.notEqual((r.json() as { via?: string }).via, "apikey", url);
      else assert.equal(r.statusCode, 401, `${url} must refuse the calendar token`);
    }
  }
  const put = await app.inject({ method: "PUT", url: "/api/settings", headers: { "x-api-key": token }, payload: {} });
  assert.equal(put.statusCode, 401);
});

test("a new API key also replaces the calendar token (the way to revoke a shared calendar link)", async () => {
  const cookie = await sessionCookie();
  const before = await calendarToken(cookie);
  regenerateApiKey();
  const after = await calendarToken(cookie);
  assert.notEqual(after, before);
  assert.equal((await app.inject({ method: "GET", url: `${FEED}?token=${before}` })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: `${FEED}?token=${after}` })).statusCode, 200);
});

test("the API key is refused on settings, sign-in, connection secrets and file deletes", async () => {
  const routes = new Set(registeredRoutes.map((r) => `${r.method} ${r.url}`));
  for (const r of API_KEY_REFUSED) assert.ok(routes.has(r), `${r} is a real route`);
  for (const must of [
    "PUT /api/settings",
    "PUT /api/auth/account",
    "PUT /api/notify/channels",
    "POST /api/indexers",
    "PUT /api/clients/:id",
    "POST /api/episodes/delete",
    "POST /api/series/:tvdbId/seasons/:season/delete",
    "POST /api/recycle/animearr/empty",
  ])
    assert.ok(API_KEY_REFUSED.has(must), `${must} is refused for the API key`);
  const open: string[] = [];
  for (const r of API_KEY_REFUSED) {
    const [method, url] = r.split(" ");
    const res = await app.inject({
      method: method as never,
      url: concrete(url),
      headers: { ...key(), "content-type": "application/json" },
      payload: JSON.stringify({ confirm: true, episodeIds: [1], tvdbId: 1 }),
    });
    if (res.statusCode !== 403) open.push(`${r} → ${res.statusCode}`);
  }
  assert.deepEqual(open, []);
  // Through ?apikey= too.
  const q = await app.inject({ method: "PUT", url: `/api/settings?apikey=${getSettings().apiKey}`, payload: {} });
  assert.equal(q.statusCode, 403);
});

test("a browser session can still use those routes", async () => {
  const cookie = await sessionCookie();
  const r = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers: { cookie, "x-animearr": "1", "content-type": "application/json" },
    payload: "{}",
  });
  assert.equal(r.statusCode, 200, r.body);
});

test("integrations keep working with the API key", async () => {
  const st = await app.inject({ method: "GET", url: "/api/status", headers: key() });
  assert.equal((st.json() as { via: string }).via, "apikey");
  for (const url of ["/api/v3/system/status", "/api/v3/series", "/api/calendar", "/api/connections", "/api/settings"]) {
    const r = await app.inject({ method: "GET", url, headers: key() });
    assert.equal(r.statusCode, 200, `${url}: ${r.body.slice(0, 200)}`);
  }
  const q = await app.inject({ method: "GET", url: `/api/v3/system/status?apikey=${getSettings().apiKey}` });
  assert.equal(q.statusCode, 200, "?apikey= (Overseerr/Jellyseerr) still works");
  const tag = await app.inject({
    method: "POST",
    url: "/api/tags",
    headers: { ...key(), "content-type": "application/json" },
    payload: { label: "airing" },
  });
  assert.equal(tag.statusCode, 200, tag.body);
});
