from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ChannelInfo(BaseModel):
    index: int
    name: str
    color: list[int] = Field(description="RGB 0-255")
    emission_nm: float | None = None
    excitation_nm: float | None = None
    modality: list[str] = []
    lut_min: float | None = None
    lut_max: float | None = None
    lut_gamma: float = 1.0
    brightness: float = 1.0
    min_pct: float = 0.0
    max_pct: float = 100.0
    visible: bool = True
    suggested_min: float = 0
    suggested_max: float = 65535


class AxisInfo(BaseModel):
    name: str
    size: int


class LutSetting(BaseModel):
    min: float
    max: float
    gamma: float = 1.0
    brightness: float = 1.0
    min_pct: float | None = None
    max_pct: float | None = None
    visible: bool = True
    color: list[int] | None = None


class ChannelEdit(BaseModel):
    index: int | None = None
    name: str | None = None
    brightness: float | None = None
    min_pct: float | None = None
    max_pct: float | None = None
    lut_min: float | None = None
    lut_max: float | None = None
    gamma: float | None = None
    visible: bool | None = None
    color: list[int] | None = None


class IdentifySummary(BaseModel):
    id: str
    name: str
    size_bytes: int
    status: str
    error: str | None = None
    version: list[int] | None = None
    dtype: str | None = None
    shape: list[int] = []
    axes: list[AxisInfo] = []
    width: int | None = None
    height: int | None = None
    channels: list[ChannelInfo] = []
    voxel_um: list[float] = []
    objective: str | None = None
    magnification: float | None = None
    zoom: float | None = None
    calibrated: bool | None = None
    na: float | None = None
    acquired: str | None = None
    instrument: str | None = None
    software: str | None = None
    bits_significant: int | None = None
    is_rgb: bool = False
    created_at: float | None = None


class FileDetail(IdentifySummary):
    text_info: dict[str, str] = {}
    experiment: list[Any] = []
    events: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {}
    app_info: dict[str, Any] = {}
    groups: dict[str, Any] = {}


class Coord(BaseModel):
    t: int = 0
    z: int = 0
    p: int = 0


class PreviewQuery(Coord):
    composite: bool = True
    scale_bar: bool = True
    format: Literal["jpeg", "png"] = "jpeg"
    quality: int = 88


class MeasureRequest(Coord):
    tool: Literal["point", "line", "rect", "ellipse", "polygon"]
    points: list[list[float]]
    channel: int | None = None


class CropRequest(Coord):
    x: int
    y: int
    w: int
    h: int
    ratio_label: str | None = None
    name: str | None = None
    folder: str | None = None
    mode: Literal["new", "inplace"] = "new"
    channel_edits: list[ChannelEdit] | None = None


class NucleusParams(Coord):
    channel_index: int | None = None
    threshold_method: Literal["Otsu", "Li", "Huang", "Triangle", "Mean", "IsoData", "Moments"] = "Otsu"
    smooth_um: float = 0.5
    min_area_um2: float = 30.0
    max_area_um2: float = 2000.0
    min_circularity: float = 0.4
    watershed: bool = True
    ws_solidity: float = 0.9
    exclude_edges: bool = True


class CropBoxSpec(BaseModel):
    x: int
    y: int
    w: int
    h: int
    ratio_label: str | None = None


class BatchItemApply(BaseModel):
    file_id: str
    crop: CropBoxSpec | None = None
    channel_edits: list[ChannelEdit] | None = None
    name: str | None = None


class BatchApplyRequest(BaseModel):
    items: list[BatchItemApply] = []
    file_ids: list[str] = []
    mode: Literal["inplace", "new"] = "inplace"
    folder: str | None = None
    ratio_label: str | None = None
    unified_channel_edits: list[ChannelEdit] | None = None
    auto_nucleus: bool = False
    nucleus_params: NucleusParams | None = None
    crop_width: int | None = None
    crop_height: int | None = None


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    file_ids: list[str] = []
    settings: dict[str, Any] = {}


class ProjectPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    file_ids: list[str] | None = None
    settings: dict[str, Any] | None = None


class ExportRequest(BaseModel):
    file_ids: list[str] = []
    # Workspace folders to export recursively; resolved to file_ids by the API.
    folders: list[str] = []
    label: str | None = None
    format: Literal["ome-tiff", "tiff", "png", "jpeg"]
    scope: Literal["current", "all"] = "current"
    channels_mode: Literal["composite", "split", "both"] = "composite"
    burn_lut: bool = False
    scale_bar: bool = True
    # Force one bar length (µm) for every image of the export (a figure); None = per image.
    scale_bar_um: float | None = None
    separate_scale_bar: bool = False
    flat_structure: bool = False
    include_metadata: bool = True
    jpeg_quality: int = 90
    coords: Coord = Coord()
    luts: dict[str, LutSetting] | None = None
    visible: list[bool] | None = None
    crops_by_file: dict[str, CropBoxSpec] | None = None
    channel_edits_by_file: dict[str, list[ChannelEdit]] | None = None


class JobInfo(BaseModel):
    id: str
    status: Literal["queued", "running", "done", "error"]
    progress: float = 0
    message: str = ""
    created_at: float
    download_name: str | None = None
    error: str | None = None
    format: str | None = None
    file_ids: list[str] = []
    label: str | None = None
