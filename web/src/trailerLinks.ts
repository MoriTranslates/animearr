/**
 * Trailer links (AniList's trailer: a YouTube or Dailymotion video id). The trailer plays from the site itself;
 * AnimeArr never downloads, proxies or stores the video. No DOM here (unit-tested).
 */
export interface Trailer {
  site: "youtube" | "dailymotion";
  id: string;
  thumbnail: string | null;
}

const ID = /^[A-Za-z0-9_-]+$/;

/** The player and "open on the site" links, or null when the site or the id isn't one we trust. */
export function trailerLinks(tr: Pick<Trailer, "site" | "id"> | null | undefined): { embed: string; watch: string; site: "YouTube" | "Dailymotion" } | null {
  if (!tr || typeof tr.id !== "string" || tr.id.length > 64 || !ID.test(tr.id)) return null;
  if (tr.site === "youtube") return { embed: `https://www.youtube-nocookie.com/embed/${tr.id}?autoplay=1&rel=0`, watch: `https://www.youtube.com/watch?v=${tr.id}`, site: "YouTube" };
  if (tr.site === "dailymotion") return { embed: `https://www.dailymotion.com/embed/video/${tr.id}`, watch: `https://www.dailymotion.com/video/${tr.id}`, site: "Dailymotion" };
  return null;
}
