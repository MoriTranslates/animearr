// Dev check (read-only): does Prowlarr return a recent feed for an empty query? Run with the dev config.
process.env.ANIMEARR_NO_LOCK = "1";
const { prowlarrSearch } = await import("../server/arr/prowlarr.js");
const r = await prowlarrSearch("", { limit: 100 });
const by: Record<string, number> = {};
for (const x of r) by[x.indexer] = (by[x.indexer] ?? 0) + 1;
console.log(r.length, "recent releases", by);
console.log(r.slice(0, 5).map((x) => x.title));
