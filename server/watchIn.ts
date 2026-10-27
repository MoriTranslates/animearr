/**
 * "Watch in …": a link to the file's item in the user's media server, to check it with your own eyes (burned-in
 * subtitles, a wrong scan). Media-server agnostic: Plex now; Jellyfin/Emby/Kodi providers slot in here later.
 */
import { getSettings } from "./settings.js";
import { plexApi, plexSections, sectionFor, toPlexPath } from "./plex.js";

export interface WatchLink { server: string; web: string; app: string | null }
interface Provider { name: string; configured: () => boolean; link: (arrPath: string, title: string, kind: "episode" | "movie") => Promise<WatchLink | null> }

const cache = new Map<string, { at: number; key: string | null }>();
let machine: { at: number; id: string } | null = null;

interface PlexItem { ratingKey: string; title: string; Media?: { Part?: { file?: string }[] }[] }
const files = (x: PlexItem) => (x.Media ?? []).flatMap((m) => (m.Part ?? []).map((p) => (p.file ?? "").replace(/\\/g, "/")));

const plex: Provider = {
  name: "Plex",
  configured: () => !!(getSettings().plex.url && getSettings().plex.token),
  async link(arrPath, title, kind) {
    const s = getSettings().plex;
    const pp = toPlexPath(arrPath);
    const hit = cache.get(pp);
    // Hits for a day; a miss (Plex hasn't scanned the file yet) for 5 minutes.
    let key = hit && Date.now() - hit.at < (hit.key ? 86_400_000 : 5 * 60_000) ? hit.key : undefined;
    if (key === undefined) {
      key = null;
      const section = sectionFor(pp, await plexSections());
      if (section) {
        // Find the show/movie by title, then the item whose file is this one.
        const list = await plexApi<{ MediaContainer: { Metadata?: PlexItem[] } }>(`/library/sections/${section.key}/all?type=${kind === "movie" ? 1 : 2}&title=${encodeURIComponent(title)}`);
        for (const m of list?.MediaContainer.Metadata ?? []) {
          if (kind === "movie") {
            if (files(m).includes(pp)) key = m.ratingKey;
          } else {
            const eps = await plexApi<{ MediaContainer: { Metadata?: PlexItem[] } }>(`/library/metadata/${m.ratingKey}/allLeaves`);
            key = (eps?.MediaContainer.Metadata ?? []).find((e) => files(e).includes(pp))?.ratingKey ?? null;
          }
          if (key) break;
        }
      }
      cache.set(pp, { at: Date.now(), key });
    }
    if (!key) return null;
    if (!machine || Date.now() - machine.at > 86_400_000) {
      const id = (await plexApi<{ MediaContainer: { machineIdentifier?: string } }>("/"))?.MediaContainer.machineIdentifier;
      if (!id) return null;
      machine = { at: Date.now(), id };
    }
    const hash = `#!/server/${machine.id}/details?key=${encodeURIComponent(`/library/metadata/${key}`)}`;
    return { server: "Plex", web: `${s.url.replace(/\/+$/, "")}/web/index.html${hash}`, app: `https://app.plex.tv/desktop/${hash}` };
  },
};

const PROVIDERS: Provider[] = [plex];

/** Links to this file in every configured media server that has it. */
export async function watchLinks(arrPath: string, title: string, kind: "episode" | "movie") {
  const out: WatchLink[] = [];
  const errors: string[] = [];
  for (const p of PROVIDERS.filter((x) => x.configured())) {
    try {
      const l = await p.link(arrPath, title, kind);
      if (l) out.push(l);
    } catch (e) {
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  return { links: out, servers: PROVIDERS.filter((x) => x.configured()).map((x) => x.name), errors };
}
