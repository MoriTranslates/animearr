// v0.1 ACCEPTANCE (live, read-only): "Full-Time Magister S6 is found by Deep Search."
// Searches Prowlarr for S06E01-E12 of Full-Time Magister (TVDB 328670) and checks that the "Quan.Zhi.Fa.Shi.S6.-.NN"
// Usenet releases (and the "S6 - 1-12" pack) map to the right S06Exx, never to S01Exx or "whole season", and are
// flagged "English burned-in (720p)" once the season's burned-in fact is recorded. Never grabs.
// Usage (server running): node scripts/acceptance-magister.mjs
const base = process.env.ANIMEARR_URL ?? "http://127.0.0.1:8484";
const H = { "Content-Type": "application/json", "X-AnimeArr": "1" };
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ username: "admin", password: process.env.ANIMEARR_PW ?? "changeme" }) });
const C = { ...H, Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
const get = async (p) => (await fetch(base + p, { headers: C })).json();
const post = async (p, b) => {
  const r = await fetch(base + p, { method: "POST", headers: C, body: JSON.stringify(b) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
};
const TVDB = 328670;
const s = await get(`/api/series/${TVDB}`);
const s6 = s.episodes.filter((e) => e.season === 6).sort((a, b) => a.episode - b.episode);
if (s6.length !== 12) throw new Error(`expected 12 S6 episodes, got ${s6.length}`);
if (!s.facts.some((f) => f.kind === "burned_in" && f.season === 6)) {
  await post("/api/facts", { tvdbId: TVDB, season: 6, kind: "burned_in", lang: "en", note: "only source: EN+CN burned-in web rips" });
  console.log("recorded fact: Season 6 has burned-in English (as the user confirmed on 2026-10-25)");
}
const r = await post("/api/search", { tvdbId: TVDB, episodeIds: s6.map((e) => e.id) });
console.log(`queries: ${r.queries.join(" | ")}\nfound ${r.found}, matched ${r.matched}, skipped ${JSON.stringify(r.skipped)}`);
const qz = r.results.filter((x) => /^Quan\.Zhi\.Fa\.Shi\.S6\.-\./.test(x.title));
let fails = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
  if (!ok) fails++;
};
for (let n = 1; n <= 12; n++) {
  const t = `Quan.Zhi.Fa.Shi.S6.-.${String(n).padStart(2, "0")}`;
  const x = qz.find((q) => q.title === t);
  if (!x) {
    check(false, `${t}: not found`);
    continue;
  }
  const want = `S06E${String(n).padStart(2, "0")}`;
  check(x.label === want && x.rank.flags.some((f) => f.label === "English burned-in (720p)") && x.protocol === "usenet", `${t} → ${x.label} [${x.rank.flags.map((f) => f.label).join(", ")}]`);
}
const pack = qz.find((q) => /S6\.-\.1-12/.test(q.title));
check(!!pack && pack.label === "S06E01-E12", `pack ${pack?.title ?? "(not found)"} → ${pack?.label}`);
check(!r.results.some((x) => /^Quan\.Zhi\.Fa\.Shi\.S6/.test(x.title) && (/S01E|whole season/.test(x.label))), "no S6 release mapped to S01Exx or a whole season");
console.log(fails ? `\n${fails} check(s) FAILED` : "\nACCEPTANCE PASSED");
process.exit(fails ? 1 : 0);
