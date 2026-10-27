import { useEffect, useState } from "react";
import { FixButtons } from "../fixes";
import { api, fmtSize } from "../api";
import { query } from "../App";
import { ShowLink } from "../episodes";
import { t, type I18nKey } from "../i18n";
import { Chip, Confirm, dateTime, Empty, ErrorBox, Menu, Spinner, thumbUrl, useLoad, usePageTitle, useToast, Why, ReleaseName } from "../ui";
import { SeasonHeader } from "../seasonal";
import { seasonOf, showVars } from "../season";
import { FileX } from "lucide-react";

interface Item {
  id: number;
  at: number;
  tvdbId: number;
  movieId?: number | null;
  series: string;
  episodes: string[];
  release: string;
  protocol: string;
  client: string | null;
  state: string;
  dryRun: boolean;
  why: string;
  error: string | null; fixes?: import("../api").Fix[];
  cover?: string | null;
  color?: string | null;
  clientName?: string;
  progress: number | null;
  attempt: number;
  stage?: string | null;
  ahead?: number | null;
  live?: { state: string; progress: number; etaSec?: number | null; speed?: number | null; sizeBytes?: number | null; clientStatus?: string; seeders?: number | null; message?: string } | null;
}

const STATE_TONE: Record<string, "good" | "bad" | "warn" | "info" | "accent"> = { done: "good", failed: "bad", "needs-attention": "warn", downloading: "accent", importing: "accent", sending: "info", "dry-run": "info" };
const ICON: Record<string, string> = { done: "✓", failed: "✕", "needs-attention": "⚠", downloading: "↓", importing: "⇢", sending: "…", "dry-run": "◌" };

const eta = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function StateChip({ state }: { state: string }) {
  return (
    <Chip tone={STATE_TONE[state] ?? "info"}>
      <span aria-hidden="true">{ICON[state] ?? ""} </span>
      {t(`grab.${state}` as I18nKey)}
    </Chip>
  );
}

/** Sonarr-style queue: what's downloading now, with live progress, plus the grab history. */
export function Queue() {
  usePageTitle(t("queue.title"));
  const [tab, setTab] = useState<"queue" | "history">(query().get("tab") === "history" ? "history" : "queue");
  return (
    <section>
      <SeasonHeader compact eyebrow={`${seasonOf().kanji} ${t(`season.${seasonOf().key}` as I18nKey)} ${seasonOf().year}`} title={t("queue.title")}>
        <div className="seg seg-accent queue-seg" role="tablist">
          {(["queue", "history"] as const).map((x) => (
            <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => (setTab(x), history.replaceState(null, "", `/queue?tab=${x}`))}>
              {t(`queue.tab.${x}`)}
            </button>
          ))}
        </div>
      </SeasonHeader>
      {tab === "queue" ? (
        <>
          <Downloading onHistory={() => (setTab("history"), history.replaceState(null, "", "/queue?tab=history"))} />
          <SonarrProblems />
        </>
      ) : (
        <History />
      )}
    </section>
  );
}

function Downloading({ onHistory }: { onHistory: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api<{ items: Item[] }>("/queue"), []);
  const [remove, setRemove] = useState<Item | null>(null);
  const [opts, setOpts] = useState({ blocklist: true, searchNext: true });
  useEffect(() => {
    const id = setInterval(() => void d.reload(), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  return (
    <div className="list">
      {!d.data.items.length && <Empty icon="↓" title={t("queue.quiet")} action={{ label: t("queue.tab.history"), run: onHistory }}>{t("queue.empty")}</Empty>}
      {d.data.items.map((g) => {
        const pct = Math.round((g.live?.progress ?? g.progress ?? 0) * 100);
        return (
          <article key={g.id} className={`card qcard${g.state === "needs-attention" ? " attention" : ""}`} style={showVars(g.color)}>
            <div className="qhead">
              {g.cover ? <img className="qposter" src={thumbUrl(g.cover, "sm")} alt="" width={44} height={64} /> : <span className="qposter" />}
              <ShowLink tvdbId={g.tvdbId} title={g.series} to={g.movieId ? `/movie/${g.movieId}` : undefined} className="qtitle">
                <span className="stack">
                  <span className="strong clamp2">{g.series}</span>
                  <span className="muted small clamp1">{g.episodes.join(", ")}</span>
                </span>
              </ShowLink>
              {g.state === "downloading" && g.stage !== "waiting" && <span className="qpct tnum">{pct}%</span>}
              {g.state !== "downloading" && <StateChip state={g.state} />}
            </div>
            {g.state === "downloading" && g.stage !== "waiting" && (
              <div className="qbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={g.series}>
                <i style={{ width: `${pct}%` }} />
              </div>
            )}
            <div className="row between qmeta">
              <span className="muted small">
                {g.state === "downloading" && g.stage === "waiting" ? `⇢ ${g.ahead ? t("ep.waitingImportAhead", { n: g.ahead }) : t("ep.waitingImport")}` : g.live?.etaSec ? t("queue.speedEta", { speed: fmtSize(g.live.speed ?? 0), eta: eta(g.live.etaSec) }) : g.state === "downloading" ? t("queue.progressNoEta", { pct }) : ""}
              </span>
              <span className="row qclient">
                <span className="muted small">
                  {g.clientName || g.protocol}
                  {g.live?.sizeBytes ? ` · ${fmtSize(g.live.sizeBytes)}` : ""}
                  {g.attempt > 1 ? ` · #${g.attempt}` : ""}
                </span>
                <Menu label={`${g.series}: ${t("common.moreActions")}`} items={[{ label: t("queue.remove"), danger: true, onSelect: () => setRemove(g), hidden: !(g.state === "downloading" || g.state === "needs-attention") }]} />
              </span>
            </div>
            <ReleaseLine release={g.release} />
            {g.state === "needs-attention" && g.error && (
              <p className="warn-text small qerr">
                <FileX className="lucide" aria-hidden="true" /> {g.error}
              </p>
            )}
            <Why lines={[g.why, ...(g.error && g.state !== "needs-attention" ? [g.error] : []), ...(g.live?.message ? [g.live.message] : [])]} />
            <div className="row">
              <FixButtons fixes={g.fixes} />
              {g.state === "needs-attention" && (
                <button
                  className="small"
                  onClick={async () => {
                    try {
                      await api(`/grabs/${g.id}/retry`, { body: {} });
                      toast(t("managed.retried"));
                      await d.reload();
                    } catch (e) {
                      toast((e as Error).message, true);
                    }
                  }}
                >
                  {t("managed.retryImport")}
                </button>
              )}
            </div>
          </article>
        );
      })}
      {remove && (
        <Confirm
          danger
          title={t("queue.removeTitle")}
          confirmLabel={t("queue.remove")}
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            try {
              await api(`/queue/${remove.id}/remove`, { body: { ...opts, confirm: true } });
              toast(t("queue.removed"));
              setRemove(null);
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("queue.removeBody", { release: remove.release, client: remove.clientName || remove.client || "" })}</p>
          <label className="check">
            <input type="checkbox" checked={opts.blocklist} onChange={(e) => setOpts({ ...opts, blocklist: e.target.checked })} /> {t("queue.blocklist")}
          </label>
          <label className="check">
            <input type="checkbox" checked={opts.searchNext} onChange={(e) => setOpts({ ...opts, searchNext: e.target.checked })} /> {t("queue.searchNext")}
          </label>
        </Confirm>
      )}
    </div>
  );
}

function History() {
  const [state, setState] = useState("");
  const [extra, setExtra] = useState<Item[]>([]);
  const d = useLoad(() => {
    setExtra([]);
    return api<Item[]>(`/history${state ? `?state=${state}` : ""}`);
  }, [state]);
  const all = [...(d.data ?? []), ...extra];
  const filters: [string, I18nKey][] = [
    ["", "queue.filter.all"],
    ["done", "queue.filter.done"],
    ["failed", "queue.filter.failed"],
    ["dry-run", "queue.filter.dry"],
  ];
  return (
    <div className="stack">
      <div className="chips pickable" role="group">
        {filters.map(([k, label]) => (
          <button key={k} className={`chip${state === k ? " on" : ""}`} aria-pressed={state === k} onClick={() => setState(k)}>
            {t(label)}
          </button>
        ))}
      </div>
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {d.data && !all.length && <Empty icon="≡">{t("queue.historyEmpty")}</Empty>}
      <div className="list">
        {all.map((g) => (
          <article key={g.id} className="card pad stack">
            <div className="row between">
              <ShowLink tvdbId={g.tvdbId} title={g.series} to={g.movieId ? `/movie/${g.movieId}` : undefined}>
                <span className="strong clamp2">
                  {g.series} <span className="mono small">{g.episodes.join(", ")}</span>
                </span>
              </ShowLink>
            </div>
            <div className="row">
              <StateChip state={g.state} />
              <span className="muted small">{dateTime(g.at)}</span>
            </div>
            <ReleaseLine release={g.release} />
            {g.state === "failed" && g.error && <p className="small warn-text clamp2">{g.error}</p>}
            <Why lines={[g.why, ...(g.error && g.state !== "failed" ? [g.error] : [])]} />
            <FixButtons fixes={g.fixes} />
          </article>
        ))}
      </div>
      {all.length >= 50 && (
        <button
          onClick={async () => {
            const next = await api<Item[]>(`/history?before=${all[all.length - 1].id}${state ? `&state=${state}` : ""}`);
            setExtra((x) => [...x, ...next]);
          }}
        >
          {t("common.loadMore")}
        </button>
      )}
    </div>
  );
}

interface Problem { id: number; downloadId: string | null; series: string; tvdbId: number | null; episodes: string[]; release: string; client: string | null; protocol: string | null; problem: string; messages: string[]; added: string | null }
const PROBLEM_TONE: Record<string, "bad" | "warn" | "info"> = { failed: "bad", "sonarr-handling": "info", "import-blocked": "warn", warning: "warn", stalled: "info" };

/** Sonarr's own queue: only the items that need a look (report; removal only when you ask). */
function SonarrProblems() {
  const toast = useToast();
  const d = useLoad(() => api<{ items: Problem[] }>("/queue/sonarr"), []);
  const [remove, setRemove] = useState<Problem | null>(null);
  const [blocklist, setBlocklist] = useState(true);
  useEffect(() => {
    const id = setInterval(() => void d.reload(), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!d.error && (!d.data || !d.data.items.length)) return null;
  return (
    <div className="stack" style={{ marginTop: "var(--space-6, 24px)" }}>
      <h2>{t("queue.sonarr.title")}</h2>
      {d.error ? <ErrorBox error={d.error} retry={d.reload} /> : <p className="muted small">{t("queue.sonarr.intro")}</p>}
      <div className="list">
        {(d.data?.items ?? []).map((p) => (
          <article key={p.id} className="card pad stack">
            <span className="stack">
              <span className="strong clamp2">{p.series}</span>
              {!!p.episodes.length && <span className="mono small">{p.episodes.join(", ")}</span>}
            </span>
            <ReleaseLine release={p.release} />
            <div className="row">
              <Chip tone={PROBLEM_TONE[p.problem] ?? "info"}>
                <span aria-hidden="true">⚠ </span>
                {t(`queue.sonarr.${p.problem}` as I18nKey)}
              </Chip>
              {p.client && <span className="muted small">{p.client}</span>}
            </div>
            {!!p.messages.length && <Why lines={p.messages} />}
            {p.problem !== "sonarr-handling" && (
              <div className="row end">
                <Menu label={`${p.series}: ${t("common.moreActions")}`} items={[{ label: t("queue.remove"), danger: true, onSelect: () => (setBlocklist(true), setRemove(p)) }]} />
              </div>
            )}
          </article>
        ))}
      </div>
      {remove && (
        <Confirm
          danger
          title={t("queue.removeTitle")}
          confirmLabel={t("queue.remove")}
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            try {
              await api(`/queue/sonarr/${remove.id}/remove`, { body: { blocklist, confirm: true, downloadId: remove.downloadId } });
              toast(t("queue.removed"));
              setRemove(null);
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("queue.sonarr.removeBody", { release: remove.release })}</p>
          <label className="check">
            <input type="checkbox" checked={blocklist} onChange={(e) => setBlocklist(e.target.checked)} /> {t("queue.sonarr.blocklist")}
          </label>
        </Confirm>
      )}
    </div>
  );
}

/** A release name: one muted line; tap to see all of it. */
export function ReleaseLine({ release }: { release: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button className={`release-line small muted${open ? "" : " clamp1"}`} title={release} aria-expanded={open} onClick={() => setOpen(!open)}>
      <ReleaseName name={release} />
    </button>
  );
}
