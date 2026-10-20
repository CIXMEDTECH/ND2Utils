# ND2Utils

Self-hosted web tool for Nikon NIS-Elements `.nd2` files: identify, preview, inspect metadata, and batch-export to OME-TIFF / TIFF / PNG / JPEG. An Advanced workspace covers NIS-Elements Viewer-style LUTs, ND dimensions, scale bar, projections, and measurements. Multi-channel (whole-slide) OME-TIFF files open in a tiled slide viewer. Leica `.lif` projects are imported as a folder with one entry per image.

ND2Utils is not affiliated with Nikon, Laboratory Imaging or Leica Microsystems.

---

## 中文

把 ND2 文件丢进浏览器：识别通道与物镜、预览荧光叠加、查看采集信息，再批量导出。需要 LUT、直方图、测量时，进入高级模式。

### 部署

**Docker（推荐）**

```bash
docker compose up -d
```

打开 http://localhost:8080 。数据直接持久化到宿主机的项目目录 `./data`（容器内路径为 `/data`），删除或重建容器不会删除该目录中的文件。

**首次部署的管理员授权码**：第一次启动时自动生成，并输出在服务日志中（`docker compose logs nd2utils`）。用它登录后，在“设置 → 授权码管理”中为其他用户发放授权码；登录后也可以在该页面再次查看管理员授权码。


环境变量（前缀 `ND2UTILS_`）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `DATA_DIR` | `./data` | 上传 / 缓存 / 导出 |
| `MAX_UPLOAD_BYTES` | 8 GB | 单文件上限 |
| `TTL_HOURS` | 24 | 临时用户文件与所有导出包的保留时长 |
| `BIND_HOST` | `127.0.0.1` | Docker 镜像里是 `0.0.0.0` |

默认只监听本机。若要给实验室局域网用，把 `BIND_HOST` 设为 `0.0.0.0` 并放在反向代理后面。

### 授权与工作空间

- 所有页面和接口都需要授权码登录。每个授权码拥有唯一的工作空间，用同一授权码在不同浏览器登录看到的是同一个工作空间。
- 管理员可为每个授权码设置备注、有效期（永久 / 1–90 天 / 自定义）和用户类型，也可停用、重新生成或删除授权码（删除会同时删除其工作空间）。
- **临时用户**：文件在上传 `TTL_HOURS` 小时后自动删除；授权码过期后整个工作空间被清理。
- **永久用户**：工作空间内容不会自动删除；授权码过期只会阻止登录，数据保留。
- 导出包（zip）对所有用户都只保留 `TTL_HOURS` 小时，请及时下载。

### 使用

1. 在首页或工作区拖入 `.nd2` 文件或整个文件夹（也可点“选择文件夹”），目录结构会原样保留。
2. 工作区左侧是文件树：右键文件或文件夹可导出、上传到此处、新建文件夹、重命名、删除（触屏设备点 `⋯`）。文件树支持搜索、全部展开/折叠，拖动右边缘可调整宽度。
   每个文件导入后会在后台初始化（预先计算自动亮度和预览数据，缓存在 `data/cache`），之后打开文件无需等待；初始化中的文件旁会显示转圈图标。
   管理员可通过右键菜单或“设置 → 授权码管理 → 转移 / 复制文件”，在任意两个工作空间之间（或同一工作空间内）复制、转移文件和文件夹。
3. 导出包内的文件位于与原 ND2 文件相同的目录中，例如 `20260918H2/vector 6h/MB2310439_DAPI.png`。
4. 高级模式：通道 LUT、直方图、比例尺、Z/T 投影与切片（无该维度时会提示）、直线/ROI 测量。
5. OME-TIFF（`.ome.tif` / `.ome.tiff`，也支持普通 `.tif`）：上传后在工作区预览多通道叠加，点“打开全片查看器”进入全片查看：
   - 分块、多分辨率浏览，滚轮/双指缩放、拖动平移、导航图、比例尺；适合几十亿像素的全片扫描图。
   - 每个通道可单独开关、改颜色、调黑场/白场/Gamma，或“只看此通道”。
   - 视野截图：按当前视野、通道颜色和显示范围保存 PNG（1×/2×/4×，可带比例尺与通道图例）。
   - 导出（后台任务）：范围可选当前视野 / 框选区域 / 整张切片，可选分辨率层级与通道；
     OME-TIFF 保留原始像素值（分块、金字塔），TIFF/PNG/JPEG 为 8 位合成图。
   - 文件自带的金字塔层级会直接使用；没有金字塔的大图在导入后台准备时自动生成缩略层级（缓存在 `data/cache`）。
6. Leica LIF（`.lif`）：一个 .lif 文件通常就是整个项目，导入后在目标位置生成与文件同名的文件夹（如 `BRD9 VECTOR.lif` → `BRD9 VECTOR/`），
   项目里的每个图像（Series）成为其中的一个文件，LAS X 中的子文件夹结构原样保留。这些图像与 ND2 一样可以预览、进入高级模式（Z/T/拼接位置、投影、测量）和批量导出；
   通道名、LUT 颜色、激发/发射波长、物镜、像素尺寸和扫描参数取自 LIF 元数据。各图像共享同一份上传数据（硬链接），不会重复占用磁盘；
   再次上传同一 .lif 会替换同名图像。暂不支持原始 FLIM 直方图数据。
7. 性能设置（仅管理员，“设置 → 性能设置”）：保存后立即生效，无需重启。
   - 切片渲染方式：**自动**（用户电脑有显卡时在浏览器中用 GPU 合成，否则由服务器合成）、**用户浏览器**、**服务器**（服务器合成好 JPEG 图块再发送，适合用户电脑性能弱；服务器不需要显卡）。
   - 瓦片解码缓存、服务器合成缓存、JPEG 质量、同时打开的文件数、后台准备线程数、同时运行的导出任务数（超出的排队）、PNG/JPEG 导出像素上限。
   - 卡片上方实时显示服务器 CPU 核心数、内存、缓存占用和导出任务情况。参数保存在 `data/performance.json`。

TIFF / PNG / JPEG 是 8 位显示图，不能用来定量。定量请导出 OME-TIFF：
`*.ome.tif` 保留原始像素值（12 位数据存放在 16 位文件中，普通看图软件里会很暗），供 Fiji / QuPath / napari 分析；
同名的 `*.tif` 是应用了显示 LUT 的 8 位图，可直接用系统看图或放入 PPT。在高级模式中隐藏的通道不会被导出为文件。


## English

Upload `.nd2` files, inspect channels and optics, preview composites, and batch-export. Advanced mode follows NIS-Elements Viewer workflows (LUT, histogram, ND bar, scale bar, MIP, ROI).

### Deploy

```bash
docker compose up -d
```

Open http://localhost:8080. Persistent data is stored directly in the host directory `./data`. Bind address defaults to localhost; set `ND2UTILS_BIND_HOST=0.0.0.0` only behind a proxy.

On first start an admin access code is generated and printed to the server log (`docker compose logs nd2utils`). Sign in with it and issue codes for other users under Settings → Access codes, where the admin code is shown again.


### Notes

- Large files are read plane-by-plane. Do not expect the whole T×Z cube in RAM.
- OME-TIFF (`.ome.tif` / `.ome.tiff`, plain `.tif` too) opens in the slide viewer: tiled multi-resolution browsing (wheel/pinch zoom, pan, overview map, scale bar), per-channel visibility / color / range / gamma, view snapshots (PNG), and background exports of the current view, a selected region or the whole slide at any pyramid level — raw OME-TIFF (tiled, pyramidal) for the chosen channels or an 8-bit TIFF / PNG / JPEG composite. Existing pyramid levels are used as is; large images without one get generated overview levels during background preparation.
- Administrators tune performance under Settings → Performance (applied immediately, stored in `data/performance.json`): slide rendering (automatic / user's browser GPU / server-rendered JPEG tiles — the server needs no GPU), tile and composite cache sizes, JPEG quality, open files, preparation threads, concurrent exports (others queue), and the PNG/JPEG export size limit, next to live CPU / memory / cache figures.
- Every page and API call requires an access code. Each code owns one workspace. Codes have an optional expiry and are either *temporary* (files removed after `TTL_HOURS` and when the code expires) or *permanent* (never cleaned up automatically). Export archives are kept for `TTL_HOURS` for everyone.
- Upload files or whole folders; the workspace keeps the folder tree. Right-click a file or folder to export it — exported files land in the same folders as their ND2 source inside the zip.
- Every imported file is prepared in the background (auto-contrast and an 8-bit preview cached in `data/cache`), so opening it later is immediate.
- Administrators can copy or move files and folders between any two workspaces (Settings → Access codes → Copy / move files, or the workspace context menu).
- Leica `.lif` files are whole projects: uploading one creates a folder named after the file (`BRD9 VECTOR.lif` → `BRD9 VECTOR/`) with one workspace file per image (series); the project's own folders become subfolders. The images work like ND2 files (preview, Advanced mode with Z/T/mosaic positions, projections, measurements, batch export) with channel names, LUT colors, wavelengths, objective, pixel size and scan settings taken from the LIF metadata. All images of a project share one copy of the uploaded data (hard links). Uploading the same .lif again replaces images with the same name. Raw FLIM histogram data is not supported.
- OME-TIFF keeps native bit depth in `*.ome.tif` (12-bit data looks dark in ordinary viewers). Each one has an 8-bit `*.tif` with the same name and the display LUT applied. TIFF / PNG / JPEG are 8-bit display images. Hidden channels are not exported.
- The local `ND2demo/` directory is a development-only fixture and is not included in git. The application does not read it at runtime, and Docker excludes it from the build context.
