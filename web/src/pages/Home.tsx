import { useState } from "react";
import { api, type Decision, type Status } from "../api";
import { Link } from "../App";
import { t } from "../i18n";
import { relTime, useLoad, usePageTitle, useToast } from "../ui";
import { DecisionCard } from "./Activity";
import { Calendar } from "./Calendar";

export function Home({ status, onChanged }: { status: Status; onChanged: () => void }) {
  usePageTitle(t("home.title"));
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const recent = useLoad(() => api<Decision[]>("/activity"), []);
  const queue = useLoad(() => api<{ items: { state: string }[] }>("/queue"), []);
  const c = status.connected!;
  const steps = [
    { done: c.sonarr && c.prowlarr && (c.sabnzbd || c.qbittorrent), label: t("home.step.connect"), to: "/settings" },
    { done: !!status.lastSync, label: t("home.step.sync"), to: "/shows" },
    { done: !!status.allowedRoots?.length, label: t("home.step.root"), to: "/settings?tab=safety" },
    { done: (status.managed ?? 0) > 0, label: t("home.step.manage"), to: "/shows" },
  ];

  async function sync() {
    setSyncing(true);
    try {
      await api("/library/sync", { body: {} });
      toast(t("home.syncing"));
      setTimeout(() => {
        onChanged();
        setSyncing(false);
      }, 8000);
    } catch (e) {
      toast((e as Error).message, true);
      setSyncing(false);
    }
  }

  return (
    <section>
      {steps.some((s) => !s.done) && (
        <div className="card pad stack">
          <h2>{t("home.start")}</h2>
          <ol className="checklist">
            {steps.map((s) => (
              <li key={s.label} className={s.done ? "done" : ""}>
                <span aria-hidden="true">{s.done ? "✓" : "○"}</span> {s.done ? s.label : <Link to={s.to}>{s.label}</Link>}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="tiles">
        <div className="card pad tile">
          <p>{t("home.library", { series: status.librarySeries ?? 0, when: status.lastSync ? relTime(status.lastSync) : t("home.never") })}</p>
          <button onClick={sync} disabled={syncing || status.syncing}>
            {syncing || status.syncing ? t("home.syncing") : t("home.syncNow")}
          </button>
        </div>
        <Link to="/queue" className="card pad tile link-tile">
          <strong>{t("home.queue", { n: queue.data?.items.filter((x) => x.state === "downloading" || x.state === "sending").length ?? 0 })}</strong>
          <span className="muted small">{t("nav.queue")} →</span>
        </Link>
        <Link to="/managed" className="card pad tile link-tile">
          <strong>{t("home.managedCount", { n: status.managed ?? 0 })}</strong>
          <span className="muted small">{t("nav.managed")} →</span>
        </Link>
      </div>
      <h2 className="section-title">
        {t("cal.title")} <Link to="/calendar">→</Link>
      </h2>
      <Calendar compact />
      <h2 className="section-title">{t("home.quick")}</h2>
      <div className="tiles">
        <Link to="/audit?tab=gaps" className="card pad tile link-tile">
          {t("home.findGaps")} →
        </Link>
        <Link to="/audit?tab=language" className="card pad tile link-tile">
          {t("home.missingLang")} →
        </Link>
        <Link to="/search?tab=identify" className="card pad tile link-tile">
          {t("home.identify")} →
        </Link>
      </div>
      <h2 className="section-title">
        {t("home.recent")} <Link to="/activity">→</Link>
      </h2>
      <div className="list">{(recent.data ?? []).slice(0, 5).map((d) => <DecisionCard key={d.id} d={d} onUndone={recent.reload} />)}</div>
    </section>
  );
}
