import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { LibraryFolders } from "../folders";
import { PhonePanel } from "../phone";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Settings as S, type Status } from "../api";
import { Link, navigate } from "../App";
import { Cutover } from "../cutover";
import { fromEntry, type CatalogEntry } from "../connectionsEdit";
import { DownloadClients, Indexers, Migration, type SaveNow } from "../connections";
import { MediaPicker } from "../mediaout";
import { t, type I18nKey } from "../i18n";
import { SeasonHeader } from "../seasonal";
import { Settings, type SettingsTab } from "./Settings";
import { ErrorBox, ErrorText, Spinner, useLoad, usePageTitle, useToast, Toggle } from "../ui";
import { rememberDetail } from "../errors";
import { saveAllUnsaved } from "../unsaved";
import { ChangeDefaultLogin } from "./Login";

const MEDIA_NAMES: Record<string, string> = { plex: "Plex", jellyfin: "Jellyfin", emby: "Emby", kodi: "Kodi" };
interface ConnState { name: string; configured: boolean; ok: boolean | null; error?: string | null; errorDetail?: string | null }
interface Overview { clients: ConnState[]; indexers: { name: string }[]; mediaServers: ConnState[]; migration: ConnState[] }

/**
 * First-run setup: two paths chosen on the welcome screen. Every step can be skipped and comes back later from
 * Settings; progress is saved, so it can be resumed. Re-run from Settings → System, without wiping anything.
 */
type Path = "new" | "migrate";
interface WizardState { done: boolean; path: Path | null; step: string; completed: string[] }
interface Step { id: string; title: I18nKey; intro: I18nKey; body: ReactNode }

/** The settings + a "save just this change" helper, for the embedded connection cards. */
function useSettingsSaver(onSaved: () => void) {
  const toast = useToast();
  const d = useLoad(() => api<S>("/settings"), []);
  const saveNow: SaveNow = async (fn) => {
    try {
      const next = await api<S>("/settings", { method: "PUT", body: fn(structuredClone(d.data!)) });
      d.setData(next);
      toast(t("common.saved"));
      onSaved();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  return { s: d.data, saveNow, reload: d.reload, error: d.error };
}

export function Wizard({ status, onChanged }: { status: Status; onChanged: () => void | Promise<void> }) {
  usePageTitle(t("wiz.title"));
  const toast = useToast();
  const st = useLoad(() => api<WizardState>("/wizard"), []);
  const [w, setW] = useState<WizardState | null>(null);
  useEffect(() => {
    if (st.data) setW(st.data);
  }, [st.data]);
  const saver = useSettingsSaver(onChanged);
  // What's really set up (a step is ticked when it is, not for being visited).
  const conn = useLoad(() => api<Overview>("/connections"), [saver.s]);
  const save = async (patch: Partial<WizardState>) => {
    const next = { ...w!, ...patch };
    setW(next);
    try {
      await api("/wizard", { method: "PUT", body: next });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  if (st.error) return <ErrorBox error={st.error} retry={st.reload} />;
  if (!w || !saver.s) return <Spinner label={t("app.loading")} />;
  const s = saver.s;
  const section = (only: SettingsTab) => <Settings status={status} onSaved={() => (onChanged(), void saver.reload())} only={only} />;

  if (!w.path || w.step === "welcome")
    return (
      <section className="wizard">
        <SeasonHeader eyebrow={t("wiz.eyebrow")} title={t("wiz.welcome")} sub={t("wiz.welcomeSub")} />
        <div className="wiz-paths">
          <button className="wiz-path card" onClick={() => void save({ path: "new", step: "account" })}>
            <span className="wiz-path-icon" aria-hidden="true">
              ✦
            </span>
            <b>{t("wiz.pathNew")}</b>
            <span className="muted small">{t("wiz.pathNewHelp")}</span>
          </button>
          <button className="wiz-path card" onClick={() => void save({ path: "migrate", step: status.defaultPassword ? "account" : "connect" })}>
            <span className="wiz-path-icon" aria-hidden="true">
              ⇄
            </span>
            <b>{t("wiz.pathMigrate")}</b>
            <span className="muted small">{t("wiz.pathMigrateHelp")}</span>
          </button>
        </div>
        <p className="muted small">
          {t("wiz.skipAll")}{" "}
          <button className="linklike" onClick={() => void save({ done: true }).then(async () => (await onChanged(), navigate("/settings")))}>
            {t("wiz.skipLink")}
          </button>
        </p>
      </section>
    );

  const steps: Step[] =
    w.path === "new"
      ? [
          { id: "account", title: "wiz.s.account", intro: "wiz.i.account", body: <AccountStep status={status} onChanged={onChanged} onLater={() => void save({ step: "folders" })} /> },
          { id: "folders", title: "wiz.s.folders", intro: "wiz.i.folders", body: <FoldersStep s={s} saveNow={saver.saveNow} /> },
          { id: "clients", title: "wiz.s.clients", intro: "wiz.i.clients", body: <ClientsStep s={s} saveNow={saver.saveNow} /> },
          { id: "indexers", title: "wiz.s.indexers", intro: "wiz.i.indexers", body: <IndexersStep s={s} saveNow={saver.saveNow} /> },
          { id: "prefs", title: "wiz.s.prefs", intro: "wiz.i.prefs", body: section("profile") },
          { id: "media", title: "wiz.s.media", intro: "wiz.i.media", body: <><MediaPicker s={s} saveNow={saver.saveNow} />{section("mediaservers")}</> },
          { id: "metadata", title: "wiz.s.metadata", intro: "wiz.i.metadata", body: section("metadata") },
          { id: "notify", title: "wiz.s.notify", intro: "wiz.i.notify", body: section("notifications") },
          { id: "done", title: "wiz.s.done", intro: "wiz.i.done", body: <DoneStep path="new" /> },
        ]
      : [
          // A migrating fresh install still has the default login: offer to change it first.
          ...(status.defaultPassword ? [{ id: "account", title: "wiz.s.account", intro: "wiz.i.account", body: <AccountStep status={status} onChanged={onChanged} onLater={() => void save({ step: "connect" })} /> } satisfies Step] : []),
          { id: "connect", title: "wiz.s.connect", intro: "wiz.i.connect", body: <Migration s={s} saveNow={saver.saveNow} /> },
          { id: "preview", title: "wiz.s.preview", intro: "wiz.i.preview", body: <PreviewStep onApplied={() => (onChanged(), void saver.reload())} /> },
          { id: "review", title: "wiz.s.review", intro: "wiz.i.review", body: <ReviewStep status={status} /> },
          { id: "clients", title: "wiz.s.clients", intro: "wiz.i.clientsMigrate", body: <ClientsStep s={s} saveNow={saver.saveNow} /> },
          { id: "takeover", title: "wiz.s.takeover", intro: "wiz.i.takeover", body: <Cutover /> },
          { id: "done", title: "wiz.s.done", intro: "wiz.i.done", body: <DoneStep path="migrate" /> },
        ];
  const idx = Math.max(0, steps.findIndex((x) => x.id === w.step));
  const step = steps[idx];
  /** Leaves the step: unsaved edits on it are saved first (a failed save shows its error and stays). Next marks it done. */
  const go = async (i: number, next = false) => {
    if (!(await saveAllUnsaved())) return;
    if (step.id === "clients") await preferWhatIsSetUp(toast);
    void save({ step: steps[Math.max(0, Math.min(steps.length - 1, i))].id, completed: next ? [...new Set([...w.completed, step.id])] : w.completed });
  };
  const c = conn.data;
  const works = (x: { configured: boolean; ok: boolean | null }) => x.configured && x.ok !== false;
  /** Steps with something to check are ticked by what's set up; the others when left with Next. */
  const isDone = (id: string): boolean => {
    switch (id) {
      case "account":
        return !status.defaultPassword;
      case "folders":
        return s.allowedRoots.length > 0;
      case "clients":
        return !!c?.clients.some(works);
      case "indexers":
        return !!c?.indexers.length;
      case "media":
        return !!c?.mediaServers.some(works);
      case "notify":
        return !!(s.notify.discordWebhook || s.notify.ntfyUrl);
      case "connect":
        return !!c?.migration.some(works);
      case "done":
        return w.done;
      default:
        return w.completed.includes(id);
    }
  };

  return (
    <section className="wizard">
      <SeasonHeader compact eyebrow={t(w.path === "new" ? "wiz.pathNew" : "wiz.pathMigrate")} title={t(step.title)} sub={t("wiz.stepOf", { n: idx + 1, total: steps.length })}>
        <div className="wiz-progress" role="progressbar" aria-valuenow={idx + 1} aria-valuemin={1} aria-valuemax={steps.length} aria-label={t("wiz.progress")}>
          <i style={{ width: `${Math.round(((idx + 1) / steps.length) * 100)}%` }} />
        </div>
      </SeasonHeader>
      <ol className="wiz-steps" aria-label={t("wiz.progress")}>
        {steps.map((x, i) => (
          <li key={x.id} className={`${i === idx ? "on" : ""}${isDone(x.id) ? " done" : ""}`}>
            <button className="linklike" onClick={() => void go(i)} aria-current={i === idx ? "step" : undefined}>
              {isDone(x.id) && <Check className="lucide" aria-label={t("wiz.stepDone")} />}
              {t(x.title)}
            </button>
          </li>
        ))}
      </ol>
      <p className="wiz-intro">{t(step.intro)}</p>
      <div className="wiz-body">{step.body}</div>
      <div className="wiz-nav sticky-actions row between">
        <button onClick={() => (idx === 0 ? void saveAllUnsaved().then((ok) => void (ok && save({ step: "welcome" }))) : void go(idx - 1))}>
          <ArrowLeft className="lucide" aria-hidden="true" /> {t("wiz.back")}
        </button>
        <span className="row">
          {step.id !== "done" && (
            <button className="ghost" onClick={() => void go(idx + 1)}>
              {t("wiz.skip")}
            </button>
          )}
          {step.id === "done" ? (
            <button className="primary" onClick={() => void saveAllUnsaved().then((ok) => void (ok && save({ done: true }).then(async () => (await onChanged(), navigate("/")))))}>
              {t("wiz.finish")}
            </button>
          ) : (
            <button className="primary" onClick={() => void go(idx + 1, true)}>
              {t("wiz.next")} <ArrowRight className="lucide" aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
    </section>
  );
}

/**
 * Leaving the download-client step: when the clients are all torrent (or all Usenet), the default profile tries that
 * first (it said "Usenet (preferred)" for a torrent-only user). Only when it still has the usenet-first default.
 */
async function preferWhatIsSetUp(toast: ReturnType<typeof useToast>) {
  try {
    const c = await api<{ clients: { type?: string; configured: boolean }[] }>("/connections");
    const kinds = new Set(c.clients.filter((x) => x.configured).map((x) => (/sab|nzb|usenet/i.test(x.type ?? "") ? "usenet" : "torrent")));
    if (kinds.size !== 1) return;
    const only = [...kinds][0] as "usenet" | "torrent";
    const p = await api<{ profiles: { id: string; protocolOrder: string[]; noProtocolPreference?: boolean }[]; defaultProfileId: string }>("/profiles");
    const def = p.profiles.find((x) => x.id === p.defaultProfileId) ?? p.profiles[0];
    if (!def || def.noProtocolPreference || def.protocolOrder[0] === only) return;
    await api(`/profiles/${def.id}`, { method: "PUT", body: { ...def, protocolOrder: [only, only === "usenet" ? "torrent" : "usenet"] } });
    toast(t(only === "torrent" ? "wiz.preferTorrent" : "wiz.preferUsenet"));
  } catch {
    /* a preference, not a step: never blocks Next */
  }
}

function AccountStep({ status, onChanged, onLater }: { status: Status; onChanged: () => void | Promise<void>; onLater: () => void }) {
  const toast = useToast();
  if (status.defaultPassword)
    return (
      <ChangeDefaultLogin
        onDone={() => {
          toast(t("security.changed"));
          void onChanged();
        }}
        onLater={onLater}
      />
    );
  return (
    <div className="card pad stack">
      <p>{status.defaultPassword ? t("wiz.account.default") : t("wiz.account.ok")}</p>
      <p className="muted small">{status.bypassLocal ? t("wiz.account.bypassOn") : t("wiz.account.bypassOff")}</p>
      <Link to="/settings?tab=security" className="button small self-start">
        {t("wiz.account.open")}
      </Link>
    </div>
  );
}

/** Folder browser over the container's mounts: pick the series and movie library folders. */
function FoldersStep({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  return (
    <div className="stack">
      <p className="banner slim small">{t("wiz.folders.docker")}</p>
      <div className="card pad">
        <LibraryFolders roots={s.allowedRoots} onAdd={(r) => saveNow((x) => ({ ...x, allowedRoots: [...new Set([...x.allowedRoots, r])] }))} onRemove={(r) => saveNow((x) => ({ ...x, allowedRoots: x.allowedRoots.filter((y) => y !== r) }))} />
      </div>
    </div>
  );
}

/** Download clients, with "create the animearr category" for SABnzbd/qBittorrent. */
function ClientsStep({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  const toast = useToast();
  const create = async (client: "sabnzbd" | "qbittorrent") => {
    try {
      const r = await api<{ category: string; existed?: boolean }>("/wizard/category", { body: { client } });
      toast(t(r.existed ? "wiz.cat.existed" : "wiz.cat.created", { cat: r.category }));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <DownloadClients s={s} saveNow={saveNow} wizard />
      <div className="row">
        {s.sabnzbd.url && <button onClick={() => void create("sabnzbd")}>{t("wiz.cat.sab", { cat: s.sabnzbd.category })}</button>}
        {s.qbittorrent.url && <button onClick={() => void create("qbittorrent")}>{t("wiz.cat.qbit", { cat: s.qbittorrent.category })}</button>}
      </div>
    </div>
  );
}

/** Indexers, with the starter picks for anime (AnimeTosho, Nyaa, SubsPlease) in one click. */
function IndexersStep({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  const toast = useToast();
  const [key, setKey] = useState(0);
  const starter = async () => {
    try {
      const cat = await api<{ entries: CatalogEntry[] }>("/catalog/indexers");
      const have = new Set(((await api<{ indexers: { catalogId: string | null }[] }>("/indexers")).indexers ?? []).map((x) => x.catalogId));
      let n = 0;
      for (const e of cat.entries.filter((x) => x.recommended && !x.needsKey && !have.has(x.id))) {
        await api("/indexers", { body: fromEntry(e) });
        n++;
      }
      toast(n ? t("wiz.starterAdded", { n }) : t("wiz.starterAlready"));
      setKey((k) => k + 1);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <div className="card pad row between">
        <span>
          <b>{t("wiz.starter")}</b>
          <br />
          <span className="muted small">{t("wiz.starterHelp")}</span>
        </span>
        <button className="primary" onClick={() => void starter()}>
          {t("wiz.starterAdd")}
        </button>
      </div>
      <Indexers key={key} s={s} saveNow={saveNow} />
    </div>
  );
}

interface Preview { sonarrError?: string; radarrError?: string; sonarr?: { animeSeries: number; roots: string[]; clients: { name: string; type: string; enabled: boolean; protocol: string; host: string | null; port: number | null; ssl?: boolean; urlBase?: string; category: string | null }[]; indexers: { name: string; type: string; protocol: string; viaProwlarr: boolean }[]; plex: boolean; tags: string[] }; radarr?: { animeMovies: number; roots: string[] } }

/** What Sonarr/Radarr have, with a checkbox per piece to take over. */
function PreviewStep({ onApplied }: { onApplied: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api<Preview>("/wizard/arr-preview"), []);
  const [roots, setRoots] = useState<Set<string>>(new Set());
  const [useClients, setUseClients] = useState(true);
  useEffect(() => {
    if (d.data) setRoots(new Set([...(d.data.sonarr?.roots ?? []), ...(d.data.radarr?.roots ?? [])].filter((r) => /anime/i.test(r))));
  }, [d.data]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const so = d.data.sonarr;
  const url = (c: { host: string | null; port: number | null; ssl?: boolean; urlBase?: string }) => (c.host ? `${c.ssl ? "https" : "http"}://${c.host}${c.port ? `:${c.port}` : ""}${c.urlBase ?? ""}` : "");
  const sab = so?.clients.find((c) => /sabnzbd/i.test(c.type) && c.enabled);
  const qb = so?.clients.find((c) => /qbittorrent/i.test(c.type) && c.enabled);
  // NZBGet, Transmission, Deluge, rTorrent: added with their address (passwords are entered afterwards).
  const others = (so?.clients ?? []).filter((c) => c.enabled && /^(nzbget|transmission|deluge|rtorrent)$/i.test(c.type) && url(c));
  return (
    <div className="stack">
      {(d.data.sonarrError || d.data.radarrError) && (
        <p className="error">
          {t("wiz.preview.error", { why: (d.data.sonarrError ?? d.data.radarrError)! })}
        </p>
      )}
      {!so && !d.data.radarr && !d.data.sonarrError && !d.data.radarrError && <p className="warn-text">{t("wiz.preview.none")}</p>}
      {so && (
        <div className="card pad stack">
          <h3>Sonarr</h3>
          <p>{t("wiz.preview.series", { n: so.animeSeries })}</p>
          <h4 className="eyebrow">{t("wiz.preview.roots")}</h4>
          {[...so.roots, ...(d.data.radarr?.roots ?? [])].map((r) => (
            <label key={r} className="check">
              <input type="checkbox" checked={roots.has(r)} onChange={(e) => setRoots((x) => (e.target.checked ? new Set([...x, r]) : new Set([...x].filter((y) => y !== r))))} /> <span className="mono">{r}</span>
            </label>
          ))}
          <h4 className="eyebrow">{t("wiz.preview.clients")}</h4>
          <ul className="plain small">
            {so.clients.map((c) => (
              <li key={c.name}>
                {/* "qBittorrent (torrents) at 192.168.1.10:8080", not "qBittorrent · QBittorrent · torrent". */}
                {t(c.protocol === "usenet" ? "wiz.preview.clientUsenet" : "wiz.preview.clientTorrent", { name: c.name })}
                {c.host && <span className="muted"> {t("wiz.preview.at", { addr: `${c.host}${c.port ? `:${c.port}` : ""}` })}</span>}
                {c.enabled ? "" : ` · ${t("clients.disabled")}`}
              </li>
            ))}
          </ul>
          {(sab || qb || others.length > 0) && (
            <label className="check">
              <input type="checkbox" checked={useClients} onChange={(e) => setUseClients(e.target.checked)} /> {t("wiz.preview.useClients")}
            </label>
          )}
          <h4 className="eyebrow">{t("wiz.preview.indexers")}</h4>
          <ul className="plain small">
            {so.indexers.map((i) => (
              <li key={i.name}>
                {i.name} · {i.protocol} {i.viaProwlarr ? `· ${t("conn.viaProwlarr")}` : ""}
              </li>
            ))}
          </ul>
          {so.indexers.some((i) => i.viaProwlarr) && <p className="muted small">{t("wiz.preview.prowlarrHint")}</p>}
          <p className="small">{so.plex ? t("wiz.preview.plexYes") : t("wiz.preview.plexNo")}</p>
        </div>
      )}
      {d.data.radarr && (
        <div className="card pad">
          <h3>Radarr</h3>
          <p>{t("wiz.preview.movies", { n: d.data.radarr.animeMovies })}</p>
        </div>
      )}
      <button
        className="primary self-start"
        onClick={async () => {
          try {
            await api("/wizard/arr-apply", { body: { roots: [...roots], sab: useClients && sab ? { url: url(sab), category: "animearr" } : null, qbit: useClients && qb ? { url: url(qb), category: "animearr" } : null, others: useClients ? others.map((c) => ({ type: c.type, name: c.name, url: url(c) })) : [] } });
            toast(t("wiz.preview.applied"));
            onApplied();
          } catch (e) {
            toast((e as Error).message, true);
          }
        }}
      >
        {t("wiz.preview.apply")}
      </button>
    </div>
  );
}

function ReviewStep({ status }: { status: Status }) {
  const toast = useToast();
  return (
    <div className="stack">
      <div className="card pad stack">
        <h3>{t("wiz.review.naming")}</h3>
        <p className="muted small">{t("wiz.review.namingHelp")}</p>
        <button
          className="self-start"
          onClick={async () => {
            try {
              await api("/media/import-defaults", { body: {} });
              toast(t("common.saved"));
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          {t("wiz.review.copyNaming")}
        </button>
      </div>
      <div className="card pad stack">
        <h3>{t("wiz.review.shows", { n: status.librarySeries ?? 0 })}</h3>
        <p className="muted small">{t("wiz.review.showsHelp")}</p>
        <Link to="/shows" className="button small self-start">
          {t("wiz.review.openLibrary")}
        </Link>
      </div>
      <div className="card pad stack">
        <h3>{t("wiz.review.movies")}</h3>
        <p className="muted small">{t("wiz.review.moviesHelp")}</p>
      </div>
    </div>
  );
}

function DoneStep({ path }: { path: Path }) {
  // Fresh statuses (a client that fails its check is said so here, not listed as set up).
  const o = useLoad(() => api<Overview>("/connections?fresh=1"), []);
  const toast = useToast();
  const failing = (o.data?.clients ?? []).filter((c) => c.configured && c.ok === false);
  const working = (o.data?.clients ?? []).filter((c) => c.configured && c.ok !== false);
  const media = (o.data?.mediaServers ?? []).filter((m) => m.configured);
  for (const c of failing) rememberDetail(t("wiz.done.clientFails", { name: c.name, why: c.error ?? "" }), c.errorDetail);
  return (
    <div className="stack">
      {o.data && !working.length && !failing.length && <p className="banner warn">{t("wiz.done.noClient")}</p>}
      {failing.map((c) => (
        <p key={c.name} className="banner warn">
          <ErrorText msg={t("wiz.done.clientFails", { name: c.name, why: c.error ?? "" })} />
        </p>
      ))}
      {o.data && !o.data.indexers.length && <p className="banner warn">{t("wiz.done.noIndexer")}</p>}
      <GoLive />
      {o.data && (
        <div className="card pad">
          <ul className="plain stack done-list">
            <li>
              {t("wiz.done.clients")}: {working.map((c) => c.name).join(", ") || "—"}
              {failing.length > 0 && <span className="warn-text"> · {t("wiz.done.notWorking", { names: failing.map((c) => c.name).join(", ") })}</span>}
            </li>
            <li>
              {t("wiz.done.indexers")}: {o.data.indexers.length}
            </li>
            <li>
              {t("wiz.done.media")}: {media.length ? media.map((m) => { const n = MEDIA_NAMES[(m as { key?: string }).key ?? "plex"] ?? "Plex"; return m.ok === false ? `${n} (${t("wiz.done.notWorkingShort")})` : n; }).join(", ") : "—"}
            </li>
          </ul>
        </div>
      )}
      <div className="row">
        <Link to="/find" className="button primary">
          {t("wiz.done.addShow")}
        </Link>
        {path === "new" && (
          <button
            onClick={async () => {
              try {
                await api("/files/scan", { body: {} });
                toast(t("wiz.done.scanning"));
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            {t("wiz.done.haveFiles")}
          </button>
        )}
      </div>
      <div className="card pad stack">
        <h3>{t("phone.settingsTitle")}</h3>
        <PhonePanel />
      </div>
      <p className="muted small">{t("wiz.done.later")}</p>
    </div>
  );
}

/** The last step: dry run (on by default) and the automatic searches, explained, with the switches right here. */
function GoLive() {
  const toast = useToast();
  const d = useLoad(() => api<{ managed: { dryRun: boolean }; backlog: { enabled: boolean }; movieSearch: { enabled: boolean } }>("/settings"), []);
  if (!d.data) return null;
  const put = async (body: unknown) => {
    try {
      await api("/settings", { method: "PUT", body });
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="card pad stack">
      <h3>{t("wiz.live.title")}</h3>
      <p className="muted small">{t("wiz.live.help")}</p>
      <Toggle checked={!d.data.managed.dryRun} onChange={(v) => void put({ managed: { dryRun: !v } })} label={t("wiz.live.real")} />
      <Toggle checked={d.data.backlog.enabled} onChange={(v) => void put({ backlog: { enabled: v } })} label={t("wiz.live.missing")} />
      <Toggle checked={d.data.movieSearch.enabled} onChange={(v) => void put({ movieSearch: { enabled: v } })} label={t("wiz.live.movies")} />
    </div>
  );
}
