/** Deluge (Web UI JSON-RPC) and rTorrent (XML-RPC) adapters, against mocked RPC endpoints. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-tc-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { delugeDriver, rtorrentDriver, torrentHash, encodeCall, decodeResponse } = await import("../server/arr/torrentClients.js");
const { partialCapable, PROTOCOL } = await import("../server/arr/clients.js");
const { patchSettings } = await import("../server/settings.js");
type Cfg = import("../server/settings.js").ClientCfg;

const cfg = (type: "deluge" | "rtorrent", url: string): Cfg => ({ id: `${type}1`, type, name: type === "deluge" ? "Deluge" : "rTorrent", url, username: type === "rtorrent" ? "u" : "", password: "pw", category: "animearr", priority: 1, enabled: true, removeCompleted: true, pathMappings: [{ from: "/downloads", to: "/data/torrents" }] });

/** A tiny valid .torrent: d8:announce…4:infod…ee */
const info = Buffer.from("d6:lengthi5e4:name5:a.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae");
const torrent = Buffer.concat([Buffer.from("d8:announce9:http://x/4:info"), info, Buffer.from("e")]);
const hash = createHash("sha1").update(info).digest("hex");

function mockFetch(handler: (url: string, body: string, headers: Record<string, string>) => { status?: number; body: string; headers?: Record<string, string> }) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const r = handler(String(url), init.body, init.headers ?? {});
    return new Response(r.body, { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return () => (globalThis.fetch = orig);
}

test("info-hash: from a .torrent (SHA-1 of the info dict) and from hex or base32 magnets", () => {
  assert.equal(torrentHash({ data: torrent }), hash);
  assert.equal(torrentHash({ magnet: `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=x` }), hash);
  // base32 of 20 bytes of 0xff…: all "7"
  assert.equal(torrentHash({ magnet: `magnet:?xt=urn:btih:${"7".repeat(32)}` }), "f".repeat(40));
});

test("capability matrix: Deluge and rTorrent are torrent clients with partial downloads", () => {
  assert.equal(PROTOCOL.deluge, "torrent");
  assert.equal(PROTOCOL.rtorrent, "torrent");
  for (const t of ["qbittorrent", "transmission", "deluge", "rtorrent"] as const) assert.equal(partialCapable(t), true, t);
  assert.equal(partialCapable("nzbget"), false);
});

// ---------------------------------------------------------------- Deluge

test("Deluge: logs in, connects the Web UI to its daemon, adds paused with the label, lists/selects files, resumes", async () => {
  const calls: { method: string; params: unknown[] }[] = [];
  let authed = false;
  const prios: unknown[] = [];
  const restore = mockFetch((url, body, headers) => {
    assert.match(url, /:8112\/json$/);
    const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
    calls.push({ method, params });
    const ok = (result: unknown) => ({ body: JSON.stringify({ result, error: null, id: 1 }) });
    if (method === "auth.login") return ((authed = params[0] === "pw"), { body: JSON.stringify({ result: authed, error: null, id: 1 }), headers: { "set-cookie": "_session_id=abc; Path=/" } });
    if (!authed || !String(headers.Cookie ?? "").includes("_session_id=abc")) return { body: JSON.stringify({ result: null, error: { message: "Not authenticated", code: 1 }, id: 1 }) };
    switch (method) {
      case "web.connected":
        return ok(false);
      case "web.get_hosts":
        return ok([["host1", "127.0.0.1", 58846, "localclient"]]);
      case "web.connect":
        return ok([]);
      case "core.get_config_value":
        return ok("/downloads");
      case "core.get_enabled_plugins":
        return ok(["Label"]);
      case "core.add_torrent_file":
        return ok(hash);
      case "label.add":
      case "label.set_torrent":
        return ok(null);
      case "core.get_torrents_status": {
        const keys = params[1] as string[];
        if (keys.includes("files")) return ok({ [hash]: { files: [{ index: 0, path: "Show/Show - 01.mkv", size: 5 }, { index: 1, path: "Show/Show - 02.mkv", size: 6 }] } });
        return ok({ [hash]: { name: "Show", progress: 100, state: "Seeding", save_path: "/downloads/animearr", eta: 0, download_payload_rate: 0, total_wanted: 6, num_seeds: 3, ratio: 0.5, label: "animearr", is_finished: true } });
      }
      case "core.set_torrent_options":
        return (prios.push(params), ok(null));
      case "core.resume_torrents":
        return { body: JSON.stringify({ result: null, error: { message: "Unknown method", code: 2 }, id: 1 }) };
      case "core.resume_torrent":
        return ok(null);
      case "core.remove_torrent":
        return ok(true);
      case "daemon.info":
        return ok("2.1.1");
      case "label.get_labels":
        return ok(["animearr"]);
    }
    return { body: JSON.stringify({ result: null, error: { message: `Unknown method ${method}`, code: 2 }, id: 1 }) };
  });
  try {
    const c = cfg("deluge", "http://deluge:8112");
    const added = await delugeDriver.add(c, { data: torrent }, { paused: true, seedRatio: 2 });
    assert.deepEqual(added, { ref: hash, select: true, paused: true });
    assert.ok(calls.some((x) => x.method === "web.connect"), "connected the Web UI to its daemon");
    const add = calls.find((x) => x.method === "core.add_torrent_file")!;
    assert.deepEqual(add.params[2], { add_paused: true, download_location: "/downloads/animearr", stop_at_ratio: true, stop_ratio: 2 });
    assert.deepEqual(calls.find((x) => x.method === "label.set_torrent")!.params, [hash, "animearr"]);
    const st = await delugeDriver.status(c, hash);
    assert.equal(st.state, "completed");
    assert.equal(st.path, "/data/torrents/animearr/Show", "the client's path is mapped");
    assert.deepEqual(await delugeDriver.listFiles(c, hash), [{ index: 0, name: "Show/Show - 01.mkv", size: 5 }, { index: 1, name: "Show/Show - 02.mkv", size: 6 }]);
    await delugeDriver.selectFiles(c, hash, [1], [0]);
    assert.deepEqual(prios[0], [[hash], { file_priorities: [0, 1] }]);
    await delugeDriver.start(c, hash);
    assert.deepEqual(calls.at(-1), { method: "core.resume_torrent", params: [[hash]] }, "Deluge 1.3 fallback");
    await delugeDriver.remove(c, hash, true);
    assert.deepEqual(calls.at(-1), { method: "core.remove_torrent", params: [hash, true] });
    const tst = await delugeDriver.test(c);
    assert.equal(tst.version, "2.1.1");
    assert.equal(tst.labelPlugin, true);
  } finally {
    restore();
  }
});

test("Deluge: no Label plugin is fine; a magnet isn't added paused; a torrent outside AnimeArr's label is left alone", async () => {
  const calls: string[] = [];
  const restore = mockFetch((_url, body) => {
    const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
    calls.push(method);
    const ok = (result: unknown) => ({ body: JSON.stringify({ result, error: null, id: 1 }), headers: { "set-cookie": "_session_id=x" } });
    if (method === "core.get_config_value") return ok("/downloads");
    if (method === "core.get_enabled_plugins") return ok([]);
    if (method === "core.add_torrent_magnet") return ((params[1] as { add_paused: boolean }).add_paused === false ? ok(hash) : ok(null));
    if (method === "core.get_torrents_status") return ok({ [hash]: { label: "", save_path: "/downloads/tv" } });
    return ok(true);
  });
  try {
    const c = cfg("deluge", "http://deluge:8112/");
    const added = await delugeDriver.add(c, { magnet: `magnet:?xt=urn:btih:${hash}` }, { paused: true });
    assert.deepEqual(added, { ref: hash, select: true, paused: false });
    assert.ok(!calls.includes("label.add"));
    await assert.rejects(delugeDriver.remove(c, hash), /leaving it alone/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- rTorrent

test("XML-RPC: encodes calls and decodes rTorrent's responses (arrays, i8, strings, faults)", () => {
  const xml = encodeCall("load.raw", ["", Buffer.from("ab"), "d.custom1.set=animearr"]);
  assert.match(xml, /<methodName>load\.raw<\/methodName>/);
  assert.match(xml, /<base64>YWI=<\/base64>/);
  const v = decodeResponse(`<?xml version="1.0"?><methodResponse><params><param><value><array><data><value><array><data><value><string>ABC</string></value><value><i8>12</i8></value><value>plain</value></data></array></value></data></array></value></param></params></methodResponse>`);
  assert.deepEqual(v, [["ABC", 12, "plain"]]);
  assert.throws(() => decodeResponse(`<methodResponse><fault><value><struct><member><name>faultCode</name><value><i4>-501</i4></value></member><member><name>faultString</name><value><string>Could not find info-hash.</string></value></member></struct></value></fault></methodResponse>`), /Could not find info-hash/);
});

test("rTorrent: loads stopped with label and folder, lists files, skips with f.priority.set + d.update_priorities, starts, erases with data", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rt-"));
  patchSettings((s) => ({ ...s, localPathMappings: [{ from: "/data", to: tmp }], importer: { ...s.importer, sourceRoots: ["/data/torrents/animearr"] }, downloads: { ...s.downloads, allowDelete: true } }));
  fs.mkdirSync(path.join(tmp, "torrents", "animearr", "Show"), { recursive: true });
  const calls: { method: string; params: string[] }[] = [];
  let loaded = false;
  const xmlVal = (v: unknown): string => (Array.isArray(v) ? `<value><array><data>${v.map(xmlVal).join("")}</data></array></value>` : typeof v === "number" ? `<value><i8>${v}</i8></value>` : `<value><string>${v}</string></value>`);
  const respond = (v: unknown) => ({ body: `<?xml version="1.0"?><methodResponse><params><param>${xmlVal(v)}</param></params></methodResponse>` });
  const restore = mockFetch((url, body, headers) => {
    assert.equal(url, "http://rt/RPC2");
    assert.equal(headers.Authorization, `Basic ${Buffer.from("u:pw").toString("base64")}`);
    const method = /<methodName>([^<]+)</.exec(body)![1];
    const params = [...body.matchAll(/<(?:string|i8|base64)>([^<]*)</g)].map((m) => m[1]);
    calls.push({ method, params });
    switch (method) {
      case "d.multicall2":
        // hash, name, label, size, completed, rate, ratio, state, active, complete, base_path, directory, message, peers_complete, wanted_chunks, is_meta, left
        return respond(loaded ? [[hash.toUpperCase(), "Show", "animearr", 11, 6, 0, 1500, 1, 1, 0, "/downloads/animearr/Show", "/downloads/animearr", "", 2, 0, 0, 0]] : []);
      case "directory.default":
        return respond("/downloads");
      case "load.raw":
        return ((loaded = true), respond(0));
      case "f.multicall":
        return respond([["Show - 01.mkv", 5], ["Show - 02.mkv", 6]]);
      case "system.client_version":
        return respond("0.9.8");
      default:
        return respond(0);
    }
  });
  try {
    const c = cfg("rtorrent", "http://rt/RPC2");
    const added = await rtorrentDriver.add(c, { data: torrent }, { paused: true });
    assert.deepEqual(added, { ref: hash, select: true, paused: true });
    const load = calls.find((x) => x.method === "load.raw")!;
    assert.ok(load.params.includes("d.custom1.set=animearr"));
    assert.ok(load.params.some((p) => p === 'd.directory.set="/downloads/animearr"'));
    const st = await rtorrentDriver.status(c, hash);
    assert.equal(st.state, "completed", "every wanted chunk is in (skipped files don't count)");
    assert.equal(st.path, "/data/torrents/animearr/Show");
    assert.deepEqual(await rtorrentDriver.listFiles(c, hash), [{ index: 0, name: "Show/Show - 01.mkv", size: 5 }, { index: 1, name: "Show/Show - 02.mkv", size: 6 }]);
    calls.length = 0;
    await rtorrentDriver.selectFiles(c, hash, [1], [0]);
    assert.deepEqual(calls.map((x) => [x.method, x.params]), [["f.priority.set", [`${hash.toUpperCase()}:f0`, "0"]], ["f.priority.set", [`${hash.toUpperCase()}:f1`, "1"]], ["d.update_priorities", [hash.toUpperCase()]]]);
    await rtorrentDriver.start(c, hash);
    assert.equal(calls.at(-1)!.method, "d.start");
    await rtorrentDriver.remove(c, hash, true);
    assert.ok(calls.some((x) => x.method === "d.erase"));
    assert.equal(fs.existsSync(path.join(tmp, "torrents", "animearr", "Show")), false, "its data folder, inside AnimeArr's download folder, is deleted by AnimeArr");
    assert.equal((await rtorrentDriver.test(c)).version, "rTorrent 0.9.8");
  } finally {
    restore();
  }
});
