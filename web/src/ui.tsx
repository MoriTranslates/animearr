import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SheepShip } from "./merry";
import { Zap } from "lucide-react";
import { fixesForMessage, runFix, type Flag, BASE } from "./api";
import { t, type I18nKey } from "./i18n";
import { exclaimMode } from "./appearance";

// ---------------------------------------------------------------- toasts (manga speech bubbles by default)

/** What a toast is about: picks its manga exclamation (KITA━! for a new episode, SUGOI!/YATTA! for a grab…). */
export type ToastKind = "success" | "grab" | "import" | "new-episode" | "complete" | "download" | "error";
export interface ToastOpts { kind?: ToastKind; burst?: "always" | "never"; cover?: string | null }
interface Toast { id: number; msg: string; error: boolean; action?: { label: string; run: () => void }; burst: { text: string; jp: string } | null; kind: ToastKind; cover: string | null }
type Push = (msg: string, error?: boolean, action?: Toast["action"], opts?: ToastOpts) => void;
const ToastCtx = createContext<Push>(() => undefined);
export const useToast = () => useContext(ToastCtx);

const BURSTS: Record<ToastKind, I18nKey[]> = {
  "new-episode": ["exclaim.kita"],
  grab: ["exclaim.sugoi", "exclaim.yatta"],
  import: ["exclaim.yatta", "exclaim.sugoi"],
  success: ["exclaim.sugoi", "exclaim.yatta", "exclaim.nice"],
  complete: ["exclaim.omedetou"],
  download: ["exclaim.doki"],
  error: ["exclaim.nani"],
};
/** Default ≈ 1 in 5 toasts; big moments (a completed season) always; Comic mode every toast; or off. */
function pickBurst(kind: ToastKind, opts?: ToastOpts) {
  const mode = exclaimMode();
  if (opts?.burst === "never" || mode === "off") return null;
  const show = opts?.burst === "always" || mode === "always" || kind === "complete" || Math.random() < 0.2;
  if (!show) return null;
  const list = BURSTS[kind];
  const key = list[Math.floor(Math.random() * list.length)];
  return { text: t(key), jp: t(`${key}.jp` as I18nKey) };
}
const EMOTE: Record<ToastKind, string> = { success: "✨", grab: "✨", import: "✨", "new-episode": "✨", complete: "🎉", download: "💨", error: "💢" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Each toast's timer pauses while it's hovered or focused (time to read it, or reach its button).
  const timers = useRef(new Map<number, { left: number; started: number; handle: ReturnType<typeof setTimeout> | null }>());
  const drop = useCallback((id: number) => {
    timers.current.delete(id);
    setToasts((x) => x.filter((y) => y.id !== id));
  }, []);
  const startTimer = useCallback(
    (id: number, ms: number) => {
      const t0 = { left: ms, started: Date.now(), handle: setTimeout(() => drop(id), ms) };
      timers.current.set(id, t0);
    },
    [drop],
  );
  const pause = (id: number) => {
    const tm = timers.current.get(id);
    if (!tm?.handle) return;
    clearTimeout(tm.handle);
    tm.left -= Date.now() - tm.started;
    tm.handle = null;
  };
  const resume = (id: number) => {
    const tm = timers.current.get(id);
    if (!tm || tm.handle) return;
    tm.started = Date.now();
    tm.handle = setTimeout(() => drop(id), Math.max(1500, tm.left));
  };
  const push = useCallback<Push>((msg, error = false, action, opts) => {
    // An error the server attached a fix to gets that fix as its button.
    if (error && !action) {
      const f = fixesForMessage(msg)?.[0];
      if (f) action = { label: f.label, run: () => runFix(f) };
    }
    const kind: ToastKind = error ? "error" : (opts?.kind ?? "success");
    const id = Date.now() + Math.random();
    const burst = pickBurst(kind, opts);
    setToasts((x) => [...x.filter((y) => !(y.error && error && y.msg === msg)).slice(-2), { id, msg, error, action, kind, burst, cover: opts?.cover ?? null }]);
    startTimer(id, error ? 12_000 : action ? 15_000 : 5000);
  }, [startTimer]);
  const close = (id: number) => {
    const tm = timers.current.get(id);
    if (tm?.handle) clearTimeout(tm.handle);
    drop(id);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="sr-only" role="alert">
        {toasts.filter((x) => x.error).map((x) => x.msg).join(". ")}
      </div>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast${x.error ? " err" : ""}${x.burst ? " has-burst" : ""}`} aria-hidden={x.error || undefined} onMouseEnter={() => pause(x.id)} onMouseLeave={() => resume(x.id)} onFocus={() => pause(x.id)} onBlur={() => resume(x.id)}>
            {x.burst && (
              <span className={`burst ${x.kind}`} aria-hidden="true" lang="ja">
                <b>{x.burst.text}</b>
                <small>{x.burst.jp}</small>
              </span>
            )}
            {x.kind === "complete" && <SheepShip size={56} className="sail-by" />}
            {x.kind === "complete" && (
              <span className="momiji" aria-hidden="true">
                <i>🍁</i>
                <i>🍁</i>
                <i>🍁</i>
              </span>
            )}
            {x.cover && <img className="toast-cover" src={thumbUrl(x.cover, "sm")} alt="" width={34} height={50} />}
            <span className="toast-emote" aria-hidden="true">
              {EMOTE[x.kind]}
            </span>
            <span className="toast-msg">{x.msg}</span>
            {x.action && (
              <button className="primary" onClick={() => (x.action!.run(), close(x.id))}>
                {x.action.label}
              </button>
            )}
            <button className="icon" aria-label={t("common.close")} onClick={() => close(x.id)}>
              ✕
            </button>
            <svg className="toast-tail" viewBox="0 0 30 22" aria-hidden="true">
              <path d="M2 0 C 8 10, 14 16, 28 21 C 20 12, 18 6, 18 0" />
            </svg>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- dialogs

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, select, input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), select, input:not([disabled]), a[href]")];
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, []);
  // Portalled to <body>: a dialog opened from the top bar (backdrop-filter makes it the containing block for "fixed")
  // would otherwise be centred on the bar and pushed off the top of the screen.
  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="icon" aria-label={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation dialog with a primary action. */
export function Confirm({ title, children, confirmLabel, onConfirm, onClose, danger }: { title: string; children: ReactNode; confirmLabel: string; onConfirm: () => Promise<void> | void; onClose: () => void; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">{children}</div>
      <div className="row end">
        <button onClick={onClose}>{t("common.cancel")}</button>
        <button
          className={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("common.working") : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="banner error-box" role="alert">
      <p>{t("common.error", { error })}</p>
      {retry && <button onClick={retry}>{t("app.retry")}</button>}
    </div>
  );
}

/** An empty state: one sentence and (ideally) one action, never a dashed box alone. */
export function Empty({ children, title, icon, action }: { children?: ReactNode; title?: string; icon?: string; action?: { label: string; run: () => void } | ReactNode }) {
  return (
    <div className="empty">
      {icon && (
        <span className="empty-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {title && <p className="empty-title">{title}</p>}
      {/* A speech bubble with a quiet "shizuka~" (just a little character on an empty page). */}
      {children && (
        <p className="empty-bubble">
          {children}
          <span className="empty-jp jp" lang="ja" aria-hidden="true">
            静か～
          </span>
        </p>
      )}
      {action && typeof action === "object" && "run" in (action as object) ? (
        <button className="small" onClick={(action as { run: () => void }).run}>
          {(action as { label: string }).label}
        </button>
      ) : (
        (action as ReactNode)
      )}
    </div>
  );
}

// ---------------------------------------------------------------- overflow menu (⋯) and split button

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hidden?: boolean }

/** A ⋯ menu: the less-used actions of a page/row live here instead of a wall of buttons. Arrow keys, Escape, outside click. */
export function Menu({ items, label, trigger = "⋯", className = "", align = "right", up = false }: { items: MenuItem[]; label?: string; trigger?: ReactNode; className?: string; align?: "left" | "right"; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const shown = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const first = wrap.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])");
    first?.focus();
    const onDown = (e: MouseEvent | TouchEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);
  if (!shown.length) return null;
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setOpen(false), btn.current?.focus());
    else if (e.key === "ArrowDown") (e.preventDefault(), list[(i + 1) % list.length]?.focus());
    else if (e.key === "ArrowUp") (e.preventDefault(), list[(i - 1 + list.length) % list.length]?.focus());
    else if (e.key === "Home") (e.preventDefault(), list[0]?.focus());
    else if (e.key === "End") (e.preventDefault(), list[list.length - 1]?.focus());
    else if (e.key === "Tab") setOpen(false);
  };
  return (
    <span className={`menu ${className}`} ref={wrap} onKeyDown={onKey}>
      <button
        ref={btn}
        type="button"
        className="icon menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ?? t("common.moreActions")}
        onClick={(e) => (e.preventDefault(), e.stopPropagation(), setOpen(!open))}
      >
        {trigger}
      </button>
      {open && (
        <ul className={`menu-pop card ${align}${up ? " up" : ""}`} role="menu" aria-label={label ?? t("common.moreActions")}>
          {shown.map((i, n) => (
            <li key={`${n}-${i.label}`} role="none">
              <button
                type="button"
                role="menuitem"
                className={`menu-item${i.danger ? " danger-text" : ""}`}
                disabled={i.disabled}
                onClick={(e) => (e.preventDefault(), e.stopPropagation(), setOpen(false), btn.current?.focus(), i.onSelect())}
              >
                {i.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/**
 * One "Find" control everywhere: the main button finds automatically; the caret holds "Choose release…" and the
 * rest (re-grab, delete…), so pages don't repeat Search / Interactive / Re-grab side by side.
 */
export function SplitButton({ label, onClick, items, disabled, primary = true, small = false, menuLabel, up = false }: { label: ReactNode; onClick: () => void; items: MenuItem[]; disabled?: boolean; primary?: boolean; small?: boolean; menuLabel?: string; up?: boolean }) {
  return (
    <span className={`split${primary ? " primary" : ""}${small ? " small" : ""}`}>
      <button type="button" className={`${primary ? "primary" : ""}${small ? " small" : ""}`} disabled={disabled} onClick={onClick}>
        {typeof label === "string" && label.startsWith("⚡ ") ? (
          <>
            <Zap className="lucide" aria-hidden="true" />
            {label.slice(2)}
          </>
        ) : (
          label
        )}
      </button>
      <Menu items={items} trigger="▾" label={menuLabel ?? t("common.moreOptions")} up={up} />
    </span>
  );
}

// ---------------------------------------------------------------- inputs

export function SecretInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="secret">
      <input type={show ? "text" : "password"} value={value} placeholder={placeholder} aria-label={label} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="ghost small" onClick={() => setShow(!show)} aria-pressed={show} aria-label={label}>
        {show ? "🙈" : "👁"}
      </button>
    </span>
  );
}

/** Comma-separated list input that keeps what you type and only splits when you leave the field. */
export function ListInput({ value, onChange, placeholder, label }: { value: (string | number)[]; onChange: (v: string[]) => void; placeholder?: string; label: string }) {
  const [text, setText] = useState(value.join(", "));
  const last = useRef(value.join(", "));
  useEffect(() => {
    const v = value.join(", ");
    if (v !== last.current) setText(v);
    last.current = v;
  }, [value]);
  const commit = () => {
    const list = text.split(",").map((x) => x.trim()).filter(Boolean);
    last.current = list.join(", ");
    onChange(list);
  };
  return <input value={text} placeholder={placeholder} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
}

export function NumberInput({ value, onChange, min, max, label }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Math.min(max, Math.max(min, Math.round(Number(text)) || min));
        setText(String(n));
        onChange(n);
      }}
    />
  );
}

export function Toggle({ checked, onChange, label, help, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span className="toggle-text">
        {label}
        {help && <small className="muted">{help}</small>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------- display

export function Chip({ tone = "info", children, title }: { tone?: "good" | "bad" | "warn" | "info" | "accent"; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function FlagChips({ flags }: { flags: Flag[] }) {
  return (
    <div className="chips">
      {flags.map((f) => (
        <Chip key={f.key + f.label} tone={f.tone}>
          {f.tone === "good" ? "✓ " : f.tone === "bad" ? "✕ " : ""}
          {f.label}
        </Chip>
      ))}
    </div>
  );
}

/** The decision "why", in a clean expandable panel. */
export function Why({ summary, lines }: { summary?: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <details className="why">
      <summary>{summary ?? t("common.why")}</summary>
      <ul>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </details>
  );
}

const IMG_HOSTS = /^https:\/\/(s4\.anilist\.co|image\.tmdb\.org|artworks\.thetvdb\.com|thetvdb\.com)\//;
/** A cover at the size it's shown: AnimeArr's thumbnail cache (the provider's smaller rendition), else the URL as is. */
export const thumbUrl = (src: string, size: "sm" | "md" | "lg" | "xl") => (IMG_HOSTS.test(src) ? `${BASE}/api/img?s=${size}&u=${encodeURIComponent(src)}` : src);
const COVER_PX: Record<string, [number, number]> = { sm: [48, 68], md: [84, 120], lg: [200, 300] };

export function Cover({ src, alt, size = "md", hero = false }: { src: string | null | undefined; alt: string; size?: "sm" | "md" | "lg"; hero?: boolean }) {
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [w, h] = COVER_PX[size];
  return (
    <div className={`cover ${size}${loaded ? " loaded" : ""}`}>
      {src && !broken ? (
        <img src={thumbUrl(src, hero ? "lg" : size === "lg" ? "md" : size)} alt="" width={w} height={h} loading={hero ? "eager" : "lazy"} decoding="async" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setBroken(true)} />
      ) : (
        <div className="noimg" aria-hidden="true">
          {alt.slice(0, 1)}
        </div>
      )}
    </div>
  );
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · AnimeArr`;
  }, [title]);
}

/** Placeholder shapes while a page loads (static under reduced motion). */
export function Skeleton({ kind, label }: { kind: "home" | "list" | "posters" | "hero"; label?: string }) {
  const n = kind === "posters" ? 12 : kind === "list" ? 6 : 0;
  return (
    <div className={`skeleton sk-${kind}`} role="status" aria-label={label ?? t("app.loading")}>
      {kind === "home" && (
        <>
          <div className="sk sk-shelf" />
          <div className="sk-row">
            <div className="sk sk-card" />
            <div className="sk sk-card" />
          </div>
        </>
      )}
      {kind === "hero" && (
        <>
          <div className="sk sk-hero" />
          <div className="sk sk-line" />
          <div className="sk sk-line short" />
        </>
      )}
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={`sk ${kind === "posters" ? "sk-poster" : "sk-item"}`} />
      ))}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="muted loading" role="status">
      <span className="spin" aria-hidden="true" /> {label}
    </p>
  );
}

export function relTime(ms: number) {
  const d = Math.round((Date.now() - ms) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(d) < 60) return rtf.format(-d, "minute");
  if (Math.abs(d) < 720) return rtf.format(-Math.round(d / 60), "hour");
  // Calendar days ("yesterday" means the day before today, not "about 36 hours ago").
  const day = (x: number) => {
    const t = new Date(x);
    return Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / 86_400_000;
  };
  const days = day(Date.now()) - day(ms);
  if (!days) return rtf.format(-Math.round(d / 60), "hour");
  return rtf.format(-days, "day");
}

export function dateTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Simple async loader: data, error, reload. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // Only the latest request may set state (fast navigation must never show an older response).
  const seq = useRef(0);
  const run = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await fn();
      if (mine !== seq.current) return;
      setData(v);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run, setData };
}

/**
 * A release name that wraps at its own separators (". _ - ] )") instead of mid-word, in the mono face.
 * Never word-break: break-all (that splits "MAGICAL" into "MAGICA / L").
 */
export function ReleaseName({ name, className = "", title }: { name: string; className?: string; title?: string }) {
  const parts = name.split(/(?<=[._\-\])])/);
  return (
    <span className={`mono release-name ${className}`} title={title}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}
