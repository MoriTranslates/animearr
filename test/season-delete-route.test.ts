/**
 * POST /api/series/:tvdbId/seasons/:season/delete over HTTP (Fastify inject, logged in, with the CSRF header): it
 * refuses without `confirm: true`, refuses a bad season or show id, and never reaches Sonarr for any of them.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-season-route-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");

let cookie = "";
before(async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = [login.headers["set-cookie"]]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .join("; ");
});

const post = (url: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url,
    headers: { cookie, "x-animearr": "1", "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });

test("no confirm, no delete", async () => {
  for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: 1 }]) {
    const r = await post("/api/series/123/seasons/1/delete", body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.match(r.body, /Confirm the delete first/);
  }
});

test("a bad season or show id is refused before anything else", async () => {
  for (const season of ["-1", "1.5", "abc", "10000"]) {
    const r = await post(`/api/series/123/seasons/${season}/delete`, { confirm: true });
    assert.equal(r.statusCode, 400, season);
    assert.match(r.body, /Bad season/);
  }
  const bad = await post("/api/series/0/seasons/1/delete", { confirm: true });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /Bad id/);
  const unknown = await post("/api/series/123/seasons/0/delete", { confirm: true });
  assert.equal(unknown.statusCode, 404, "season 0 (specials) is a valid season; the show just isn't in the library");
});
