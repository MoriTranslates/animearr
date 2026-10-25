// Finds elements wider than the viewport on a page (phone width). node scripts/overflow.mjs /path
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const base = process.env.ANIMEARR_URL ?? "http://127.0.0.1:8484";
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-AnimeArr": "1" }, body: JSON.stringify({ username: "admin", password: process.env.ANIMEARR_PW ?? "animearr" }) });
const sid = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ovf-"));
const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 40 && !ws; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { const p = (await (await fetch("http://127.0.0.1:9334/json")).json()).find((x) => x.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {}
}
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map();
ws.addEventListener("message", (m) => { const x = JSON.parse(m.data); if (x.id && pend.has(x.id)) (pend.get(x.id))(x), pend.delete(x.id); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Network.setCookie", { name: sid[0], value: sid[1], url: base });
await send("Page.navigate", { url: base + process.argv[2] });
await new Promise((r) => setTimeout(r, 3500));
const r = await send("Runtime.evaluate", { returnByValue: true, expression: `JSON.stringify([...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > 391).slice(0, 12).map(e => e.tagName + "." + e.className + " w=" + Math.round(e.getBoundingClientRect().width) + " r=" + Math.round(e.getBoundingClientRect().right) + " :" + (e.textContent||"").slice(0,40)))` });
console.log(JSON.parse(r.result.result.value).join("\n"));
ws.close(); proc.kill();
