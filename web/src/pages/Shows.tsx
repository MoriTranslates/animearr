import { useMemo, useState } from "react";
import { api, type LibraryShow, type Status } from "../api";
import { Link, navigate } from "../App";
import { ShowLink } from "../episodes";
import { t } from "../i18n";
import { Chip, Confirm, Cover, Empty, ErrorBox, Modal, Spinner, useLoad, usePageTitle, useToast } from "../ui";
import { ScopeEditor } from "../scope";

type Filter = "airing" | "continuing" | "managed" | "all";

export function Shows({ status }: { status: Status }) {
  usePageTitle(t("shows.title"));
  const toast = useToast();
  const data = useLoad(() => api<{ season: { name: string; year: number }; allowedRoots: string[]; series: LibraryShow[] }>("/library/candidates"), []);
  const [filter, setFilter] = useState<Filter>("airing");
  const [tag, setTag] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const tags = useMemo(() => [...new Set((data.data?.series ?? []).flatMap((s) => s.tags.map(String)))].sort(), [data.data]);
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (data.data?.series ?? []).filter(
      (s) =>
        (filter === "all" || (filter === "airing" && s.airingThisSeason) || (filter === "continuing" && s.status === "continuing") || (filter === "managed" && s.managed)) &&
        (!tag || s.tags.map(String).includes(tag)) &&
        (!ql || s.title.toLowerCase().includes(ql)),
    );
  }, [data.data, filter, tag, q]);

  const toggle = (id: number) => setSel((x) => {
    const n = new Set(x);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const [scopeOpen, setScopeOpen] = useState(false);
  const [manageAsk, setManageAsk] = useState<{ shows: number; missing: number; dryRun: boolean; backlog: boolean; perHour: number } | null>(null);
  const [fillAsk, setFillAsk] = useState(false);
  async function askManage() {
    try {
      setManageAsk(await api("/managed/preview", { body: { tvdbIds: [...sel] } }));
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function fill() {
    setFillAsk(false);
    try {
      const r = await api<{ added: number }>("/fillin", { body: { tvdbIds: [...sel] } });
      toast(t("fill.added", { n: r.added }), false, { label: t("fill.open"), run: () => navigate("/fillin") });
      setSel(new Set());
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function apply(on: boolean, live = false) {
    setBusy(true);
    setManageAsk(null);
    try {
      const r = await api<{ changed: number; refused: { title: string; reason: string }[] }>("/managed", { body: { tvdbIds: [...sel], on, live } });
      if (r.refused.length) toast(t("shows.refused", { list: r.refused.map((x) => `${x.title} (${x.reason})`).join("; ") }), true);
      else toast(t("common.saved"));
      setSel(new Set());
      await data.reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <LibraryHead current="shows" />
      <p className="muted small">{t("shows.intro")}</p>
      {!status.allowedRoots?.length && (
        <p className="banner warn">
          {t("shows.noRoots")} <Link to="/settings?tab=safety">{t("nav.settings")} →</Link>
        </p>
      )}
      <div className="filters card pad">
        <div className="chips pickable" role="group" aria-label={t("common.filter")}>
          {(["airing", "continuing", "managed", "all"] as Filter[]).map((f) => (
            <button key={f} className={`chip${filter === f ? " on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "airing" ? t("shows.filter.airing", { season: data.data ? `${data.data.season.name} ${data.data.season.year}` : "" }) : t(`shows.filter.${f}`)}
            </button>
          ))}
        </div>
        <div className="row">
          {!!tags.length && (
            <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t("shows.filter.tag")} className="auto">
              <option value="">{t("shows.filter.tag")}: {t("shows.filter.all")}</option>
              {tags.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          )}
          <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("shows.searchPlaceholder")} aria-label={t("shows.searchPlaceholder")} />
        </div>
      </div>
      {data.error && <ErrorBox error={data.error} retry={data.reload} />}
      {data.loading && !data.data && <Spinner label={t("app.loading")} />}
      {data.data && (
        <>
          <div className="row between">
            <span className="muted small">{t("shows.count", { shown: shown.length, total: data.data.series.length })}</span>
            <div className="row">
              <button className="small" onClick={() => setSel(new Set(shown.map((s) => s.tvdbId)))}>
                {t("shows.selectAll")}
              </button>
              {!!sel.size && (
                <button className="small ghost" onClick={() => setSel(new Set())}>
                  {t("shows.clear")}
                </button>
              )}
            </div>
          </div>
          {!shown.length && <Empty icon="▦" action={filter !== "all" ? { label: t("shows.filter.all"), run: () => setFilter("all") } : { label: t("nav.find"), run: () => navigate("/find") }}>{t("shows.empty")}</Empty>}
          <div className="poster-grid">
            {shown.map((s) => (
              <article key={s.tvdbId} className={`poster-card${sel.has(s.tvdbId) ? " selected" : ""}`}>
                <input className="poster-check" type="checkbox" checked={sel.has(s.tvdbId)} onChange={() => toggle(s.tvdbId)} aria-label={s.title} />
                <ShowLink tvdbId={s.tvdbId} title={s.title} className="poster-link">
                  <Cover src={s.cover} alt={s.title} size="lg" />
                  <span className="poster-title clamp2">{s.title}</span>
                </ShowLink>
                <div className="poster-body">
                  <div className="chips">
                    {s.managed && filter !== "managed" && <Chip tone="accent">{t("chip.managed")}{s.dryRun ? ` · ${t("chip.dryRun")}` : ""}</Chip>}
                    {s.managed && filter === "managed" && s.dryRun && <Chip tone="accent">{t("chip.dryRun")}</Chip>}
                    {s.airingThisSeason && filter !== "airing" && <Chip tone="good">{t("chip.airing")}</Chip>}
                    {!s.allowed && <Chip tone="warn" title={s.path}>{t("chip.outsideRoot")}</Chip>}
                    {s.anidb !== "matched" && <Chip tone="warn">{t("chip.unmatched")}</Chip>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {!!sel.size && (
        <div className="bulkbar card">
          <span>{t("shows.selected", { n: sel.size })}</span>
          <div className="row">
            <button className="ghost" disabled={busy} onClick={() => setScopeOpen(true)}>
              {t("scope.bulk")}
            </button>
            <button className="ghost" disabled={busy} onClick={() => setFillAsk(true)}>
              {t("fill.add")}
            </button>
            <button className="ghost" disabled={busy} onClick={() => apply(false)}>
              {t("shows.unmanageSelected")}
            </button>
            <button className="primary" disabled={busy} onClick={() => void askManage()}>
              {t("shows.manageSelected")}
            </button>
          </div>
        </div>
      )}
      {manageAsk && (
        <Modal title={t("shows.manageTitle", { n: manageAsk.shows })} onClose={() => setManageAsk(null)}>
          <div className="stack">
            <p>{manageAsk.dryRun ? t("shows.manageDry") : t("shows.manageLiveBody", { missing: manageAsk.missing, perHour: manageAsk.perHour })}</p>
            {!manageAsk.dryRun && !manageAsk.backlog && <p className="muted small">{t("shows.manageNoBacklog")}</p>}
            <div className="row">
              {!manageAsk.dryRun && (
                <button className="primary" onClick={() => void apply(true, true)}>
                  {t("shows.manageLive")}
                </button>
              )}
              <button onClick={() => void apply(true, false)}>{t("shows.manageDryButton")}</button>
              <button className="ghost" onClick={() => setManageAsk(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {fillAsk && (
        <Confirm title={t("fill.addTitle", { n: sel.size })} confirmLabel={t("fill.add")} onClose={() => setFillAsk(false)} onConfirm={() => fill()}>
          <p>{t("fill.addBody")}</p>
        </Confirm>
      )}
      {scopeOpen && (
        <Modal title={t("scope.bulkTitle", { n: sel.size })} onClose={() => setScopeOpen(false)}>
          <p className="muted small">{t("scope.bulkNote")}</p>
          <ScopeEditor tvdbIds={[...sel]} previewFor={[...sel][0]} onSaved={() => setScopeOpen(false)} />
        </Modal>
      )}
    </section>
  );
}

/** Library = Shows and Movies behind one segmented control (one nav entry for both). */
export function LibraryHead({ current }: { current: "shows" | "movies" }) {
  return (
    <div className="row between">
      <h1>{t("nav.library")}</h1>
      <div className="seg" role="group" aria-label={t("nav.library")}>
        <button className={current === "shows" ? "on" : ""} aria-pressed={current === "shows"} onClick={() => current !== "shows" && navigate("/shows")}>
          {t("lib.shows")}
        </button>
        <button className={current === "movies" ? "on" : ""} aria-pressed={current === "movies"} onClick={() => current !== "movies" && navigate("/movies")}>
          {t("lib.movies")}
        </button>
      </div>
    </div>
  );
}
