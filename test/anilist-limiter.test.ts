/**
 * AniList rate limits (429): background work waits out Retry-After without holding the queue, and interactive calls
 * (the Add search, an Add) never sit behind that wait: a long pause fails them at once with "try again in N s", a short
 * one is waited out and they still go first. Time-based checks use tolerance ranges.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-anilist-"));
process.env.ANIMEARR_NO_LOCK = "1";

const A = await import("../server/metadata/anilist.js");
const reset = (A as { resetAnilistLimiter?: () => void }).resetAnilistLimiter;
beforeEach(() => reset?.());

const ok = (media: unknown[] = []) => new Response(JSON.stringify({ data: { Page: { media } } }), { status: 200 });
const limited = (retryAfter: number | null) =>
  new Response("slow down", { status: 429, headers: retryAfter === null ? {} : { "retry-after": String(retryAfter) } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolves with the call's outcome, or "still waiting" after `ms`. */
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p.then(
      (v) => ({ v }),
      (e: Error) => ({ e }),
    ),
    sleep(ms).then(() => "still waiting" as const),
  ]);

test("a background 429 with a long Retry-After: an interactive search fails at once and says when to try again", async () => {
  let calls = 0;
  const bg: typeof fetch = (async () => (calls++, limited(30))) as typeof fetch;
  const background = A.mediaByIds([1], bg); // catalog refresh hits the limit
  void background.catch(() => undefined); // it waits for the pause; its outcome isn't this test's business
  await sleep(300);
  assert.equal(calls, 1);
  const t0 = Date.now();
  const r = await within(A.searchMedia("frieren", 15, (async () => ok()) as typeof fetch), 4000);
  assert.notEqual(r, "still waiting", "the search didn't wait behind the background pause");
  assert.ok(typeof r === "object" && "e" in r, "it failed fast");
  assert.match((r as { e: Error }).e.message, /AniList is rate-limiting.*try again in (2\d|30) s/);
  assert.ok(Date.now() - t0 < 3000, `answered in ${Date.now() - t0} ms`);
});

test("Retry-After is honoured: the next request waits about that long, then succeeds", async () => {
  const at: number[] = [];
  let n = 0;
  const f: typeof fetch = (async () => (at.push(Date.now()), n++ === 0 ? limited(1) : ok([{ id: 7 }]))) as typeof fetch;
  const got = await A.mediaByIds([7], f);
  assert.deepEqual(
    got.map((m) => m.id),
    [7],
  );
  const gap = at[1] - at[0];
  assert.ok(gap >= 900 && gap < 3500, `waited ${gap} ms for a 1 s Retry-After`);
});

test("a short pause is waited out for an interactive call, which still goes before the waiting background work", async () => {
  const order: string[] = [];
  let first = true;
  const f: typeof fetch = (async (_u: string | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const who = body.includes("search") ? "search" : "background";
    order.push(who);
    if (first) {
      first = false;
      return limited(2);
    }
    return ok();
  }) as typeof fetch;
  const background = A.mediaByIds([1, 2], f);
  await sleep(300);
  const search = A.searchMedia("dandadan", 15, f);
  const r = await within(search, 6000);
  assert.ok(typeof r === "object" && "v" in r, "the search succeeded after the short pause");
  await background;
  assert.deepEqual(order, ["background", "search", "background"]);
});

test("three 429s in a row: the call gives up with a clear message instead of hanging", async () => {
  const f: typeof fetch = (async () => limited(1)) as typeof fetch;
  const t0 = Date.now();
  await assert.rejects(A.mediaByIds([3], f), /AniList is rate-limiting/);
  const took = Date.now() - t0;
  assert.ok(took >= 1800 && took < 8000, `gave up after ${took} ms`);
});

test("a search superseded while it waits its turn isn't run, and no other call is dropped in its place", async () => {
  const asked: string[] = [];
  const f: typeof fetch = (async (_u: string | URL, init?: RequestInit) => {
    const v = (JSON.parse(String(init?.body)) as { variables: { q?: string; ids?: number[] } }).variables;
    asked.push(v.q ?? `ids ${v.ids?.join(",")}`);
    return ok();
  }) as typeof fetch;
  await A.mediaByIds([1], f); // the next request has to wait ~2 s (spacing)
  const s1 = A.searchMedia("fri", 15, f); // waiting for its turn...
  await sleep(300);
  const bg = A.mediaByIds([2], f);
  const s2 = A.searchMedia("frieren", 15, f); // ...when the user types on
  await assert.rejects(s1, /superseded/);
  const r = await within(Promise.all([s2, bg]), 8000);
  assert.ok(typeof r === "object" && "v" in r, "the newer search and the background call both ran");
  assert.deepEqual(asked, ["ids 1", "frieren", "ids 2"]);
});
