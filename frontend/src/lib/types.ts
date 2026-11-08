export type Lang = "zh" | "en";
export type Theme = "light" | "dark" | "system";

export interface ChannelInfo {
  index: number;
  name: string;
  color: number[];
  emission_nm: number | null;
  excitation_nm: number | null;
  modality: string[];
  lut_min: number | null;
  lut_max: number | null;
  lut_gamma: number;
  suggested_min: number;
  suggested_max: number;
}

export interface AxisInfo {
  name: string;
  size: number;
}

export interface FileSummary {
  id: string;
  name: string;
  /** Workspace folder path, "" for the root, e.g. "20260918H2/vector 6h". */
  folder: string;
  /** Source format; missing on files imported before OME-TIFF support (= ND2).
   * "lif": one image of an imported Leica LIF project (named by LAS X, no file extension). */
  format?: "nd2" | "ome-tiff" | "tiff" | "lif" | null;
  /** Resolution levels [width, height] of (OME-)TIFF slides, finest first. */
  levels?: number[][] | null;
  size_bytes: number;
  status: string;
  error?: string | null;
  version: number[] | null;
  dtype: string | null;
  shape: number[];
  axes: AxisInfo[];
  width: number | null;
  height: number | null;
  channels: ChannelInfo[];
  voxel_um: number[];
  objective: string | null;
  magnification: number | null;
  na: number | null;
  acquired: string | null;
  instrument: string | null;
  software: string | null;
  bits_significant: number | null;
  is_rgb: boolean;
  created_at: number | null;
  /** Background preparation of the preview after import. */
  prepare?: "pending" | "ready" | "error" | null;
  /** Version of the prepared previews (changes when the cache is rebuilt). */
  prepared_at?: number | null;
  /** True when created by cropping another image in the workspace. */
  cropped?: boolean | null;
  crop?: {
    x: number;
    y: number;
    w: number;
    h: number;
    ratio_label?: string;
    source_id?: string;
    source_name?: string;
  } | null;
}

export interface CropRequest {
  x: number;
  y: number;
  w: number;
  h: number;
  ratio_label?: string;
  name?: string;
  folder?: string;
  t?: number;
  z?: number;
  p?: number;
}

export interface FileDetail extends FileSummary {
  text_info: Record<string, string>;
  experiment: unknown[];
  events: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  app_info: Record<string, unknown>;
  groups: Record<string, unknown>;
  /** Upload of a LIF project: the folder it became and how many images it holds. */
  imported?: { folder: string; count: number } | null;
}

export interface LutSetting {
  min: number;
  max: number;
  gamma: number;
  visible: boolean;
  color: number[];
}

export interface JobInfo {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  created_at: number;
  download_name?: string | null;
  error?: string | null;
  format?: string | null;
  file_ids: string[];
  label?: string | null;
}

export type CodeKind = "permanent" | "temporary";
export type CodeStatus = "active" | "expired" | "disabled";

export interface AccessUser {
  id: string;
  label: string;
  role: "admin" | "user";
  kind: CodeKind;
  expires_at: number | null;
  created_at: number | null;
  last_login_at: number | null;
  disabled: boolean;
  status: CodeStatus;
  usage: { files: number; bytes: number };
}

export interface AccessCode extends AccessUser {
  code: string;
}

/** What an export targets: a set of files and/or whole folders (recursive). */
export interface ExportTarget {
  fileIds: string[];
  folders: string[];
  label: string;
}

export type Tool = "pan" | "probe" | "line" | "rect" | "ellipse" | "polygon";

export interface PackedPlane {
  width: number;
  height: number;
  dtype: "u8" | "u16" | "f32";
  channels: {
    name: string;
    color: number[];
    suggestedMin: number;
    suggestedMax: number;
    data: Float32Array;
  }[];
}

export interface MeasureResult {
  tool: string;
  area_px: number;
  area_um2: number | null;
  length_px: number;
  length_um: number | null;
  channels: {
    name: string;
    count: number;
    min?: number;
    max?: number;
    mean?: number;
    std?: number;
    sum?: number;
  }[];
  profiles?: {
    name: string;
    distance_px: number;
    distance_um?: number;
    values: number[];
  }[];
}

export interface SlideLevel {
  width: number;
  height: number;
  /** Full-resolution width / level width. */
  downsample: number;
  /** Built by the server (2x2 binning) because the file has no such level. */
  virtual: boolean;
}

export interface SlideInfo {
  id: string;
  width: number;
  height: number;
  tile_size: number;
  dtype: string;
  levels: SlideLevel[];
  sizes: { T: number; Z: number; C: number };
  channels: ChannelInfo[];
  autoscale: { index: number; min: number; max: number; gamma: number }[];
  um_per_px: number | null;
  magnification: number | null;
  /** Cache version (see FileSummary.prepared_at). */
  version?: number;
}

export type SlideExportFormat = "ome-tiff" | "tiff" | "png" | "jpeg";

export type RenderModeSetting = "auto" | "browser" | "server";

export interface PerformanceValues {
  render_mode: RenderModeSetting;
  tile_cache_mb: number;
  render_cache_mb: number;
  server_tile_quality: number;
  max_open_files: number;
  prepare_workers: number;
  export_workers: number;
  raster_max_mpx: number;
  local_cache: boolean;
  local_cache_auto: boolean;
  local_cache_mb: number;
  cache_rebuild_users: boolean;
}

export interface PerformanceView {
  values: PerformanceValues;
  schema: Record<
    keyof PerformanceValues,
    { type: "int" | "choice" | "bool"; min?: number; max?: number; default: number | string | boolean; choices?: string[] }
  >;
  status: {
    cpu_count: number | null;
    memory_total: number | null;
    memory_available: number | null;
    tile_cache_bytes: number;
    render_cache_bytes: number;
    open_slides: number;
    exports_running: number;
    exports_waiting: number;
  };
}
