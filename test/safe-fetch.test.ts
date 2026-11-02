/**
 * Redirects on credentialed calls: same-origin only, never re-sending a key to another host or a metadata address, and
 * never turning a write into a read. Two real local HTTP servers (different ports = different origins).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-safefetch-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { safeFetch, OutboundRefused } = await import("../server/system/safeFetch.js");
const { jsonCall } = await import("../server/arr/http.js");
const { fetchReleaseFile } = await import("../server/arr/prowlarr.js");

interface Seen {
  method: string;
  url: string;
  key: string | undefined;
  body: string;
}
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function server(handler: Handler) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", key: req.headers["x-api-key"] as string | undefined, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  after(() => new Promise<void>((r) => s.close(() => r())));
  return { origin, seen };
}

const redirect = (res: http.ServerResponse, status: number, to: string) => {
  res.writeHead(status, { Location: to });
  res.end();
};
const ok = (res: http.ServerResponse, text = '{"ok":true}') => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(text);
};

// The "other host": records whatever reaches it.
const other = await server((req, res) => ok(res));

test("a same-origin redirect is followed and keeps the key", async () => {
  const a = await server((req, res) => (req.url === "/old" ? redirect(res, 301, "/new") : ok(res)));
  const res = await safeFetch(`${a.origin}/old`, { headers: { "X-Api-Key": "SECRET" } });
  assert.equal(res.status, 200);
  assert.deepEqual(
    a.seen.map((x) => [x.url, x.key]),
    [
      ["/old", "SECRET"],
      ["/new", "SECRET"],
    ],
  );
});

test("a cross-origin redirect is refused and the other host never receives the key", async () => {
  const before = other.seen.length;
  const a = await server((req, res) => redirect(res, 302, `${other.origin}/steal`));
  await assert.rejects(safeFetch(`${a.origin}/api`, { headers: { "X-Api-Key": "SECRET" } }), (e: Error) => {
    assert.ok(e instanceof OutboundRefused);
    assert.match(e.message, /another address/);
    assert.ok(!e.message.includes("SECRET"));
    return true;
  });
  // Through the real Sonarr/Radarr/Prowlarr helper too.
  await assert.rejects(
    jsonCall("Sonarr", { url: a.origin, apiKey: "SECRET" }, "/api/v3", "GET", "/system/status"),
    /Sonarr: .*another address/,
  );
  assert.equal(other.seen.length, before, "the other host saw no request at all");
});

test("a redirect to a cloud-metadata address is refused (every spelling)", async () => {
  for (const to of ["http://169.254.169.254/latest/meta-data/", "http://[::ffff:a9fe:a9fe]/", "http://metadata.google.internal/"]) {
    const a = await server((req, res) => redirect(res, 302, to));
    await assert.rejects(
      safeFetch(`${a.origin}/x`, { headers: { "X-Api-Key": "SECRET" } }, { crossOrigin: "strip" }),
      /link-local or cloud-metadata/,
    );
  }
  await assert.rejects(safeFetch("http://169.254.169.254/latest/meta-data/"), /link-local or cloud-metadata/);
});

test("a POST answered with 302 is refused, not turned into a GET", async () => {
  const a = await server((req, res) => (req.url === "/write" ? redirect(res, 302, "/elsewhere") : ok(res)));
  await assert.rejects(
    safeFetch(`${a.origin}/write`, { method: "POST", headers: { "X-Api-Key": "SECRET" }, body: "payload" }),
    /answered a POST with a redirect \(HTTP 302\)/,
  );
  assert.deepEqual(
    a.seen.map((x) => [x.method, x.url]),
    [["POST", "/write"]],
  );
  // 301 and 303 too.
  for (const status of [301, 303]) {
    const b = await server((req, res) => redirect(res, status, "/elsewhere"));
    await assert.rejects(safeFetch(`${b.origin}/w`, { method: "PUT", body: "x" }), /answered a PUT with a redirect/);
    assert.equal(b.seen.length, 1);
  }
});

test("a POST answered with 307 on the same origin keeps the method, body and key", async () => {
  const a = await server((req, res) => (req.url === "/v1" ? redirect(res, 307, "/v2") : ok(res)));
  const res = await safeFetch(`${a.origin}/v1`, { method: "POST", headers: { "X-Api-Key": "SECRET" }, body: '{"n":1}' });
  assert.equal(res.status, 200);
  assert.deepEqual(a.seen[1], { method: "POST", url: "/v2", key: "SECRET", body: '{"n":1}' });
  // 307 to another origin is still refused, and nothing reaches it.
  const before = other.seen.length;
  const b = await server((req, res) => redirect(res, 307, `${other.origin}/v2`));
  await assert.rejects(safeFetch(`${b.origin}/v1`, { method: "POST", headers: { "X-Api-Key": "SECRET" }, body: "x" }), /another address/);
  assert.equal(other.seen.length, before);
});

test('"strip" follows a cross-origin GET with no credential headers; never a write', async () => {
  const before = other.seen.length;
  const a = await server((req, res) => redirect(res, 302, `${other.origin}/file`));
  const res = await safeFetch(
    `${a.origin}/dl`,
    { headers: { "X-Api-Key": "SECRET", Authorization: "Bearer T", Cookie: "SID=1", "User-Agent": "AnimeArr" } },
    { crossOrigin: "strip" },
  );
  assert.equal(res.status, 200);
  assert.equal(other.seen.length, before + 1);
  assert.equal(other.seen.at(-1)!.key, undefined);
  await assert.rejects(safeFetch(`${a.origin}/dl`, { method: "POST", body: "x" }, { crossOrigin: "strip" }), /answered a POST/);
});

test("a redirect loop gives up", async () => {
  const a = await server((req, res) => redirect(res, 302, req.url === "/a" ? "/b" : "/a"));
  await assert.rejects(safeFetch(`${a.origin}/a`, {}, { maxRedirects: 3 }), /more than 3 times/);
});

test("release download: Prowlarr's proxy may hand off to the indexer's host (no headers) or a magnet", async () => {
  const torrent = Buffer.from("d8:announce0:e");
  const indexer = await server((req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-bittorrent" });
    res.end(torrent);
  });
  const prowlarr = await server((req, res) =>
    req.url?.startsWith("/magnet")
      ? redirect(res, 302, `magnet:?xt=urn:btih:${"ab".repeat(20)}`)
      : redirect(res, 301, `${indexer.origin}/t.torrent`),
  );
  const base = { guid: "g", title: "Show - 01", size: 1, indexerId: 1, indexer: "x", protocol: "torrent" as const };
  const got = await fetchReleaseFile({ ...base, downloadUrl: `${prowlarr.origin}/1/download?apikey=K` });
  assert.deepEqual(got.data, torrent);
  assert.equal(indexer.seen[0].url, "/t.torrent");
  const mag = await fetchReleaseFile({ ...base, downloadUrl: `${prowlarr.origin}/magnet?apikey=K` });
  assert.match(mag.magnet ?? "", /^magnet:\?xt=urn:btih:/);
  // …but never to a metadata address.
  const evil = await server((req, res) => redirect(res, 302, "http://169.254.169.254/latest"));
  await assert.rejects(fetchReleaseFile({ ...base, downloadUrl: `${evil.origin}/x` }), /cloud-metadata/);
});
