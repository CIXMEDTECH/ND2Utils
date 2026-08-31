import type { FileDetail, FileSummary, JobInfo, MeasureResult } from "./types";

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

async function parseError(res: Response): Promise<Error> {
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

export async function health() {
  return json<{ ok: boolean; max_upload_bytes: number; ttl_hours: number }>(await fetch("/api/health"));
}

export async function listFiles(): Promise<FileSummary[]> {
  const data = await json<{ files: FileSummary[] }>(await fetch("/api/files"));
  return data.files;
}

export async function getFile(id: string): Promise<FileDetail> {
  return json<FileDetail>(await fetch(`/api/files/${id}`));
}

export async function deleteFile(id: string) {
  return json(await fetch(`/api/files/${id}`, { method: "DELETE" }));
}

export function previewUrl(
  id: string,
  opts: {
    t?: number;
    z?: number;
    p?: number;
    composite?: boolean;
    scale_bar?: boolean;
    visible?: boolean[];
  } = {},
): string {
  const q = new URLSearchParams();
  q.set("t", String(opts.t ?? 0));
  q.set("z", String(opts.z ?? 0));
  q.set("p", String(opts.p ?? 0));
  q.set("composite", opts.composite === false ? "false" : "true");
  q.set("scale_bar", opts.scale_bar === false ? "false" : "true");
  if (opts.visible?.some((value) => !value)) {
    q.set("visible", opts.visible.map((value) => (value ? "1" : "0")).join(","));
  }
  return `/api/files/${id}/preview?${q.toString()}`;
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

export async function startExport(body: Record<string, unknown>): Promise<JobInfo> {
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
  onProgress?: (ratio: number) => void,
): Promise<FileDetail> {
  if (!file.name.toLowerCase().endsWith(".nd2")) {
    throw new Error("not_nd2");
  }
  const chunkLimit = 32 * 1024 * 1024;
  const chunkSize = 8 * 1024 * 1024;
  if (file.size <= chunkLimit) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const res = await new Promise<Response>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files");
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
      body: JSON.stringify({ filename: file.name, size: file.size }),
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
