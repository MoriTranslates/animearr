/** Media-server output: NFO/.plexmatch content, never touching the user's own files, sync after renames/removals,
 * the {Server Id Hint} token, and the Jellyfin/Emby/Kodi request shapes (mocked servers only). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings, updateSettings, publicSettings } = await import("../server/system/settings.js");
const { tvshowNfo, episodeNfo, seasonNfo, plexmatch, plainText, syncSeriesFiles, MARKER, realWriteDeps } =
  await import("../server/media/mediaout.js");
const { embyRequest, kodiRequest, testEmbyLike, testKodi, notifyMediaServers, flushMediaServers } =
  await import("../server/media/mediaservers.js");
const { renderSeriesFolder, serverIdHint } = await import("../server/import/naming.js");
const { stripXmlIllegal } = await import("../server/core/xml.js");

const show = {
  title: "Frieren: Beyond Journey's End",
  originalTitle: "葬送のフリーレン",
  year: 2023,
  plot: "After the party defeats the Demon King<br><br><i>(Source: Crunchyroll)</i> & more",
  premiered: "2023-09-29",
  status: "Continuing",
  genres: ["Adventure", "Fantasy"],
  ids: { tvdb: 424536, tmdb: 209867, anidb: 17617, anilist: 154587 },
  poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/x.jpg",
  banner: null,
};

test("tvshow.nfo: marker, escaped text, every id with tvdb as the default, poster", () => {
  const x = tvshowNfo(show);
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>\n<!-- Written by AnimeArr/);
  assert.match(x, /<title>Frieren: Beyond Journey&#?\w*;?s End<\/title>|<title>Frieren: Beyond Journey's End<\/title>/);
  assert.match(x, /<originaltitle>葬送のフリーレン<\/originaltitle>/);
  assert.match(x, /<plot>After the party defeats the Demon King\n\n\(Source: Crunchyroll\) &amp; more<\/plot>/);
  assert.match(x, /<uniqueid type="tvdb" default="true">424536<\/uniqueid>/);
  assert.match(x, /<uniqueid type="anidb">17617<\/uniqueid>/);
  assert.match(x, /<uniqueid type="anilist">154587<\/uniqueid>/);
  assert.match(x, /<thumb aspect="poster">https:\/\/s4\.anilist\.co/);
  assert.doesNotMatch(x, /<uniqueid type="imdb">/, "unknown ids are left out");
  // A show TVDB doesn't have: the AniList/AniDB id becomes the default.
  assert.match(tvshowNfo({ ...show, ids: { anidb: 1, anilist: 2 } }), /<uniqueid type="anidb" default="true">1<\/uniqueid>/);
  assert.equal(plainText("a<br/>b &amp; c"), "a\nb & c");
});

test("episode NFO: one block per episode (multi-episode files), season.nfo, .plexmatch hints", () => {
  const x = episodeNfo("Frieren", [
    { season: 1, episode: 1, title: "The Journey's End", aired: "2023-09-29", runtime: 24 },
    { season: 1, episode: 2, title: null },
  ]);
  assert.equal(x.match(/<episodedetails>/g)?.length, 2);
  assert.match(x, /<season>1<\/season>\n {2}<episode>1<\/episode>\n {2}<aired>2023-09-29<\/aired>\n {2}<runtime>24<\/runtime>/);
  assert.match(x, /<title>Episode 2<\/title>/, "a missing title still gives the server something");
  assert.match(seasonNfo(0), /<title>Specials<\/title>/);
  const pm = plexmatch(show);
  assert.match(pm, /^# Written by AnimeArr/);
  assert.match(pm, /\ntitle: Frieren: Beyond Journey's End\nyear: 2023\ntvdbid: 424536\ntmdbid: 209867\n$/);
});

test("plainText strips the other tags AniList/TMDB send: tables, details, boolean attributes, packed attributes", () => {
  assert.equal(plainText("<table><tr><td>x</td></tr></table>"), "x");
  assert.equal(plainText("<details><summary>s</summary>d</details>"), "sd");
  assert.equal(plainText("a<hr noshade>b"), "ab");
  assert.equal(plainText("<img src=x ismap>after"), "after");
  assert.equal(plainText('<a href="u"class="c">l</a>'), "l");
  // The deliberate trade-off stays: unknown words are text.
  assert.equal(plainText("a <b and c> d"), "a <b and c> d");
});

test("stripXmlIllegal drops exactly the characters XML 1.0 forbids (code points as numbers)", () => {
  const ch = (cp: number) => String.fromCharCode(cp);
  const dropped = [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0xfffe, 0xffff, 0xd800, 0xdbff, 0xdc00, 0xdfff];
  for (const cp of dropped) assert.equal(stripXmlIllegal("a" + ch(cp) + "b"), "ab", `U+${cp.toString(16)}`);
  const kept = [0x09, 0x0a, 0x0d, 0x20, 0x7f, 0xe9, 0x2028, 0xfeff, 0xfffd];
  for (const cp of kept) assert.equal(stripXmlIllegal("a" + ch(cp) + "b"), "a" + ch(cp) + "b", `U+${cp.toString(16)}`);
  // A surrogate pair (an emoji) is one valid character; a high half at the very end is not.
  const emoji = String.fromCodePoint(0x1f389);
  assert.equal(stripXmlIllegal("x" + emoji + "y"), "x" + emoji + "y");
  assert.equal(stripXmlIllegal("x" + ch(0xd83c)), "x");
  assert.equal(stripXmlIllegal(ch(0xdf89) + ch(0xd83c) + "z"), "z", "halves in the wrong order are two lone surrogates");
  const plain = "no change";
  assert.equal(stripXmlIllegal(plain), plain);
});

test("NFO and .plexmatch writers: control bytes, '<' in plain text and newlines in titles (review L15)", () => {
  // A stray control byte (or a lone surrogate) makes the whole NFO unparseable: it is dropped.
  const nfo = tvshowNfo({ ...show, title: "Bad\u0001Title\u0000", plot: "Plot\u000Bwith\u001Fbytes \uD800 end" });
  assert.equal(stripXmlIllegal(nfo), nfo, JSON.stringify(nfo));
  assert.match(nfo, /<title>BadTitle<\/title>/);
  const ep = episodeNfo("Show\u0007", [{ season: 1, episode: 1, title: "Ep\u0002 one", plot: "x\u0008y" }]);
  assert.equal(stripXmlIllegal(ep), ep, JSON.stringify(ep));
  // Tabs, newlines and ordinary Unicode survive.
  assert.match(tvshowNfo({ ...show, plot: "Line one\nLine two\tend 葬送 🎉" }), /<plot>Line one\nLine two\tend 葬送 🎉<\/plot>/);
  // plainText only removes real tags: "a < b and c > d" is text.
  assert.equal(plainText("a < b and c > d"), "a < b and c > d");
  assert.equal(plainText("x<3 and y>2"), "x<3 and y>2");
  assert.equal(plainText("Hi<br>there <i>you</i> <b class='x'>all</b>"), "Hi\nthere you all");
  // Review (misc) #3: tag-like text, a ">" inside a quoted attribute, and HTML comments.
  assert.equal(plainText("a <b and c> d"), "a <b and c> d");
  assert.equal(plainText('1<a href="x>y">z</a>'), "1z");
  assert.equal(plainText("<!-- c -->x"), "x");
  assert.equal(plainText("a<!-- multi\nline -->b"), "ab");
  assert.equal(plainText('<p>One</p><p>Two <span style="color:red">red</span></p>'), "OneTwo red");
  assert.equal(plainText("<i>(Source: Crunchyroll)</i>"), "(Source: Crunchyroll)");
  assert.equal(plainText("<img src='a.png' alt=\"x > y\"/>after"), "after");
  assert.equal(plainText("1 <foo> 2"), "1 <foo> 2", "unknown tag names are text");
  // .plexmatch is one "key: value" per line: a newline in a title can't add a line of its own.
  const pm = plexmatch({ ...show, title: "Evil\ntvdbid: 1\r\nimdbid: tt0", year: 2023 });
  assert.equal(pm.split("\n").filter((l) => l.startsWith("tvdbid:")).length, 1, pm);
  assert.ok(!/^imdbid: tt0$/m.test(pm), pm);
  assert.match(pm, /\ntitle: Evil tvdbid: 1 imdbid: tt0\n/);
});

test("sync: writes, leaves the user's own files alone, doesn't rewrite unchanged ones, removes stale NFOs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-mo-"));
  const s1 = path.join(dir, "Season 01");
  fs.mkdirSync(s1);
  const v1 = path.join(s1, "Frieren - S01E01.mkv");
  const v2 = path.join(s1, "Frieren - S01E02.mkv");
  fs.writeFileSync(v1, "x");
  fs.writeFileSync(v2, "x");
  // The user's own tvshow.nfo (no marker) and an old AnimeArr NFO for a file that was renamed away.
  fs.writeFileSync(path.join(dir, "tvshow.nfo"), "<tvshow><title>My own</title></tvshow>");
  fs.writeFileSync(path.join(s1, "Frieren - S01E01 [old name].nfo"), `<!-- ${MARKER} -->`);
  fs.writeFileSync(path.join(s1, "Frieren - S01E03.nfo"), "<episodedetails>user's</episodedetails>"); // no video, but not ours
  const images: string[] = [];
  const deps = { ...realWriteDeps, image: async (u: string) => (images.push(u), { data: Buffer.from("img"), ext: "jpg" }) };
  const out = {
    show,
    folder: dir,
    files: [
      { path: v1, episodes: [{ season: 1, episode: 1, title: "The Journey's End" }] },
      { path: v2, episodes: [{ season: 1, episode: 2, title: "It Didn't Have to Be Magic" }] },
    ],
  };
  const c = await syncSeriesFiles(out, { nfo: true, plexmatch: true, artwork: true }, deps);
  assert.equal(
    fs.readFileSync(path.join(dir, "tvshow.nfo"), "utf8"),
    "<tvshow><title>My own</title></tvshow>",
    "the user's own NFO is never overwritten",
  );
  assert.equal(c.userFiles, 1);
  assert.match(fs.readFileSync(path.join(s1, "Frieren - S01E01.nfo"), "utf8"), /<title>The Journey's End<\/title>/);
  assert.match(fs.readFileSync(path.join(s1, "season.nfo"), "utf8"), /<seasonnumber>1<\/seasonnumber>/);
  assert.match(fs.readFileSync(path.join(dir, ".plexmatch"), "utf8"), /tvdbid: 424536/);
  assert.equal(fs.existsSync(path.join(s1, "Frieren - S01E01 [old name].nfo")), false, "AnimeArr's NFO for a renamed-away file is removed");
  assert.equal(fs.existsSync(path.join(s1, "Frieren - S01E03.nfo")), true, "a stray NFO without the marker stays");
  assert.equal(c.removed, 1);
  assert.equal(c.artwork, 1);
  assert.ok(fs.existsSync(path.join(dir, "poster.jpg")));
  // Second run: nothing changes, no artwork fetched again.
  const again = await syncSeriesFiles(out, { nfo: true, plexmatch: true, artwork: true }, deps);
  assert.equal(again.written, 0);
  assert.equal(images.length, 1);
  // The episode file deleted: its NFO goes on the next sync.
  fs.unlinkSync(v2);
  const after = await syncSeriesFiles({ ...out, files: out.files.slice(0, 1) }, { nfo: true, plexmatch: false, artwork: false }, deps);
  assert.equal(after.removed, 1);
  assert.equal(fs.existsSync(path.join(s1, "Frieren - S01E02.nfo")), false);
  // Everything off: nothing is written.
  const off = await syncSeriesFiles(out, { nfo: false, plexmatch: false, artwork: false }, deps);
  assert.equal(off.written, 0);
});

test("{Server Id Hint}: Plex {tvdb-N}, Jellyfin/Emby [tvdbid-N], nothing for Kodi, none or TVDB-less shows", () => {
  const opts = { replaceIllegalCharacters: true, colonReplacement: "smart" as const, multiEpisodeStyle: "prefixedRange" as const };
  const f = "{Series TitleYear} {Server Id Hint}";
  assert.equal(
    renderSeriesFolder(f, { seriesTitle: "Frieren", seriesYear: 2023, tvdbId: 424536, server: "plex" }, opts),
    "Frieren (2023) {tvdb-424536}",
  );
  assert.equal(
    renderSeriesFolder(f, { seriesTitle: "Frieren", seriesYear: 2023, tvdbId: 424536, server: "jellyfin" }, opts),
    "Frieren (2023) [tvdbid-424536]",
  );
  assert.equal(renderSeriesFolder(f, { seriesTitle: "Frieren", seriesYear: 2023, tvdbId: 424536, server: "kodi" }, opts), "Frieren (2023)");
  assert.equal(renderSeriesFolder(f, { seriesTitle: "Frieren", seriesYear: 2023, tvdbId: null, server: "plex" }, opts), "Frieren (2023)");
  assert.equal(serverIdHint("emby", 1), "[tvdbid-1]");
});

test("Jellyfin/Emby/Kodi requests: auth headers, paths and bodies", async () => {
  const jf = embyRequest("jellyfin", { url: "http://jf:8096/", apiKey: "k3y" }, "/Library/Media/Updated", {
    Updates: [{ Path: "/media/a", UpdateType: "Modified" }],
  });
  assert.equal(jf.url, "http://jf:8096/Library/Media/Updated");
  assert.match((jf.init.headers as Record<string, string>).Authorization, /^MediaBrowser .*Token="k3y"$/);
  assert.equal(jf.init.method, "POST");
  assert.deepEqual(JSON.parse(String(jf.init.body)), { Updates: [{ Path: "/media/a", UpdateType: "Modified" }] });
  const em = embyRequest("emby", { url: "http://emby:8096", apiKey: "k3y" }, "/System/Info");
  assert.equal(em.url, "http://emby:8096/emby/System/Info");
  assert.equal((em.init.headers as Record<string, string>)["X-Emby-Token"], "k3y");
  assert.equal(em.init.method, "GET");
  const ko = kodiRequest({ url: "http://kodi:8080", username: "kodi", password: "pw" }, "VideoLibrary.Scan", {
    directory: "/media/a/",
    showdialogs: false,
  });
  assert.equal(ko.url, "http://kodi:8080/jsonrpc");
  assert.equal((ko.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("kodi:pw").toString("base64")}`);
  assert.deepEqual(JSON.parse(String(ko.init.body)), {
    jsonrpc: "2.0",
    id: 1,
    method: "VideoLibrary.Scan",
    params: { directory: "/media/a/", showdialogs: false },
  });
  assert.throws(() => embyRequest("jellyfin", { url: "http://169.254.169.254", apiKey: "k" }, "/x"), /isn't allowed/);
  // Tests read the server's answer.
  const fake = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(
    await testEmbyLike("jellyfin", { url: "http://jf:8096", apiKey: "k" }, fake({ ServerName: "Home", Version: "10.11.0" })),
    { version: "10.11.0", name: "Home" },
  );
  await assert.rejects(testEmbyLike("emby", { url: "http://e:8096", apiKey: "bad" }, fake({}, 401)), /refused the API key \(401\)/);
  assert.deepEqual(
    await testKodi(
      { url: "http://k:8080", username: "", password: "" },
      fake({ result: { name: "Kodi", version: { major: 21, minor: 1 } } }),
    ),
    { version: "21.1", name: "Kodi" },
  );
  await assert.rejects(
    testKodi({ url: "http://k:8080", username: "", password: "" }, fake({ error: { message: "Invalid params." } })),
    /Kodi: Invalid params/,
  );
});

test("notify: only enabled servers, mapped paths, batched; secrets stay masked", async () => {
  const calls: string[] = [];
  const deps = { scan: async (k: string, folders: string[]) => void calls.push(`${k}:${folders.join("|")}`) };
  notifyMediaServers(["/media/Anime/Frieren"], deps, 60_000);
  assert.deepEqual(await flushMediaServers(deps), [], "nothing until a server is switched on");
  patchSettings((s) => ({
    ...s,
    jellyfin: { url: "http://jf:8096", apiKey: "k3y", enabled: true, pathMappings: [{ from: "/media", to: "/data" }] },
    kodi: { url: "http://kodi:8080", username: "", password: "", enabled: false, pathMappings: [] },
  }));
  notifyMediaServers(["/media/Anime/Frieren", "/media/Anime/Frieren/"], deps, 60_000);
  await flushMediaServers(deps);
  assert.deepEqual(calls, ["jellyfin:/data/Anime/Frieren"]);
  const pub = publicSettings() as unknown as { jellyfin: { apiKey: string } };
  assert.notEqual(pub.jellyfin.apiKey, "k3y", "the key never goes to the browser");
  // A new address without re-entering the key drops the old key (it was only valid for the old address).
  updateSettings({ jellyfin: { url: "http://other:8096", apiKey: pub.jellyfin.apiKey } });
  const { getSettings } = await import("../server/system/settings.js");
  assert.equal(getSettings().jellyfin.apiKey, "");
  updateSettings({ mediaOutput: { main: "vlc" } });
  assert.equal(getSettings().mediaOutput.main, "none", "an unknown server is ignored");
});

test("from AnimeArr's catalog: a show's files are written only inside an allowed root and only when switched on", async () => {
  const { cache, db } = await import("../server/system/db.js");
  const { syncSeriesMetadata, afterLibraryChange } = await import("../server/media/mediaout.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-lib-"));
  const showDir = path.join(root, "Frieren (2023)", "Season 01");
  fs.mkdirSync(showDir, { recursive: true });
  const video = path.join(showDir, "Frieren - S01E01.mkv");
  fs.writeFileSync(video, "x");
  const r = root.replace(/\\/g, "/");
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, tmdb_id, title, year, status, path, root_folder, monitored, synced_at) VALUES (77, 424536, 209867, 'Frieren', 2023, 'continuing', ?, ?, 1, 0)",
    )
    .run(`${r}/Frieren (2023)`, r);
  cache
    .prepare("INSERT INTO files (id, series_id, season, path) VALUES (5, 77, 1, ?)")
    .run(`${r}/Frieren (2023)/Season 01/Frieren - S01E01.mkv`);
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, absolute, title, air_date, monitored, has_file, file_id) VALUES (501, 77, 1, 1, 1, 'The Journey''s End', '2023-09-29', 1, 1, 5)",
    )
    .run();
  db.prepare(
    "INSERT INTO entries (anilist_id, anidb_id, tvdb_id, tvdb_season, title_native, description, cover, fetched_at) VALUES (154587, 17617, 424536, '1', '葬送のフリーレン', 'After the <b>party</b>', NULL, 0)",
  ).run();
  patchSettings((s) => ({ ...s, allowedRoots: [], mediaOutput: { main: "jellyfin", nfo: true, plexmatch: true, artwork: false } }));
  assert.equal(await syncSeriesMetadata(424536), null, "outside the allowed roots: nothing is written");
  patchSettings((s) => ({ ...s, allowedRoots: [r] }));
  const c = await syncSeriesMetadata(424536);
  assert.ok(c && c.written >= 3);
  const nfo = fs.readFileSync(path.join(root, "Frieren (2023)", "tvshow.nfo"), "utf8");
  assert.match(nfo, /<uniqueid type="anilist">154587<\/uniqueid>/);
  assert.match(nfo, /<plot>After the party<\/plot>/);
  assert.match(fs.readFileSync(video.replace(/\.mkv$/, ".nfo"), "utf8"), /<title>The Journey's End<\/title>/);
  // The hook after a rename: the stale NFO goes, the new one is written.
  const renamed = path.join(showDir, "Frieren - S01E01 - The Journey's End.mkv");
  fs.renameSync(video, renamed);
  cache.prepare("UPDATE files SET path = ? WHERE id = 5").run(`${r}/Frieren (2023)/Season 01/Frieren - S01E01 - The Journey's End.mkv`);
  await afterLibraryChange({ tvdbId: 424536, folders: [`${r}/Frieren (2023)`] });
  assert.equal(fs.existsSync(video.replace(/\.mkv$/, ".nfo")), false);
  assert.ok(fs.existsSync(renamed.replace(/\.mkv$/, ".nfo")));
  patchSettings((s) => ({ ...s, mediaOutput: { ...s.mediaOutput, nfo: false, plexmatch: false } }));
  assert.equal(await syncSeriesMetadata(424536), null, "all switched off: nothing to do");
});

test("notify: a big batch of folders asks each server for one library scan; a small one stays per folder", async () => {
  const { BULK_SCAN_FOLDERS } = await import("../server/media/plex.js");
  const { scanFolders } = await import("../server/media/mediaservers.js");
  patchSettings((s) => ({
    ...s,
    jellyfin: { url: "http://jf:8096", apiKey: "k3y", enabled: true, pathMappings: [] },
    kodi: { url: "http://kodi:8080", username: "", password: "", enabled: true, pathMappings: [] },
  }));
  const sent: { url: string; body: string }[] = [];
  const fake = (async (u: string, init: RequestInit) => (
    sent.push({ url: String(u), body: String(init.body ?? "") }),
    new Response("{}")
  )) as unknown as typeof fetch;
  const folders = (n: number) => Array.from({ length: n }, (_, i) => `/media/Anime/Show ${i}`);
  await scanFolders("jellyfin", folders(BULK_SCAN_FOLDERS), fake);
  assert.deepEqual(
    sent.map((x) => x.url),
    ["http://jf:8096/Library/Media/Updated"],
    "at the threshold: still per folder",
  );
  sent.length = 0;
  await scanFolders("jellyfin", folders(BULK_SCAN_FOLDERS + 1), fake);
  assert.deepEqual(
    sent.map((x) => x.url),
    ["http://jf:8096/Library/Refresh"],
    "over it: one refresh of the whole library",
  );
  sent.length = 0;
  await scanFolders("kodi", folders(BULK_SCAN_FOLDERS + 1), fake);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body).params, { showdialogs: false }, "Kodi: a scan without a directory");
  sent.length = 0;
  await scanFolders("kodi", folders(2), fake);
  assert.equal(sent.length, 2, "a small batch is one scan per folder");
});
