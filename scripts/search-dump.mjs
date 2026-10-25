// Dev: run a Deep Search and print a compact table. node scripts/search-dump.mjs <tvdbId> <season> [episodes,...|missing]
const [tvdb, season, which] = process.argv.slice(2);
const base = process.env.ANIMEARR_URL ?? "http://127.0.0.1:8484";
const H = { "Content-Type": "application/json", "X-AnimeArr": "1" };
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ username: "admin", password: process.env.ANIMEARR_PW ?? "changeme" }) });
const C = { ...H, Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
const s = await (await fetch(`${base}/api/series/${tvdb}`, { headers: C })).json();
let eps = s.episodes.filter((e) => e.season === Number(season));
if (which === "missing") eps = eps.filter((e) => !e.hasFile && e.airUtc && e.airUtc < Date.now());
else if (which) eps = eps.filter((e) => which.split(",").map(Number).includes(e.episode));
const r = await (await fetch(`${base}/api/search`, { method: "POST", headers: C, body: JSON.stringify({ tvdbId: Number(tvdb), episodeIds: eps.map((e) => e.id) }) })).json();
if (r.error) throw new Error(r.error);
console.log(`${s.title} S${season} eps ${eps.map((e) => e.episode).join(",")}: found ${r.found}, matched ${r.matched}`);
for (const x of r.results) console.log(`${x.rank.accept ? "OK " : "NO "} ${String(x.rank.score).padStart(5)} ${x.protocol.slice(0, 3)} ${x.label.padEnd(12)} ${(x.size / 1e9).toFixed(2)}G ${x.title.slice(0, 110)}\n      ${x.rank.flags.map((f) => f.label).join(" | ")}`);
