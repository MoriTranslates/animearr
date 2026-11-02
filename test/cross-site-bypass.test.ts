/**
 * With "No password on my local network" on, a web page the user visits must not use the browser to call AnimeArr
 * (review M12). Cross-site requests can't read the answer (no CORS, no JSONP, no framing), but a GET can still cause
 * work, e.g. an indexer search through GET /api/v3/release from an <img> tag. Requests let in by the home-network
 * bypass must be same-origin (Sec-Fetch-Site) or come from no page at all (typed URL, curl), and a present Origin must
 * match the Host. Sessions (SameSite=Strict cookie) and the API key are unaffected.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-xsite-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;
delete process.env.ANIMEARR_LOCAL_NETWORKS;

const { setAccount, patchSettings, getSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");

before(() => patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: true } })));

const HOST = "192.168.1.5:8484";
const lan = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, remoteAddress: "192.168.1.20", headers: { host: HOST, ...headers } }).then((r) => r.statusCode);

test("a cross-site page can't use the home-network bypass, even for a GET", async () => {
  assert.equal(await lan("/api/settings", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" }), 403);
  assert.equal(await lan("/api/v3/release?seriesId=1", { "sec-fetch-site": "cross-site" }), 403, "an indexer search from an <img>");
  assert.equal(await lan("/api/settings", { "sec-fetch-site": "same-site" }), 403, "another service on the same address");
  assert.equal(await lan("/api/settings", { origin: "http://evil.example" }), 403, "a foreign Origin (older browsers)");
});

test("AnimeArr's own pages, typed URLs and scripts still get the bypass", async () => {
  assert.equal(await lan("/api/settings", { "sec-fetch-site": "same-origin" }), 200, "the web UI");
  assert.equal(await lan("/api/settings", { "sec-fetch-site": "none" }), 200, "a typed URL or bookmark");
  assert.equal(await lan("/api/settings"), 200, "curl / scripts send no fetch metadata");
  assert.equal(await lan("/api/settings", { origin: `http://${HOST}` }), 200, "a matching Origin");
});

test("DNS rebinding stays refused, and the API key and sessions are unaffected", async () => {
  assert.equal(await lan("/api/settings", { host: "rebind.evil.example" }), 401, "a foreign Host gets no bypass");
  const key = await app.inject({
    method: "GET",
    url: "/api/settings",
    remoteAddress: "203.0.113.9",
    headers: { "x-api-key": getSettings().apiKey, "sec-fetch-site": "cross-site" },
  });
  assert.equal(key.statusCode, 200, "the API key isn't a browser credential");
});
