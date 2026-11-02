/** Log viewer: ring buffer, level filter, search, file rotation, and secret redaction. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { record, getLogs, resetLogs, fromPino, flushLogs, logText, LOG_FILE } = await import("../server/system/logs.js");
const { redactText } = await import("../server/system/redact.js");

test("the ring keeps the newest 2000 lines", () => {
  resetLogs();
  for (let i = 0; i < 2100; i++) record("info", `line ${i}`);
  const r = getLogs({ limit: 5000 });
  assert.equal(r.total, 2000);
  assert.equal(r.entries[0].msg, "line 100");
  assert.equal(r.entries.at(-1)!.msg, "line 2099");
  assert.equal(
    getLogs({ limit: 3 })
      .entries.map((e) => e.msg)
      .join(","),
    "line 2097,line 2098,line 2099",
  );
});

test("the level filter shows that level and worse; search ignores case", () => {
  resetLogs();
  record("debug", "tick");
  record("info", "Synced the Library");
  record("warn", "indexer slow");
  record("error", "grab failed");
  assert.deepEqual(
    getLogs({ level: "error" }).entries.map((e) => e.msg),
    ["grab failed"],
  );
  assert.deepEqual(
    getLogs({ level: "warn" }).entries.map((e) => e.level),
    ["warn", "error"],
  );
  assert.equal(getLogs({ level: "info" }).matched, 3);
  assert.equal(getLogs({ level: "debug" }).matched, 4);
  assert.equal(getLogs({ level: "nonsense" }).matched, 4, "an unknown level shows everything");
  assert.deepEqual(
    getLogs({ q: "LIBRARY" }).entries.map((e) => e.msg),
    ["Synced the Library"],
  );
  assert.equal(getLogs({ level: "warn", q: "library" }).matched, 0);
});

test("pino lines become readable entries; the viewer's own polling is left out", () => {
  const a = fromPino(
    JSON.stringify({
      level: 30,
      time: 1000,
      msg: "incoming request",
      reqId: "req-1",
      req: { method: "GET", url: "/api/shows", remoteAddress: "1.2.3.4" },
    }),
  )!;
  assert.deepEqual([a.level, a.msg, a.at], ["info", "incoming request GET /api/shows", 1000]);
  const b = fromPino(
    JSON.stringify({ level: 30, msg: "request completed", reqId: "req-1", res: { statusCode: 200 }, responseTime: 12.4 }),
  )!;
  assert.equal(b.msg, "request completed 200 (12 ms)");
  assert.equal(
    fromPino(JSON.stringify({ level: 30, msg: "incoming request", reqId: "req-2", req: { method: "GET", url: "/api/system/logs" } })),
    null,
  );
  assert.equal(fromPino(JSON.stringify({ level: 30, msg: "request completed", reqId: "req-2", res: { statusCode: 200 } })), null);
  assert.equal(
    fromPino(JSON.stringify({ level: 50, msg: "boom", err: { message: "bad", stack: "Error: bad\n    at x" } }))!.level,
    "error",
  );
  assert.equal(fromPino("plain text line")!.msg, "plain text line");
});

test("secrets never reach the buffer, the file or the download", () => {
  resetLogs();
  record("info", "GET https://idx.example.com/api?t=search&apikey=SECRET123&q=frieren");
  record("warn", `notify failed: POST https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012/sendMessage`);
  record("error", `login {"username":"captain","password":"hunter2hunter2"}`);
  record("info", "fetch https://user:p4ss@host.example.com/x with Authorization: Bearer abc.DEF-123");
  record("info", "hook https://discord.com/api/webhooks/1234567/AbCdEfGhIj_klmn posted");
  flushLogs();
  const all = JSON.stringify(getLogs().entries) + fs.readFileSync(LOG_FILE, "utf8") + logText();
  for (const secret of ["SECRET123", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012", "hunter2hunter2", "p4ss", "abc.DEF-123", "AbCdEfGhIj_klmn"])
    assert.ok(!all.includes(secret), `${secret} leaked`);
  assert.match(all, /frieren/, "ordinary text is kept");
  assert.match(logText(), /ERROR login/);
});

test("redactText: known values, key=value pairs and JSON", () => {
  assert.equal(redactText("apikey=abc&x=1"), "apikey=***&x=1");
  assert.equal(redactText(`{"token": "xyz123", "name": "ok"}`), `{"token": "***", "name": "ok"}`);
  assert.equal(redactText("smtp said no to MySecretValue", ["MySecretValue"]), "smtp said no to ***");
  assert.equal(redactText("nothing to hide here"), "nothing to hide here");
});

test("the file is size-capped by rotation", () => {
  resetLogs();
  const big = "x".repeat(3900);
  for (let i = 0; i < 1400; i++) record("info", `${i} ${big}`); // ~5.4 MB
  flushLogs();
  record("info", "after the cap");
  flushLogs();
  assert.ok(fs.existsSync(`${LOG_FILE}.1`), "the full file was rotated aside");
  assert.ok(fs.statSync(LOG_FILE).size < 5_500_000);
  assert.match(logText(), /after the cap/);
});
