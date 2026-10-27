import { useEffect, useState } from "react";
import { ArrowUp, File, FileVideo, Folder } from "lucide-react";
import { api, fmtSize } from "./api";
import { t } from "./i18n";
import { Chip, ErrorBox, Spinner, relTime } from "./ui";

export interface BrowseEntry { name: string; path: string; dir: boolean; size: number; mtime: number; video: boolean; videos: number }
interface Browse { roots: { path: string; label: string }[]; path: string | null; parent: string | null; entries: BrowseEntry[]; truncated: boolean; grabPath: string | null }

/**
 * Manual import picker (like Sonarr's): AnimeArr's download folders, newest first; a folder opens on click, a file is
 * selected on click (so is the open folder, to import all of it). Starts in the grab's own download when there is one.
 */
export function ImportBrowser({ start, grabId, selected, onSelect }: { start?: string | null; grabId?: number | null; selected: string; onSelect: (path: string, dir: boolean) => void }) {
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
      // The folder that opened is the selection until a file is picked (import the whole download).
      const isFile = r.entries.length === 1 && r.entries[0].path === r.path && !r.entries[0].dir;
      if (r.path && (!first || !selected)) onSelect(r.path, !isFile);
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
  return (
    <div className="import-browser stack">
      <div className="row browse-bar">
        <button type="button" className="small" disabled={busy || !data?.path} onClick={up} aria-label={t("import.up")}>
          <ArrowUp size={14} aria-hidden="true" /> {t("import.up")}
        </button>
        <span className="mono small muted browse-where" title={data?.path ?? ""}>
          {data?.path ?? t("import.roots")}
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
                  aria-label={e.dir ? t("import.openFolder", { name: e.name }) : t("import.pickFile", { name: e.name })}
                  onClick={() => (e.dir ? void load(e.path) : onSelect(e.path, false))}
                >
                  <span className="browse-icon" aria-hidden="true">
                    {e.dir ? <Folder size={16} /> : e.video ? <FileVideo size={16} /> : <File size={16} />}
                  </span>
                  <span className="browse-name">{e.name}</span>
                  <span className="browse-meta small muted">
                    {e.dir && e.videos > 0 && <Chip tone="info">{t("import.videos", { n: e.videos })}</Chip>}
                    {!e.dir && e.video && <Chip tone="accent">{t("import.video")}</Chip>}
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
    </div>
  );
}
