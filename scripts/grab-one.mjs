// Dev: Deep Search one episode and grab the release whose title matches a regex (real grab unless dry-run is on).
// node scripts/grab-one.mjs <tvdbId> <season> <episode> <titleRegex>
const [tvdb, season, ep, pat] = process.argv.slice(2);
const base = process.env.ANIMEARR_URL ?? "http://127.0.0.1:8484";
const H = { "Content-Type": "application/json", "X-AnimeArr": "1" };
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ username: "admin", password: process.env.ANIMEARR_PW ?? "changeme" }) });
const C = { ...H, Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
const s = await (await fetch(`${base}/api/series/${tvdb}`, { headers: C })).json();
const e = s.episodes.find((x) => x.season === Number(season) && x.episode === Number(ep));
const r = await (await fetch(`${base}/api/search`, { method: "POST", headers: C, body: JSON.stringify({ tvdbId: Number(tvdb), episodeIds: [e.id] }) })).json();
const pick = r.results.find((x) => new RegExp(pat).test(x.title) && x.rank.accept);
if (!pick) throw new Error("no matching accepted result");
console.log("grabbing:", pick.title, "→", pick.label, "|", pick.rank.why);
const g = await (await fetch(`${base}/api/grab`, { method: "POST", headers: C, body: JSON.stringify({ tvdbId: Number(tvdb), episodeIds: [e.id], guid: pick.guid, confirm: true }) })).json();
console.log(JSON.stringify(g));
