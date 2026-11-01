/** A run of bracketed language codes after "Multiple Subtitle" lists subtitles: "[ITA]" there is not an Italian dub. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-subtags-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { parseRelease } = await import("../server/core/parser.js");

test("Erai-raws batch with a subtitle tag list is not an Italian dub", () => {
  const p = parseRelease("[Erai-raws] Black Clover S01 (TV) - 001 ~ 170 [1080p][BATCH][Multiple Subtitle] [ENG][POR-BR][SPA-LA][SPA][ARA][FRE][GER][ITA][RUS]");
  assert.ok(!p.hints.audio.includes("it"));
  assert.ok(p.hints.multiSubs);
});

test("a real Italian release still reads as an Italian dub", () => {
  assert.ok(parseRelease("Black Clover - 01 ITA 1080p WEB-DL").hints.audio.includes("it"));
  assert.ok(parseRelease("[Group] Black Clover - 01 [ITA][1080p]").hints.audio.includes("it"));
});
