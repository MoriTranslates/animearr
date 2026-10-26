import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { fixesForMessage, runFix, type Flag } from "./api";
import { t } from "./i18n";

// ---------------------------------------------------------------- toasts

interface Toast { id: number; msg: string; error: boolean; action?: { label: string; run: () => void } }
type Push = (msg: string, error?: boolean, action?: Toast["action"]) => void;
const ToastCtx = createContext<Push>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback<Push>((msg, error = false, action) => {
    // An error the server attached a fix to gets that fix as its button.
    if (error && !action) {
      const f = fixesForMessage(msg)?.[0];
      if (f) action = { label: f.label, run: () => runFix(f) };
    }
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.filter((y) => !(y.error && error && y.msg === msg)).slice(-2), { id, msg, error, action }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), error ? 12_000 : action ? 8000 : 4500);
  }, []);
  const close = (id: number) => setToasts((x) => x.filter((y) => y.id !== id));
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="sr-only" role="alert">
        {toasts.filter((x) => x.error).map((x) => x.msg).join(". ")}
      </div>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast${x.error ? " err" : ""}`} aria-hidden={x.error || undefined}>
            <span>{x.msg}</span>
            {x.action && (
              <button className="primary" onClick={() => (x.action!.run(), close(x.id))}>
                {x.action.label}
              </button>
            )}
            <button className="icon" aria-label={t("common.close")} onClick={() => close(x.id)}>
              ✕
            </button>
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
  return (
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
    </div>
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

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty muted">{children}</p>;
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

export function Toggle({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
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

export function Cover({ src, alt, size = "md" }: { src: string | null | undefined; alt: string; size?: "sm" | "md" | "lg" }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`cover ${size}`}>
      {src && !broken ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <div className="noimg" aria-hidden="true">{alt.slice(0, 1)}</div>}
    </div>
  );
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · AnimeArr`;
  }, [title]);
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
  if (Math.abs(d) < 1440) return rtf.format(-Math.round(d / 60), "hour");
  return rtf.format(-Math.round(d / 1440), "day");
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
