import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { Chip, Cover, Spinner, useLoad, useToast } from "./ui";

interface Candidate { anilistId: number; title: string; romaji: string | null; year: number | null; kind: string | null; episodes: number | null; cover: string | null; tvdbId: number | null; score: number; reason: string; owned: boolean }
interface Match { folder: { title: string; year: number | null }; candidates: Candidate[]; best: Candidate | null; confidence: "confident" | "likely" | "unsure" | "none"; reason: string; anilist: string }
interface Folder { name: string; path: string; videos: number }
interface Scan { root: string; folders: Folder[]; skipped: { owned: number; hidden: number } }
interface Adopted { title: string; episodes: number; mapped: number; unmapped: { path: string; why: string }[] }
interface SearchHit { anilistId: number; title: string; romaji: string | null; year: number | null; kind: string | null; episodes: number | null; cover: string | null; tvdbId: number | null; inLibrary: unknown }

/** Row state: matching → review → added / skipped. */
interface Row { folder: Folder; state: "waiting" | "matching" | "review" | "adding" | "added" | "skipped" | "error"; match?: Match; pick?: Candidate; done?: Adopted; error?: string }

const KIND: Record<string, string> = { TV: "TV", TV_SHORT: "TV", ONA: "ONA", OVA: "OVA", SPECIAL: "Special" };
const tone = { confident: "good", likely: "info", unsure: "warn", none: "bad" } as const;
const fromHit = (h: SearchHit): Candidate => ({ anilistId: h.anilistId, title: h.title, romaji: h.romaji, year: h.year, kind: h.kind, episodes: h.episodes, cover: h.cover, tvdbId: h.tvdbId, score: 0, reason: "", owned: !!h.inLibrary });

/**
 * Import existing folders: pick a root, review each top-level folder's best match, add them as they are. Matching goes
 * one folder at a time (AniList is slow and rate-limited); nothing on disk is moved, renamed or deleted.
 */
export function ImportFolders({ onClose }: { onClose?: () => void }) {
  const toast = useToast();
  const roots = useLoad(() => api<{ allowedRoots: string[] }>("/settings"), []);
  const [root, setRoot] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [skipped, setSkipped] = useState<Scan["skipped"] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [bulk, setBulk] = useState(false);
  const run = useRef(0); // a new scan stops the old matching loop
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows ?? [];
  useEffect(() => {
    if (!root && roots.data?.allowedRoots[0]) setRoot(roots.data.allowedRoots[0]);
  }, [roots.data, root]);
  useEffect(() => () => void run.current++, []);
  const patch = (name: string, p: Partial<Row>) => setRows((x) => (x ?? []).map((r) => (r.folder.name === name ? { ...r, ...p } : r)));

  const scan = async () => {
    const me = ++run.current;
    setScanning(true);
    setRows(null);
    try {
      const s = await api<Scan>(`/import/folders?root=${encodeURIComponent(root)}`);
      setSkipped(s.skipped);
      setRows(s.folders.map((folder) => ({ folder, state: "waiting" })));
      setScanning(false);
      for (const f of s.folders) {
        if (run.current !== me) return;
        patch(f.name, { state: "matching" });
        try {
          const match = await api<Match>("/import/match", { body: { name: f.name } });
          if (run.current !== me) return;
          patch(f.name, { state: "review", match, pick: match.best ?? undefined });
        } catch (e) {
          patch(f.name, { state: "error", error: (e as Error).message });
        }
      }
    } catch (e) {
      toast((e as Error).message, true);
      setScanning(false);
    }
  };

  const add = async (r: Row): Promise<boolean> => {
    if (!r.pick) return false;
    patch(r.folder.name, { state: "adding" });
    try {
      const done = await api<Adopted>("/import/adopt", { body: { rootFolder: root, name: r.folder.name, anilistId: r.pick.anilistId } });
      patch(r.folder.name, { state: "added", done });
      return true;
    } catch (e) {
      patch(r.folder.name, { state: "error", error: (e as Error).message });
      return false;
    }
  };
  const confident = (rows ?? []).filter((r) => r.state === "review" && r.match?.confidence === "confident" && r.pick && r.pick === r.match.best && !r.pick.owned);
  const addAll = async () => {
    setBulk(true);
    let n = 0;
    for (const r of confident) if (await add(r)) n++; // one at a time: each add is a catalog lookup
    setBulk(false);
    toast(t("import.addedN", { n }));
  };

  return (
    <div className="card pad stack">
      <div className="row between">
        <h2>{t("import.title")}</h2>
        {onClose && (
          <button className="small ghost" onClick={onClose}>
            {t("common.close")}
          </button>
        )}
      </div>
      <p className="muted small">{t("import.help")}</p>
      {roots.data && !roots.data.allowedRoots.length && <p className="banner warn">{t("import.noRoots")}</p>}
      <div className="row">
        <select value={root} onChange={(e) => setRoot(e.target.value)} aria-label={t("import.root")}>
          {(roots.data?.allowedRoots ?? []).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!root || scanning} onClick={() => void scan()}>
          {t("import.scan")}
        </button>
      </div>
      {scanning && <Spinner label={t("import.scanning")} />}
      {rows && skipped && (
        <p className="muted small">
          {t("import.found", { n: rows.length })}
          {skipped.owned > 0 && ` · ${t("import.skippedOwned", { n: skipped.owned })}`}
        </p>
      )}
      {rows && !rows.length && <p className="muted">{t("import.none")}</p>}
      {!!rows?.length && (
        <div className="row">
          <button disabled={!confident.length || bulk} onClick={() => void addAll()}>
            {t("import.addConfident", { n: confident.length })}
          </button>
          <span className="muted small">{t("import.untouched")}</span>
        </div>
      )}
      <ul className="plain stack">
        {(rows ?? []).map((r) => (
          <FolderRow key={r.folder.name} r={r} onPick={(pick) => patch(r.folder.name, { pick })} onAdd={() => void add(r)} onSkip={() => patch(r.folder.name, { state: r.state === "skipped" ? "review" : "skipped" })} />
        ))}
      </ul>
    </div>
  );
}

function FolderRow({ r, onPick, onAdd, onSkip }: { r: Row; onPick: (c: Candidate) => void; onAdd: () => void; onSkip: () => void }) {
  const [searching, setSearching] = useState(false);
  const m = r.match;
  const pick = r.pick;
  const options = [...(m?.candidates ?? [])];
  if (pick && !options.some((c) => c.anilistId === pick.anilistId)) options.unshift(pick);
  const line = (c: Candidate) => [c.kind ? (KIND[c.kind] ?? c.kind) : null, c.year, c.episodes ? t("import.eps", { n: c.episodes }) : null].filter(Boolean).join(" · ");
  return (
    <li className={`card pad stack${r.state === "skipped" ? " dim" : ""}`}>
      <div className="row between">
        <strong className="mono">{r.folder.name}</strong>
        <span className="muted small">{r.folder.videos ? t("import.files", { n: r.folder.videos }) : t("import.noFiles")}</span>
      </div>
      {(r.state === "waiting" || r.state === "matching") && <span className="muted small">{r.state === "waiting" ? t("import.waiting") : t("import.matching")}</span>}
      {r.state === "error" && <p className="warn-text small">{r.error}</p>}
      {r.state === "added" && r.done && (
        <div className="stack">
          <span className="small">{t("import.added", { title: r.done.title, mapped: r.done.mapped, total: r.done.mapped + r.done.unmapped.length })}</span>
          {r.done.unmapped.length > 0 && (
            <details>
              <summary className="small warn-text">{t("import.unmapped", { n: r.done.unmapped.length })}</summary>
              <p className="muted small">{t("import.unmappedHelp")}</p>
              <ul className="plain small mono">
                {r.done.unmapped.map((u) => (
                  <li key={u.path}>{u.path}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {(r.state === "review" || r.state === "adding" || r.state === "skipped" || (r.state === "error" && m)) && (
        <>
          {pick ? (
            <div className="row">
              <Cover src={pick.cover} alt={pick.title} size="sm" />
              <div className="stack grow">
                <span>
                  {pick.title}
                  {pick.romaji && pick.romaji !== pick.title && <span className="muted small"> · {pick.romaji}</span>}
                </span>
                <span className="muted small">{line(pick)}</span>
                {m && pick === m.best && (
                  <span className="small">
                    <Chip tone={tone[m.confidence]}>{t(`import.conf.${m.confidence}` as "import.conf.confident")}</Chip> {m.reason}
                  </span>
                )}
                {pick.owned && <span className="warn-text small">{t("import.owned")}</span>}
              </div>
            </div>
          ) : (
            <span className="muted small">{m?.reason ?? t("import.noMatch")}</span>
          )}
          {r.state !== "adding" && (
            <div className="row">
              {options.length > 1 && (
                <select value={pick?.anilistId ?? ""} onChange={(e) => onPick(options.find((c) => c.anilistId === Number(e.target.value))!)} aria-label={t("import.other")}>
                  {options.map((c) => (
                    <option key={c.anilistId} value={c.anilistId}>
                      {c.title} ({[c.kind, c.year].filter(Boolean).join(", ")})
                    </option>
                  ))}
                </select>
              )}
              <button className="small" onClick={() => setSearching((x) => !x)}>
                {t("import.search")}
              </button>
              {r.state !== "skipped" && (
                <button className="small primary" disabled={!pick || pick.owned} onClick={onAdd}>
                  {t("import.accept")}
                </button>
              )}
              <button className="small ghost" onClick={onSkip}>
                {r.state === "skipped" ? t("import.unskip") : t("import.skip")}
              </button>
            </div>
          )}
          {r.state === "adding" && <Spinner label={t("import.adding")} />}
          {searching && <ManualSearch initial={m?.folder.title ?? r.folder.name} onPick={(c) => (onPick(c), setSearching(false))} />}
        </>
      )}
    </li>
  );
}

/** Manual search (the same search as Find): pick any show for a folder the matcher got wrong. */
function ManualSearch({ initial, onPick }: { initial: string; onPick: (c: Candidate) => void }) {
  const [q, setQ] = useState(initial);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      setHits((await api<{ results: SearchHit[] }>(`/add/search?q=${encodeURIComponent(q)}`)).results.filter((h) => h.kind !== "MOVIE" && h.kind !== "MUSIC"));
    } catch {
      setHits([]);
    }
    setBusy(false);
  };
  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("import.search")} className="grow" />
        <button className="small" disabled={busy || q.trim().length < 2}>
          {t("import.go")}
        </button>
      </form>
      {busy && <Spinner label={t("app.loading")} />}
      {hits && !hits.length && !busy && <p className="muted small">{t("import.noHits")}</p>}
      <ul className="plain stack">
        {(hits ?? []).slice(0, 8).map((h) => (
          <li key={h.anilistId} className="row">
            <Cover src={h.cover} alt={h.title} size="sm" />
            <span className="grow">
              {h.title} <span className="muted small">{[h.kind ? (KIND[h.kind] ?? h.kind) : null, h.year, h.episodes ? t("import.eps", { n: h.episodes }) : null].filter(Boolean).join(" · ")}</span>
            </span>
            <button className="small" disabled={!!h.inLibrary} onClick={() => onPick(fromHit(h))}>
              {h.inLibrary ? t("import.inLibrary") : t("import.use")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
