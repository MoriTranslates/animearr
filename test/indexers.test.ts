/** Direct indexers, the catalogue, added download clients, protocol delays. All mocked (no network). */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-ix-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { patchSettings, getSettings, MASK } = await import("../server/settings.js");
const { searchIndexer, searchAll, parseSize, indexerNumId, seedLimitsFor } = await import("../server/indexers.js");
const { saveIndexer, listIndexers, indexerCatalog, indexerDuplicates, saveClient } = await import("../server/connectionsAdmin.js");
const { clientsFor, realClients } = await import("../server/arr/clients.js");
const { delayLeftMin } = await import("../server/managed.js");

const realFetch = globalThis.fetch;
after(() => void (globalThis.fetch = realFetch));
const seen: string[] = [];
const reply = (body: string, type = "application/xml") => (globalThis.fetch = (async (u: string | URL) => (seen.push(String(u)), new Response(body, { headers: { "content-type": type } }))) as typeof fetch);
const ix = (over: Record<string, unknown>) => ({ id: "t1", kind: "newznab", protocol: "usenet", name: "T", url: "https://ix.example", apiPath: "/api", apiKey: "K", categories: [5070], priority: 25, enabled: true, seedRatio: null, seedTimeMin: null, tags: [], catalogId: null, ...over }) as never;

test("Newznab: query, categories and key in the URL; size, links and age from the feed", async () => {
  reply(`<rss><channel><item><title>[Grp] Show - 01 (1080p)</title><guid>g1</guid><link>https://ix.example/get/1?apikey=K</link><pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate><enclosure url="https://ix.example/get/1?apikey=K" length="123" type="application/x-nzb"/><newznab:attr name="size" value="734003200"/><newznab:attr name="grabs" value="9"/></item></channel></rss>`);
  const r = await searchIndexer(ix({}), "show 01");
  assert.match(seen.at(-1)!, /t=search&q=show\+01&cat=5070.*apikey=K/);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].size, r[0].grabs, r[0].protocol, r[0].indexerId], [734003200, 9, "usenet", indexerNumId("t1")]);
  assert.ok(r[0].ageMinutes! >= 59 && r[0].ageMinutes! <= 61);
});

test("Nyaa: seeders, size, and the .torrent link (it carries the trackers)", async () => {
  reply(`<rss><channel><item><title>[SubsPlease] Show - 02 (1080p)</title><link>https://nyaa.si/download/1.torrent</link><guid>https://nyaa.si/view/1</guid><pubDate>Sat, 12 Sep 2026 15:45:00 -0000</pubDate><nyaa:seeders>42</nyaa:seeders><nyaa:leechers>3</nyaa:leechers><nyaa:infoHash>${"ef3e".repeat(10)}</nyaa:infoHash><nyaa:size>1.4 GiB</nyaa:size></item></channel></rss>`);
  const r = await searchIndexer(ix({ kind: "nyaa", protocol: "torrent", url: "https://nyaa.si" }), "show");
  assert.match(seen.at(-1)!, /page=rss&q=show&c=1_0&f=0/);
  assert.equal(r[0].seeders, 42);
  assert.equal(r[0].size, Math.round(1.4 * 1024 ** 3));
  assert.equal(r[0].downloadUrl, "https://nyaa.si/download/1.torrent");
  assert.equal(r[0].magnetUrl, undefined);
});

test("SubsPlease JSON and a generic RSS template", async () => {
  reply(JSON.stringify({ "Show - 03": { show: "Show", episode: "03", release_date: new Date().toUTCString(), downloads: [{ res: "1080", magnet: "magnet:?xt=urn:btih:AAA" }, { res: "720", magnet: "magnet:?xt=urn:btih:BBB" }] } }), "application/json");
  const sp = await searchIndexer(ix({ kind: "subsplease", protocol: "torrent", url: "https://subsplease.org" }), "show");
  assert.deepEqual(sp.map((x) => x.title), ["[SubsPlease] Show - 03 (1080p)", "[SubsPlease] Show - 03 (720p)"]);
  reply(`<rss><channel><item><title>Show 04</title><link>https://t.example/a.torrent</link><description>Size: 151.57MB magnet:?xt=urn:btih:CCC</description></item></channel></rss>`);
  const rss = await searchIndexer(ix({ kind: "rss", protocol: "torrent", url: "https://t.example/rss.php?terms={q}" }), "show 04");
  assert.equal(seen.at(-1), "https://t.example/rss.php?terms=show%2004");
  assert.deepEqual([rss[0].size, rss[0].magnetUrl], [151570000, "magnet:?xt=urn:btih:CCC"]);
  assert.equal(parseSize("6.6 GiB"), Math.round(6.6 * 1024 ** 3));
});

test("searchAll: Prowlarr optional; one failing indexer doesn't fail the search", async () => {
  patchSettings((s) => ({ ...s, prowlarr: { ...s.prowlarr, url: "", apiKey: "" }, indexers: [ix({ id: "a", name: "A" }), ix({ id: "b", name: "B", url: "https://down.example" })] }));
  globalThis.fetch = (async (u: string | URL) => (String(u).includes("down.example") ? new Response("", { status: 502 }) : new Response(`<rss><item><title>X</title><link>https://ix.example/x</link></item></rss>`))) as typeof fetch;
  const r = await searchAll("x");
  assert.deepEqual(r.map((x) => x.indexer), ["A"]);
  patchSettings((s) => ({ ...s, indexers: [] }));
  await assert.rejects(searchAll("x"), /No indexer is set up/);
});

test("indexer settings: validation, masked keys kept, key dropped when the address changes, duplicates", () => {
  assert.throws(() => saveIndexer(null, { kind: "rss", name: "R", url: "https://r.example/rss" }), /\{q\}/);
  const a = saveIndexer(null, { kind: "newznab", name: "Geek", url: "https://api.nzbgeek.info", apiKey: "SECRET" });
  assert.equal(a.apiKey, MASK);
  saveIndexer(a.id!, { name: "Geek 2", apiKey: MASK });
  assert.equal(getSettings().indexers.find((x) => x.id === a.id)!.apiKey, "SECRET");
  saveIndexer(a.id!, { url: "https://other.example", apiKey: MASK });
  assert.equal(getSettings().indexers.find((x) => x.id === a.id)!.apiKey, "", "a key isn't sent to another address");
  const t1 = saveIndexer(null, { kind: "torznab", name: "Tracker", url: "https://tr.example", seedRatio: 1.5, seedTimeMin: 4320 });
  assert.deepEqual(seedLimitsFor(indexerNumId(t1.id!)), { seedRatio: 1.5, seedTimeMin: 4320 });
  saveIndexer(null, { kind: "torznab", name: "Tracker again", url: "https://tr.example" });
  const d = indexerDuplicates(["AnimeTosho", "Geek 2"]);
  assert.ok(d.some((x) => x.name === "Tracker"), "same host twice");
  assert.ok(d.some((x) => x.with.includes("via Prowlarr")), "same site via Prowlarr");
  assert.ok(listIndexers().every((x) => x.apiKey === "" || x.apiKey === MASK), "keys never leave masked");
});

test("the catalogue loads, with a check date on every entry", () => {
  const c = indexerCatalog();
  assert.ok(c.entries.length >= 15);
  assert.ok(c.entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.checked.date) && ["ok", "down", "unverified"].includes(e.checked.status)));
  assert.ok(c.entries.some((e) => e.id === "nyaa" && e.recommended));
});

test("download clients: by protocol and priority; the next one when the first refuses", async () => {
  patchSettings((s) => ({ ...s, sabnzbd: { url: "http://sab", apiKey: "k", category: "animearr" }, clientPrefs: { sabnzbd: { priority: 2, enabled: true } }, extraClients: [] }));
  saveClient(null, { type: "nzbget", name: "NZBGet", url: "http://nzbget:6789", username: "u", password: "p", priority: 1 });
  assert.deepEqual(clientsFor("usenet").map((c) => c.type), ["nzbget", "sabnzbd"]);
  const calls: string[] = [];
  globalThis.fetch = (async (u: string | URL) => {
    calls.push(String(u));
    if (String(u).includes("nzbget")) return new Response("", { status: 500 });
    return new Response(JSON.stringify({ status: true, nzo_ids: ["SABnzbd_nzo_1"] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const job = await realClients.addNzb(Buffer.from("<nzb/>"), "Show 01");
  assert.deepEqual(job, { client: "sabnzbd", ref: "SABnzbd_nzo_1" });
  assert.ok(calls[0].includes("nzbget") && calls.some((c) => c.includes("sab")));
});

test("protocol delays: a release waits until it's old enough; no delay = no wait", () => {
  patchSettings((s) => ({ ...s, protocol: { usenetDelayMin: 0, torrentDelayMin: 120 } }));
  assert.equal(delayLeftMin({ protocol: "torrent", ageHours: 0.5 }), 90);
  assert.equal(delayLeftMin({ protocol: "torrent", ageHours: 3 }), 0);
  assert.equal(delayLeftMin({ protocol: "usenet", ageHours: 0 }), 0);
});

test("secrets: keys masked in /api/settings, credentials out of guids and error texts", async () => {
  const { publicSettings } = await import("../server/settings.js");
  const { redactUrl } = await import("../server/arr/http.js");
  patchSettings((s) => ({ ...s, indexers: [ix({ id: "k", apiKey: "TOPSECRET" })], extraClients: [{ id: "n", type: "nzbget", name: "N", url: "http://n", username: "u", password: "PW", category: "animearr", priority: 1, enabled: true, removeCompleted: true, pathMappings: [] }] }));
  const pub = JSON.stringify(publicSettings());
  assert.ok(!pub.includes("TOPSECRET") && !pub.includes('"PW"'));
  assert.equal(redactUrl("https://j/dl?jackett_apikey=abc&path=x"), "https://j/dl?jackett_apikey=***&path=x");
  assert.equal(redactUrl("https://t/rss?torrent_pass=abc"), "https://t/rss?torrent_pass=***");
  reply(`<rss><item><title>Y</title><link>https://t.example/dl/1?passkey=SECRET123</link></item></rss>`);
  const r = await searchIndexer(ix({ kind: "torznab", protocol: "torrent" }), "y");
  assert.ok(!r[0].guid.includes("SECRET123"), "a credentialed link isn't used as the guid");
});
