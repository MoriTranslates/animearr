/** Absolute Duo (2026-10-27): the real track layouts of its files, judged for a Sub profile. English AUDIO never counts as "has English" in Sub mode. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-aduo-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { judge } = await import("../server/verify.js");
const { probeOf } = await import("../server/mediafiles.js");

const SUB = { subLangs: ["en"], dubLangs: ["en"], watchMode: "sub" as const, originalLangs: ["ja"] };
const rec = (audio: (string | null)[], subs: { lang: string | null; forced?: boolean }[]) =>
  ({ path: "/x.mkv", size: 1, mtime: 0, duration: 1420, container: "matroska", video: null, audio: audio.map((lang, i) => ({ index: i + 1, codec: "aac", lang, title: null, default: i === 0, channels: 2 })), subs: subs.map((s, i) => ({ index: audio.length + 1 + i, codec: "ass", lang: s.lang, title: null, default: true, forced: !!s.forced, partial: !!s.forced })), sidecars: [] }) as unknown as Parameters<typeof probeOf>[0];
const v = (r: ReturnType<typeof rec>, mode: "sub" | "dub" | "either" = "sub") => judge(probeOf(r), { ...SUB, watchMode: mode }, 24, null);

test("E01: untagged audio + English ASS flagged forced → signs-only, not OK", () => {
  const x = v(rec([null], [{ lang: "en", forced: true }]));
  assert.equal(x.ok, false);
  assert.equal(x.code, "forced-only");
});
test("E02/E03/E08: Japanese audio + an untagged ASS track → language unknown (not 'no subs')", () => {
  const x = v(rec(["ja"], [{ lang: null }]));
  assert.equal(x.ok, false);
  assert.equal(x.code, "untagged");
});
test("E04–E07, E09–E12: English audio, no subtitle track → 'dub only, no subs' in Sub mode", () => {
  const x = v(rec(["en"], []));
  assert.equal(x.ok, false);
  assert.equal(x.code, "dub-no-subs");
  assert.match(x.why, /en dub only, no en subtitles/);
  assert.equal(v(rec(["en"], []), "dub").ok, true, "a Dub profile accepts it");
  assert.equal(v(rec(["en"], []), "either").ok, true, "so does Either");
});
test("after Fix detection: Japanese audio + English full subs → OK", () => {
  assert.equal(v(rec(["ja"], [{ lang: "en" }])).ok, true);
});
