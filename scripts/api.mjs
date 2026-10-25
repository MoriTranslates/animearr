// Dev helper: node scripts/api.mjs METHOD /api/path ['{"json":1}']  (logs in as the dev account)
const [method, p, body] = process.argv.slice(2);
const base = process.env.ANIMEARR_URL ?? "http://127.0.0.1:8484";
const H = { "Content-Type": "application/json", "X-AnimeArr": "1" };
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ username: "admin", password: process.env.ANIMEARR_PW ?? "changeme" }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const r = await fetch(base + p, { method, headers: { ...H, Cookie: cookie }, body: body ?? (method === "GET" ? undefined : "{}") });
const t = await r.text();
if (!r.ok) console.error(r.status);
process.stdout.write(t);
