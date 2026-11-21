import { isSupportedName } from "./format";
import type {
  AccessCode,
  AccessUser,
  BatchApplyRequest,
  CodeKind,
  CropRequest,
  FileDetail,
  FileSummary,
  JobInfo,
  LutSetting,
  MeasureResult,
  NucleusParams,
  NucleusResult,
  PerformanceValues,
  PerformanceView,
  ProjectInfo,
  RenderModeSetting,
  SlideExportFormat,
  SlideInfo,
} from "./types";

export class ApiError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;

/** Called whenever the server reports that the session is gone (logged out, code expired…). */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export async function parseError(res: Response): Promise<Error> {
  if (res.status === 401 && !res.url.includes("/api/auth/")) onUnauthorized?.();
  try {
    const body = (await res.json()) as { detail?: unknown };
    const detail = body.detail;
    if (typeof detail === "string") return new ApiError(detail, res.status);
    if (detail && typeof detail === "object") {
      const record = detail as { code?: unknown; message?: unknown };
      return new ApiError(
        typeof record.message === "string" ? record.message : res.statusText,
        res.status,
        typeof record.code === "string" ? record.code : undefined,
      );
    }
    return new ApiError(res.statusText, res.status);
  } catch {
    return new ApiError(`${res.status} ${res.statusText}`, res.status);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function send(url: string, method: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: body === undefined ? undefined : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface ServerSettings {
  version: string;
  max_upload_bytes: number;
  ttl_hours: number;
  render_mode: RenderModeSetting;
  raster_max_pixels: number;
  /** Browsers keep previews locally (IndexedDB), up to `local_cache_bytes`. */
  local_cache: boolean;
  /** ...and download every prepared preview of the workspace in the background. */
  local_cache_auto: boolean;
  local_cache_bytes: number;
  /** The signed-in user may rebuild caches from the file tree. */
  cache_rebuild: boolean;
}

export async function serverSettings(): Promise<ServerSettings> {
  return json<ServerSettings>(await fetch("/api/settings"));
}

let cachedSettings: Promise<ServerSettings> | null = null;

/** Server settings, fetched once per page load (refreshed after an admin changes them). */
export function clientSettings(refresh = false): Promise<ServerSettings> {
  if (!cachedSettings || refresh) {
    cachedSettings = serverSettings();
    cachedSettings.catch(() => {
      cachedSettings = null;
    });
  }
  return cachedSettings;
}

export async function getPerformance(): Promise<PerformanceView> {
  return json(await fetch("/api/admin/performance"));
}

export async function updatePerformance(values: Partial<PerformanceValues>): Promise<PerformanceView> {
  const view = await json<PerformanceView>(await send("/api/admin/performance", "PUT", values));
  void clientSettings(true).catch(() => undefined);
  return view;
}

export async function resetPerformance(): Promise<PerformanceView> {
  const view = await json<PerformanceView>(await send("/api/admin/performance/reset", "POST"));
  void clientSettings(true).catch(() => undefined);
  return view;
}

export async function me() {
  return json<{ authenticated: boolean; user: AccessUser | null }>(await fetch("/api/auth/me"));
}

export async function login(code: string) {
  return json<{ authenticated: true; user: AccessUser }>(await send("/api/auth/login", "POST", { code }));
}

export async function logout() {
  return json(await send("/api/auth/logout", "POST"));
}

export async function listCodes() {
  return json<{ codes: AccessCode[]; ttl_hours: number }>(await fetch("/api/admin/codes"));
}

export async function createCode(body: { label: string; kind: CodeKind; expires_at: number | null }) {
  return json<AccessCode>(await send("/api/admin/codes", "POST", body));
}

export async function updateCode(
  id: string,
  body: Partial<{ label: string; kind: CodeKind; expires_at: number | null; disabled: boolean }>,
) {
  return json<AccessCode>(await send(`/api/admin/codes/${id}`, "PATCH", body));
}

export async function regenerateCode(id: string) {
  return json<AccessCode>(await send(`/api/admin/codes/${id}/regenerate`, "POST"));
}

export async function deleteCode(id: string) {
  return json(await send(`/api/admin/codes/${id}`, "DELETE"));
}

export async function adminWorkspace(codeId: string): Promise<{ files: FileSummary[]; folders: string[] }> {
  return json(await fetch(`/api/admin/workspaces/${codeId}`));
}

export async function adminTransfer(body: {
  source: string;
  target: string;
  file_ids: string[];
  folders: string[];
  target_folder: string;
  mode: "copy" | "move";
  conflict: "skip" | "replace";
}) {
  return json<{ copied: number; moved: number; skipped: number; replaced: number }>(
    await send("/api/admin/transfer", "POST", body),
  );
}

export async function listWorkspace(): Promise<{ files: FileSummary[]; folders: string[] }> {
  return json(await fetch("/api/files"));
}

export async function createFolder(path: string) {
  return json<{ path: string }>(await send("/api/folders", "POST", { path }));
}

export async function renameFolder(path: string, newPath: string) {
  return json<{ path: string }>(await send("/api/folders/rename", "POST", { path, new_path: newPath }));
}

export async function deleteFolder(path: string) {
  return json<{ path: string; removed_files: string[] }>(await send("/api/folders/delete", "POST", { path }));
}

export async function updateFile(id: string, body: { name?: string; folder?: string }) {
  return json<FileDetail>(await send(`/api/files/${id}`, "PATCH", body));
}

export async function cropFile(id: string, body: CropRequest): Promise<FileSummary> {
  return json<FileSummary>(await send(`/api/files/${id}/crop`, "POST", body));
}

export async function resetFile(id: string): Promise<FileSummary> {
  return json<FileSummary>(await send(`/api/files/${id}/reset`, "POST"));
}

export async function detectNuclei(id: string, body?: Partial<NucleusParams>): Promise<NucleusResult> {
  return json<NucleusResult>(await send(`/api/files/${id}/nuclei`, "POST", body ?? {}));
}

export async function batchApply(body: BatchApplyRequest): Promise<{ files: FileSummary[]; mode: "inplace" | "new"; count: number }> {
  return json<{ files: FileSummary[]; mode: "inplace" | "new"; count: number }>(
    await send("/api/files/batch-apply", "POST", body),
  );
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const data = await json<{ projects: ProjectInfo[] }>(await fetch("/api/projects"));
  return data.projects;
}

export async function createProject(body: {
  name: string;
  description?: string;
  file_ids?: string[];
  settings?: Record<string, unknown>;
}): Promise<ProjectInfo> {
  return json<ProjectInfo>(await send("/api/projects", "POST", body));
}

export async function getProject(id: string): Promise<ProjectInfo> {
  return json<ProjectInfo>(await fetch(`/api/projects/${id}`));
}

export async function updateProject(
  id: string,
  body: Partial<{
    name: string;
    description: string;
    file_ids: string[];
    settings: Record<string, unknown>;
  }>,
): Promise<ProjectInfo> {
  return json<ProjectInfo>(await send(`/api/projects/${id}`, "PATCH", body));
}

export async function deleteProject(id: string): Promise<{ id: string; status: string }> {
  return json<{ id: string; status: string }>(await send(`/api/projects/${id}`, "DELETE"));
}

export async function getFile(id: string): Promise<FileDetail> {
  return json<FileDetail>(await fetch(`/api/files/${id}`));
}

export async function deleteFile(id: string) {
  return json(await fetch(`/api/files/${id}`, { method: "DELETE" }));
}

/** Prepare the previews of these files / everything below these folders again (in the background). */
export async function rebuildCache(body: { file_ids?: string[]; folders?: string[] }) {
  return json<{ count: number }>(await send("/api/cache/rebuild", "POST", body));
}

export async function fetchPlane(id: string, t = 0, z = 0, p = 0, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(`/api/files/${id}/plane?t=${t}&z=${z}&p=${p}`, { signal });
  if (!res.ok) throw await parseError(res);
  return res.arrayBuffer();
}

export async function autoscale(id: string, t = 0, z = 0, p = 0) {
  return json<{ channels: { index: number; name: string; min: number; max: number; color: number[] }[] }>(
    await fetch(`/api/files/${id}/autoscale?t=${t}&z=${z}&p=${p}`),
  );
}

export async function measure(
  id: string,
  body: {
    tool: string;
    points: number[][];
    t?: number;
    z?: number;
    p?: number;
  },
): Promise<MeasureResult> {
  const res = await fetch(`/api/files/${id}/measure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return json(res);
}

export async function slideInfo(id: string): Promise<SlideInfo> {
  return json(await fetch(`/api/files/${id}/slide`));
}

export async function startSlideExport(
  id: string,
  body: {
    format: SlideExportFormat;
    region: number[] | null;
    level: number;
    channels: number[];
    luts: LutSetting[];
    t: number;
    z: number;
    scale_bar: boolean;
    scale_bar_um?: number;
    jpeg_quality?: number;
  },
): Promise<{ id: string; width: number; height: number }> {
  return json(
    await fetch(`/api/files/${id}/slide/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function startExport(body: Record<string, unknown>): Promise<JobInfo & { file_count: number }> {
  return json(await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function listJobs(): Promise<JobInfo[]> {
  const data = await json<{ jobs: JobInfo[] }>(await fetch("/api/jobs"));
  return data.jobs;
}

export async function getJob(id: string): Promise<JobInfo> {
  return json(await fetch(`/api/jobs/${id}`));
}

export interface MoveUndo {
  files: { id: string; folder: string; name: string }[];
  folders_removed: string[];
  folders_added: string[];
}

export interface MoveResult {
  moved: number;
  skipped: number;
  renamed: number;
  replaced: number;
  undo: MoveUndo;
}

export type MoveConflict = "skip" | "replace" | "rename";

export async function moveItems(body: {
  file_ids: string[];
  folders: string[];
  target_folder: string;
  conflict?: MoveConflict;
}): Promise<MoveResult> {
  return json<MoveResult>(await send("/api/items/move", "POST", body));
}

export interface OrganizeGroup {
  source: string;
  label: string;
  target: string;
  count: number;
  file_ids: string[];
  names: string[];
}

export interface OrganizeResult {
  groups: OrganizeGroup[];
  files: number;
  unchanged: number;
  regroup: boolean;
  folders_to_prune: string[];
  moved?: number;
  pruned?: string[];
  undo?: MoveUndo;
}

export async function organizeByMagnification(body: {
  folder: string;
  recursive?: boolean;
  apply?: boolean;
  unknown_label?: string;
  file_ids?: string[];
  since?: number;
  regroup?: boolean;
}): Promise<OrganizeResult> {
  return json(await send("/api/organize/magnification", "POST", body));
}

export async function undoMove(undo: MoveUndo): Promise<{ restored: number; skipped: number }> {
  return json(await send("/api/items/undo-move", "POST", undo));
}

export function thumbUrl(file: { id: string; prepared_at?: number | null }): string {
  return `/api/files/${file.id}/thumb?v=${file.prepared_at ?? 0}`;
}

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
  // Already gone (deleted in another tab, or purged): that is what the user wanted.
  if (!res.ok && res.status !== 404) throw await parseError(res);
}

export async function clearJobs(body: { scope: "finished" | "all"; job_ids?: string[] }): Promise<string[]> {
  const data = await json<{ deleted: string[] }>(await send("/api/jobs/clear", "POST", body));
  return data.deleted;
}

export function jobDownloadUrl(id: string) {
  return `/api/jobs/${id}/download`;
}

export async function uploadFile(
  file: File,
  folder: string,
  onProgress?: (ratio: number) => void,
): Promise<FileDetail> {
  if (!isSupportedName(file.name)) {
    throw new Error("not_nd2");
  }
  const chunkLimit = 32 * 1024 * 1024;
  const chunkSize = 8 * 1024 * 1024;
  if (file.size <= chunkLimit) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const res = await new Promise<Response>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/files?${new URLSearchParams({ folder })}`);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total);
      };
      xhr.onload = () =>
        resolve(
          new Response(xhr.response, {
            status: xhr.status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      xhr.onerror = () => reject(new Error("network"));
      xhr.responseType = "text";
      xhr.send(fd);
    });
    return json(res);
  }
  const init = await json<{ upload_id: string }>(
    await fetch("/api/uploads/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, size: file.size, folder }),
    }),
  );
  let offset = 0;
  while (offset < file.size) {
    const blob = file.slice(offset, offset + chunkSize);
    const fd = new FormData();
    fd.append("file", blob, file.name);
    const res = await fetch(`/api/uploads/${init.upload_id}/chunk?offset=${offset}`, {
      method: "PUT",
      body: fd,
    });
    if (!res.ok) throw await parseError(res);
    offset += blob.size;
    onProgress?.(offset / file.size);
  }
  return json(
    await fetch(`/api/uploads/${init.upload_id}/complete`, { method: "POST" }),
  );
}

export async function projectionUrl(
  id: string,
  axis: string,
  mode: string,
  t = 0,
  z = 0,
  p = 0,
) {
  const res = await fetch(
    `/api/files/${id}/projection?axis=${axis}&mode=${mode}&t=${t}&z=${z}&p=${p}`,
  );
  if (!res.ok) throw await parseError(res);
  return URL.createObjectURL(await res.blob());
}

// --- analyses (comet assay, EdU) --------------------------------------------------------

export type AnalysisType = "comet" | "edu";
export type TailDirection = "right" | "left" | "up" | "down";
export type HeadMode = "auto" | "profile" | "brightest";
export type CometThresholdMethod = "huang" | "otsu" | "li" | "triangle" | "manual";

export interface CometParams {
  channel: number | null;
  tail: TailDirection;
  background_correction: boolean;
  head_mode: HeadMode;
  min_area: number;
  threshold_method: CometThresholdMethod;
  threshold_offset: number;
  threshold_value: number;
  median_radius: number;
  rolling_ball_factor: number;
  opening_iterations: number;
  max_area: number;
  exclude_edge: boolean;
  convexity_min: number;
  symmetry_max: number;
  centerline_max: number;
  outlier_centerline: number;
  outlier_area_sigma: number;
}

export const COMET_DEFAULTS: CometParams = {
  channel: null,
  tail: "right",
  background_correction: true,
  head_mode: "auto",
  min_area: 400,
  threshold_method: "huang",
  threshold_offset: 0,
  threshold_value: 30,
  median_radius: 10,
  rolling_ball_factor: 0.3,
  opening_iterations: 3,
  max_area: 0,
  exclude_edge: true,
  convexity_min: 0.85,
  symmetry_max: 0.5,
  centerline_max: 0.2,
  outlier_centerline: 0.15,
  outlier_area_sigma: 2,
};

export type EduKind = "auto" | "green" | "red" | "farred";
export type EduCountMode = "nucleus" | "independent";
export type SegMethod = "otsu" | "li" | "triangle" | "manual";
export type EduMethod = "li" | "log-otsu" | "otsu" | "manual";

export interface EduParams {
  nucleus_channel: number | null;
  edu_channel: number | null;
  edu_kind: EduKind;
  count_mode: EduCountMode;
  smooth_sigma: number;
  background_radius: number;
  nucleus_method: SegMethod;
  nucleus_factor: number;
  nucleus_threshold: number;
  split_touching: boolean;
  split_strength: number;
  min_area: number;
  max_area: number;
  exclude_border: boolean;
  edu_method: EduMethod;
  edu_threshold: number;
  edu_scope: "analysis" | "image";
  edu_seg_method: SegMethod;
  edu_seg_factor: number;
  edu_seg_threshold: number;
}

export const EDU_DEFAULTS: EduParams = {
  nucleus_channel: null,
  edu_channel: null,
  edu_kind: "auto",
  count_mode: "nucleus",
  smooth_sigma: 1.5,
  background_radius: 0,
  nucleus_method: "otsu",
  nucleus_factor: 1,
  nucleus_threshold: 0,
  split_touching: true,
  split_strength: 2,
  min_area: 0,
  max_area: 0,
  exclude_border: false,
  edu_method: "li",
  edu_threshold: 0,
  edu_scope: "analysis",
  edu_seg_method: "otsu",
  edu_seg_factor: 1,
  edu_seg_threshold: 0,
};

/** EdU parameters that only reclassify nuclei (no new segmentation). */
export const EDU_CLASSIFY_KEYS = ["count_mode", "edu_method", "edu_threshold", "edu_scope"] as const;

export interface ChannelBrief {
  index: number;
  name: string;
  color: number[];
}

export interface EduCounts {
  nuclei: number;
  positive: number;
  independent: number;
  excluded: number;
  ratio: number | null;
  ratio_independent: number | null;
}

export interface AnalysisFile {
  file_id: string;
  name: string;
  file_name?: string;
  folder: string;
  group: string;
  width: number | null;
  height: number | null;
  channels: ChannelBrief[];
  override: Record<string, unknown> | null;
  analyzed?: boolean;
  error?: string | null;
  /** Comet: valid/outlier/invalid/deleted; EdU: see EduCounts. */
  counts?: { valid: number; outlier: number; invalid: number; deleted: number } & Partial<EduCounts>;
  analyzed_at?: number;
  // EdU
  partner?: { file_id: string; name: string; channels: ChannelBrief[] } | null;
  threshold?: number | null;
}

export interface AnalysisInfo {
  id: string;
  type: AnalysisType;
  name: string;
  params: CometParams | EduParams;
  status: "idle" | "queued" | "running" | "done";
  progress: number;
  created_at: number;
  updated_at: number;
  file_count: number;
  files: AnalysisFile[] | null;
  // EdU
  unpaired?: { file_id: string; name: string; reason: "no_nucleus" | "no_edu" }[];
  pooled_thresholds?: Record<string, number | null>;
}

export interface Comet {
  key: number;
  num?: number;
  status: "valid" | "outlier" | "invalid";
  reasons: string[];
  outline: number[][];
  hull?: number[][];
  head?: { cx: number; cy: number; r: number } | null;
  metrics?: Record<string, number>;
  profiles?: { comet: number[]; head: number[]; tail: number[] };
}

export interface CometResult {
  file_id: string;
  name: string;
  width: number;
  height: number;
  channel: number;
  threshold?: number;
  comets: Comet[];
  deleted: number[];
  um_per_px: number | null;
  error: string | null;
  analyzed_at: number | null;
  params?: CometParams;
  preview?: boolean;
}

export interface EduNucleus {
  key: number;
  /** Flat [x0, y0, x1, y1, …] in image pixels. */
  outline: number[];
  cx: number;
  cy: number;
  area: number;
  dapi: number;
  edu: number;
}

export interface EduObject {
  key: number;
  outline: number[];
  cx: number;
  cy: number;
  area: number;
  mean: number;
}

export interface EduChannelMeta {
  file_id: string;
  file: string;
  channel: number;
  channel_name: string;
  color: number[];
}

export interface EduResult {
  file_id: string;
  name: string;
  width: number;
  height: number;
  nuclei: EduNucleus[];
  edu_objects: EduObject[];
  marks: Record<string, "positive" | "negative" | "excluded">;
  edu_deleted: number[];
  auto_thresholds: Record<string, number | null>;
  nucleus_level: number;
  edu_seg_level: number;
  diameter: number;
  median_area: number;
  background_radius: number;
  nucleus?: EduChannelMeta;
  edu?: EduChannelMeta;
  um_per_px: number | null;
  error: string | null;
  analyzed_at: number | null;
  params?: EduParams;
  preview?: boolean;
}

export interface Stat {
  n: number;
  mean: number | null;
  sd: number | null;
  sem: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface AnalysisSummary {
  total: number;
  include_outliers: boolean;
  groups: { group: string; metrics: Record<string, Stat>; values: Record<string, number[]> }[];
}

export interface EduGroupSummary {
  group: string;
  fields: number;
  nuclei: number;
  positive: number;
  independent: number;
  pooled_percent: number | null;
  pooled_percent_independent: number | null;
  percent: Stat;
  percent_independent: Stat;
  values: number[];
  values_independent: number[];
  names: string[];
}

export interface EduSummary {
  type: "edu";
  count_mode: EduCountMode;
  groups: EduGroupSummary[];
  threshold: number | null;
  pooled: Record<string, number | null>;
  total: number;
}

export interface PairingResult {
  fields: { file_id: string; name: string; folder: string; nucleus: string; edu: string | null }[];
  unpaired: { file_id: string; name: string; reason: "no_nucleus" | "no_edu" }[];
}

export async function listAnalyses(): Promise<AnalysisInfo[]> {
  return (await json<{ analyses: AnalysisInfo[] }>(await fetch("/api/analyses"))).analyses;
}

export async function createAnalysis(body: {
  name?: string;
  type?: AnalysisType;
  file_ids?: string[];
  folders?: string[];
  params?: Partial<CometParams> | Partial<EduParams>;
  run?: boolean;
}): Promise<AnalysisInfo> {
  return json(await send("/api/analyses", "POST", body));
}

export async function pairAnalysisFiles(body: { file_ids?: string[]; folders?: string[]; edu_kind?: EduKind }): Promise<PairingResult> {
  return json(await send("/api/analyses/pairing", "POST", body));
}

export async function getAnalysis(id: string): Promise<AnalysisInfo> {
  return json(await fetch(`/api/analyses/${id}`));
}

export async function updateAnalysis(
  id: string,
  body: Partial<{ name: string; params: Partial<CometParams> | Partial<EduParams>; groups: Record<string, string>; file_ids: string[] }>,
): Promise<AnalysisInfo> {
  return json(await send(`/api/analyses/${id}`, "PATCH", body));
}

export async function deleteAnalysis(id: string): Promise<void> {
  await json(await send(`/api/analyses/${id}`, "DELETE"));
}

export async function runAnalysis(id: string, fileIds?: string[]): Promise<{ queued: number }> {
  return json(await send(`/api/analyses/${id}/run`, "POST", { file_ids: fileIds ?? null }));
}

export async function getAnalysisResult<T = CometResult>(id: string, fileId: string): Promise<T | null> {
  const res = await fetch(`/api/analyses/${id}/results/${fileId}`);
  if (res.status === 202) return null;
  return json(res);
}

export const getCometResult = (id: string, fileId: string) => getAnalysisResult<CometResult>(id, fileId);

/** One image analysed with draft parameters; nothing is stored. */
export async function previewAnalysis<T = CometResult>(id: string, fileId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return json(
    await fetch(`/api/analyses/${id}/preview`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ file_id: fileId, params }),
      signal,
    }),
  );
}

export async function patchAnalysisResult(
  id: string,
  fileId: string,
  body: {
    deleted?: number[];
    params?: Record<string, unknown>;
    reset_params?: boolean;
    marks?: Record<string, "positive" | "negative" | "excluded">;
    edu_deleted?: number[];
  },
): Promise<unknown> {
  return json(await send(`/api/analyses/${id}/results/${fileId}`, "PATCH", body));
}

export const patchCometResult = patchAnalysisResult;

export async function analysisSummary(id: string, includeOutliers: boolean): Promise<AnalysisSummary> {
  return json(await fetch(`/api/analyses/${id}/summary?include_outliers=${includeOutliers}`));
}

export async function eduSummary(id: string): Promise<EduSummary> {
  return json(await fetch(`/api/analyses/${id}/summary`));
}

export async function exportAnalysis(id: string): Promise<{ id: string }> {
  return json(await send(`/api/analyses/${id}/export`, "POST"));
}

export function analysisImageUrl(
  id: string,
  fileId: string,
  version: number | null | undefined,
  opts: { role?: "nucleus" | "edu"; channel?: number | null } = {},
): string {
  const extra = `${opts.role ? `&role=${opts.role}` : ""}${opts.channel !== undefined && opts.channel !== null ? `&channel=${opts.channel}` : ""}`;
  return `/api/analyses/${id}/image/${fileId}?v=${version ?? 0}${extra}`;
}
