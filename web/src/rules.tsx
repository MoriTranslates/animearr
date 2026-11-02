import { useState } from "react";
import { useUnsaved } from "./unsaved";
import { api } from "./api";
import { t } from "./i18n";
import { Chip, Confirm, ErrorBox, Modal, Spinner, Toggle, useLoad, useToast } from "./ui";

export interface Tag {
  id: number;
  label: string;
  series: number;
  movies: number;
  rules: number;
}
export interface PreferredTerm {
  term: string;
  score: number;
}
export interface ReleaseRule {
  id: string;
  name: string;
  enabled: boolean;
  must: string[];
  mustNot: string[];
  preferred: PreferredTerm[];
  tags: number[];
}
interface TestResult {
  rejected: string | null;
  score: number;
  why: string[];
  matches: { rule: string; blocked: string | null; preferred: PreferredTerm[] }[];
}

// ---------------------------------------------------------------- Settings → Tags

/** Settings → Tags: add, rename and delete tags; deleting says what uses the tag and unlinks it. */
export function TagsEditor() {
  const toast = useToast();
  const d = useLoad(() => api<{ tags: Tag[] }>("/tags"), []);
  const [label, setLabel] = useState("");
  const [del, setDel] = useState<Tag | null>(null);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const add = async () => {
    try {
      await api("/tags", { body: { label } });
      setLabel("");
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">{t("tags.intro")}</p>
      <div className="card pad stack">
        {!d.data.tags.length && <p className="muted">{t("tags.none")}</p>}
        {d.data.tags.map((x) => (
          <TagRow key={`${x.id}:${x.label}`} tag={x} onChanged={d.reload} onDelete={() => setDel(x)} />
        ))}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            className="grow"
            value={label}
            maxLength={40}
            placeholder={t("tags.newPlaceholder")}
            aria-label={t("tags.add")}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button className="primary" disabled={!label.trim()}>
            + {t("tags.add")}
          </button>
        </form>
      </div>
      {del && (
        <Confirm
          danger
          title={t("tags.deleteTitle", { label: del.label })}
          confirmLabel={t("common.delete")}
          onClose={() => setDel(null)}
          onConfirm={async () => {
            try {
              await api(`/tags/${del.id}`, { method: "DELETE" });
              setDel(null);
              toast(t("tags.deleted"));
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>
            {del.series + del.movies + del.rules
              ? t("tags.deleteBody", { series: del.series, movies: del.movies, rules: del.rules })
              : t("tags.deleteUnused")}
          </p>
        </Confirm>
      )}
    </div>
  );
}

function TagRow({ tag, onChanged, onDelete }: { tag: Tag; onChanged: () => void; onDelete: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(tag.label);
  const used = tag.series + tag.movies + tag.rules;
  const rename = async () => {
    try {
      await api(`/tags/${tag.id}`, { method: "PUT", body: { label: name } });
      toast(t("common.saved"));
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
      setName(tag.label);
    }
  };
  return (
    <div className="row">
      <input
        className="grow"
        value={name}
        maxLength={40}
        aria-label={t("tags.rename")}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim().toLowerCase() !== tag.label && void rename()}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span className="muted small">
        {used ? t("tags.usage", { series: tag.series, movies: tag.movies, rules: tag.rules }) : t("tags.unused")}
      </span>
      <button className="danger small" onClick={onDelete}>
        {t("common.delete")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- tags on a show or movie

/** Tap-to-toggle tags for one show or movie (saves at once), with a field to make a new tag. */
export function TagPicker({ endpoint, value, onChanged }: { endpoint: string; value: number[]; onChanged: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api<{ tags: Tag[] }>("/tags"), []);
  const [label, setLabel] = useState("");
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const save = async (ids: number[]) => {
    try {
      await api(endpoint, { method: "PUT", body: { tags: ids } });
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const toggle = (id: number) => void save(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const create = async () => {
    try {
      const made = await api<{ id: number }>("/tags", { body: { label } });
      setLabel("");
      await d.reload();
      await save([...new Set([...value, made.id])]);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">{t("tags.pickHelp")}</p>
      <div className="row" role="group" aria-label={t("tags.title")}>
        {d.data.tags.map((x) => (
          <button
            key={x.id}
            type="button"
            className={`chip${value.includes(x.id) ? " on" : ""}`}
            aria-pressed={value.includes(x.id)}
            onClick={() => toggle(x.id)}
          >
            {x.label}
          </button>
        ))}
        {!d.data.tags.length && <span className="muted small">{t("tags.none")}</span>}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          className="grow"
          value={label}
          maxLength={40}
          placeholder={t("tags.newPlaceholder")}
          aria-label={t("tags.add")}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button disabled={!label.trim()}>+ {t("tags.add")}</button>
      </form>
    </div>
  );
}

/** Add or remove tags on all selected shows at once (Library → Shows → Select). */
export function BulkTags({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api<{ tags: Tag[] }>("/tags"), []);
  const [picked, setPicked] = useState<number[]>([]);
  const run = async (mode: "add" | "remove") => {
    try {
      await api("/tags/bulk", { body: { kind: "series", ids, [mode]: picked } });
      toast(t("tags.bulkDone"));
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title={t("tags.bulkTitle", { n: ids.length })} onClose={onClose}>
      <div className="stack">
        <p className="muted small">{t("tags.bulkHelp")}</p>
        {d.error && <ErrorBox error={d.error} retry={d.reload} />}
        {!d.data && !d.error && <Spinner label={t("app.loading")} />}
        {d.data && (
          <div className="row" role="group" aria-label={t("tags.title")}>
            {d.data.tags.map((x) => (
              <button
                key={x.id}
                type="button"
                className={`chip${picked.includes(x.id) ? " on" : ""}`}
                aria-pressed={picked.includes(x.id)}
                onClick={() => setPicked(picked.includes(x.id) ? picked.filter((p) => p !== x.id) : [...picked, x.id])}
              >
                {x.label}
              </button>
            ))}
            {!d.data.tags.length && <span className="muted small">{t("tags.none")}</span>}
          </div>
        )}
        <div className="row end">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button disabled={!picked.length} onClick={() => void run("remove")}>
            {t("tags.bulkRemove")}
          </button>
          <button className="primary" disabled={!picked.length} onClick={() => void run("add")}>
            {t("tags.bulkAdd")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Settings → Release rules

/** Type a term and press Enter (or comma): terms are chips you can remove. */
function TermChips({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const [text, setText] = useState("");
  const commit = () => {
    const x = text.trim();
    if (x && !value.some((v) => v.toLowerCase() === x.toLowerCase())) onChange([...value, x]);
    setText("");
  };
  return (
    <div className="term-editor">
      <div className="row">
        {value.map((v) => (
          <span key={v} className="chip accent term-chip">
            <code>{v}</code>
            <button
              type="button"
              className="linklike"
              aria-label={t("rules.removeTerm", { term: v })}
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        value={text}
        placeholder={t("rules.termPlaceholder")}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || (e.key === "," && !text.trim().startsWith("/"))) {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

function PreferredEditor({ value, onChange }: { value: PreferredTerm[]; onChange: (v: PreferredTerm[]) => void }) {
  const [term, setTerm] = useState("");
  const [score, setScore] = useState("5");
  const add = () => {
    const x = term.trim();
    const n = Math.round(Number(score));
    if (!x || !Number.isFinite(n) || value.some((v) => v.term.toLowerCase() === x.toLowerCase())) return;
    onChange([...value, { term: x, score: n }]);
    setTerm("");
  };
  return (
    <div className="term-editor">
      <div className="row">
        {value.map((v) => (
          <span key={v.term} className={`chip ${v.score < 0 ? "bad" : "good"} term-chip`}>
            <code>{v.term}</code> {v.score > 0 ? "+" : ""}
            {v.score}
            <button
              type="button"
              className="linklike"
              aria-label={t("rules.removeTerm", { term: v.term })}
              onClick={() => onChange(value.filter((x) => x.term !== v.term))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <input
          className="grow"
          value={term}
          placeholder={t("rules.termPlaceholder")}
          aria-label={t("rules.preferred")}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        />
        <input
          className="narrow"
          inputMode="numeric"
          value={score}
          placeholder={t("rules.scorePlaceholder")}
          aria-label={t("rules.score")}
          onChange={(e) => setScore(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        />
        <button type="button" disabled={!term.trim()} onClick={add}>
          {t("rules.addTerm")}
        </button>
      </div>
    </div>
  );
}

/** Settings → Release rules: must / must-not / preferred terms, optionally limited by tags, with a test box. */
export function RulesEditor() {
  const toast = useToast();
  const d = useLoad(() => api<{ rules: ReleaseRule[] }>("/release-rules"), []);
  const tags = useLoad(() => api<{ tags: Tag[] }>("/tags"), []);
  const [del, setDel] = useState<ReleaseRule | null>(null);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data || !tags.data) return <Spinner label={t("app.loading")} />;
  return (
    <div className="stack">
      <p className="muted small">{t("rules.intro")}</p>
      <p className="muted small">{t("rules.termsHelp")}</p>
      {!d.data.rules.length && <p className="muted">{t("rules.none")}</p>}
      {d.data.rules.map((r) => (
        <RuleCard key={`${r.id}:${JSON.stringify(r)}`} rule={r} tags={tags.data!.tags} onSaved={d.reload} onDelete={() => setDel(r)} />
      ))}
      <button
        className="self-start"
        onClick={async () => {
          try {
            await api("/release-rules", { body: { name: t("rules.newName") } });
            await d.reload();
          } catch (e) {
            toast((e as Error).message, true);
          }
        }}
      >
        + {t("rules.add")}
      </button>
      <p className="muted small">{t("rules.preferHelp")}</p>
      <RuleTester />
      {del && (
        <Confirm
          danger
          title={t("rules.deleteTitle", { name: del.name })}
          confirmLabel={t("common.delete")}
          onClose={() => setDel(null)}
          onConfirm={async () => {
            try {
              await api(`/release-rules/${del.id}`, { method: "DELETE" });
              setDel(null);
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("rules.deleteBody")}</p>
        </Confirm>
      )}
    </div>
  );
}

function RuleCard({
  rule: initial,
  tags,
  onSaved,
  onDelete,
}: {
  rule: ReleaseRule;
  tags: Tag[];
  onSaved: () => void;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [r, setR] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const set = (patch: Partial<ReleaseRule>) => (setR({ ...r, ...patch }), setDirty(true));
  const save = async () => {
    try {
      const saved = await api<ReleaseRule>(`/release-rules/${r.id}`, { method: "PUT", body: r });
      setR(saved);
      setDirty(false);
      toast(t("common.saved"));
      onSaved();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  useUnsaved(dirty, () => save());
  return (
    <div className="card pad stack">
      <div className="row between">
        <input
          className="grow profile-name"
          value={r.name}
          maxLength={60}
          onChange={(e) => set({ name: e.target.value })}
          aria-label={t("rules.name")}
        />
        {!r.enabled && <Chip tone="warn">{t("rules.disabledChip")}</Chip>}
      </div>
      <Toggle checked={r.enabled} onChange={(v) => set({ enabled: v })} label={t("rules.enabled")} />
      <label>
        {t("rules.must")}
        <TermChips value={r.must} onChange={(v) => set({ must: v })} label={t("rules.must")} />
        <span className="muted small">{t("rules.mustHelp")}</span>
      </label>
      <label>
        {t("rules.mustNot")}
        <TermChips value={r.mustNot} onChange={(v) => set({ mustNot: v })} label={t("rules.mustNot")} />
      </label>
      <div>
        {t("rules.preferred")}
        <PreferredEditor value={r.preferred} onChange={(v) => set({ preferred: v })} />
      </div>
      <fieldset className="stack">
        <legend className="small muted">{t("rules.tags")}</legend>
        <span className="small">{r.tags.length ? t("rules.tagsOnly") : t("rules.tagsAll")}</span>
        <div className="row" role="group" aria-label={t("rules.tags")}>
          {tags.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`chip${r.tags.includes(x.id) ? " on" : ""}`}
              aria-pressed={r.tags.includes(x.id)}
              onClick={() => set({ tags: r.tags.includes(x.id) ? r.tags.filter((y) => y !== x.id) : [...r.tags, x.id] })}
            >
              {x.label}
            </button>
          ))}
          {!tags.length && <span className="muted small">{t("rules.noTagsYet")}</span>}
        </div>
      </fieldset>
      <div className="row">
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          {t("common.save")}
        </button>
        {dirty && (
          <button className="ghost" onClick={() => (setR(initial), setDirty(false))}>
            {t("common.cancel")}
          </button>
        )}
        <button className="danger" onClick={onDelete}>
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}

/** "Test against a title": which saved rules block a sample release name or add points. */
function RuleTester() {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [res, setRes] = useState<TestResult | null>(null);
  const run = async () => {
    try {
      setRes(await api<TestResult>("/release-rules/test", { body: { title } }));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="card pad stack">
      <strong>{t("rules.test")}</strong>
      <p className="muted small">{t("rules.testHelp")}</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          className="grow"
          value={title}
          placeholder={t("rules.testPlaceholder")}
          aria-label={t("rules.test")}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button disabled={!title.trim()}>{t("rules.testRun")}</button>
      </form>
      {res && (
        <div className="stack small" role="status">
          {!res.matches.length && <p className="muted">{t("rules.testNoRules")}</p>}
          {res.matches.length > 0 && (
            <p>{res.rejected ? <Chip tone="bad">{res.rejected}</Chip> : <Chip tone="good">{t("rules.testOk")}</Chip>}</p>
          )}
          {res.matches.map((m) => (
            <p key={m.rule}>
              <strong>{m.rule}</strong>: {m.blocked ? t("rules.testRuleBlocked", { why: m.blocked }) : t("rules.testRuleOk")}
              {m.preferred.map((p) => (
                <Chip key={p.term} tone={p.score < 0 ? "bad" : "good"}>
                  {t("rules.testRulePrefers", { term: p.term, score: `${p.score > 0 ? "+" : ""}${p.score}` })}
                </Chip>
              ))}
            </p>
          ))}
          {res.score !== 0 && <p className="muted">{t("rules.testScore", { score: `${res.score > 0 ? "+" : ""}${res.score}` })}</p>}
        </div>
      )}
    </div>
  );
}
