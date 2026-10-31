/**
 * ⚡ runs as a background job: the button answers at once. This follows the jobs (GET /autosearch/jobs, every 3 s and
 * only while one is queued or running) so episode rows can show "Searching…", and reports each job you started when
 * it's done, like the old wait-for-it toast.
 */
import { useSyncExternalStore } from "react";
import { api } from "./api";
import { t, type I18nKey } from "./i18n";

export interface AutoOutcome { episodeIds: number[]; label: string; outcome: "grabbed" | "would-grab" | "needs-look" | "skipped" | "failed"; release?: string; why: string }
export interface AutoJob { id: string; kind: "episodes" | "movie"; tvdbId: number | null; movieId: number | null; title: string; episodeIds: number[]; state: "queued" | "running" | "done" | "failed"; position: number; results: AutoOutcome[]; queued?: { n: number; where: "soon" | "fillin" }; error: string | null }
/** What POST /autosearch (and /movies/:id/autosearch) answer. */
export interface AutoQueued { queued: true; jobId: string; episodes: number; position: number }

const POLL_MS = 3000;
let view = { jobs: [] as AutoJob[], episodes: new Set<number>(), movies: new Set<number>() };
let at = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** Jobs started from this tab: told once when they end. */
const watchers = new Map<string, (job: AutoJob) => void>();

function refresh(): Promise<void> {
  inflight ??= (async () => {
    try {
      const v = await api<{ jobs: AutoJob[]; searching: number[]; searchingMovies: number[] }>("/autosearch/jobs");
      view = { jobs: v.jobs, episodes: new Set(v.searching), movies: new Set(v.searchingMovies) };
      at = Date.now();
      for (const [id, done] of watchers) {
        const job = v.jobs.find((j) => j.id === id);
        if (job && job.state !== "done" && job.state !== "failed") continue;
        watchers.delete(id); // gone (AnimeArr restarted): nothing to report
        if (job) done(job);
      }
      listeners.forEach((l) => l());
    } catch {
      /* the next poll tries again */
    } finally {
      inflight = null;
      schedule();
    }
  })();
  return inflight;
}

/** Polls again only while a job is queued or running (or one started here hasn't been seen to end). */
function schedule() {
  if (timer || !(watchers.size || view.jobs.some((j) => j.state === "queued" || j.state === "running"))) return;
  timer = setTimeout(() => {
    timer = null;
    void refresh();
  }, POLL_MS);
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (Date.now() - at > POLL_MS) void refresh();
  return () => void listeners.delete(l);
}

/** The episodes and movies being searched by ⚡ right now. */
export function useAutoSearching() {
  return useSyncExternalStore(subscribe, () => view);
}

/** Follows a job started here; `done` gets it once it has finished. */
export function followAutoJob(jobId: string, done: (job: AutoJob) => void) {
  watchers.set(jobId, done);
  void refresh();
}

/** "Searching 3 episodes… (results in Activity)", plus the place in line when others are ahead. */
export function queuedMessage(r: AutoQueued, movie?: string) {
  const msg = movie ? t("auto.queuedMovie", { title: movie }) : t("auto.queuedToast", { n: r.episodes });
  return r.position ? `${msg} · ${t("auto.inLine", { n: r.position })}` : msg;
}

/** The finished job as one toast: the episode's outcome and why, or a count per outcome for several. */
export function outcomeMessage(job: AutoJob) {
  const r = job.results;
  if (job.state === "failed") return { msg: `${job.title}: ${t("auto.failed")} · ${job.error ?? ""}`, error: true, look: [] as number[], got: 0 };
  const look = r.filter((x) => x.outcome === "needs-look");
  const got = r.filter((x) => x.outcome === "grabbed" || x.outcome === "would-grab").length;
  const msg =
    r.length === 1
      ? `${r[0].label}: ${t(`auto.${r[0].outcome}` as I18nKey)}${r[0].release ? ` · ${r[0].release}` : ""} · ${r[0].why}`
      : t("auto.summary", { got, look: look.length, other: r.length - got - look.length }) + (job.queued ? ` · ${t(job.queued.where === "soon" ? "auto.queuedSoon" : "auto.queuedFillIn", { n: job.queued.n })}` : "");
  return { msg, error: r.length > 0 && r.every((x) => x.outcome === "failed"), look: look.flatMap((x) => x.episodeIds), got };
}
