import { useEffect, useRef, useState } from "react";
import { api, BASE } from "./api";
import { t, type I18nKey } from "./i18n";
import { Toggle, useToast } from "./ui";

interface Entry { at: number; level: "error" | "warn" | "info" | "debug"; msg: string }
const LEVELS = ["error", "warn", "info", "debug"] as const;
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

/** Settings → System → Logs: the last lines, filtered by level and text, with auto-refresh and a download. */
export function LogsCard() {
  const toast = useToast();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("info");
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState(false);
  const [r, setR] = useState<{ entries: Entry[]; total: number; matched: number } | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true); // follow the newest line unless the reader scrolled up
  const load = async () => {
    try {
      setR(await api(`/system/logs?level=${level}&q=${encodeURIComponent(q)}&limit=500`));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  useEffect(() => {
    const h = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(h);
  }, [level, q]);
  useEffect(() => {
    if (!auto) return;
    const h = setInterval(() => void load(), 5000);
    return () => clearInterval(h);
  }, [auto, level, q]);
  useEffect(() => {
    if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight;
  }, [r]);
  return (
    <div className="card pad stack">
      <h2>{t("logs.title")}</h2>
      <p className="muted small">{t("logs.help")}</p>
      <div className="row">
        <label>
          {t("logs.level")}
          <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {t(`logs.lvl.${l}` as I18nKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          {t("logs.search")}
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <Toggle checked={auto} onChange={setAuto} label={t("logs.auto")} />
      <pre
        ref={box}
        className="mono logbox"
        tabIndex={0}
        aria-label={t("logs.title")}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {r && !r.entries.length ? t("logs.empty") : r?.entries.map((e, i) => (
          <span key={i} className={`log-${e.level}`}>
            {time(e.at)} {e.level.toUpperCase().padEnd(5)} {e.msg}
            {"\n"}
          </span>
        ))}
      </pre>
      <div className="row between">
        <span className="muted small">{r ? t("logs.count", { shown: r.entries.length, total: r.total }) : ""}</span>
        <span className="row">
          <button className="small" onClick={() => void load()}>
            {t("logs.refresh")}
          </button>
          <a className="button-link small" href={`${BASE}/api/system/logs/download`} download>
            {t("logs.download")}
          </a>
        </span>
      </div>
    </div>
  );
}
