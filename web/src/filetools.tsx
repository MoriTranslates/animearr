/**
 * Per-file tools on the episode sheet and the movie page:
 * - "Watch in Plex" (any media server AnimeArr knows; Plex for now), to check a file with your own eyes;
 * - quick verdicts for a file without (or with unknown) subtitles: burned-in English / find a replacement;
 * - Peek: three frames from the middle, to spot burned-in subtitles without opening a player;
 * - Fix detection: every track and subtitle file the scan saw, and the fixes for a wrong or missing language tag.
 */
import { useEffect, useState } from "react";
import { Eye, Play, Wrench } from "lucide-react";
import { api } from "./api";
import { t } from "./i18n";
import { Spinner, useToast } from "./ui";

interface WatchLink { server: string; web: string; app: string | null }
interface WatchResult { links: WatchLink[]; servers: string[]; errors: string[] }

const watchUrl = (path: string, title: string, kind: "episode" | "movie") => `/watch?path=${encodeURIComponent(path)}&title=${encodeURIComponent(title)}&kind=${kind}`;

/** Opens the file in the media server from a menu (the tab opens first, so a popup blocker doesn't eat it). */
export async function openInMediaServer(path: string, title: string, kind: "episode" | "movie", toast: (m: string, err?: boolean) => void) {
  const w = window.open("about:blank", "_blank");
  try {
    const r = await api<WatchResult>(watchUrl(path, title, kind));
    const l = r.links[0];
    if (!l) {
      w?.close();
      toast(r.servers.length ? t("watch.notFound", { server: r.servers.join(", ") }) : t("watch.noServer"), true);
      return;
    }
    if (w) {
      w.opener = null;
      w.location.href = l.web;
    } else window.open(l.web, "_blank", "noopener,noreferrer");
  } catch (e) {
    w?.close();
    toast((e as Error).message, true);
  }
}

/** "▶ Watch in Plex" + "Open in the Plex app", looked up when the user asks (one Plex lookup per file, cached server-side). */
export function WatchIn({ path, title, kind }: { path: string; title: string; kind: "episode" | "movie" }) {
  const [r, setR] = useState<WatchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const look = async () => {
    setBusy(true);
    // Open the tab on the click itself (a tab opened after the lookup is eaten by popup blockers).
    const w = window.open("about:blank", "_blank");
    try {
      const x = await api<WatchResult>(watchUrl(path, title, kind));
      setR(x);
      if (x.links[0] && w) {
        w.opener = null;
        w.location.href = x.links[0].web;
      } else w?.close();
    } catch (e) {
      w?.close();
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (r && !r.servers.length) return <span className="muted small">{t("watch.noServer")}</span>;
  const l = r?.links[0];
  return (
    <span className="watch-in row">
      {l ? (
        <a className="button small" href={l.web} target="_blank" rel="noopener noreferrer">
          <Play className="lucide" aria-hidden="true" /> {t("watch.in", { server: l.server })}
        </a>
      ) : (
        <button type="button" className="small" onClick={() => void look()} disabled={busy}>
          <Play className="lucide" aria-hidden="true" /> {busy ? t("common.working") : t("watch.in", { server: "Plex" })}
        </button>
      )}
      {l?.app && (
        <a className="small" href={l.app} target="_blank" rel="noopener noreferrer">
          {t("watch.app", { server: l.server })}
        </a>
      )}
      {r && !l && <span className="muted small">{t("watch.notFound", { server: r.servers.join(", ") })}</span>}
      {err && <span className="error small">{err}</span>}
    </span>
  );
}

/** For a file without (or with unknown) subtitles in the profile's language: two quick answers. */
export function Verdicts({ tvdbId, season, lang, onFind, onDone }: { tvdbId: number; season: number; lang: string; onFind: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const L = lang.toUpperCase();
  return (
    <div className="verdicts card soft">
      <p className="small">{t("verdict.ask", { lang: L })}</p>
      <div className="row">
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/facts", { body: { tvdbId, season, kind: "burned_in", lang } });
              toast(t("verdict.burnedSaved", { lang: L }));
              onDone();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("verdict.burned", { lang: L })}
        </button>
        <button type="button" className="small" disabled={busy} onClick={onFind}>
          {t("verdict.replace", { lang: L })}
        </button>
      </div>
      <p className="muted small">{t("verdict.burnedHint")}</p>
    </div>
  );
}

/** Three frames from the middle of the episode (burned-in subtitles show at a glance). */
export function Peek({ path }: { path: string }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (frames)
    return (
      <div className="peek">
        {frames.length ? frames.map((f, i) => <img key={i} src={f} alt={t("peek.frame", { n: i + 1 })} loading="lazy" />) : <p className="muted small">{t("peek.none")}</p>}
      </div>
    );
  return (
    <span className="row">
      <button
        type="button"
        className="small ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setFrames((await api<{ frames: string[] }>(`/files/peek?path=${encodeURIComponent(path)}`)).frames);
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Eye className="lucide" aria-hidden="true" /> {busy ? t("peek.busy") : t("peek.button")}
      </button>
      {err && <span className="error small">{err}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- Fix detection

interface Track { index: number; codec: string | null; lang: string | null; title: string | null; default: boolean; forced?: boolean; partial?: boolean; overridden?: boolean }
interface Detail {
  path: string;
  scanned: boolean;
  exists: boolean | null;
  sameEpisode: string | null;
  container: string | null;
  audio: (Track & { channels?: number | null })[];
  subs: Track[];
  sidecars: { file: string; lang: string | null; forced?: boolean }[];
  strays: string[];
  overrides: { id: number; trackIndex: number; lang: string | null; forced: boolean }[];
  mkv: boolean;
}
const LANGS = ["en", "ja", "es", "pt", "fr", "de", "it", "ru", "zh", "ko", "ar"];

/** Every track the scan saw and the fixes for a wrong or missing tag. Changes are logged in Activity, with undo. */
export function FixDetection({ path, tvdbId, season, group, title, onChanged, defaultOpen = false }: { path: string; tvdbId?: number | null; season?: number | null; group?: string | null; title?: string; onChanged: () => void; defaultOpen?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(defaultOpen);
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState<"file" | "season" | "group">("file");
  const [alsoTag, setAlsoTag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const load = () =>
    api<Detail>(`/files/detail?path=${encodeURIComponent(path)}`)
      .then((x) => (setD(x), setErr(null)))
      .catch((e) => setErr((e as Error).message));
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      await load();
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void (defaultOpen && load()), []);
  const setTrack = (s: Track, lang: string | null, forced: boolean) =>
    run(() => api("/files/track", { body: { path, trackIndex: s.index, lang, forced, scope, tvdbId, season, group, title, alsoTag: alsoTag && scope !== "group" && d?.mkv } }), t("fix.saved"));
  return (
    <details
      className="fix-detection"
      open={open}
      onToggle={(e) => {
        const o = (e.target as HTMLDetailsElement).open;
        setOpen(o);
        if (o && !d) void load();
      }}
    >
      <summary className="small">
        <Wrench className="lucide" aria-hidden="true" /> {t("fix.title")}
      </summary>
      {err && <p className="error small">{err}</p>}
      {open && !d && !err && <Spinner label={t("app.loading")} />}
      {d && (
        <div className="stack fix-body">
          {d.exists === false && (
            <p className="banner warn small">
              {t("fix.missing")}
              {d.sameEpisode ? ` ${t("fix.sameEpisode", { name: d.sameEpisode })}` : ""}
            </p>
          )}
          {!d.scanned && d.exists !== false && <p className="muted small">{t("fix.notScanned")}</p>}
          {!!d.audio.length && (
            <>
              <h4>{t("fix.audio")}</h4>
              <ul className="plain small tracks">
                {d.audio.map((a) => (
                  <li key={`a${a.index}`}>
                    🔊 <b>{a.lang ?? t("fix.untagged")}</b> · {a.codec}
                    {a.channels ? ` ${a.channels}ch` : ""}
                    {a.title ? ` · “${a.title}”` : ""}
                    {a.default ? ` · ${t("files.default")}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>{t("fix.subs")}</h4>
          {!d.subs.length && <p className="muted small">{t("fix.noSubTracks")}</p>}
          {!!d.subs.length && (
            <>
              <div className="row small fix-scope">
                <label>
                  {t("fix.scope")}{" "}
                  <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                    <option value="file">{t("fix.scope.file")}</option>
                    {tvdbId && season !== null && season !== undefined && <option value="season">{t("fix.scope.season")}</option>}
                    {group && <option value="group">{t("fix.scope.group", { group })}</option>}
                  </select>
                </label>
                {d.mkv && (
                  <label className="check">
                    <input type="checkbox" checked={alsoTag} onChange={(e) => setAlsoTag(e.target.checked)} disabled={scope === "group"} /> {t("fix.alsoTag")}
                  </label>
                )}
              </div>
              {d.subs.some((s) => !s.lang) && <p className="strong">{t("fix.whichEnglish")}</p>}
              <ul className="plain small tracks">
                {/* The tracks that matter first (no language, English, signs-only, your fixes); the rest on request. */}
                {(all ? d.subs : d.subs.filter((s) => !s.lang || s.lang === "en" || s.partial || s.forced || s.overridden)).map((s) => (
                  <li key={`s${s.index}`} className="track-row">
                    <span>
                      💬 <b>{s.lang ?? t("fix.untagged")}</b> · {s.codec}
                      {s.title ? ` · “${s.title}”` : ""}
                      {s.forced || s.partial ? ` · ${t("files.partial")}` : ""}
                      {s.default ? ` · ${t("files.default")}` : ""}
                      {s.overridden ? <span className="tag info inline">{t("fix.yourFix")}</span> : null}
                    </span>
                    <span className="row">
                      <select aria-label={t("fix.langOf", { n: s.index })} value={s.lang ?? ""} disabled={busy} onChange={(e) => void setTrack(s, e.target.value || null, !!s.partial)}>
                        <option value="">{t("fix.untagged")}</option>
                        {[...new Set([...LANGS, ...(s.lang ? [s.lang] : [])])].map((l) => (
                          <option key={l} value={l}>
                            {l}
                          </option>
                        ))}
                      </select>
                      {(s.lang !== "en" || s.partial) && (
                        <button type="button" className="small" disabled={busy} onClick={() => void setTrack(s, "en", false)}>
                          {t("fix.isEnglish")}
                        </button>
                      )}
                      {!s.partial && (
                        <button type="button" className="small ghost" disabled={busy} onClick={() => void setTrack(s, s.lang ?? "en", true)}>
                          {t("fix.signsOnly")}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {!all && d.subs.some((s) => !(!s.lang || s.lang === "en" || s.partial || s.forced || s.overridden)) && (
                <button type="button" className="linklike small self-start" onClick={() => setAll(true)}>
                  {t("fix.showAll", { n: d.subs.length })}
                </button>
              )}
            </>
          )}
          {(!!d.sidecars.length || !!d.strays.length) && <h4>{t("fix.sidecars")}</h4>}
          <ul className="plain small tracks">
            {d.sidecars.map((s) => (
              <li key={s.file}>
                📄 <b>{s.lang ?? t("fix.untagged")}</b> · <span className="mono">{s.file}</span>
              </li>
            ))}
            {d.strays.map((f) => (
              <li key={f} className="track-row">
                <span>
                  📄 <span className="mono">{f}</span> <span className="muted">· {t("fix.unrecognised")}</span>
                </span>
                <button type="button" className="small" disabled={busy} onClick={() => void run(() => api("/files/sidecar", { body: { video: path, file: f, lang: "en", tvdbId, title } }), t("fix.renamed"))}>
                  {t("fix.useAsEnglish")}
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="small ghost" disabled={busy || d.exists === false} onClick={() => void run(() => api("/files/rescan", { body: { path } }), t("fix.rescanned"))}>
              {t("fix.rescan")}
            </button>
          </div>
          <p className="muted small">{t("fix.undoHint")}</p>
        </div>
      )}
    </details>
  );
}
