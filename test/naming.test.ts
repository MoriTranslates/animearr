/** Sonarr/Radarr-compatible naming: tokens, modifiers, multi-episode styles, illegal characters, colons. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEpisode, renderMovie, renderSeasonFolder, renderSeriesFolder, cleanName } from "../server/naming.js";

const opts = { replaceIllegalCharacters: true, colonReplacement: "smart" as const, multiEpisodeStyle: "prefixedRange" as const };
const SONARR_ANIME = "{Series TitleYear} - S{season:00}E{episode:00} - {absolute:000} - {Episode CleanTitle} [{Preferred Words }{Quality Full}]{[MediaInfo VideoDynamicRangeType]}[{MediaInfo VideoBitDepth}bit]{[MediaInfo VideoCodec]}[{Mediainfo AudioCodec} { Mediainfo AudioChannels}]{MediaInfo AudioLanguages}{-Release Group}";

const ep = {
  seriesTitle: "Frieren: Beyond Journey's End",
  seriesYear: 2023,
  season: 1,
  episodes: [{ episode: 5, absolute: 5, title: "Phantoms of the Dead", airDate: "2023-10-06" }],
  quality: "WEBDL-1080p",
  mediaInfo: { videoCodec: "h264", videoBitDepth: 8, audioCodec: "aac", audioChannels: 2, audioLanguages: ["ja"], subtitleLanguages: ["en"] },
  releaseGroup: "SubsPlease",
};

test("Sonarr's default anime format renders like Sonarr", () => {
  assert.equal(renderEpisode(SONARR_ANIME, ep, opts), "Frieren - Beyond Journey's End (2023) - S01E05 - 005 - Phantoms of the Dead [WEBDL-1080p][8bit][x264][AAC 2.0][JA]-SubsPlease");
});

test("standard format, dots, case, optional prefixes", () => {
  assert.equal(renderEpisode("{Series.Title}.S{season:00}E{episode:00}.{Episode.Title}{-Release Group}", { ...ep, releaseGroup: null }, opts), "Frieren.Beyond.Journey's.End.S01E05.Phantoms.of.the.Dead");
  assert.equal(renderEpisode("{series title} - {episode:00}", ep, opts), "frieren - beyond journey's end - 05");
});

test("multi-episode styles", () => {
  const two = { ...ep, episodes: [{ episode: 1, absolute: 1, title: "A" }, { episode: 2, absolute: 2, title: "B" }, { episode: 3, absolute: 3, title: "C" }] };
  const f = "S{season:00}E{episode:00}";
  assert.equal(renderEpisode(f, two, { ...opts, multiEpisodeStyle: "extend" }), "S01E01-02-03");
  assert.equal(renderEpisode(f, two, { ...opts, multiEpisodeStyle: "repeat" }), "S01E01E02E03");
  assert.equal(renderEpisode(f, two, { ...opts, multiEpisodeStyle: "duplicate" }), "S01E01 - S01E02 - S01E03");
  assert.equal(renderEpisode(f, two, { ...opts, multiEpisodeStyle: "scene" }), "S01E01-E02-E03");
  assert.equal(renderEpisode(f, two, { ...opts, multiEpisodeStyle: "range" }), "S01E01-03");
  assert.equal(renderEpisode(f, two, { ...opts, multiEpisodeStyle: "prefixedRange" }), "S01E01-E03");
  assert.equal(renderEpisode("{absolute:000} {Episode Title}", two, opts), "001-003 A + B + C");
});

test("illegal characters and colon modes", () => {
  assert.equal(cleanName("Re:Zero / Part 2? <x>", { ...opts, colonReplacement: "delete" }), "ReZero + Part 2 x");
  assert.equal(cleanName("Re:Zero", { ...opts, colonReplacement: "dash" }), "Re-Zero");
  assert.equal(cleanName("Title: Sub", { ...opts, colonReplacement: "spaceDashSpace" }), "Title - Sub");
  assert.equal(cleanName("Steins;Gate 0: 12:30", { ...opts, colonReplacement: "smart" }), "Steins;Gate 0 - 12-30");
});

test("folders and movies", () => {
  assert.equal(renderSeriesFolder("{Series TitleYear} [tvdbid-{TvdbId}]", { seriesTitle: "Bleach", seriesYear: 2004, tvdbId: 74796 }, opts), "Bleach (2004) [tvdbid-74796]");
  assert.equal(renderSeasonFolder("Season {season:00}", 3, opts), "Season 03");
  assert.equal(renderSeasonFolder("Season {season}", 3, opts), "Season 3");
  assert.equal(renderEpisode("{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}", { ...ep, mediaInfo: undefined }, opts), "Frieren - Beyond Journey's End - S01E05 - Phantoms of the Dead WEBDL-1080p");
  assert.equal(renderEpisode("{Series Title} {season}x{episode}", ep, opts), "Frieren - Beyond Journey's End 1x5");
  assert.equal(renderMovie("{Movie CleanTitle} ({Release Year}) {[Quality Full]}{-Release Group}", { movieTitle: "Suzume", year: 2022, quality: "Bluray-1080p", releaseGroup: null }, opts), "Suzume (2022) [Bluray-1080p]");
  const radarr = "{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}} {edition-{Edition Tags}} {[Quality Full]}{-Release Group}";
  assert.equal(renderMovie(radarr, { movieTitle: "Suzume", year: 2022, quality: "Bluray-1080p" }, opts), "Suzume (2022) [Bluray-1080p]");
  assert.equal(renderMovie(radarr, { movieTitle: "Suzume", year: 2022, imdbId: "tt16428256", quality: "Bluray-1080p" }, opts), "Suzume (2022) {imdb-tt16428256} [Bluray-1080p]");
});
