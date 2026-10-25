// node scripts/time-search.mjs <tvdbId> <season> <episode> [full]  — times one blocking Deep Search
const [tvdb, season, ep, full] = process.argv.slice(2);
const base = process.env.ANIMEARR_URL ?? "http://127.0.0.1:8484";
const H = { "Content-Type": "application/json", "X-AnimeArr": "1" };
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ username: "admin", password: process.env.ANIMEARR_PW ?? "animearr" }) });
const C = { ...H, Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
const s = await (await fetch(`${base}/api/series/${tvdb}`, { headers: C })).json();
const e = s.episodes.find((x) => x.season === Number(season) && x.episode === Number(ep));
const t0 = Date.now();
const r = await (await fetch(`${base}/api/search`, { method: "POST", headers: C, body: JSON.stringify({ tvdbId: Number(tvdb), episodeIds: [e.id], full: full === "full" }) })).json();
const best = r.results.find((x) => x.rank.accept);
console.log(`${s.title} S${season}E${ep}: ${((Date.now() - t0) / 1000).toFixed(1)} s, tier ${r.tier}, ${r.queries.length} queries, ${r.found} releases, ${r.matched} matched; best: ${best ? best.title + " (" + best.rank.why + ")" : "none"}`);
