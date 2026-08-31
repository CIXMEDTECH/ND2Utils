# ND2Utils

Self-hosted web tool for Nikon NIS-Elements `.nd2` files: identify, preview, inspect metadata, and batch-export to OME-TIFF / TIFF / PNG / JPEG. An Advanced workspace covers NIS-Elements Viewer-style LUTs, ND dimensions, scale bar, projections, and measurements.

ND2Utils is not affiliated with Nikon or Laboratory Imaging.

---

## 中文

把 ND2 文件丢进浏览器：识别通道与物镜、预览荧光叠加、查看采集信息，再批量导出。需要 LUT、直方图、测量时，进入高级模式。

### 部署

**Docker（推荐）**

```bash
docker compose up -d
```

打开 http://localhost:8080 。数据直接持久化到宿主机的项目目录 `./data`（容器内路径为 `/data`），删除或重建容器不会删除该目录中的文件。


环境变量（前缀 `ND2UTILS_`）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `DATA_DIR` | `./data` | 上传 / 缓存 / 导出 |
| `MAX_UPLOAD_BYTES` | 8 GB | 单文件上限 |
| `TTL_HOURS` | 24 | 自动清理 |
| `BIND_HOST` | `127.0.0.1` | Docker 镜像里是 `0.0.0.0` |

默认只监听本机。若要给实验室局域网用，把 `BIND_HOST` 设为 `0.0.0.0` 并放在反向代理后面。

### 使用

1. 在首页或工作区拖入一个或多个 `.nd2` 文件。
2. 工作区：预览、元信息、勾选文件后导出。
3. 高级模式：通道 LUT、直方图、比例尺、Z/T 投影与切片（无该维度时会提示）、直线/ROI 测量。

TIFF / PNG / JPEG 是 8 位显示图，不能用来定量。定量请导出 OME-TIFF。
OME-TIFF 导出包同时包含文件名带 `DISPLAY` 的 8 位预览 TIFF；预览图用于系统看图和演示，`.ome.tif` 与原始通道 TIFF 用于定量分析。

文件、预览和导出记录按浏览器会话隔离；同一浏览器的标签页共享数据，不同浏览器或无痕窗口互不可见。这是匿名会话隔离，不等同于账号登录，公开部署仍应放在带身份认证的反向代理后面。


## English

Upload `.nd2` files, inspect channels and optics, preview composites, and batch-export. Advanced mode follows NIS-Elements Viewer workflows (LUT, histogram, ND bar, scale bar, MIP, ROI).

### Deploy

```bash
docker compose up -d
```

Open http://localhost:8080. Persistent data is stored directly in the host directory `./data`. Bind address defaults to localhost; set `ND2UTILS_BIND_HOST=0.0.0.0` only behind a proxy.


### Notes

- Large files are read plane-by-plane. Do not expect the whole T×Z cube in RAM.
- OME-TIFF keeps native bit depth. TIFF / PNG / JPEG apply the on-screen LUT and are 8-bit.
- OME-TIFF exports also include bright 8-bit TIFF companions marked `DISPLAY`; use those for ordinary viewers and the raw `.ome.tif`/channel TIFF files for analysis.
- Files, previews, and export jobs are isolated by browser session. This is anonymous session isolation rather than account authentication; public deployments should still use an authenticating reverse proxy.
- The local `ND2demo/` directory is a development-only fixture and is not included in git. The application does not read it at runtime, and Docker excludes it from the build context.
