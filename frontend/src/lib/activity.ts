/**
 * What the app is doing in the background, for the global progress indicator in the header:
 * uploads, preview preparation on the server, the local preview cache filling up, and exports.
 *
 * `useActivityTracker` (mounted once by Shell, so on every page) also owns the polling that keeps
 * files and jobs current while something runs, and starts the background cache download.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useApp } from "../store";
import { isSlide } from "./format";
import { subscribe, warm, warmProgress } from "./previewCache";
import { orderedFiles } from "./tree";
import type { JobInfo } from "./types";
import { useUploads } from "./uploads";

export interface Task {
  key: string;
  kind: "upload" | "prepare" | "cache" | "export";
  state: "running" | "queued" | "done" | "error";
  /** 0..1, or null when unknown. */
  ratio: number | null;
  done?: number;
  total?: number;
  /** Upload status line, or the export's label. */
  text?: string | null;
  jobId?: string;
}

type Count = { done: number; total: number } | null;

interface ActivityState {
  prepare: Count;
  cache: Count;
  /** Exports that finished while this tab watched them (shown for a while, with a download link). */
  finished: JobInfo[];
}

export const useActivity = create<ActivityState>(() => ({ prepare: null, cache: null, finished: [] }));

const FILES_POLL_MS = 2500;
const JOBS_POLL_MS = 1500;
const FINISHED_SHOW_MS = 20_000;

let primedFor: string | null = null;
/** Files seen preparing in the current batch (progress = how many of them are ready). */
const prepareBatch = new Set<string>();
/** Running jobs this tab has seen, and when finished ones stop being shown. */
const watchedJobs = new Set<string>();
const finishedUntil = new Map<string, number>();

const isActive = (job: JobInfo) => job.status === "queued" || job.status === "running";

export function useActivityTracker() {
  const userId = useApp((s) => s.user?.id ?? null);
  const files = useApp((s) => s.files);
  const folders = useApp((s) => s.folders);
  const jobs = useApp((s) => s.jobs);
  const pendingIds = files.filter((f) => f.prepare === "pending").map((f) => f.id);
  const pendingKey = pendingIds.join(",");
  const jobsActive = jobs.some(isActive);

  // First page of a session: learn about files still being prepared and running exports.
  useEffect(() => {
    if (!userId || primedFor === userId) return;
    primedFor = userId;
    const app = useApp.getState();
    void app.refreshJobs().catch(() => undefined);
    if (!app.files.length) void app.refreshFiles().catch(() => undefined);
  }, [userId]);

  useEffect(() => {
    if (!pendingKey) return;
    const handle = window.setInterval(() => void useApp.getState().refreshFiles().catch(() => undefined), FILES_POLL_MS);
    return () => window.clearInterval(handle);
  }, [pendingKey]);

  useEffect(() => {
    if (!jobsActive) return;
    const handle = window.setInterval(() => void useApp.getState().refreshJobs().catch(() => undefined), JOBS_POLL_MS);
    return () => window.clearInterval(handle);
  }, [jobsActive]);

  useEffect(() => {
    const ids = pendingKey ? pendingKey.split(",") : [];
    if (!ids.length) {
      prepareBatch.clear();
      useActivity.setState({ prepare: null });
      return;
    }
    ids.forEach((id) => prepareBatch.add(id));
    useActivity.setState({ prepare: { done: prepareBatch.size - ids.length, total: prepareBatch.size } });
  }, [pendingKey]);

  // Keep every prepared preview in the local cache (if enabled), starting next to the selection.
  const order = useMemo(() => orderedFiles(folders, files).filter((f) => !isSlide(f)), [folders, files]);
  useEffect(() => {
    const at = Math.max(0, order.findIndex((f) => f.id === useApp.getState().selectedId));
    warm([...order.slice(at), ...order.slice(0, at)]);
  }, [order]);

  useEffect(() => {
    const update = () => {
      const next = warmProgress();
      const prev = useActivity.getState().cache;
      if (next?.done !== prev?.done || next?.total !== prev?.total) useActivity.setState({ cache: next });
    };
    update();
    return subscribe(update);
  }, []);

  useEffect(() => {
    const now = Date.now();
    for (const job of jobs) {
      if (isActive(job)) watchedJobs.add(job.id);
      else if (watchedJobs.delete(job.id)) finishedUntil.set(job.id, now + FINISHED_SHOW_MS);
    }
    const prune = () => {
      const t = Date.now();
      for (const [id, until] of finishedUntil) if (until <= t) finishedUntil.delete(id);
      const current = useApp.getState().jobs;
      useActivity.setState({ finished: current.filter((job) => finishedUntil.has(job.id) && !isActive(job)) });
    };
    prune();
    if (!finishedUntil.size) return;
    const handle = window.setTimeout(prune, Math.max(0, Math.min(...finishedUntil.values()) - now) + 50);
    return () => window.clearTimeout(handle);
  }, [jobs]);
}

/** Everything in progress (and recently finished exports), most important first. */
export function useTasks(): Task[] {
  const upload = useUploads((s) => s.progress);
  const jobs = useApp((s) => s.jobs);
  const { prepare, cache, finished } = useActivity();
  return useMemo(() => {
    const tasks: Task[] = [];
    if (upload) tasks.push({ key: "upload", kind: "upload", state: "running", ratio: upload.ratio, text: upload.label });
    for (const job of jobs.filter(isActive)) {
      tasks.push({
        key: `job:${job.id}`,
        kind: "export",
        state: job.status === "queued" ? "queued" : "running",
        ratio: job.status === "queued" ? null : job.progress || 0,
        text: job.label || job.format,
        jobId: job.id,
      });
    }
    if (prepare) tasks.push({ key: "prepare", kind: "prepare", state: "running", ratio: prepare.done / prepare.total, ...prepare });
    if (cache) tasks.push({ key: "cache", kind: "cache", state: "running", ratio: cache.done / cache.total, ...cache });
    for (const job of finished) {
      tasks.push({
        key: `job:${job.id}`,
        kind: "export",
        state: job.status === "error" ? "error" : "done",
        ratio: 1,
        text: job.label || job.format,
        jobId: job.id,
      });
    }
    return tasks;
  }, [cache, finished, jobs, prepare, upload]);
}
