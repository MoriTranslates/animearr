import { useEffect, useState } from "react";
import { api, sxe, type Grab, type ManagedShow, type Status } from "../api";
import { navigate } from "../App";
import { ShowLink } from "../episodes";
import { t, type I18nKey } from "../i18n";
import { Chip, Confirm, Cover, dateTime, Empty, ErrorBox, Menu, relTime, Spinner, useLoad, usePageTitle, useToast, Why } from "../ui";
import { ReleaseLine, StateChip } from "./Queue";

const STATE_TONE: Record<string, "good" | "bad" | "warn" | "info" | "accent"> = { waiting: "info", retry: "warn", "would-grab": "accent", grabbed: "good", "gave-up": "bad", done: "good", backlog: "info", replace: "warn" };

export function Managed({ status }: { status: Status }) {
  usePageTitle(t("managed.title"));
  const toast = useToast();
  const data = useLoad(() => api<{ dryRun: boolean; shows: ManagedShow[]; grabs: Grab[] }>("/managed"), []);
  // Refresh while the page is open, so grabs and imports move on by themselves.
  useEffect(() => {
    const id = setInterval(() => void data.reload(), 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [confirm, setConfirm] = useState<ManagedShow | null>(null);

  const shows = data.data?.shows ?? [];
  const attention = shows.filter((m) => m.schedule.some((x) => x.state === "retry" || x.state === "gave-up"));
  const pending = (m: ManagedShow) => m.schedule.some((x) => x.state !== "done");
  const scheduled = shows.filter((m) => !attention.includes(m) && pending(m));
  const quiet = shows.filter((m) => !attention.includes(m) && !pending(m));
  const sonarrToo = shows.filter((m) => !m.unmonitoredInSonarr);
  const card = (m: ManagedShow) => (
    <article key={m.tvdbId} className="card show-card">
      <div className="row between no-wrap">
        <ShowLink tvdbId={m.tvdbId} title={m.title} className="show-card-head">
          <Cover src={m.cover} alt={m.title} size="sm" />
          <span className="stack">
            <span className="strong clamp2">{m.title}</span>
            <span className="chips">
              {m.dryRun && (
                <Chip tone="info" title={t("dry.showChipHelp")}>
                  {t("chip.dryRun")}
                </Chip>
              )}
              {!m.unmonitoredInSonarr && <Chip tone="warn">{t("managed.sonarrToo")}</Chip>}
            </span>
          </span>
        </ShowLink>
        <Menu label={`${m.title}: ${t("common.moreActions")}`} items={[{ label: t("managed.sonarrMonitor"), onSelect: () => setConfirm(m), hidden: m.unmonitoredInSonarr }]} />
      </div>
      <ul className="sched show-body">
        {m.schedule.filter((s) => s.state !== "done").map((s) => (
          <li key={s.episodeId}>
            <span className="mono">{sxe(s.season, s.episode)}</span>
            <Chip tone={STATE_TONE[s.state] ?? "info"}>{t(`managed.state.${s.state}` as I18nKey)}</Chip>
            {(s.state === "waiting" || s.state === "retry") && <span className="muted small">{t("managed.nextAt", { when: dateTime(s.nextAt) })}</span>}
            {s.why && <Why lines={[s.why]} />}
          </li>
        ))}
      </ul>
    </article>
  );

  return (
    <section>
      <div className="row between">
        <h1>{t("managed.title")}</h1>
        <div className="row">
          <AutomateTabs current="managed" />
          <Menu
            items={[
              {
                label: t("managed.runNow"),
                onSelect: async () => {
                  try {
                    await api("/managed/run", { body: {} });
                    toast(t("common.working"));
                    setTimeout(() => void data.reload(), 5000);
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                },
              },
              { label: t("managed.choose"), onSelect: () => navigate("/shows?filter=all") },
            ]}
          />
        </div>
      </div>
      {data.error && <ErrorBox error={data.error} retry={data.reload} />}
      {data.loading && !data.data && <Spinner label={t("app.loading")} />}
      {data.data && !shows.length && <Empty icon="★" action={{ label: t("managed.choose"), run: () => navigate("/shows") }}>{t("managed.empty")}</Empty>}
      {!!sonarrToo.length && status.connected?.sonarr && <p className="muted small">{t("managed.sonarrTooNote", { n: sonarrToo.length })}</p>}
      {!!attention.length && (
        <>
          <h2 className="section-title">{t("managed.group.attention", { n: attention.length })}</h2>
          <div className="list">{attention.map(card)}</div>
        </>
      )}
      {!!scheduled.length && (
        <>
          <h2 className="section-title">{t("managed.group.scheduled", { n: scheduled.length })}</h2>
          <div className="list">{scheduled.map(card)}</div>
        </>
      )}
      {!!quiet.length && (
        <details className="quiet-group">
          <summary className="section-title">
            <h2>{t("managed.group.quiet", { n: quiet.length })}</h2> <span className="muted small">{t("managed.noSchedule")}</span>
          </summary>
          <div className="poster-grid small-posters">
            {quiet.map((m) => (
              <ShowLink key={m.tvdbId} tvdbId={m.tvdbId} title={m.title} className="poster-link card">
                <Cover src={m.cover} alt={m.title} size="lg" />
                <span className="poster-title clamp2">{m.title}</span>
              </ShowLink>
            ))}
          </div>
        </details>
      )}
      <h2 className="section-title">{t("managed.grabs")}</h2>
      {data.data && !data.data.grabs.length && <Empty icon="↓">{t("managed.noGrabs")}</Empty>}
      <div className="list">
        {data.data?.grabs.map((g) => (
          <article key={g.id} className="card pad">
            <div className="row between">
              <StateChip state={g.dry_run ? "dry-run" : g.state} />
              <span className="muted small">{relTime(g.at)}</span>
            </div>
            <ReleaseLine release={g.release} />
            <Why lines={[g.why, ...(g.error ? [g.error] : [])]} />
            {g.state === "needs-attention" && (
              <button
                className="small self-start"
                onClick={async () => {
                  try {
                    await api(`/grabs/${g.id}/retry`, { body: {} });
                    toast(t("managed.retried"));
                    await data.reload();
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                {t("managed.retryImport")}
              </button>
            )}
          </article>
        ))}
      </div>
      {confirm && (
        <Confirm
          title={t("managed.sonarrMonitor")}
          confirmLabel={t("common.yes")}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await api(`/managed/${confirm.tvdbId}/sonarr-monitor`, { body: { monitored: false, confirm: true } });
              setConfirm(null);
              await data.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("managed.sonarrMonitorConfirm", { title: confirm.title })}</p>
        </Confirm>
      )}
    </section>
  );
}

/** Managed and Fill-in are one place: two views behind a segmented control. */
export function AutomateTabs({ current }: { current: "managed" | "fillin" }) {
  return (
    <div className="seg" role="group" aria-label={t("nav.group.automate")}>
      <button className={current === "managed" ? "on" : ""} aria-pressed={current === "managed"} onClick={() => current !== "managed" && navigate("/managed")}>
        {t("nav.managed")}
      </button>
      <button className={current === "fillin" ? "on" : ""} aria-pressed={current === "fillin"} onClick={() => current !== "fillin" && navigate("/fillin")}>
        {t("nav.fillin")}
      </button>
    </div>
  );
}
