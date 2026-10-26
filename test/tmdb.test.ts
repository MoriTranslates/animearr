/** TMDB credential: v3 API key (?api_key=) or Read Access Token (Bearer), auto-detected; redacted in logs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { tmdbFetch, tmdbKeyKind, testTmdb } = await import("../server/catalog.js");
const { redactUrl } = await import("../server/arr/http.js");

const KEY = "0123456789abcdef0123456789abcdef";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ4eXoifQ.c2lnbmF0dXJlX3BhcnQ";

test("auto-detects the credential and sends it the right way", async () => {
  assert.equal(tmdbKeyKind(KEY), "apiKey");
  assert.equal(tmdbKeyKind(JWT), "token");
  assert.equal(tmdbKeyKind("nope"), "unknown");
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
  await tmdbFetch("/configuration", KEY, f);
  await tmdbFetch("/tv/1/season/1?language=en-US", JWT, f);
  assert.match(calls[0].url, /\/3\/configuration\?api_key=0123/);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, undefined);
  assert.equal(calls[1].url, "https://api.themoviedb.org/3/tv/1/season/1?language=en-US");
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, `Bearer ${JWT}`);
  assert.deepEqual(await testTmdb(JWT, f), { ok: true, kind: "token" });
  await assert.rejects(testTmdb(KEY, (async () => new Response("", { status: 401 })) as unknown as typeof fetch), /refused/);
});

test("both forms are redacted in logs", () => {
  assert.equal(redactUrl(`GET /3/x?api_key=${KEY}&a=1`), "GET /3/x?api_key=***&a=1");
  assert.equal(redactUrl(`Authorization: Bearer ${JWT}`), "Authorization: Bearer ***");
  assert.equal(redactUrl(`token ${JWT} leaked`), "token *** leaked");
});
