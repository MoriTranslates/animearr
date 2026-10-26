/** Poster thumbnails: the provider's smaller rendition, known hosts only, cached. All mocked. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-img-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { sizedUrl, allowedImage, thumb } = await import("../server/img.js");

test("sizes map to the provider's renditions", () => {
  assert.equal(sizedUrl("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-a.jpg", "sm"), "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1-a.jpg");
  assert.equal(sizedUrl("https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1-a.jpg", "xl"), "https://s4.anilist.co/file/anilistcdn/media/anime/cover/extraLarge/bx1-a.jpg");
  assert.equal(sizedUrl("https://image.tmdb.org/t/p/original/x.jpg", "md"), "https://image.tmdb.org/t/p/w185/x.jpg");
  assert.equal(sizedUrl("https://artworks.thetvdb.com/banners/v4/series/1/posters/a.jpg", "sm"), "https://artworks.thetvdb.com/banners/v4/series/1/posters/a_t.jpg");
  assert.equal(sizedUrl("https://artworks.thetvdb.com/banners/v4/series/1/posters/a_t.jpg", "md"), "https://artworks.thetvdb.com/banners/v4/series/1/posters/a_t.jpg");
  assert.equal(sizedUrl("https://artworks.thetvdb.com/banners/v4/series/1/posters/a.jpg", "lg"), "https://artworks.thetvdb.com/banners/v4/series/1/posters/a.jpg");
});

test("only known image hosts over https (no open proxy)", () => {
  assert.ok(allowedImage("https://s4.anilist.co/a.jpg"));
  assert.ok(!allowedImage("http://s4.anilist.co/a.jpg"));
  assert.ok(!allowedImage("https://192.168.1.1/a.jpg"));
  assert.ok(!allowedImage("https://s4.anilist.co.evil.com/a.jpg"));
  assert.ok(!allowedImage("file:///etc/passwd"));
});

test("fetched once, then served from the cache; non-images and failures refused", async () => {
  let calls = 0;
  const img = { fetch: (async () => (calls++, new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }))) as typeof fetch };
  const u = "https://image.tmdb.org/t/p/original/y.jpg";
  const a = await thumb(u, "sm", img);
  const b = await thumb(u, "sm", img);
  assert.ok(a && b && a.file === b.file && a.type === "image/jpeg");
  assert.equal(calls, 1);
  const html = { fetch: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch };
  assert.equal(await thumb("https://image.tmdb.org/t/p/original/z.jpg", "sm", html), null);
  // A missing rendition falls back to the original URL.
  const seen: string[] = [];
  const fallback = { fetch: (async (url: string) => (seen.push(String(url)), String(url).includes("/w154/") ? new Response("", { status: 404 }) : new Response(new Uint8Array([9]), { headers: { "content-type": "image/png" } }))) as unknown as typeof fetch };
  assert.ok(await thumb("https://image.tmdb.org/t/p/original/q.jpg", "sm", fallback));
  assert.deepEqual(seen, ["https://image.tmdb.org/t/p/w154/q.jpg", "https://image.tmdb.org/t/p/original/q.jpg"]);
});

test("resized to WebP when smaller; the original kept when resizing isn't possible", async () => {
  const f = { fetch: (async () => new Response(new Uint8Array(1000), { headers: { "content-type": "image/png" } })) as typeof fetch };
  const widths: number[] = [];
  const a = await thumb("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/r1.png", "sm", { ...f, resize: async (_b, w) => (widths.push(w), Buffer.alloc(100)) });
  assert.equal(a?.type, "image/webp");
  assert.equal(fs.statSync(a!.file).size, 100);
  assert.deepEqual(widths, [144]);
  const b = await thumb("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/r2.png", "sm", { ...f, resize: async () => null });
  assert.equal(b?.type, "image/png");
});

test("redirects off the allowed hosts and non-raster types are refused", async () => {
  const redirect = { fetch: (async () => new Response(null, { status: 302, headers: { location: "http://192.168.1.1/admin.png" } })) as typeof fetch };
  assert.equal(await thumb("https://image.tmdb.org/t/p/original/r1.jpg", "sm", redirect), null);
  const svg = { fetch: (async () => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } })) as typeof fetch };
  assert.equal(await thumb("https://image.tmdb.org/t/p/original/r2.jpg", "sm", svg), null);
  const big = { fetch: (async () => new Response(new Uint8Array(10), { headers: { "content-type": "image/png", "content-length": "99999999" } })) as typeof fetch };
  assert.equal(await thumb("https://image.tmdb.org/t/p/original/r3.jpg", "sm", big), null);
});
