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
    suggested_min: float = 0
    suggested_max: float = 65535


class AxisInfo(BaseModel):
    name: str
    size: int


class LutSetting(BaseModel):
    min: float
    max: float
    gamma: float = 1.0
    visible: bool = True
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
    name: str | None = None
    folder: str | None = None


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
    include_metadata: bool = True
    jpeg_quality: int = 90
    coords: Coord = Coord()
    luts: dict[str, LutSetting] | None = None
    visible: list[bool] | None = None


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
