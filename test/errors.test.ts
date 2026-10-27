/** Connection and validation errors in plain words, with the raw text kept as detail (playtest: "fetch failed"). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeError, addressOf } from "../server/errors.js";

test("unreachable services: name the service and the address, say what to check; raw text as detail", () => {
  const a = humanizeError("SABnzbd unreachable (fetch failed)", { url: "http://example.invalid:8080/sab" });
  assert.equal(a.message, "AnimeArr couldn't reach SABnzbd at example.invalid:8080. Is it running, and is the address right?");
  assert.equal(a.detail, "SABnzbd unreachable (fetch failed)");
  const b = humanizeError("Prowlarr unreachable (getaddrinfo ENOTFOUND example.invalid)");
  assert.match(b.message, /^No computer called example\.invalid was found on your network\. Check Prowlarr's address/);
  const c = humanizeError("qBittorrent unreachable (connect ECONNREFUSED 192.168.1.10:8080)");
  assert.equal(c.message, "qBittorrent at 192.168.1.10:8080 refused the connection. Is it running, and is the port right?");
  assert.match(humanizeError("Plex unreachable (timed out)", { url: "http://192.168.1.10:32400" }).message, /^Plex at 192\.168\.1\.10:32400 didn't answer in time/);
  assert.match(humanizeError("fetch failed", { service: "Jackett", url: "http://192.168.1.10:9117" }).message, /couldn't reach Jackett at 192\.168\.1\.10:9117/);
});

test("HTTP 401/403/404/5xx in plain words", () => {
  assert.match(humanizeError("Sonarr GET /api/v3/system/status failed (HTTP 401) (wrong API key?)").message, /^Sonarr said the API key or password is wrong/);
  assert.match(humanizeError("Radarr GET /api/v3/system/status failed (HTTP 403)").message, /^Radarr refused access/);
  assert.match(humanizeError("Prowlarr GET /api/v1/indexer failed (HTTP 404)").message, /^Prowlarr answered, but nothing is at that address/);
  assert.match(humanizeError("Sonarr GET /api/v3/series failed (HTTP 502)").message, /problem of its own \(error 502\)/);
});

test("known messages; plain ones untouched; no network wording for non-network errors", () => {
  assert.equal(humanizeError("Something went wrong: Paste a release name").message, "Paste a release name");
  assert.equal(humanizeError("Sonarr is not configured").message, "Sonarr isn't set up yet.");
  assert.match(humanizeError("AniDB titles download failed (HTTP 403)").message, /^AniDB refused the title download for now/);
  assert.match(humanizeError("TMDB API key (32 hex characters) or a Read Access Token (starts with eyJ)").message, /^That doesn't look like a TMDB key/);
  const plain = humanizeError("Confirm the grab first");
  assert.deepEqual(plain, { message: "Confirm the grab first", detail: null });
  assert.deepEqual(humanizeError("Search timed out after 3 tries"), { message: "Search timed out after 3 tries", detail: null });
});

test("addressOf keeps host:port only (never credentials or paths)", () => {
  assert.equal(addressOf("http://user:pw@192.168.1.10:8080/sab?apikey=x"), "192.168.1.10:8080");
  assert.equal(addressOf("not a url"), "");
});
