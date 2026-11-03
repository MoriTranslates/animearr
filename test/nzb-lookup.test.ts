/**
 * Finding an NZB a restart cut off mid-send (review 2026-11-02, H9 follow-up): SABnzbd and NZBGet are asked, by the
 * release name, in their queue and history. One exact match in AnimeArr's category: that job. Absent from every
 * client: null. A client down, several matches or a near match: "can't tell" (an error), never "absent".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-nzb-lookup-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings } = await import("../server/system/settings.js");
const { realClients } = await import("../server/arr/clients.js");

const NAME = "[Grp] Show - 05 (1080p) [ABCD1234]";
type Job = { name: string; cat?: string; id?: string; doneSec?: number };
const sab = { queue: [] as Job[], history: [] as Job[], down: false };
const nzbget = { queue: [] as Job[], history: [] as Job[], down: false };

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
before(() => {
  patchSettings((s) => ({
    ...s,
    sabnzbd: { url: "http://sab.test", apiKey: "k", category: "animearr" },
    extraClients: [
      {
        id: "ng1",
        type: "nzbget",
        name: "NZBGet",
        url: "http://nzbget.test",
        username: "",
        password: "",
        category: "animearr",
        priority: 2,
        enabled: true,
        removeCompleted: false,
        pathMappings: [],
      },
    ],
  }));
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const url = new URL(String(u));
    if (url.hostname === "sab.test") {
      if (sab.down) throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      const mode = url.searchParams.get("mode");
      if (mode === "queue")
        return json({
          queue: { slots: sab.queue.map((j, i) => ({ nzo_id: j.id ?? `SABnzbd_nzo_q${i}`, filename: j.name, cat: j.cat ?? "animearr" })) },
        });
      if (mode === "history")
        return json({
          history: {
            slots: sab.history.map((j, i) => ({
              nzo_id: j.id ?? `SABnzbd_nzo_h${i}`,
              name: j.name,
              category: j.cat ?? "animearr",
              completed: j.doneSec ?? Math.floor(Date.now() / 1000),
            })),
          },
        });
      throw new Error(`unexpected SAB mode ${mode}`);
    }
    if (url.hostname === "nzbget.test") {
      if (nzbget.down) return new Response("down", { status: 503 });
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      if (method === "listgroups")
        return json({
          result: nzbget.queue.map((j, i) => ({ NZBID: Number(j.id ?? 100 + i), NZBName: j.name, Category: j.cat ?? "animearr" })),
        });
      if (method === "history")
        return json({
          result: nzbget.history.map((j, i) => ({
            NZBID: Number(j.id ?? 200 + i),
            Name: j.name,
            Category: j.cat ?? "animearr",
            HistoryTime: j.doneSec ?? Math.floor(Date.now() / 1000),
          })),
        });
      throw new Error(`unexpected NZBGet method ${method}`);
    }
    throw new Error(`unexpected ${url.href}`);
  }) as typeof fetch;
});
after(() => void (globalThis.fetch = realFetch));

const reset = () => {
  Object.assign(sab, { queue: [], history: [], down: false });
  Object.assign(nzbget, { queue: [], history: [], down: false });
};
const find = () => realClients.findNzb!(NAME, Date.now() - 60_000); // the grab was made a minute ago

test("an earlier grab of the same release, finished before this one, isn't taken for it", async () => {
  reset();
  sab.history = [{ name: NAME, doneSec: Math.floor(Date.now() / 1000) - 86_400 }];
  nzbget.history = [{ name: NAME, doneSec: Math.floor(Date.now() / 1000) - 3_600 }];
  assert.equal(await find(), null);
});

test("found in SABnzbd's queue", async () => {
  reset();
  sab.queue = [{ name: "something else" }, { name: NAME, id: "SABnzbd_nzo_x1" }];
  assert.deepEqual(await find(), { client: "sabnzbd", ref: "SABnzbd_nzo_x1" });
});

test("found in NZBGet's history (it finished already)", async () => {
  reset();
  nzbget.history = [{ name: NAME, id: "321" }];
  assert.deepEqual(await find(), { client: "ng1", ref: "321" });
});

test("absent from every queue and history: null (it never arrived)", async () => {
  reset();
  sab.history = [{ name: "[Grp] Show - 04 (1080p)" }];
  nzbget.queue = [{ name: "Other Show - 01" }];
  assert.equal(await find(), null);
});

test("a job of that name in another category isn't AnimeArr's", async () => {
  reset();
  sab.queue = [{ name: NAME, cat: "tv" }];
  assert.equal(await find(), null);
});

test("a client down: can't tell (never 'absent')", async () => {
  reset();
  nzbget.down = true;
  await assert.rejects(find(), /NZBGet/);
  reset();
  sab.down = true;
  nzbget.history = [{ name: NAME, id: "9" }];
  assert.deepEqual(await find(), { client: "ng1", ref: "9" }, "found in the client that answered");
});

test("two matches, or only a near match: can't tell", async () => {
  reset();
  sab.queue = [{ name: NAME, id: "a" }];
  sab.history = [{ name: NAME, id: "b" }];
  await assert.rejects(find(), /2 jobs/);
  reset();
  nzbget.queue = [{ name: "[Grp] Show - 05 (1080p) [ABCD1234].1" }];
  sab.queue = [{ name: "[grp] show - 05 (1080p) [abcd1234]" }];
  await assert.rejects(find(), /similar name/);
});
