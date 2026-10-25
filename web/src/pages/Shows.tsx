import { useMemo, useState } from "react";
import { api, type LibraryShow, type Status } from "../api";
import { Link } from "../App";
import { t } from "../i18n";
import { Chip, Cover, Empty, ErrorBox, Spinner, useLoad, usePageTitle, useToast } from "../ui";

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

  async function apply(on: boolean) {
    setBusy(true);
    try {
      const r = await api<{ changed: number; refused: { title: string; reason: string }[] }>("/managed", { body: { tvdbIds: [...sel], on } });
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
      <h1>{t("shows.title")}</h1>
      <p className="muted">{t("shows.intro")}</p>
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
          {!shown.length && <Empty>{t("shows.empty")}</Empty>}
          <div className="poster-grid">
            {shown.map((s) => (
              <article key={s.tvdbId} className={`poster-card${sel.has(s.tvdbId) ? " selected" : ""}`}>
                <label className="poster-select">
                  <input type="checkbox" checked={sel.has(s.tvdbId)} onChange={() => toggle(s.tvdbId)} aria-label={s.title} />
                  <Cover src={s.cover} alt={s.title} size="lg" />
                </label>
                <div className="poster-body">
                  <Link to={`/show/${s.tvdbId}`} className="poster-title clamp2">
                    {s.title}
                  </Link>
                  <div className="chips">
                    {s.managed && <Chip tone="accent">{t("chip.managed")}{s.dryRun ? ` · ${t("chip.dryRun")}` : ""}</Chip>}
                    {s.airingThisSeason && <Chip tone="good">{t("chip.airing")}</Chip>}
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
            <button className="ghost" disabled={busy} onClick={() => apply(false)}>
              {t("shows.unmanageSelected")}
            </button>
            <button className="primary" disabled={busy} onClick={() => apply(true)}>
              {t("shows.manageSelected")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
