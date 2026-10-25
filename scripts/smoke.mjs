// Smoke test: logs in, opens every page in headless Chrome at phone size, saves screenshots and reports console errors.
// Usage: node scripts/smoke.mjs <outDir> [width] [height]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const out = process.argv[2] ?? "smoke";
const W = Number(process.argv[3] ?? 390);
const Hh = Number(process.argv[4] ?? 844);
fs.mkdirSync(out, { recursive: true });
const base = process.env.ANIMEARR_URL ?? "http://127.0.0.1:8484";
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-AnimeArr": "1" }, body: JSON.stringify({ username: "admin", password: process.env.ANIMEARR_PW ?? "changeme" }) });
const sid = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
const port = 9333;
const profile = fs.mkdtempSync(path.join(out, "profile-"));
const proc = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", `--window-size=${W},${Hh}`, "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 40 && !ws; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find((x) => x.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
}
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) (pending.get(msg.id))(msg), pending.delete(msg.id);
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: Hh, deviceScaleFactor: 2, mobile: W < 800 });
await send("Network.setCookie", { name: sid[0], value: sid[1], url: base });
const pages = (process.env.PAGES ?? "/,/managed,/shows,/audit?tab=gaps,/audit?tab=language,/audit?tab=specials,/search?tvdbId=328670&eps=,/search?tab=identify,/activity,/settings,/settings?tab=safety,/settings?tab=system,/show/328670").split(",");
const report = [];
for (const entry of pages) {
  // "path|css-selector" clicks that element after loading (e.g. open the episode sheet).
  const [p, click] = entry.split("|");
  const before = errors.length;
  await send("Page.navigate", { url: base + p });
  await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 3500)));
  if (click) {
    await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(click)})?.click()` });
    await new Promise((r) => setTimeout(r, 2500));
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const name = (entry.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home").slice(0, 60);
  fs.writeFileSync(path.join(out, `${name}-${W}.png`), Buffer.from(shot.result.data, "base64"));
  const ev = await send("Runtime.evaluate", { expression: "JSON.stringify({h1: document.querySelector('h1')?.textContent ?? null, text: document.body.innerText.length, scrollW: document.documentElement.scrollWidth, err: document.querySelector('.error-box')?.textContent ?? null})", returnByValue: true });
  const info = JSON.parse(ev.result.result.value);
  report.push({ page: entry, ...info, overflowX: info.scrollW > W, consoleErrors: errors.slice(before) });
}
console.log(JSON.stringify(report, null, 1));
ws.close();
proc.kill();
setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1000);
