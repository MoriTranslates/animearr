import { useEffect, useState } from "react";
import { api, store, type PathMapping, type Settings as S, type Status } from "../api";
import { applyTheme, query } from "../App";
import { t } from "../i18n";
import { ProfilesEditor } from "../profiles";
import { Chip, Confirm, ErrorBox, ListInput, NumberInput, relTime, SecretInput, Spinner, Toggle, useLoad, usePageTitle, useToast } from "../ui";

type Tab = "connections" | "profile" | "safety" | "paths" | "security" | "system";
const TABS: Tab[] = ["connections", "profile", "safety", "paths", "security", "system"];

export function Settings({ status, onSaved }: { status: Status; onSaved: () => void }) {
  usePageTitle(t("settings.title"));
  const toast = useToast();
  const initial = query().get("tab") as Tab;
  const [tab, setTab] = useState<Tab>(TABS.includes(initial) ? initial : "connections");
  const loaded = useLoad(() => api<S>("/settings"), []);
  const [s, setS] = useState<S | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (loaded.data) setS(loaded.data);
  }, [loaded.data]);
  const upd = (fn: (x: S) => S) => {
    setS((x) => (x ? fn(structuredClone(x)) : x));
    setDirty(true);
  };
  async function save() {
    if (!s) return;
    try {
      const next = await api<S>("/settings", { method: "PUT", body: s });
      setS(next);
      setDirty(false);
      toast(t("common.saved"));
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  if (loaded.error) return <ErrorBox error={loaded.error} retry={loaded.reload} />;
  if (!s) return <Spinner label={t("app.loading")} />;
  return (
    <section>
      <h1>{t("settings.title")}</h1>
      <div className="tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => (setTab(x), history.replaceState(null, "", `/settings?tab=${x}`))}>
            {t(`settings.tab.${x}`)}
          </button>
        ))}
      </div>
      {tab === "connections" && <Connections s={s} upd={upd} />}
      {tab === "profile" && <ProfilesEditor />}
      {tab === "safety" && <Safety s={s} upd={upd} />}
      {tab === "paths" && <Paths s={s} upd={upd} />}
      {tab === "system" && <System status={status} />}
      {tab === "security" && <Security s={s} status={status} onChanged={onSaved} />}
      {tab !== "system" && tab !== "security" && tab !== "profile" && (
        <div className="sticky-actions">
          <button className="primary" disabled={!dirty} onClick={save}>
            {t("common.save")}
          </button>
        </div>
      )}
    </section>
  );
}

type Upd = (fn: (x: S) => S) => void;

const SERVICES = [
  { key: "sonarr", name: "Sonarr" },
  { key: "radarr", name: "Radarr" },
  { key: "prowlarr", name: "Prowlarr" },
  { key: "sabnzbd", name: "SABnzbd" },
  { key: "qbittorrent", name: "qBittorrent" },
] as const;

function Connections({ s, upd }: { s: S; upd: Upd }) {
  const toast = useToast();
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  async function test(key: (typeof SERVICES)[number]["key"], name: string) {
    const c = s[key] as Record<string, unknown>;
    try {
      const r = await api<{ version: string; categoryExists?: boolean }>(`/test/${key}`, { body: c });
      const text = t("settings.testOk", { app: name, version: r.version }) + (r.categoryExists === false ? ` — ${t("settings.categoryMissing", { cat: String(c.category), app: name })}` : "");
      setResults((x) => ({ ...x, [key]: { ok: r.categoryExists !== false, text } }));
    } catch (e) {
      setResults((x) => ({ ...x, [key]: { ok: false, text: (e as Error).message } }));
      toast((e as Error).message, true);
    }
  }
  return (
    <div className="stack">
      {SERVICES.map(({ key, name }) => {
        const c = s[key] as Record<string, string>;
        const set = (field: string, v: string) => upd((x) => ({ ...x, [key]: { ...(x[key] as object), [field]: v } }));
        return (
          <div key={key} className="card pad stack">
            <div className="row between">
              <h2>{name}</h2>
              <button className="small" onClick={() => test(key, name)}>
                {t("common.test")}
              </button>
            </div>
            <div className="form">
              <label>
                {t("settings.url")}
                <input value={c.url} onChange={(e) => set("url", e.target.value)} placeholder="http://192.168.1.10:8989" />
              </label>
              {key === "qbittorrent" ? (
                <>
                  <label>
                    {t("settings.username")}
                    <input value={c.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" />
                  </label>
                  <label className="field">
                    {t("settings.password")}
                    <SecretInput value={c.password} onChange={(v) => set("password", v)} label={t("settings.password")} />
                  </label>
                </>
              ) : (
                <label className="field">
                  {t("settings.apiKey")}
                  <SecretInput value={c.apiKey} onChange={(v) => set("apiKey", v)} label={`${name} ${t("settings.apiKey")}`} />
                </label>
              )}
              {(key === "sabnzbd" || key === "qbittorrent") && (
                <label>
                  {t("settings.category")}
                  <input value={c.category} onChange={(e) => set("category", e.target.value)} />
                </label>
              )}
              {key === "sonarr" && (
                <label>
                  {t("settings.animeTag")}
                  <input value={c.animeTag} onChange={(e) => set("animeTag", e.target.value)} />
                </label>
              )}
              {key === "radarr" && (
                <label>
                  {t("settings.animeRoots")}
                  <ListInput value={s.radarr.animeRoots} onChange={(v) => upd((x) => ({ ...x, radarr: { ...x.radarr, animeRoots: v } }))} label={t("settings.animeRoots")} placeholder="/media/Movies/Anime" />
                </label>
              )}
            </div>
            {results[key] && <p className={results[key].ok ? "good-text" : "warn-text"}>{results[key].text}</p>}
          </div>
        );
      })}
    </div>
  );
}

function Safety({ s, upd }: { s: S; upd: Upd }) {
  const roots = useLoad(() => api<{ roots: { path: string; freeSpace?: number }[]; suggested: string | null }>("/sonarr/rootfolders"), []);
  const m = s.managed;
  const setM = (fn: (x: S["managed"]) => S["managed"]) => upd((x) => ({ ...x, managed: fn(x.managed) }));
  return (
    <div className="stack">
      <div className="card pad stack">
        <Toggle checked={m.dryRun} onChange={(v) => setM((x) => ({ ...x, dryRun: v }))} label={t("settings.safety.dryRun")} help={t("settings.safety.dryRunHelp")} />
      </div>
      <div className="card pad stack">
        <h2>{t("settings.safety.roots")}</h2>
        <p className="muted small">{t("settings.safety.rootsHelp")}</p>
        {roots.error && <p className="warn-text">{roots.error}</p>}
        <div className="stack">
          {(roots.data?.roots ?? []).map((r) => (
            <label key={r.path} className="check">
              <input
                type="checkbox"
                checked={s.allowedRoots.includes(r.path)}
                onChange={(e) => upd((x) => ({ ...x, allowedRoots: e.target.checked ? [...x.allowedRoots, r.path] : x.allowedRoots.filter((y) => y !== r.path) }))}
              />
              <span className="mono">{r.path}</span>
              {roots.data?.suggested === r.path && <Chip tone="accent">{t("settings.safety.suggested")}</Chip>}
            </label>
          ))}
        </div>
      </div>
      <div className="card pad stack">
        <h2>{t("repair.title")}</h2>
        <p className="muted small">{t("repair.help")}</p>
        <div className="form">
          <label>
            {t("repair.mode")}
            <select value={s.repair.mode} onChange={(e) => upd((x) => ({ ...x, repair: { ...x.repair, mode: e.target.value as "off" | "log" | "auto" } }))}>
              <option value="off">{t("repair.mode.off")}</option>
              <option value="log">{t("repair.mode.log")}</option>
              <option value="auto">{t("repair.mode.auto")}</option>
            </select>
          </label>
          <label>
            {t("repair.maxPerDay")}
            <NumberInput value={s.repair.maxPerDay} min={1} max={100} onChange={(v) => upd((x) => ({ ...x, repair: { ...x.repair, maxPerDay: v } }))} label={t("repair.maxPerDay")} />
          </label>
        </div>
      </div>
      <div className="card pad form">
        <label>
          {t("settings.safety.delay")}
          <NumberInput value={m.searchDelayMin} min={0} max={1440} onChange={(v) => setM((x) => ({ ...x, searchDelayMin: v }))} label={t("settings.safety.delay")} />
        </label>
        <label>
          {t("settings.safety.backoff")}
          <ListInput value={m.backoffMin} onChange={(v) => setM((x) => ({ ...x, backoffMin: v.map(Number).filter((n) => n > 0) }))} label={t("settings.safety.backoff")} />
        </label>
        <label>
          {t("settings.safety.attempts")}
          <NumberInput value={m.maxAttempts} min={1} max={100} onChange={(v) => setM((x) => ({ ...x, maxAttempts: v }))} label={t("settings.safety.attempts")} />
        </label>
        <label>
          {t("settings.safety.rss")}
          <NumberInput value={m.rssMin} min={0} max={1440} onChange={(v) => setM((x) => ({ ...x, rssMin: v }))} label={t("settings.safety.rss")} />
        </label>
        <label>
          {t("settings.safety.confidence")}
          <NumberInput value={m.minConfidence} min={50} max={100} onChange={(v) => setM((x) => ({ ...x, minConfidence: v }))} label={t("settings.safety.confidence")} />
        </label>
      </div>
    </div>
  );
}

function MappingList({ value, onChange, title, help }: { value: PathMapping[]; onChange: (v: PathMapping[]) => void; title: string; help: string }) {
  return (
    <div className="card pad stack">
      <h2>{title}</h2>
      <p className="muted small">{help}</p>
      {value.map((m, i) => (
        <div key={i} className="row">
          <input className="grow" value={m.from} placeholder={t("settings.paths.from")} aria-label={t("settings.paths.from")} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
          <span aria-hidden="true">→</span>
          <input className="grow" value={m.to} placeholder={t("settings.paths.to")} aria-label={t("settings.paths.to")} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
          <button className="small ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            {t("common.delete")}
          </button>
        </div>
      ))}
      <button className="small self-start" onClick={() => onChange([...value, { from: "", to: "" }])}>
        {t("common.add")}
      </button>
    </div>
  );
}

function Paths({ s, upd }: { s: S; upd: Upd }) {
  return (
    <div className="stack">
      <MappingList value={s.localPathMappings} onChange={(v) => upd((x) => ({ ...x, localPathMappings: v }))} title={t("settings.paths.local")} help={t("settings.paths.localHelp")} />
      <MappingList value={s.remotePathMappings} onChange={(v) => upd((x) => ({ ...x, remotePathMappings: v }))} title={t("settings.paths.remote")} help={t("settings.paths.remoteHelp")} />
    </div>
  );
}

interface SystemInfo {
  version: string;
  jobs: { name: string; state: string; detail: string; finishedAt: number | null }[];
  metadata: { anidb: { count: number }; animeLists: { count: number } };
  aliasKeys: number;
  db: { corrupt: boolean; detail: string };
  backups: { name: string; kind: string; size: number; at: number }[];
  backupDir: string;
  memoryMb: number;
}

function System({ status }: { status: Status }) {
  const toast = useToast();
  const d = useLoad(() => api<SystemInfo>("/system"), []);
  const [restore, setRestore] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [theme, setTheme] = useState(store.get("theme", "dark"));
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const x = d.data;
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg);
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      {x.db.corrupt && <p className="banner warn">{t("settings.system.dbCorrupt", { detail: x.db.detail })}</p>}
      <div className="card pad stack">
        <h2>{t("settings.system.jobs")}</h2>
        <ul className="plain">
          {x.jobs.map((j) => (
            <li key={j.name}>
              <Chip tone={j.state === "error" ? "bad" : j.state === "running" ? "warn" : "good"}>{j.name}</Chip> <span className="small">{j.detail}</span> {j.finishedAt && <span className="muted small">· {relTime(j.finishedAt)}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="card pad stack">
        <h2>{t("settings.system.metadata")}</h2>
        <p className="small">
          AniDB {x.metadata.anidb.count} · Anime-Lists {x.metadata.animeLists.count} · {x.aliasKeys} alias keys · {x.memoryMb} MB
        </p>
        <button className="small self-start" onClick={() => act(() => api("/system/metadata", { body: {} }), t("common.saved"))}>
          {t("settings.system.refreshMeta")}
        </button>
      </div>
      <div className="card pad stack">
        <h2>{t("settings.system.backups")}</h2>
        <p className="muted small">{t("settings.system.backupHelp", { dir: x.backupDir })}</p>
        <button className="small self-start" onClick={() => act(() => api("/system/backup", { body: {} }), t("common.saved"))}>
          {t("settings.system.backupNow")}
        </button>
        <ul className="plain">
          {x.backups.map((b) => (
            <li key={b.name} className="row between">
              <span className="small">
                <Chip>{b.kind}</Chip> {new Date(b.at).toLocaleString()} · {Math.round(b.size / 1024)} KB
              </span>
              <button className="small ghost" onClick={() => setRestore(b.name)}>
                {t("settings.system.restore")}
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">{t("settings.system.rebuildHelp")}</p>
        <button className="small self-start" onClick={() => act(() => api("/system/cache/reset", { body: {} }), t("common.saved"))}>
          {t("settings.system.rebuildCache")}
        </button>
      </div>
      <div className="card pad stack">
        <label>
          {t("settings.system.theme")}
          <select
            value={theme}
            onChange={(e) => {
              setTheme(e.target.value);
              store.set("theme", e.target.value);
              applyTheme(e.target.value);
            }}
          >
            <option value="dark">{t("settings.system.dark")}</option>
            <option value="light">{t("settings.system.light")}</option>
          </select>
        </label>
        <p className="muted small">
          AnimeArr v{x.version} · {status.via}
        </p>
        <button
          className="self-start"
          onClick={async () => {
            await api("/auth/logout", { body: {} });
            location.href = "/";
          }}
        >
          {t("settings.system.logout")}
        </button>
      </div>
      {restore && (
        <Confirm
          danger
          title={t("settings.system.restore")}
          confirmLabel={t("settings.system.restore")}
          onClose={() => setRestore(null)}
          onConfirm={async () => {
            try {
              const r = await api<{ message: string }>("/system/restore", { body: { name: restore, password: pw } });
              toast(r.message);
              setRestore(null);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("settings.system.restoreConfirm", { name: restore })}</p>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label={t("login.password")} autoComplete="current-password" />
        </Confirm>
      )}
    </div>
  );
}


function Security({ s, status, onChanged }: { s: S; status: Status; onChanged: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [user, setUser] = useState(s.auth.username);
  const [bypass, setBypass] = useState(status.bypassLocal ?? s.auth.bypassLocal);
  async function change(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return toast(t("security.mismatch"), true);
    try {
      await api("/auth/account", { method: "PUT", body: { currentPassword: cur, username: user, password: pw } });
      setCur("");
      setPw("");
      setPw2("");
      toast(t("security.changed"));
      onChanged();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }
  async function setMode(on: boolean) {
    try {
      await api("/auth/mode", { method: "PUT", body: { bypassLocal: on } });
      setBypass(on);
      toast(on ? t("security.bypassOn") : t("security.bypassOff"));
      onChanged();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }
  return (
    <div className="stack">
      <form className="card pad stack" onSubmit={change}>
        <h2>{t("security.password")}</h2>
        <div className="form">
          <label>
            {t("security.username")}
            <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" />
          </label>
          <label>
            {t("security.current")}
            <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
          </label>
          <label>
            {t("security.new")}
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
          <label>
            {t("security.confirm")}
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
        </div>
        <button className="primary self-start">{t("common.save")}</button>
      </form>
      <div className="card pad stack">
        <label className="check">
          <input type="checkbox" checked={bypass} onChange={(e) => void setMode(e.target.checked)} /> {t("security.bypass")}
        </label>
        <p className="muted small">{t("security.bypassHelp")}</p>
      </div>
    </div>
  );
}
