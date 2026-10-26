import { useState, type ReactNode } from "react";
import { api, type Settings as S } from "./api";
import { navigate } from "./App";
import { t, type I18nKey } from "./i18n";
import { Confirm, ListInput, Modal, relTime, SecretInput, Spinner, useLoad, useToast } from "./ui";

/**
 * Settings → Indexers / Download clients / Media servers / Migration, Sonarr-style: one card per connection (what it
 * is, its role, a live status in words, what it's used for), a "+" card with the supported types, an edit dialog
 * with Test / Save / Delete. Usenet on the left, torrents on the right.
 */

export interface ConnStatus { key: string; configured: boolean; ok: boolean | null; version: string | null; error: string | null; grabs: number; lastGrabAt: number | null }
export interface IndexerRow { id: number; name: string; protocol: "usenet" | "torrent"; enabled: boolean; priority: number | null; source: "prowlarr"; grabs: number; failures: number; lastError: string | null }
export interface Overview { clients: ConnStatus[]; indexerSources: ConnStatus[]; indexers: IndexerRow[]; mediaServers: ConnStatus[]; migration: ConnStatus[]; protocolOrder: ("usenet" | "torrent")[] }

type Key = "sabnzbd" | "qbittorrent" | "prowlarr" | "plex" | "sonarr" | "radarr";
type Protocol = "usenet" | "torrent";

/** Every type the "+" pickers offer; `ready: false` ones arrive with multiple clients/indexers. */
const TYPES: { id: string; name: string; protocol: Protocol | "both" | "media" | "migration"; kind: "client" | "indexer" | "media" | "migration"; key?: Key; ready: boolean; logo: string }[] = [
  { id: "sabnzbd", name: "SABnzbd", protocol: "usenet", kind: "client", key: "sabnzbd", ready: true, logo: "SAB" },
  { id: "nzbget", name: "NZBGet", protocol: "usenet", kind: "client", ready: false, logo: "NZB" },
  { id: "qbittorrent", name: "qBittorrent", protocol: "torrent", kind: "client", key: "qbittorrent", ready: true, logo: "qB" },
  { id: "transmission", name: "Transmission", protocol: "torrent", kind: "client", ready: false, logo: "Tr" },
  { id: "deluge", name: "Deluge", protocol: "torrent", kind: "client", ready: false, logo: "De" },
  { id: "rtorrent", name: "rTorrent", protocol: "torrent", kind: "client", ready: false, logo: "rT" },
  { id: "prowlarr", name: "Prowlarr", protocol: "both", kind: "indexer", key: "prowlarr", ready: true, logo: "Pr" },
  { id: "newznab", name: "Newznab (custom)", protocol: "usenet", kind: "indexer", ready: false, logo: "NZ" },
  { id: "torznab", name: "Torznab (custom)", protocol: "torrent", kind: "indexer", ready: false, logo: "TZ" },
  { id: "plex", name: "Plex", protocol: "media", kind: "media", key: "plex", ready: true, logo: "Px" },
  { id: "jellyfin", name: "Jellyfin", protocol: "media", kind: "media", ready: false, logo: "Jf" },
  { id: "emby", name: "Emby", protocol: "media", kind: "media", ready: false, logo: "Em" },
  { id: "sonarr", name: "Sonarr", protocol: "migration", kind: "migration", key: "sonarr", ready: true, logo: "So" },
  { id: "radarr", name: "Radarr", protocol: "migration", kind: "migration", key: "radarr", ready: true, logo: "Ra" },
];
const NAME: Record<Key, string> = { sabnzbd: "SABnzbd", qbittorrent: "qBittorrent", prowlarr: "Prowlarr", plex: "Plex", sonarr: "Sonarr", radarr: "Radarr" };
const ROLE: Record<Key, I18nKey> = { sabnzbd: "conn.role.usenetClient", qbittorrent: "conn.role.torrentClient", prowlarr: "conn.role.prowlarr", plex: "conn.role.plex", sonarr: "conn.role.sonarr", radarr: "conn.role.radarr" };
const logoOf = (key: string) => TYPES.find((x) => x.id === key)?.logo ?? key.slice(0, 2);

export type SaveNow = (fn: (x: S) => S) => Promise<boolean>;

export function useOverview() {
  const o = useLoad(() => api<Overview>("/connections"), []);
  /** After a save/delete: skip the server's 20 s cache. */
  const fresh = () => api<Overview>("/connections?fresh=1").then((v) => o.setData(v), () => undefined);
  return { ...o, fresh };
}

/** The one-line explanation every section opens with. */
export function SectionIntro({ icon, text, children }: { icon: string; text: string; children?: ReactNode }) {
  return (
    <div className="section-intro">
      <span className="section-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="stack">
        <p>{text}</p>
        {children}
      </div>
    </div>
  );
}

/** Indexers → AnimeArr → Download client → AnimeArr imports → Library → Plex. */
export function HowItFits({ here }: { here: "indexers" | "clients" | "media" }) {
  const steps: [string, I18nKey, string | null][] = [
    ["⌕", "conn.flow.indexers", "indexers"],
    ["◆", "conn.flow.animearr", null],
    ["↓", "conn.flow.client", "clients"],
    ["⇢", "conn.flow.import", null],
    ["▦", "conn.flow.library", null],
    ["▶", "conn.flow.media", "media"],
  ];
  return (
    <details className="how-fits card pad">
      <summary className="small">{t("conn.flow.title")}</summary>
      <ol className="flow" aria-label={t("conn.flow.title")}>
        {steps.map(([icon, label, id]) => (
          <li key={label} className={id === here ? "here" : ""}>
            <span aria-hidden="true">{icon}</span> {t(label)}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Status dot + words: "Connected · v4.3.2", "Can't reach: …", "Not set up". */
export function StatusLine({ st, loading }: { st?: ConnStatus; loading?: boolean }) {
  if (loading && !st) return <span className="quiet-status"><span className="dot off" aria-hidden="true" />{t("conn.checking")}</span>;
  if (!st || !st.configured) return <span className="quiet-status"><span className="dot off" aria-hidden="true" />{t("conn.notSetUp")}</span>;
  if (st.ok === false) return <span className="quiet-status bad-text"><span className="dot bad" aria-hidden="true" />{t("conn.cantReach", { why: st.error ?? "" })}</span>;
  return <span className="quiet-status"><span className="dot good" aria-hidden="true" />{st.version ? t("conn.connectedV", { version: st.version }) : t("conn.connected")}</span>;
}

function ConnCard({ k, st, loading, extra, onEdit }: { k: Key; st?: ConnStatus; loading: boolean; extra?: ReactNode; onEdit: () => void }) {
  return (
    <button className="conn-card card" onClick={onEdit} aria-label={`${NAME[k]}: ${t("conn.edit")}`}>
      <span className="conn-logo" aria-hidden="true">
        {logoOf(k)}
      </span>
      <span className="conn-text">
        <span className="strong">{NAME[k]}</span>
        <span className="muted small">{t(ROLE[k])}</span>
        <StatusLine st={st} loading={loading} />
        {st && st.grabs > 0 && <span className="muted small">{t("conn.usedFor", { n: st.grabs, when: st.lastGrabAt ? relTime(st.lastGrabAt) : "—" })}</span>}
        {extra}
      </span>
    </button>
  );
}

function AddCard({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="conn-card add card" onClick={onClick}>
      <span className="conn-plus" aria-hidden="true">
        +
      </span>
      <span className="strong">{label}</span>
    </button>
  );
}

/** "+ Add": the supported types, with the ones still to come shown (and not clickable). */
function TypePicker({ title, types, configured, onPick, onClose }: { title: string; types: typeof TYPES; configured: (k?: Key) => boolean; onPick: (k: Key) => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <ul className="type-grid">
        {types.map((x) => {
          const already = x.key ? configured(x.key) : false;
          return (
            <li key={x.id}>
              <button className="type-card card" disabled={!x.ready || already} onClick={() => x.key && onPick(x.key)}>
                <span className="conn-logo" aria-hidden="true">
                  {x.logo}
                </span>
                <span className="strong">{x.name}</span>
                <span className="muted small">{already ? t("conn.already") : x.ready ? t(x.kind === "client" ? (x.protocol === "usenet" ? "conn.role.usenetClient" : "conn.role.torrentClient") : x.kind === "indexer" ? (x.id === "prowlarr" ? "conn.role.prowlarr" : x.protocol === "usenet" ? "conn.role.newznab" : "conn.role.torznab") : x.kind === "media" ? "conn.role.plex" : "conn.role.sonarr") : t("conn.soon")}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

/** Edit a connection: its fields on a draft, Test, Save, Delete (clears it). */
function EditConn({ k, s, saveNow, onClose, children }: { k: Key; s: S; saveNow: SaveNow; onClose: () => void; children?: (draft: S, set: (fn: (x: S) => S) => void) => ReactNode }) {
  const toast = useToast();
  const [draft, setDraft] = useState<S>(() => structuredClone(s));
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const set = (fn: (x: S) => S) => setDraft((x) => fn(structuredClone(x)));
  const c = (k === "plex" ? { url: draft.plex.url, apiKey: draft.plex.token } : draft[k]) as Record<string, unknown>;
  const field = (f: string, v: unknown) => set((x) => ({ ...x, [k]: { ...(x[k] as object), [f]: v } }));
  async function test() {
    setBusy(true);
    try {
      const r = await api<{ version: string; categoryExists?: boolean; name?: string }>(`/test/${k}`, { body: c });
      setRes({ ok: r.categoryExists !== false, text: t("settings.testOk", { app: NAME[k], version: r.version }) + (r.categoryExists === false ? ` · ${t("settings.categoryMissing", { cat: String(c.category), app: NAME[k] })}` : "") });
    } catch (e) {
      setRes({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    // Only this connection's section, on top of what's saved (never other unsaved edits on the page).
    const ok = await saveNow((b) => ({ ...b, [k]: draft[k] }));
    setBusy(false);
    if (ok) onClose();
  }
  const cleared = (x: S): S => {
    if (k === "plex") return { ...x, plex: { ...x.plex, url: "", token: "", enabled: false } };
    const cur = x[k] as Record<string, unknown>;
    return { ...x, [k]: { ...cur, url: "", ...("apiKey" in cur ? { apiKey: "" } : {}), ...("password" in cur ? { password: "" } : {}) } };
  };
  return (
    <Modal title={NAME[k]} onClose={onClose}>
      <p className="muted small">{t(ROLE[k])} · {t(`conn.help.${k}` as I18nKey)}</p>
      {children ? (
        children(draft, set)
      ) : (
        <div className="form">
          <label>
            {t("settings.url")}
            <input value={String(c.url ?? "")} onChange={(e) => field("url", e.target.value)} placeholder={k === "sabnzbd" ? "http://192.168.1.10:8080" : k === "qbittorrent" ? "http://192.168.1.10:8081" : k === "prowlarr" ? "http://192.168.1.10:9696" : "http://192.168.1.10:8989"} />
          </label>
          {k === "qbittorrent" ? (
            <>
              <label>
                {t("settings.username")}
                <input value={String(c.username ?? "")} onChange={(e) => field("username", e.target.value)} autoComplete="off" />
              </label>
              <label className="field">
                {t("settings.password")}
                <SecretInput value={String(c.password ?? "")} onChange={(v) => field("password", v)} label={t("settings.password")} />
              </label>
            </>
          ) : (
            <label className="field">
              {t("settings.apiKey")}
              <SecretInput value={String(c.apiKey ?? "")} onChange={(v) => field("apiKey", v)} label={`${NAME[k]} ${t("settings.apiKey")}`} />
            </label>
          )}
          {(k === "sabnzbd" || k === "qbittorrent") && (
            <label>
              {t("settings.category")}
              <input value={String(c.category ?? "")} onChange={(e) => field("category", e.target.value)} />
              <span className="muted small">{t("conn.categoryHelp")}</span>
            </label>
          )}
          {k === "sonarr" && (
            <label>
              {t("settings.animeTag")}
              <input value={String(c.animeTag ?? "")} onChange={(e) => field("animeTag", e.target.value)} />
            </label>
          )}
          {k === "radarr" && (
            <label>
              {t("settings.animeRoots")}
              <ListInput value={draft.radarr.animeRoots} onChange={(v) => set((x) => ({ ...x, radarr: { ...x.radarr, animeRoots: v } }))} label={t("settings.animeRoots")} placeholder="/media/Movies/Anime" />
            </label>
          )}
        </div>
      )}
      {res && <p className={`small ${res.ok ? "good-text" : "warn-text"}`}>{res.text}</p>}
      <div className="row between">
        <button className="danger" onClick={() => setDel(true)} disabled={busy}>
          {t("common.delete")}
        </button>
        <div className="row">
          <button onClick={() => void test()} disabled={busy}>
            {t("common.test")}
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {t("common.save")}
          </button>
        </div>
      </div>
      {del && (
        <Confirm
          danger
          title={t("conn.deleteTitle", { name: NAME[k] })}
          confirmLabel={t("common.delete")}
          onClose={() => setDel(false)}
          onConfirm={async () => {
            if (await saveNow(cleared)) {
              toast(t("conn.deleted", { name: NAME[k] }));
              onClose();
            }
          }}
        >
          <p>{t(`conn.deleteBody.${k === "plex" ? "plex" : k === "sonarr" || k === "radarr" ? "migration" : "other"}` as I18nKey)}</p>
        </Confirm>
      )}
    </Modal>
  );
}

const statusOf = (list: ConnStatus[] | undefined, k: Key) => list?.find((x) => x.key === k);

/** "Usenet is tried first" (the default profile's order), linked to where it's chosen. */
function ProtocolOrder({ order }: { order?: Protocol[] }) {
  const first = order?.[0] ?? "usenet";
  return (
    <p className="small protocol-order">
      {t(first === "usenet" ? "conn.order.usenet" : "conn.order.torrent")}{" "}
      <button className="linklike" onClick={() => navigate("/settings?tab=profile")}>
        {t("conn.order.change")}
      </button>
    </p>
  );
}

function Column({ protocol, title, summary, children }: { protocol: Protocol; title: string; summary: string; children: ReactNode }) {
  return (
    <section className="proto-col" aria-label={title}>
      <header className="proto-head">
        <span className="proto-icon" aria-hidden="true">
          {protocol === "usenet" ? "✉" : "⇅"}
        </span>
        <h2>{title}</h2>
        <span className="muted small">{summary}</span>
      </header>
      <div className="conn-grid">{children}</div>
    </section>
  );
}

export function DownloadClients({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  const o = useOverview();
  const [edit, setEdit] = useState<Key | null>(null);
  const [pick, setPick] = useState<Protocol | null>(null);
  const st = (k: Key) => statusOf(o.data?.clients, k);
  const configured = (k?: Key) => !!k && !!st(k)?.configured;
  const col = (p: Protocol, keys: Key[]) => {
    const list = keys.filter((k) => configured(k) || (!o.data && k));
    const failing = list.filter((k) => st(k)?.ok === false).length;
    return (
      <Column protocol={p} title={t(p === "usenet" ? "conn.col.usenetClients" : "conn.col.torrentClients")} summary={o.data ? `${t("conn.count", { n: keys.filter(configured).length })}${failing ? ` · ${t("conn.failing", { n: failing })}` : ""}` : ""}>
        {keys.filter(configured).map((k) => (
          <ConnCard key={k} k={k} st={st(k)} loading={o.loading} onEdit={() => setEdit(k)} />
        ))}
        <AddCard label={t(p === "usenet" ? "conn.add.usenetClient" : "conn.add.torrentClient")} onClick={() => setPick(p)} />
      </Column>
    );
  };
  return (
    <div className="stack">
      <SectionIntro icon="↓" text={t("conn.intro.clients")}>
        <ProtocolOrder order={o.data?.protocolOrder} />
      </SectionIntro>
      <HowItFits here="clients" />
      {o.loading && !o.data && <Spinner label={t("conn.checking")} />}
      <div className="proto-cols">
        {col("usenet", ["sabnzbd"])}
        {col("torrent", ["qbittorrent"])}
      </div>
      {pick && <TypePicker title={t(pick === "usenet" ? "conn.add.usenetClient" : "conn.add.torrentClient")} types={TYPES.filter((x) => x.kind === "client" && x.protocol === pick)} configured={configured} onPick={(k) => (setPick(null), setEdit(k))} onClose={() => setPick(null)} />}
      {edit && <EditConn k={edit} s={s} saveNow={async (fn) => { const ok = await saveNow(fn); if (ok) void o.fresh(); return ok; }} onClose={() => setEdit(null)} />}
    </div>
  );
}

export function Indexers({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  const o = useOverview();
  const [edit, setEdit] = useState<Key | null>(null);
  const [pick, setPick] = useState<Protocol | null>(null);
  const prow = statusOf(o.data?.indexerSources, "prowlarr");
  const configured = (k?: Key) => k === "prowlarr" && !!prow?.configured;
  const col = (p: Protocol) => {
    const list = (o.data?.indexers ?? []).filter((x) => x.protocol === p);
    const failing = list.filter((x) => x.failures > 0).length;
    return (
      <Column protocol={p} title={t(p === "usenet" ? "conn.col.usenetIndexers" : "conn.col.torrentIndexers")} summary={o.data ? `${t("conn.indexerCount", { n: list.length })}${failing ? ` · ${t("conn.failing", { n: failing })}` : ""}` : ""}>
        {list.map((x) => (
          <div key={x.id} className={`conn-card card indexer${x.enabled ? "" : " off"}`}>
            <span className="conn-logo" aria-hidden="true">
              {x.name.slice(0, 2)}
            </span>
            <span className="conn-text">
              <span className="strong">{x.name}</span>
              <span className="muted small">
                {t(p === "usenet" ? "conn.proto.usenet" : "conn.proto.torrent")} · {t("conn.viaProwlarr")}
                {x.priority !== null ? ` · ${t("conn.priority", { n: x.priority })}` : ""}
              </span>
              {!x.enabled ? (
                <span className="quiet-status"><span className="dot off" aria-hidden="true" />{t("conn.disabled")}</span>
              ) : x.failures ? (
                <span className="quiet-status warn-text" title={x.lastError ?? undefined}><span className="dot warn" aria-hidden="true" />{t("conn.failures", { n: x.failures, why: x.lastError ?? "" })}</span>
              ) : (
                <span className="quiet-status"><span className="dot good" aria-hidden="true" />{t("conn.healthy")}</span>
              )}
              {x.grabs > 0 && <span className="muted small">{t("conn.usedForShort", { n: x.grabs })}</span>}
            </span>
          </div>
        ))}
        {o.data && !list.length && prow?.configured && <p className="muted small">{t("conn.noneOfProto")}</p>}
        <AddCard label={t(p === "usenet" ? "conn.add.usenetIndexer" : "conn.add.torrentIndexer")} onClick={() => setPick(p)} />
      </Column>
    );
  };
  return (
    <div className="stack">
      <SectionIntro icon="⌕" text={t("conn.intro.indexers")}>
        <ProtocolOrder order={o.data?.protocolOrder} />
      </SectionIntro>
      <HowItFits here="indexers" />
      <h2 className="eyebrow">{t("conn.managers")}</h2>
      <div className="conn-grid managers">
        {prow?.configured || !o.data ? (
          <div className="stack">
            <ConnCard k="prowlarr" st={prow} loading={o.loading} onEdit={() => setEdit("prowlarr")} extra={prow?.configured ? <span className="muted small">{t("conn.prowlarrSync")}</span> : null} />
            {prow?.configured && (
              <div className="row small">
                <button className="small" onClick={() => void o.fresh()}>
                  ↻ {t("conn.syncNow")}
                </button>
                {s.prowlarr.url && (
                  <a href={s.prowlarr.url} target="_blank" rel="noreferrer">
                    {t("conn.openProwlarr")} ↗
                  </a>
                )}
              </div>
            )}
          </div>
        ) : (
          <button className="conn-card card suggest" onClick={() => setEdit("prowlarr")}>
            <span className="conn-logo" aria-hidden="true">Pr</span>
            <span className="conn-text">
              <span className="strong">Prowlarr</span>
              <span className="muted small">{t("conn.suggest.prowlarr")}</span>
            </span>
          </button>
        )}
        <div className="conn-card card suggest disabled" aria-disabled="true">
          <span className="conn-logo" aria-hidden="true">Ja</span>
          <span className="conn-text">
            <span className="strong">Jackett</span>
            <span className="muted small">{t("conn.suggest.jackett")}</span>
            <span className="muted small">{t("conn.soon")}</span>
          </span>
        </div>
        <div className="conn-card card suggest disabled" aria-disabled="true">
          <span className="conn-logo" aria-hidden="true">?</span>
          <span className="conn-text">
            <span className="strong">{t("conn.suggest.noneTitle")}</span>
            <span className="muted small">{t("conn.suggest.none")}</span>
            <span className="muted small">{t("conn.soon")}</span>
          </span>
        </div>
      </div>
      <div className="proto-cols">
        {col("usenet")}
        {col("torrent")}
      </div>
      {pick && <TypePicker title={t(pick === "usenet" ? "conn.add.usenetIndexer" : "conn.add.torrentIndexer")} types={TYPES.filter((x) => x.kind === "indexer" && (x.protocol === pick || x.protocol === "both"))} configured={configured} onPick={(k) => (setPick(null), setEdit(k))} onClose={() => setPick(null)} />}
      {edit && <EditConn k={edit} s={s} saveNow={async (fn) => { const ok = await saveNow(fn); if (ok) void o.fresh(); return ok; }} onClose={() => setEdit(null)} />}
    </div>
  );
}

export function MediaServers({ s, saveNow, plexForm }: { s: S; saveNow: SaveNow; plexForm: (draft: S, set: (fn: (x: S) => S) => void) => ReactNode }) {
  const o = useOverview();
  const [edit, setEdit] = useState(false);
  const [pick, setPick] = useState(false);
  const plex = statusOf(o.data?.mediaServers, "plex");
  return (
    <div className="stack">
      <SectionIntro icon="▶" text={t("conn.intro.media")} />
      <HowItFits here="media" />
      <div className="conn-grid">
        {(plex?.configured || !o.data) && <ConnCard k="plex" st={plex} loading={o.loading} onEdit={() => setEdit(true)} extra={<span className="muted small">{s.plex.enabled ? t("conn.plexOn") : t("conn.plexOff")}</span>} />}
        <AddCard label={t("conn.add.media")} onClick={() => setPick(true)} />
      </div>
      {pick && <TypePicker title={t("conn.add.media")} types={TYPES.filter((x) => x.kind === "media")} configured={(k) => k === "plex" && !!plex?.configured} onPick={() => (setPick(false), setEdit(true))} onClose={() => setPick(false)} />}
      {edit && (
        <EditConn k="plex" s={s} saveNow={async (fn) => { const ok = await saveNow(fn); if (ok) void o.fresh(); return ok; }} onClose={() => setEdit(false)}>
          {plexForm}
        </EditConn>
      )}
    </div>
  );
}

export function Migration({ s, saveNow, children }: { s: S; saveNow: SaveNow; children?: ReactNode }) {
  const o = useOverview();
  const [edit, setEdit] = useState<Key | null>(null);
  return (
    <div className="stack">
      <SectionIntro icon="⇄" text={t("conn.intro.migration")} />
      <div className="conn-grid">
        {(["sonarr", "radarr"] as Key[]).map((k) => {
          const st = statusOf(o.data?.migration, k);
          return st?.configured || !o.data ? <ConnCard key={k} k={k} st={st} loading={o.loading} onEdit={() => setEdit(k)} /> : <AddCard key={k} label={t("conn.connect", { name: NAME[k] })} onClick={() => setEdit(k)} />;
        })}
      </div>
      {children}
      {edit && <EditConn k={edit} s={s} saveNow={async (fn) => { const ok = await saveNow(fn); if (ok) void o.fresh(); return ok; }} onClose={() => setEdit(null)} />}
    </div>
  );
}
