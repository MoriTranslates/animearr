/**
 * Settings → Media servers: what AnimeArr writes beside the videos (NFO files, .plexmatch, artwork) and which
 * server is the main one (it picks the {Server Id Hint} folder style). Plus the new-user wizard's "which media
 * server(s) do you use?" picker, which switches on the files those servers read.
 */
import { useState } from "react";
import { api, type Settings as S } from "./api";
import type { SaveNow } from "./connections";
import { t } from "./i18n";
import { Toggle, useToast } from "./ui";

type Main = S["mediaOutput"]["main"];
const SERVERS: { id: Exclude<Main, "none">; name: string }[] = [
  { id: "plex", name: "Plex" },
  { id: "jellyfin", name: "Jellyfin" },
  { id: "emby", name: "Emby" },
  { id: "kodi", name: "Kodi" },
];

export function MediaOutputCard({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  const toast = useToast();
  const m = s.mediaOutput;
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<S["mediaOutput"]>) => void saveNow((x) => ({ ...x, mediaOutput: { ...x.mediaOutput, ...patch } }));
  return (
    <section className="card pad stack" aria-labelledby="mediaout-title">
      <h2 id="mediaout-title">{t("media.out.title")}</h2>
      <p className="muted small">{t("media.out.help")}</p>
      <label>
        {t("media.out.main")}
        <select value={m.main} onChange={(e) => set({ main: e.target.value as Main })}>
          <option value="none">{t("media.out.mainNone")}</option>
          {SERVERS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <span className="muted small">{t("media.out.mainHelp")}</span>
      </label>
      <Toggle checked={m.nfo} onChange={(v) => set({ nfo: v })} label={t("media.out.nfo")} help={t("media.out.nfoHelp")} />
      <Toggle checked={m.plexmatch} onChange={(v) => set({ plexmatch: v })} label={t("media.out.plexmatch")} help={t("media.out.plexmatchHelp")} />
      <Toggle checked={m.artwork} onChange={(v) => set({ artwork: v })} label={t("media.out.artwork")} help={t("media.out.artworkHelp")} />
      <div className="row">
        <button
          disabled={busy || !(m.nfo || m.plexmatch || m.artwork)}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ started: boolean }>("/mediaout/sync", { method: "POST" });
              toast(r.started ? t("media.out.syncStarted") : t("media.out.syncRunning"));
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("media.out.syncAll")}
        </button>
        <span className="muted small">{t("media.out.syncHelp")}</span>
      </div>
    </section>
  );
}

/** Wizard (new users): pick the servers; the first one picked becomes the main one. */
export function MediaPicker({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  // Starts from what's saved (main server, the files switched on, servers already connected); kept on screen after.
  const [picked, setPicked] = useState<Exclude<Main, "none">[]>(() => SERVERS.filter((x) => s.mediaOutput.main === x.id || (x.id === "plex" ? s.mediaOutput.plexmatch : (s[x.id] as { enabled: boolean }).enabled)).map((x) => x.id).sort((a, b) => (a === s.mediaOutput.main ? -1 : b === s.mediaOutput.main ? 1 : 0)));
  const choose = (next: Exclude<Main, "none">[]) => {
    setPicked(next);
    void saveNow((x) => ({
      ...x,
      mediaOutput: {
        main: next[0] ?? "none",
        // Jellyfin, Emby and Kodi read NFO files and artwork; Plex reads .plexmatch.
        nfo: next.some((k) => k !== "plex"),
        artwork: next.some((k) => k !== "plex"),
        plexmatch: next.includes("plex"),
      },
    }));
  };
  return (
    <fieldset className="card pad stack">
      <legend>{t("media.pick.title")}</legend>
      <p className="muted small">{t("media.pick.help")}</p>
      <div className="row wrap">
        {SERVERS.map((x) => (
          <label key={x.id} className="check">
            <input type="checkbox" checked={picked.includes(x.id)} onChange={(e) => choose(e.target.checked ? [...picked, x.id] : picked.filter((k) => k !== x.id))} /> {x.name}
          </label>
        ))}
      </div>
      {picked.length > 0 && <p className="muted small">{t("media.pick.main", { name: SERVERS.find((x) => x.id === picked[0])!.name })}</p>}
    </fieldset>
  );
}
