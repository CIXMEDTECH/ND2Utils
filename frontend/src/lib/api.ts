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
