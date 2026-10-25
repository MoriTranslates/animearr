import { parseRelease } from "../server/core/parser.js";
for (const t of process.argv.slice(2)) {
  const p = parseRelease(t);
  console.log(JSON.stringify({ t, title: p.title, g: p.group, s: p.season, ss: p.seasons, e: p.episodes, a: p.absolute, sp: p.specialNumber, spk: p.special, v: p.version, batch: p.batch, full: p.fullSeason, res: p.resolution, src: p.source, plat: p.platform, alt: p.altTitles, h: p.hints }));
}
