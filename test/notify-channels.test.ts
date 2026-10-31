/** Extra notification channels: payload shapes per channel (mocked fetch / mail transport), secrets, failures. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings, getSettings, publicSettings, MASK } = await import("../server/settings.js");
const { send, testChannel, channelStatus } = await import("../server/notify.js");
const { newChannel, cleanChannels, maskChannel, buildRequest, deliver } = await import("../server/notifyChannels.js");

const note = { event: "grabbed", head: "⬇️ Grabbed: Frieren", title: "Frieren", body: "Sent [Group] Frieren - 05 <1080p> & more", link: "http://animearr.lan/show/1", meta: { tvdbId: 424536, episodeIds: [5], release: "[Group] Frieren - 05", grabId: 9 }, at: Date.UTC(2026, 9, 31, 12) };
const ok = (calls: { url: string; init: RequestInit }[], status = 200) => ((async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("", { status }))) as unknown as typeof fetch);

const full = () => {
  const mk = (type: "webhook" | "telegram" | "pushover" | "email", patch: object) => ({ ...newChannel(type, type), name: type, ...patch });
  return [
    mk("webhook", { url: "https://hooks.example.com/in/SECRETPATH", method: "PUT", headers: [{ name: "Authorization", value: "Bearer SECRETHDR" }] }),
    mk("telegram", { botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012", chatId: "-100200", threadId: "7", silent: true }),
    mk("pushover", { userKey: "USERKEY1234", appToken: "APPTOKEN1234", priority: 1, device: "phone", sound: "magic" }),
    mk("email", { host: "smtp.example.com", port: 465, secure: "tls", username: "me", password: "SMTPPASSWORD", from: "animearr@example.com", to: "a@example.com, b@example.com" }),
  ];
};

test("webhook: JSON payload, chosen method, custom headers", () => {
  const [wh] = full();
  const r = buildRequest(wh, note)!;
  assert.equal(r.url, "https://hooks.example.com/in/SECRETPATH");
  assert.equal(r.init.method, "PUT");
  assert.equal((r.init.headers as Record<string, string>).Authorization, "Bearer SECRETHDR");
  const b = JSON.parse(r.init.body as string);
  assert.equal(b.eventType, "grabbed");
  assert.deepEqual(b.show, { tvdbId: 424536, title: "Frieren" });
  assert.equal(b.release, "[Group] Frieren - 05");
  assert.equal(b.timestamp, "2026-10-31T12:00:00.000Z");
  assert.ok(b.applicationVersion);
  assert.equal(b.movie, undefined);
});

test("telegram: Bot API sendMessage with escaped HTML, topic and silent", () => {
  const r = buildRequest(full()[1], note)!;
  assert.match(r.url, /^https:\/\/api\.telegram\.org\/bot123456:[\w-]+\/sendMessage$/);
  const b = JSON.parse(r.init.body as string);
  assert.equal(b.chat_id, "-100200");
  assert.equal(b.parse_mode, "HTML");
  assert.equal(b.message_thread_id, 7);
  assert.equal(b.disable_notification, true);
  assert.match(b.text, /<b>⬇️ Grabbed: Frieren<\/b>/);
  assert.match(b.text, /&lt;1080p&gt; &amp; more/);
});

test("pushover: keys, priority, device, sound", () => {
  const r = buildRequest(full()[2], note)!;
  assert.equal(r.url, "https://api.pushover.net/1/messages.json");
  const b = JSON.parse(r.init.body as string);
  assert.deepEqual([b.token, b.user, b.priority, b.device, b.sound], ["APPTOKEN1234", "USERKEY1234", 1, "phone", "magic"]);
  assert.equal(b.url, note.link);
});

test("email: goes through the transport with split recipients and TLS settings", async () => {
  const sent: { c: unknown; m: { to: string[]; subject: string; text: string } }[] = [];
  const r = await deliver(full()[3], note, { fetch, sendMail: async (c, m) => void sent.push({ c, m }) });
  assert.equal(r.ok, true);
  assert.deepEqual(sent[0].m.to, ["a@example.com", "b@example.com"]);
  assert.match(sent[0].m.subject, /Grabbed: Frieren/);
  assert.match(sent[0].m.text, /show\/1/);
});

test("send(): each channel follows its own switch and event toggles; results land in the status", async () => {
  const [wh, tg, po, em] = full();
  tg.events.grabbed = false;
  po.enabled = false;
  patchSettings((s) => ({ ...s, notify: { ...s.notify, events: { ...s.notify.events, grabbed: false }, channels: [wh, tg, po, em] } }));
  const calls: { url: string; init: RequestInit }[] = [];
  const mails: unknown[] = [];
  const out = await send("grabbed", "Frieren", "Sent it", { fetch: ok(calls), sendMail: async (_c, m) => void mails.push(m) }, null, { tvdbId: 1 });
  assert.deepEqual(out.map((o) => o.id), ["webhook", "email"], "telegram has grabbed off, pushover is disabled, legacy has none set");
  assert.equal(calls.length, 1);
  assert.equal(mails.length, 1);
  assert.equal(channelStatus().webhook.ok, true);
  assert.deepEqual(await send("imported", "x", "y", { fetch: ok([]), sendMail: async () => undefined }).then((r) => r.map((o) => o.id)), ["webhook", "telegram", "email"]);
});

test("a failing channel never throws, shows its last error, and no secret appears in it", async () => {
  const ch = full();
  patchSettings((s) => ({ ...s, notify: { ...s.notify, channels: ch } }));
  const boom = (async (url: string, init: RequestInit) => {
    throw new Error(`connect ECONNREFUSED ${url} ${JSON.stringify(init.headers)} ${init.body}`); // a transport that echoes the whole request
  }) as unknown as typeof fetch;
  const out = await send("failed", "Frieren", "Broke", { fetch: boom, sendMail: async () => { throw new Error("535 auth failed for me:SMTPPASSWORD"); } });
  assert.equal(out.length, 4);
  assert.ok(out.every((o) => !o.ok));
  const all = JSON.stringify([out, channelStatus()]);
  for (const secret of ["SECRETPATH", "SECRETHDR", "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012", "USERKEY1234", "APPTOKEN1234", "SMTPPASSWORD"]) assert.ok(!all.includes(secret), `${secret} leaked`);
  assert.ok(channelStatus().email.error);
  const t = await testChannel(ch[0], { fetch: ok([], 500) });
  assert.equal(t.ok, false);
  assert.equal(t.why, "HTTP 500");
  assert.equal((await testChannel(newChannel("telegram", "t"))).ok, false, "an unfinished channel says what is missing");
});

test("secrets are masked for the browser and kept when saved back masked", () => {
  const saved = full();
  patchSettings((s) => ({ ...s, notify: { ...s.notify, channels: saved } }));
  assert.equal((publicSettings().notify as Record<string, unknown>).channels, undefined);
  const masked = saved.map(maskChannel);
  const text = JSON.stringify(masked);
  for (const secret of ["SECRETPATH", "SECRETHDR", "ABCDEFGHIJKL", "USERKEY1234", "APPTOKEN1234", "SMTPPASSWORD"]) assert.ok(!text.includes(secret));
  assert.equal(masked[0].url, MASK);
  const back = cleanChannels(masked, getSettings().notify.channels);
  assert.deepEqual(back, saved, "masked values come back as the saved ones");
  masked[0].url = "https://other.example.com/x";
  assert.equal(cleanChannels(masked, saved)[0].url, "https://other.example.com/x");
});

test("channel input is validated", () => {
  assert.throws(() => cleanChannels([{ type: "webhook", url: "ftp://x" }], []), /web address|http/);
  assert.throws(() => cleanChannels([{ type: "webhook", url: "http://169.254.169.254/x" }], []), /isn't allowed/);
  assert.throws(() => cleanChannels([{ type: "telegram", botToken: "nope" }], []), /bot token/);
  const [e] = cleanChannels([{ type: "email", host: "h", port: 99999, secure: "weird", to: "a@b.c", from: "x@y.z" }], []);
  assert.equal(e.port, 65535);
  assert.equal(e.secure, "starttls");
  const [p] = cleanChannels([{ type: "pushover", priority: 9 }], []);
  assert.equal(p.priority, 2);
});
