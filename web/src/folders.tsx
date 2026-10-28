import { Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { useLoad } from "./ui";

interface Listing { path: string; parent: string | null; writable: boolean; refused?: string | null; dirs: { name: string; path: string; writable: boolean; refused?: string | null }[] }

/**
 * The library ("allowed root") folders: the chosen ones with Remove, and a browser over the container's folders to add
 * one. AnimeArr's own data folder (/config) and system folders can't be chosen (the server refuses them too).
 * Used by the setup wizard and Settings → Automation & safety.
 */
export function LibraryFolders({ roots, refused = {}, onAdd, onRemove }: { roots: string[]; refused?: Record<string, string>; onAdd: (root: string) => void | Promise<unknown>; onRemove: (root: string) => void | Promise<unknown> }) {
  const [p, setP] = useState("/");
  const d = useLoad(() => api<Listing>(`/fs/folders?path=${encodeURIComponent(p)}`), [p]);
  const here = d.data;
  const why = here?.refused ?? null;
  return (
    <div className="stack">
      <div className="stack">
        <h3>{t("wiz.folders.chosen")}</h3>
        {!roots.length && <p className="muted small">{t("wiz.folders.none")}</p>}
        <ul className="plain stack">
          {roots.map((r) => (
            <li key={r} className="stack">
              <span className="row between">
                <span className="mono">{r}</span>
                <button className="small ghost" onClick={() => void onRemove(r)}>
                  {t("folders.remove")}
                </button>
              </span>
              {refused[r] && <span className="warn-text small">{refused[r]}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="card pad stack folder-browser">
        <h3>{t("folders.add")}</h3>
        <div className="row between">
          <span className="mono">{here?.path ?? p}</span>
          {here && (
            <button className="small primary" disabled={!here.writable || !!why || roots.includes(here.path)} onClick={() => void onAdd(here.path)}>
              {roots.includes(here.path) ? t("folders.chosen") : why ? t("folders.notLibrary") : here.writable ? t("wiz.folders.use") : t("wiz.folders.readOnly")}
            </button>
          )}
        </div>
        {why && here?.path !== "/" && <p className="muted small">{why}</p>}
        {here && !here.writable && !why && <p className="muted small">{t("folders.readOnlyHelp")}</p>}
        {d.error && <p className="warn-text small">{d.error}</p>}
        <ul className="plain folder-list">
          {here?.parent && (
            <li>
              <button className="linklike" onClick={() => setP(here.parent!)}>
                <FolderOpen className="lucide" aria-hidden="true" /> ..
              </button>
            </li>
          )}
          {here?.dirs.map((x) => (
            <li key={x.path}>
              <button className="linklike" onClick={() => setP(x.path)}>
                <Folder className="lucide" aria-hidden="true" /> {x.name}
              </button>
              {x.refused ? <span className="muted small"> · {t("folders.notHere")}</span> : !x.writable && <span className="muted small"> · {t("wiz.folders.readOnly")}</span>}
            </li>
          ))}
        </ul>
        <p className="muted small">{t("wiz.folders.what")}</p>
      </div>
    </div>
  );
}
