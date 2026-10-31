import { useEffect, useState } from "react";
import { api, type Settings as S } from "./api";
import { t, type I18nKey } from "./i18n";
import type { LanguageProfile } from "./profiles";
import type { Tag } from "./rules";
import { ScopeFields } from "./scope";
import type { Scope } from "./scope";
import { Chip, Confirm, ErrorBox, Modal, NumberInput, relTime, SecretInput, Spinner, Toggle, useLoad, useToast } from "./ui";

type Status = "CURRENT" | "PLANNING" | "COMPLETED" | "PAUSED" | "DROPPED" | "REPEATING";
interface Item { anilistId: number; title: string; kind: "show" | "movie" }
interface ListResult { at?: number; total?: number; matched?: number; pending?: boolean; wouldAdd?: Item[]; added?: { anilistId: number; title: string; at: number }[]; skipped?: Record<string, number>; errors?: string[]; error?: string }
interface ImportList {
  id: number; name: string; source: "anilist" | "mal"; username: string; statuses: Status[]; profileId: string | null; rootFolder: string; movieRootFolder: string; scope: Scope | null; then: "none" | "queue";
  tags: number[]; enabled: boolean; confirmed: boolean; lastSyncAt: number | null; lastResult: ListResult;
}
interface Exclusion { anilistId: number; title: string; listName: string; at: number }
interface Loaded { lists: ImportList[]; exclusions: Exclusion[]; statuses: Status[]; intervalHours: number; maxAuto: number }
interface TestResult { total: number; matched: number; wouldAdd: number; skipped: Record<string, number>; items: (Item & { action: string; reason?: string; status: Status })[] }

const skippedText = (sk: Record<string, number> | undefined) =>
  Object.entries(sk ?? {})
    .map(([k, n]) => `${n} ${t(`lists.reason.${k}` as I18nKey)}`)
    .join(", ");

/** Settings → Import lists: AniList / MyAnimeList accounts that add shows by themselves (never remove). */
export function ImportLists({ s, upd }: { s: S; upd: (fn: (x: S) => S) => void }) {
  const toast = useToast();
  const d = useLoad(() => api<Loaded>("/import-lists"), []);
  const [edit, setEdit] = useState<ImportList | "new" | null>(null);
  const [review, setReview] = useState<ImportList | null>(null);
  const [del, setDel] = useState<ImportList | null>(null);
  const [busy, setBusy] = useState<number | "all" | null>(null);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const sync = async (l?: ImportList) => {
    setBusy(l?.id ?? "all");
    try {
      if (l) {
        const r = await api<{ preview: boolean; added: number; wouldAdd: number }>(`/import-lists/${l.id}/sync`, { body: {} });
        toast(r.preview ? t("lists.syncedPreview", { n: r.wouldAdd }) : r.added ? t("lists.synced", { n: r.added }) : t("lists.syncedNone"));
      } else {
        const r = await api<{ lists: { name: string; added: number; preview: boolean; error?: string }[] }>("/import-lists/sync", { body: {} });
        const bad = r.lists.find((x) => x.error);
        toast(bad ? `${bad.name}: ${bad.error}` : t("lists.synced", { n: r.lists.reduce((a, x) => a + x.added, 0) }), !!bad);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
      await d.reload();
    }
  };
  const lists = d.data.lists;
  return (
    <div className="stack">
      <p className="muted small">{t("lists.intro")}</p>
      <div className="card pad stack">
        <h2>{t("lists.settings")}</h2>
        <div className="form">
          <label>
            {t("lists.interval")}
            <NumberInput value={s.lists.intervalHours} min={1} max={168} label={t("lists.interval")} onChange={(v) => upd((x) => ({ ...x, lists: { ...x.lists, intervalHours: v } }))} />
          </label>
          <label className="field">
            {t("lists.malClient")}
            <SecretInput value={s.lists.malClientId} onChange={(v) => upd((x) => ({ ...x, lists: { ...x.lists, malClientId: v } }))} label={t("lists.malClient")} />
            <span className="muted small">{t("lists.malClientHelp")}</span>
          </label>
        </div>
      </div>
      <div className="card pad stack">
        {!lists.length && <p className="muted">{t("lists.none")}</p>}
        {lists.map((l) => (
          <ListRow key={l.id} l={l} busy={busy === l.id || busy === "all"} onSync={() => void sync(l)} onReview={() => setReview(l)} onEdit={() => setEdit(l)} onDelete={() => setDel(l)} />
        ))}
        <div className="row">
          <button className="primary" onClick={() => setEdit("new")}>
            + {t("lists.add")}
          </button>
          {lists.length > 1 && (
            <button disabled={busy !== null} onClick={() => void sync()}>
              {busy === "all" ? t("lists.syncing") : t("lists.syncAll")}
            </button>
          )}
        </div>
      </div>
      <Exclusions items={d.data.exclusions} onChanged={d.reload} />
      {edit && (
        <ListForm
          s={s}
          list={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            await d.reload();
          }}
        />
      )}
      {review && (
        <Review
          list={d.data.lists.find((x) => x.id === review.id) ?? review}
          onClose={() => setReview(null)}
          onChanged={async () => {
            await d.reload();
          }}
        />
      )}
      {del && (
        <Confirm
          danger
          title={t("lists.deleteTitle", { name: del.name })}
          confirmLabel={t("common.delete")}
          onClose={() => setDel(null)}
          onConfirm={async () => {
            try {
              await api(`/import-lists/${del.id}`, { method: "DELETE" });
              setDel(null);
              toast(t("lists.deleted"));
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("lists.deleteBody")}</p>
        </Confirm>
      )}
    </div>
  );
}

function ListRow({ l, busy, onSync, onReview, onEdit, onDelete }: { l: ImportList; busy: boolean; onSync: () => void; onReview: () => void; onEdit: () => void; onDelete: () => void }) {
  const r = l.lastResult;
  const pending = !l.confirmed && r.pending ? (r.wouldAdd?.length ?? 0) : 0;
  return (
    <div className="stack list-row">
      <div className="row between">
        <span className="row">
          <strong>{l.name}</strong>
          <Chip tone="info">{t(`lists.source.${l.source}` as I18nKey)}</Chip>
          {!l.enabled && <Chip tone="warn">{t("lists.disabled")}</Chip>}
        </span>
        <span className="row">
          <button className="small" disabled={busy} onClick={onSync}>
            {busy ? t("lists.syncing") : t("lists.syncNow")}
          </button>
          <button className="small ghost" onClick={onEdit}>
            {t("lists.edit")}
          </button>
          <button className="small ghost" onClick={onDelete}>
            {t("common.delete")}
          </button>
        </span>
      </div>
      <span className="muted small">
        {l.username} · {l.statuses.map((x) => t(`lists.status.${x}` as I18nKey)).join(", ")}
      </span>
      {!l.lastSyncAt && <span className="muted small">{t("lists.never")}</span>}
      {l.lastSyncAt && !r.error && (
        <span className="muted small">{t("lists.last", { when: relTime(l.lastSyncAt), matched: r.matched ?? 0, total: r.total ?? 0, added: r.added?.length ?? 0 })}</span>
      )}
      {r.error && <span className="small bad-text">{t("lists.failed", { error: r.error })}</span>}
      {!!r.errors?.length && <span className="small bad-text">{t("lists.problems", { list: r.errors.join("; ") })}</span>}
      {l.lastSyncAt && !l.confirmed && (
        <div className="row">
          <span className="small">{pending ? t("lists.pending", { n: pending }) : t("lists.pendingNone")}</span>
          {pending > 0 && (
            <button className="small primary" onClick={onReview}>
              {t("lists.review")}
            </button>
          )}
        </div>
      )}
      {!!r.added?.length && (
        <details>
          <summary className="small">{t("lists.recent")}</summary>
          <ul className="small">
            {r.added.slice(0, 10).map((a) => (
              <li key={`${a.anilistId}:${a.at}`}>
                {a.title} <span className="muted">· {relTime(a.at)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The first-sync preview: what would be added, with Exclude per item and one confirm. */
function Review({ list, onClose, onChanged }: { list: ImportList; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const items = list.lastResult.wouldAdd ?? [];
  const exclude = async (it: Item) => {
    try {
      await api("/import-lists/exclusions", { body: { anilistId: it.anilistId, title: it.title } });
      await api(`/import-lists/${list.id}/sync`, { body: {} }); // a fresh preview without it
      await onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title={t("lists.reviewTitle", { name: list.name })} onClose={onClose}>
      <div className="stack">
        <p className="muted small">{t("lists.reviewHelp")}</p>
        {!items.length && <p>{t("lists.reviewNone")}</p>}
        <ul className="stack">
          {items.map((it) => (
            <li key={it.anilistId} className="row between">
              <span>
                {it.title} {it.kind === "movie" && <Chip tone="accent">{t("lists.movie")}</Chip>}
              </span>
              <button className="small ghost" onClick={() => void exclude(it)}>
                {t("lists.exclude")}
              </button>
            </li>
          ))}
        </ul>
        {!!list.lastResult.skipped && !!Object.keys(list.lastResult.skipped).length && <p className="muted small">{t("lists.skipped", { list: skippedText(list.lastResult.skipped) })}</p>}
        <div className="row">
          <button
            className="primary"
            disabled={busy || !items.length}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ added: number; errors: string[] }>(`/import-lists/${list.id}/sync`, { body: { confirm: true } });
                toast(t("lists.synced", { n: r.added }), !!r.errors.length);
                await onChanged();
                onClose();
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t("lists.syncing") : t("lists.confirm", { n: items.length })}
          </button>
          <button onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </Modal>
  );
}

function ListForm({ s, list, onClose, onSaved }: { s: S; list: ImportList | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const profiles = useLoad(() => api<{ profiles: LanguageProfile[]; defaultProfileId: string }>("/profiles"), []);
  const tags = useLoad(() => api<{ tags: Tag[] }>("/tags"), []);
  const showRoots = s.allowedRoots.filter((r) => !/movies/i.test(r));
  const [f, setF] = useState<Omit<ImportList, "id" | "confirmed" | "lastSyncAt" | "lastResult">>(
    () =>
      list ?? {
        name: "", source: "anilist", username: "", statuses: ["CURRENT", "PLANNING"], profileId: null, rootFolder: showRoots[0] ?? s.allowedRoots[0] ?? "", movieRootFolder: "", scope: null, then: "none", tags: [], enabled: true,
      },
  );
  const [test, setTest] = useState<TestResult | "busy" | null>(null);
  useEffect(() => setTest(null), [f.source, f.username, f.statuses]);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const ready = !!f.username.trim() && !!f.statuses.length;
  return (
    <Modal title={list ? t("lists.editTitle") : t("lists.newTitle")} onClose={onClose}>
      <div className="stack">
        {!s.allowedRoots.length && <p className="small bad-text">{t("lists.needsFolder")}</p>}
        <div className="form">
          <label>
            {t("lists.source")}
            <select value={f.source} onChange={(e) => set({ source: e.target.value as "anilist" | "mal" })}>
              <option value="anilist">{t("lists.source.anilist")}</option>
              <option value="mal">{t("lists.source.mal")}</option>
            </select>
          </label>
          <label>
            {t("lists.username")}
            <input value={f.username} maxLength={60} onChange={(e) => set({ username: e.target.value })} />
            <span className="muted small">{t("lists.usernameHelp")}</span>
          </label>
          <label>
            {t("lists.name")}
            <input value={f.name} maxLength={60} placeholder={t("lists.namePlaceholder")} onChange={(e) => set({ name: e.target.value })} />
          </label>
        </div>
        <fieldset className="stack">
          <legend>{t("lists.statuses")}</legend>
          {(["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"] as Status[]).map((x) => (
            <Toggle key={x} checked={f.statuses.includes(x)} onChange={() => set({ statuses: toggle(f.statuses, x) })} label={t(`lists.status.${x}` as I18nKey)} />
          ))}
        </fieldset>
        <div className="form">
          <label>
            {t("lists.root")}
            <select value={f.rootFolder} onChange={(e) => set({ rootFolder: e.target.value })}>
              {s.allowedRoots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("lists.movieRoot")}
            <select value={f.movieRootFolder} onChange={(e) => set({ movieRootFolder: e.target.value })}>
              <option value="">{t("lists.movieRootAuto")}</option>
              {s.allowedRoots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("lists.profile")}
            <select value={f.profileId ?? ""} onChange={(e) => set({ profileId: e.target.value || null })}>
              <option value="">{t("lists.profileDefault")}</option>
              {(profiles.data?.profiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("lists.monitor")}
            <select value={f.scope ? "custom" : "default"} onChange={(e) => set({ scope: e.target.value === "custom" ? (s.scope.continuing as Scope) : null })}>
              <option value="default">{t("lists.monitorDefault")}</option>
              <option value="custom">{t("lists.monitorCustom")}</option>
            </select>
          </label>
        </div>
        {f.scope && <ScopeFields value={f.scope} onChange={(v) => set({ scope: v })} />}
        <div className="form">
          <label>
            {t("lists.then")}
            <select value={f.then} onChange={(e) => set({ then: e.target.value as "none" | "queue" })}>
              <option value="none">{t("lists.then.none")}</option>
              <option value="queue">{t("lists.then.queue")}</option>
            </select>
            <span className="muted small">{t("lists.thenHelp")}</span>
          </label>
        </div>
        {!!tags.data?.tags.length && (
          <fieldset className="stack">
            <legend>{t("lists.tags")}</legend>
            <span className="row wrap">
              {tags.data.tags.map((x) => (
                <button key={x.id} type="button" className={`small${f.tags.includes(x.id) ? " on" : ""}`} aria-pressed={f.tags.includes(x.id)} onClick={() => set({ tags: toggle(f.tags, x.id) })}>
                  {x.label}
                </button>
              ))}
            </span>
          </fieldset>
        )}
        <Toggle checked={f.enabled} onChange={(v) => set({ enabled: v })} label={t("lists.enabled")} />
        {test === "busy" && <Spinner label={t("lists.testing")} />}
        {test && test !== "busy" && (
          <div className="stack small">
            <strong>{t("lists.testResult", { total: test.total, matched: test.matched, add: test.wouldAdd })}</strong>
            {!!Object.keys(test.skipped).length && <span className="muted">{t("lists.skipped", { list: skippedText(test.skipped) })}</span>}
            <ul>
              {test.items
                .filter((x) => x.action === "add")
                .slice(0, 8)
                .map((x) => (
                  <li key={x.anilistId}>{x.title}</li>
                ))}
            </ul>
          </div>
        )}
        <div className="row">
          <button
            className="primary"
            disabled={!ready}
            onClick={async () => {
              try {
                await (list ? api(`/import-lists/${list.id}`, { method: "PUT", body: f }) : api("/import-lists", { body: f }));
                toast(t("common.saved"));
                await onSaved();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            {t("common.save")}
          </button>
          <button
            disabled={!ready || test === "busy"}
            onClick={async () => {
              setTest("busy");
              try {
                setTest(await api<TestResult>("/import-lists/test", { body: f }));
              } catch (e) {
                setTest(null);
                toast((e as Error).message, true);
              }
            }}
          >
            {t("lists.test")}
          </button>
          <button className="ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Exclusions({ items, onChanged }: { items: Exclusion[]; onChanged: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const id = Number(/(\d+)\/?[^\d]*$/.exec(text.trim())?.[1] ?? "");
  return (
    <div className="card pad stack">
      <h2>{t("lists.exclusions")}</h2>
      <p className="muted small">{t("lists.exclusionsHelp")}</p>
      {!items.length && <p className="muted">{t("lists.exclusionsNone")}</p>}
      {items.map((x) => (
        <div key={x.anilistId} className="row between">
          <span>
            {x.title || `AniList ${x.anilistId}`} <span className="muted small">· AniList {x.anilistId}</span>
          </span>
          <button
            className="small ghost"
            onClick={async () => {
              try {
                await api(`/import-lists/exclusions/${x.anilistId}`, { method: "DELETE" });
                onChanged();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            {t("lists.exclusionRemove")}
          </button>
        </div>
      ))}
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/import-lists/exclusions", { body: { anilistId: id } });
            setText("");
            onChanged();
          } catch (x) {
            toast((x as Error).message, true);
          }
        }}
      >
        <input className="grow" value={text} placeholder={t("lists.exclusionId")} aria-label={t("lists.exclusionId")} onChange={(e) => setText(e.target.value)} />
        <button disabled={!Number.isInteger(id) || id <= 0}>{t("lists.exclusionAdd")}</button>
      </form>
    </div>
  );
}
