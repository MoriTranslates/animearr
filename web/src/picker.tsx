import { useEffect, useMemo, useRef, useState } from "react";
import { api, store, sxe } from "./api";
import { Link } from "./App";
import { airLabel, StatusPill, useEpisodeActions, type EpisodeRow } from "./episodes";
import { t } from "./i18n";
import { Cover, Empty, Spinner, useLoad } from "./ui";

export interface PickedShow { tvdbId: number; title: string; cover?: string | null; year?: number | null; status?: string }

/** Show autocomplete with poster thumbs, year and status. */
export function ShowPicker({ onPick }: { onPick: (s: PickedShow) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<PickedShow[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!q.trim()) return setList([]);
    const ac = new AbortController();
    const id = setTimeout(() => void api<PickedShow[]>(`/series?q=${encodeURIComponent(q)}`, { signal: ac.signal }).then((x) => (setList(x.slice(0, 8)), setActive(0))).catch(() => undefined), 180);
    return () => (clearTimeout(id), ac.abort());
  }, [q]);
  const pick = (s: PickedShow) => (onPick(s), setList([]), setQ(""));
  return (
    <div className="picker">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setList([]);
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.max(0, Math.min(a + 1, list.length - 1))));
          if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          if (e.key === "Enter" && list[active]) (e.preventDefault(), pick(list[active]));
        }}
        placeholder={t("search.pickShowPlaceholder")}
        aria-label={t("search.pickShow")}
        role="combobox"
        aria-expanded={!!list.length}
        aria-controls="show-picker-list"
      />
      {!!list.length && (
        <ul className="picker-list card" id="show-picker-list" role="listbox">
          {list.map((s, i) => (
            <li key={s.tvdbId} role="option" aria-selected={i === active}>
              <button className={`picker-item${i === active ? " active" : ""}`} onClick={() => pick(s)}>
                <Cover src={s.cover} alt={s.title} size="sm" />
                <span className="picker-text">
                  <span className="strong clamp2">{s.title}</span>
                  <span className="muted small">
                    {[s.year, s.status === "continuing" ? t("series.airing") : s.status === "ended" ? t("series.ended") : s.status].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ShowData {
  header: { title: string; cover: string | null; counts: { have: number; aired: number; missing: number } };
  rows: EpisodeRow[];
}

type View = { kind: "missing" } | { kind: "season"; n: number } | { kind: "abs"; from: number };

/**
 * Pick episodes of a show: a season (with counts) or "all missing", missing-only by default, checkboxes with
 * shift-click ranges and a quick range box, then ⚡ automatic or 🔍 interactive from a sticky bar.
 */
export function EpisodePicker({ show, initial, dryRun, onChange, onInteractive, noAuto = false }: { show: PickedShow; initial?: number[]; dryRun: boolean; onChange: () => void; onInteractive: (ids: number[]) => void; noAuto?: boolean }) {
  const d = useLoad(() => api<ShowData>(`/series/${show.tvdbId}`), [show.tvdbId]);
  const [sel, setSel] = useState<Set<number>>(new Set(initial ?? []));
  const [missingOnly, setMissingOnly] = useState(true);
  const [abs, setAbs] = useState(() => store.get("pickerAbsolute", false));
  const [view, setView] = useState<View | null>(null);
  const [range, setRange] = useState("");
  const last = useRef<number | null>(null);
  const rows = useMemo(() => [...(d.data?.rows ?? [])].sort((a, b) => a.season - b.season || a.episode - b.episode), [d.data]);
  const missingRows = rows.filter((r) => r.status === "missing" && !r.movie);
  const seasons = useMemo(() => {
    const m = new Map<number, EpisodeRow[]>();
    for (const r of rows) m.set(r.season, [...(m.get(r.season) ?? []), r]);
    return [...m].sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : a[0] - b[0]));
  }, [rows]);
  const longRunner = rows.filter((r) => r.absolute).length > 100;
  const absOn = abs && longRunner;
  // Start at the selection, else at all missing, else the latest season.
  useEffect(() => {
    if (!d.data || view) return;
    const first = rows.find((r) => sel.has(r.id));
    if (first && absOn && first.season > 0 && first.absolute) setView({ kind: "abs", from: Math.floor((first.absolute - 1) / 50) * 50 + 1 });
    else if (first) setView({ kind: "season", n: first.season });
    else if (absOn) setView({ kind: "abs", from: 1 });
    else if (missingRows.length) setView({ kind: "missing" });
    else if (seasons.length) setView({ kind: "season", n: seasons.filter(([n]) => n > 0).at(-1)?.[0] ?? seasons[0][0] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.data]);

  const inView = (r: EpisodeRow) => {
    if (!view) return false;
    if (view.kind === "missing") return r.status === "missing" && !r.movie;
    if (view.kind === "abs") return r.season > 0 && !!r.absolute && r.absolute >= view.from && r.absolute < view.from + 50;
    return r.season === view.n;
  };
  const shown = rows.filter((r) => inView(r) && (!missingOnly || view?.kind === "missing" || r.status === "missing" || sel.has(r.id)));
  const allInView = rows.filter(inView);
  const num = (r: EpisodeRow) => (absOn && r.absolute && r.season > 0 ? String(r.absolute) : String(r.episode));

  const toggle = (r: EpisodeRow, shift: boolean) => {
    const n = new Set(sel);
    const on = !n.has(r.id);
    const a = shift && last.current !== null ? shown.findIndex((y) => y.id === last.current) : -1;
    const b = shown.findIndex((y) => y.id === r.id);
    if (a >= 0 && b >= 0) for (const y of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) if (!y.movie) on ? n.add(y.id) : n.delete(y.id);
    else if (on) n.add(r.id);
    else n.delete(r.id);
    last.current = r.id;
    setSel(n);
  };
  const applyRange = () => {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(range);
    if (!m) return;
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    setSel((x) => {
      const n = new Set(x);
      for (const r of absOn ? rows.filter((x) => !x.movie && (!missingOnly || x.status === "missing")) : shown) {
        if (r.movie) continue;
        const v = absOn && r.absolute && r.season > 0 ? r.absolute : view?.kind === "season" && r.season === view.n ? r.episode : null;
        if (v !== null && v >= Math.min(a, b) && v <= Math.max(a, b)) n.add(r.id);
      }
      return n;
    });
    setRange("");
  };
  const picked = rows.filter((r) => sel.has(r.id));
  const actions = useEpisodeActions({ tvdbId: show.tvdbId, episodes: picked.map((r) => ({ id: r.id, label: sxe(r.season, r.episode) })), managedLive: false, dryRun, onDone: () => (void d.reload(), onChange()) });

  if (d.error) return <p className="error">{d.error}</p>;
  if (!d.data || !view) return <Spinner label={t("app.loading")} />;
  const h = d.data.header;
  const viewKey = view.kind === "missing" ? "missing" : view.kind === "abs" ? `abs:${view.from}` : `s:${view.n}`;
  const maxAbs = Math.max(0, ...rows.map((r) => r.absolute ?? 0));
  return (
    <div className="stack">
      <div className="row picker-head">
        <Cover src={h.cover} alt={h.title} size="sm" />
        <div className="stack grow">
          <Link to={`/show/${show.tvdbId}`} className="strong clamp2">
            {h.title}
          </Link>
          <span className="muted small">{t("picker.counts", { have: h.counts.have, aired: h.counts.aired, missing: h.counts.missing })}</span>
        </div>
      </div>
      <div className="row picker-controls">
        <select
          value={viewKey}
          aria-label={t("picker.which")}
          onChange={(e) => {
            const v = e.target.value;
            setView(v === "missing" ? { kind: "missing" } : v.startsWith("abs:") ? { kind: "abs", from: Number(v.slice(4)) } : { kind: "season", n: Number(v.slice(2)) });
          }}
        >
          <option value="missing">{t("picker.allMissing", { n: missingRows.length })}</option>
          {absOn
            ? Array.from({ length: Math.ceil(maxAbs / 50) }, (_, i) => i * 50 + 1).map((from) => (
                <option key={from} value={`abs:${from}`}>
                  {t("picker.absRange", { from, to: Math.min(from + 49, maxAbs), missing: rows.filter((r) => r.absolute && r.absolute >= from && r.absolute < from + 50 && r.status === "missing").length })}
                </option>
              ))
            : seasons.map(([n, list]) => (
                <option key={n} value={`s:${n}`}>
                  {t(n === 0 ? "picker.specials" : "picker.season", { n, eps: list.length, missing: list.filter((r) => r.status === "missing" && !r.movie).length })}
                </option>
              ))}
          {absOn &&
            seasons
              .filter(([n]) => n === 0)
              .map(([n, list]) => (
                <option key={n} value={`s:${n}`}>
                  {t("picker.specials", { n, eps: list.length, missing: list.filter((r) => r.status === "missing" && !r.movie).length })}
                </option>
              ))}
        </select>
        {longRunner && (
          <label className="check">
            <input
              type="checkbox"
              checked={abs}
              onChange={(e) => {
                setAbs(e.target.checked);
                store.set("pickerAbsolute", e.target.checked);
                setView(e.target.checked ? { kind: "abs", from: 1 } : { kind: "missing" });
              }}
            />
            {t("picker.absolute")}
          </label>
        )}
        {view.kind !== "missing" && (
          <label className="check">
            <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} /> {t("search.missingOnly")}
          </label>
        )}
      </div>
      <div className="row picker-tools">
        <button className="small ghost" onClick={() => setSel((x) => new Set([...x, ...shown.filter((r) => !r.movie).map((r) => r.id)]))}>
          {t("shows.selectAll")}
        </button>
        <button className="small ghost" onClick={() => setSel(new Set())} disabled={!sel.size}>
          {t("picker.none")}
        </button>
        <form className="row" onSubmit={(e) => (e.preventDefault(), applyRange())}>
          <input className="range-input" disabled={view.kind === "missing" && !absOn} value={range} onChange={(e) => setRange(e.target.value)} placeholder={absOn ? t("picker.rangeAbs") : t("picker.range")} aria-label={t("picker.rangeLabel")} />
        </form>
      </div>
      {!shown.length ? (
        <Empty>
          {view.kind === "missing" ? t("picker.nothingMissingShow") : t("picker.nothingMissing", { what: view.kind === "season" ? (view.n === 0 ? t("series.specials") : t("common.season", { n: view.n })) : "" })}
          {missingOnly && view.kind !== "missing" && allInView.length > 0 && (
            <>
              {" · "}
              <button className="link" onClick={() => setMissingOnly(false)}>
                {t("picker.showAll")}
              </button>
            </>
          )}
        </Empty>
      ) : (
        <ul className="ep-list picker-list-eps card">
          {shown.map((r) => (
            <li key={r.id} className={`ep-row${sel.has(r.id) ? " selected" : ""}`}>
              <label className="ep-main picker-row" onClick={(e) => (e.preventDefault(), !r.movie && toggle(r, e.shiftKey))}>
                <input type="checkbox" checked={sel.has(r.id)} disabled={!!r.movie} readOnly aria-label={`${sxe(r.season, r.episode)} ${r.title ?? ""}`} />
                <span className="ep-num">{num(r)}</span>
                <span className="ep-text">
                  <span className="ep-title clamp2" title={r.title ?? undefined}>
                    {view.kind !== "season" && <span className="mono muted">{sxe(r.season, r.episode)} · </span>}
                    {r.title ?? t("ep.tba")}
                  </span>
                  <span className="ep-meta muted small">{airLabel(r.airUtc)}</span>
                </span>
                <span className="ep-status">{r.movie ? <span className="chip info">🎬 {t("ep.movieChip")}</span> : <StatusPill e={r} />}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {!!picked.length && (
        <div className="bulkbar card picker-bar">
          <span>{t("ep.selected", { n: picked.length })}{picked.length > 26 ? ` · ${t("auto.first26")}` : ""}</span>
          <div className="row">
            {/* Replace season: an automatic search would grab per episode, not replace the season. */}
            {!noAuto && (
              <button className="primary" onClick={actions.auto} disabled={actions.autoBusy}>
                ⚡ {actions.autoBusy ? t("common.working") : t("picker.auto")}
              </button>
            )}
            <button onClick={() => onInteractive(picked.slice(0, 26).map((r) => r.id))}>🔍 {t("auto.interactive")}</button>
          </div>
        </div>
      )}
      {actions.ui}
    </div>
  );
}
