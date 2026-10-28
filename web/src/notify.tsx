import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell as BellIcon } from "lucide-react";
import { FixButtons } from "./fixes";
import { api, type Settings as S } from "./api";
import { t, type I18nKey } from "./i18n";
import { relTime, SecretInput, Toggle, useToast } from "./ui";

interface BellItem { id: number; at: number; event: "grabbed" | "imported" | "failed" | "paused" | "indexer" | "setup"; title: string; body: string; summary?: string | null; read: boolean; resolved?: boolean; action?: boolean; fixes?: import("./api").Fix[] }
interface Bell { unread: number; needs?: number; items: BellItem[] }
const ICON = { grabbed: "⬇️", imported: "✅", failed: "⚠️", paused: "⏸️", indexer: "🔌", setup: "🛠️" } as const;

/** One notification: the plain summary first; the raw message (release names, hosts, paths) under Details. */
function BellRow({ n, onRead }: { n: BellItem; onRead: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const plain = n.summary || n.body;
  return (
    <li className={`stack bell-item${n.read ? "" : " unread"}`}>
      <span className="row bell-item-head">
        {!n.read && <span className="bell-dot" aria-label={t("bell.unread")} />}
        <span className="grow">
          <span aria-hidden="true">{ICON[n.event]}</span> <strong>{n.title || t(`bell.${n.event}` as I18nKey)}</strong> <span className="muted">· {relTime(n.at)}</span>
        </span>
        {!n.read && n.id > 0 && (
          <button className="icon bell-dismiss" aria-label={t("bell.markRead")} title={t("bell.markRead")} onClick={() => onRead(n.id)}>
            ✓
          </button>
        )}
      </span>
      <span className={n.summary ? undefined : "clamp2"}>{plain}</span>
      {n.resolved && <span className="muted small">{t("bell.resolved")}</span>}
      <FixButtons fixes={n.fixes} />
      {n.summary && n.summary !== n.body && (
        <>
          <button className="linklike small self-start" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"} {t("activity.detailsShort")}
          </button>
          {open && <span className="muted small why-text">{n.body}</span>}
        </>
      )}
    </li>
  );
}

/**
 * The in-app bell: "Needs action" and "Recent", newest first. Opening it doesn't mark anything read: items are read
 * when dismissed (✓), when their problem is settled, or with "Mark all read". A bottom sheet on phones.
 */
export function BellButton() {
  const [b, setB] = useState<Bell | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"needs" | "recent">("needs");
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; right: number }>({ top: 64, right: 16 });
  useEffect(() => {
    let alive = true;
    const load = () => api<Bell>("/notifications").then((x) => alive && setB(x), () => undefined);
    void load();
    const h = setInterval(load, 60_000);
    return () => ((alive = false), clearInterval(h));
  }, []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && (setOpen(false), btn.current?.focus());
    // A fix opens its own dialog (the import, a confirmation): the bell steps out of the way.
    const fix = () => setOpen(false);
    document.addEventListener("keydown", key);
    window.addEventListener("animearr:fix", fix);
    document.body.classList.add("bell-open");
    return () => {
      document.removeEventListener("keydown", key);
      window.removeEventListener("animearr:fix", fix);
      document.body.classList.remove("bell-open");
    };
  }, [open]);
  const read = async (body: { upToId?: number; ids?: number[] }) => {
    const x = await api<Bell>("/notifications/read", { body }).catch(() => null);
    if (x) setB(x);
  };
  const shown = b?.items.filter((n) => tab === "recent" || n.action) ?? [];
  const unreadShown = b?.items.some((n) => !n.read);
  return (
    <div className="bell" ref={ref}>
      <button
        ref={btn}
        className="icon-btn bell-btn"
        aria-label={t("bell.labelNeeds", { n: b?.needs ?? 0 })}
        aria-expanded={open}
        onClick={async () => {
          const opening = !open;
          // Placed under the button (portalled to <body>: the top bar's backdrop-filter would trap "fixed").
          const r = btn.current?.getBoundingClientRect();
          if (r) setAt({ top: Math.round(r.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
          setOpen(opening);
          if (!opening) return;
          const fresh = await api<Bell>("/notifications").catch(() => b);
          setB(fresh);
          setTab(fresh?.needs ? "needs" : "recent");
        }}
      >
        <BellIcon className="lucide" aria-hidden="true" />
        {/* Only what needs you counts on the badge. */}
        {b?.needs ? <span className="bell-count">{b.needs > 99 ? "99+" : b.needs}</span> : null}
      </button>
      {open &&
        createPortal(
        <>
          <div className="bell-back" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="bell-pop card pad stack" role="dialog" aria-modal="true" aria-label={t("bell.title")} style={{ top: at.top, right: at.right }}>
            <div className="row bell-head">
              <h2 className="grow">{t("bell.title")}</h2>
              {unreadShown && (
                // Setup problems (negative ids) aren't stored notifications: the newest stored one is the read point.
                <button className="small" onClick={() => { const newest = b?.items.find((i) => i.id > 0); if (newest) void read({ upToId: newest.id }); }}>
                  {t("bell.markAll")}
                </button>
              )}
              <button className="icon" aria-label={t("common.close")} onClick={() => (setOpen(false), btn.current?.focus())}>
                ✕
              </button>
            </div>
            <div className="tabs bell-tabs" role="tablist">
              <button role="tab" aria-selected={tab === "needs"} className={tab === "needs" ? "on" : ""} onClick={() => setTab("needs")}>
                {t("bell.needs", { n: b?.needs ?? 0 })}
              </button>
              <button role="tab" aria-selected={tab === "recent"} className={tab === "recent" ? "on" : ""} onClick={() => setTab("recent")}>
                {t("bell.recent")}
              </button>
            </div>
            {tab === "needs" && !b?.needs && <p className="muted small">{t("bell.allClear")}</p>}
            {tab === "recent" && !b?.items.length && <p className="muted small">{t("bell.none")}</p>}
            <ul className="rename-list small bell-list">
              {shown.map((n) => (
                <BellRow key={n.id} n={n} onRead={(id) => void read({ ids: [id] })} />
              ))}
            </ul>
            {shown.length > 3 && <p className="muted small bell-more">{t("bell.count", { n: shown.length })}</p>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** Settings → Connections: Discord / ntfy for grabbed, imported, failed and paused-by-limit. */
export function NotifyCard({ s, upd }: { s: S; upd: (fn: (x: S) => S) => void }) {
  const toast = useToast();
  const n = s.notify;
  const set = (patch: Partial<S["notify"]>) => upd((x) => ({ ...x, notify: { ...x.notify, ...patch } }));
  return (
    <div className="card pad stack">
      <div className="row between">
        <h2>{t("notify.title")}</h2>
        <button
          className="small"
          onClick={async () => {
            try {
              const r = await api<{ results: { channel: string; ok: boolean; why: string }[] }>("/notifications/test", { body: {} });
              toast(r.results.map((x) => `${x.channel}: ${x.why}`).join(" · "), r.results.some((x) => !x.ok));
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          {t("common.test")}
        </button>
      </div>
      <p className="muted small">{t("notify.help")}</p>
      <div className="form">
        <label className="field">
          {t("notify.discord")}
          <SecretInput value={n.discordWebhook} onChange={(v) => set({ discordWebhook: v })} label={t("notify.discord")} />
        </label>
        <label>
          {t("notify.ntfy")}
          <input value={n.ntfyUrl} onChange={(e) => set({ ntfyUrl: e.target.value })} placeholder="https://ntfy.sh/my-animearr" />
        </label>
        <label className="field">
          {t("notify.ntfyToken")}
          <SecretInput value={n.ntfyToken} onChange={(v) => set({ ntfyToken: v })} label={t("notify.ntfyToken")} />
        </label>
        {(["grabbed", "imported", "failed", "paused", "indexer"] as const).map((ev) => (
          <Toggle key={ev} checked={n.events[ev]} onChange={(v) => set({ events: { ...n.events, [ev]: v } })} label={t(`notify.ev.${ev}` as I18nKey)} />
        ))}
      </div>
      <p className="muted small">{t("notify.saveFirst")}</p>
    </div>
  );
}
