import { useEffect, useState } from "react";
import { ArrowUp, File, FileVideo, Folder } from "lucide-react";
import { api, fmtSize } from "./api";
import { t } from "./i18n";
import { Chip, ErrorBox, Spinner, relTime } from "./ui";

export interface BrowseEntry { name: string; path: string; dir: boolean; size: number; mtime: number; video: boolean; videos: number }
interface Root { path: string; label: string }
interface Browse { roots: Root[]; path: string | null; parent: string | null; entries: BrowseEntry[]; truncated: boolean; grabPath: string | null }

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/**
 * A browse path in words: "This download › Season 1", "AnimeArr's downloads › new" (never a bare /data/… path; the
 * full path stays available under Details).
 */
export function friendlyPath(p: string | null, roots: Root[], grabPath?: string | null): string {
  if (!p) return t("import.roots");
  if (grabPath && (p === grabPath || p.startsWith(`${grabPath}/`))) {
    const rest = p.slice(grabPath.length).split("/").filter(Boolean);
    return [t("import.thisDownload"), ...rest].join(" › ");
  }
  const root = [...roots].sort((a, b) => b.path.length - a.path.length).find((r) => p === r.path || p.startsWith(`${r.path}/`));
  if (!root) return base(p);
  const rest = p.slice(root.path.length).split("/").filter(Boolean);
  const own = roots.filter((r) => r.label !== "download");
  // Two download folders: told apart by the first folder where their paths differ ("qbittorrent" / "sabnzbd").
  const tell = () => {
    const parts = root.path.split("/");
    const others = own.filter((r) => r !== root).map((r) => r.path.split("/"));
    return parts.find((seg, i) => seg && others.every((o) => o[i] !== seg)) ?? base(root.path);
  };
  const name = root.label === "download" ? t("import.thisDownload") : own.length > 1 ? t("import.ownFolderNamed", { name: tell() }) : t("import.ownFolder");
  return [name, ...rest].join(" › ");
}

/**
 * Manual import picker (like Sonarr's): AnimeArr's download folders, newest first; a folder opens on click, a file is
 * selected on click (so is the open folder, to import all of it). Starts in the grab's own download when there is one;
 * that first selection is reported with auto = true (nothing is planned until the user asks).
 */
export function ImportBrowser({ start, grabId, selected, onSelect, onPlace }: { start?: string | null; grabId?: number | null; selected: string; onSelect: (path: string, dir: boolean, auto: boolean) => void; onPlace?: (name: string) => void }) {
  const [data, setData] = useState<Browse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (path: string | null, first = false) => {
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (path !== null) q.set("path", path);
      if (grabId) q.set("grabId", String(grabId));
      const r = await api<Browse>(`/import/browse?${q}`);
      setData(r);
      onPlace?.(friendlyPath(r.path, r.roots, r.grabPath));
      // The folder that opened is the selection until a file is picked (import the whole download).
      const isFile = r.entries.length === 1 && r.entries[0].path === r.path && !r.entries[0].dir;
      if (r.path && (!first || !selected)) onSelect(r.path, !isFile, first);
    } catch (e) {
      setError((e as Error).message);
      // A start path outside the roots (typed by hand): fall back to the roots.
      if (first && path) void load("");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load(start ? start : grabId ? null : "", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grabId]);
  const up = () => void load(data?.parent ?? "");
  const where = data ? friendlyPath(data.path, data.roots, data.grabPath) : t("import.roots");
  // Roots are listed by what they are, not by their path.
  const nameOf = (e: BrowseEntry) => (data && !data.path ? friendlyPath(e.path, data.roots, data.grabPath) + (e.dir ? "" : ` › ${e.name}`) : e.name);
  return (
    <div className="import-browser stack">
      <div className="row browse-bar">
        <button type="button" className="small" disabled={busy || !data?.path} onClick={up} aria-label={t("import.up")}>
          <ArrowUp size={14} aria-hidden="true" /> {t("import.up")}
        </button>
        <span className="small browse-where" title={data?.path ?? ""}>
          {where}
        </span>
        {busy && <Spinner label={t("app.loading")} />}
      </div>
      {error && <ErrorBox error={error} retry={() => void load(data?.path ?? "")} />}
      {data && !data.entries.length && <p className="muted small">{t("import.empty")}</p>}
      {data && data.entries.length > 0 && (
        <ul className="browse-list" aria-label={t("import.browse")}>
          {data.entries.map((e) => {
            const on = selected === e.path;
            return (
              <li key={e.path}>
                <button
                  type="button"
                  className={`browse-item${on ? " on" : ""}${e.dir || e.video ? "" : " dim"}`}
                  aria-pressed={e.dir ? undefined : on}
                  aria-label={e.dir ? t("import.openFolder", { name: nameOf(e) }) : t("import.pickFile", { name: e.name })}
                  onClick={() => (e.dir ? void load(e.path) : onSelect(e.path, false, false))}
                >
                  <span className="browse-icon" aria-hidden="true">
                    {e.dir ? <Folder size={16} /> : e.video ? <FileVideo size={16} /> : <File size={16} />}
                  </span>
                  <span className="browse-name">{nameOf(e)}</span>
                  <span className="browse-meta small muted">
                    {on && <Chip tone="good">{t("import.picked")}</Chip>}
                    {e.dir && e.videos > 0 && <Chip tone="info">{t("import.videos", { n: e.videos })}</Chip>}
                    {!e.dir && e.video && !on && <Chip tone="accent">{t("import.video")}</Chip>}
                    <span>{fmtSize(e.size)}</span>
                    <span>{relTime(e.mtime)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {data?.truncated && <p className="muted small">{t("import.truncated")}</p>}
      {data?.path && (
        <details className="small muted">
          <summary>{t("import.details")}</summary>
          <span className="mono">{data.path}</span>
        </details>
      )}
    </div>
  );
}
