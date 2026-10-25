import { useEffect, useState } from "react";
import { api, sxe, type Grab, type ManagedShow, type Status } from "../api";
import { Link } from "../App";
import { ShowLink } from "../episodes";
import { t, type I18nKey } from "../i18n";
import { Chip, Confirm, Cover, dateTime, Empty, ErrorBox, relTime, Spinner, Toggle, useLoad, usePageTitle, useToast, Why } from "../ui";

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

  async function setDry(m: ManagedShow, dryRun: boolean) {
    try {
      await api(`/managed/${m.tvdbId}`, { method: "PUT", body: { dryRun } });
      await data.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  return (
    <section>
      <div className="row between">
        <h1>{t("managed.title")}</h1>
        <div className="row">
          <Link to="/shows" className="button">
            {t("managed.choose")}
          </Link>
          <button
            onClick={async () => {
              await api("/managed/run", { body: {} });
              toast(t("common.working"));
              setTimeout(() => void data.reload(), 5000);
            }}
          >
            {t("managed.runNow")}
          </button>
        </div>
      </div>
      <div className={`banner ${status.dryRun ? "" : "warn"}`}>{status.dryRun ? t("home.dryRunOn") : t("home.dryRunOff")}</div>
      {data.error && <ErrorBox error={data.error} retry={data.reload} />}
      {data.loading && !data.data && <Spinner label={t("app.loading")} />}
      {data.data && !data.data.shows.length && <Empty>{t("managed.empty")}</Empty>}
      <div className="list">
        {data.data?.shows.map((m) => (
          <article key={m.tvdbId} className="card show-card">
            <ShowLink tvdbId={m.tvdbId} title={m.title} className="show-card-head">
              <Cover src={m.cover} alt={m.title} size="md" />
              <span className="stack">
                <span className="strong clamp2">{m.title}</span>
                {m.unmonitoredInSonarr && <Chip tone="info">{t("managed.sonarrUnmonitored")}</Chip>}
              </span>
            </ShowLink>
            <div className="show-body">
              <Toggle checked={m.dryRun} onChange={(v) => setDry(m, v)} label={t("managed.showDryRun")} />
              {!m.unmonitoredInSonarr && (
                <button className="small ghost self-start" onClick={() => setConfirm(m)}>
                  {t("managed.sonarrMonitor")}
                </button>
              )}
              {m.schedule.length ? (
                <ul className="sched">
                  {m.schedule.map((s) => (
                    <li key={s.episodeId}>
                      <span className="mono">{sxe(s.season, s.episode)}</span>
                      <Chip tone={STATE_TONE[s.state] ?? "info"}>{t(`managed.state.${s.state}` as I18nKey)}</Chip>
                      {(s.state === "waiting" || s.state === "retry") && <span className="muted small">{t("managed.nextAt", { when: dateTime(s.nextAt) })}</span>}
                      {s.why && <Why lines={[s.why]} />}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">{t("managed.noSchedule")}</p>
              )}
            </div>
          </article>
        ))}
      </div>
      <h2 className="section-title">{t("managed.grabs")}</h2>
      {data.data && !data.data.grabs.length && <Empty>{t("managed.noGrabs")}</Empty>}
      <div className="list">
        {data.data?.grabs.map((g) => (
          <article key={g.id} className="card pad">
            <div className="row between">
              <Chip tone={g.state === "done" ? "good" : g.state === "failed" ? "bad" : g.state === "needs-attention" ? "warn" : g.dry_run ? "accent" : "info"}>{g.state}</Chip>
              <span className="muted small">{relTime(g.at)}</span>
            </div>
            <p className="mono small">{g.release}</p>
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
