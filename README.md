# Lucida 明室

Self-hosted microscopy workbench for Nikon `.nd2`, Leica `.lif`, OME-TIFF and plain TIFF images: import and organise files like a file manager, inspect and measure, edit and compose figures with magnification-aware scale bars, quantify comet assays, and batch-export to OME-TIFF / TIFF / PNG / JPEG.

Formerly ND2Utils — the repository, Docker image (`ghcr.io/cidmex/nd2utils`), environment variables (`ND2UTILS_*`) and data layout keep that name. Lucida is not affiliated with Nikon, Laboratory Imaging or Leica Microsystems.

---

## 中文

Lucida 明室（原 ND2Utils）是一个自托管的显微图像工作台：把 ND2 / LIF / OME-TIFF / TIFF 拖进浏览器，像文件管理器一样整理，查看通道、物镜和采集信息，精细查看与测量，多图编辑拼图，彗星实验统计，最后批量导出。

### v1.1 新功能（beta）

- **更流畅**：导入时不再卡住其他操作（文件打开锁按文件拆分、上传写盘移出事件循环、导出任务独立线程池、未准备好的预览立即返回并优先处理；前端轮询不再整页重渲染）。
- **字体**：内置思源黑体（Noto Sans SC）+ Inter，字号整体加大；“设置 → 语言与外观 → 字号”可选 标准 / 大 / 特大。
- **文件管理器**：拖动文件或文件夹到另一个文件夹即可移动；Ctrl/⌘+X 剪切、Ctrl/⌘+V 粘贴；右键“移动到…”；Shift / Ctrl 多选；移动后可撤销。点文件夹在中间显示文件夹视图（列表或缩略图）。
- **元信息与比例尺**：自动读取物镜倍数和共聚焦 zoom；比例尺长度按“物镜 × zoom”查表（100x → 10 µm 起，保持在图宽的 8%–40%），预览、裁切、项目编辑和导出一致；没有像素标定的图不再画假比例尺。
- **按倍镜整理**：右键文件夹“按倍镜整理…”，把文件分到 `100x`、`100x zoom3` 这样的子文件夹（先预览，可撤销）；上传栏可勾选“导入后按倍镜整理”。“全部重新分组”：忽略已有的倍镜文件夹，把整个文件夹树里的文件按当前识别的倍镜重新放好（实验子文件夹保留，清空的旧倍镜文件夹自动删除），需二次确认，可撤销。
- **彗星实验统计**（导航“分析”）：复刻 OpenComet 算法，自动找彗星、定位头部，计算尾部 DNA%、尾矩、Olive 尾矩等 16 项指标；点击彗星可删除 / 恢复；按实验组汇总（均值、标准差、SEM、中位数，可含离群）并画箱线图；导出 `comets.csv`、`summary.csv` 和标注图。
- **EdU 增殖分析**：在核通道（DAPI / Hoechst）分割全部细胞核（距离变换分水岭拆分粘连核），在红 / 绿 EdU 通道判定阳性，EdU 阳性比例 = 阳性细胞数 / 细胞核总数。两种计数方式可切换：以核为准（核内 EdU 平均强度高于阈值，默认 Li 自动阈值、全部图像合并计算），或两通道各自计数；阈值可在直方图上拖动，即时生效。DAPI / EdU 分开保存的图像（如 EVOS `…_DAPI.tiff` + `…_GFP.tiff`）按文件名自动配对。点击细胞核可改判或排除；按组汇总（视野数、合并比例、均值 ± SD）；导出 `fields.csv`、`nuclei.csv`、`edu_objects.csv`、`summary.csv` 和标注图。
- **先调参、再分析**：彗星实验和 EdU 分析新建后不再直接批量运行，先在当前图上调参数并实时预览（不保存），满意后再分析全部图像；彗星实验新增高级参数（阈值方法与偏移、中值 / 滚球半径、开运算、面积上限、贴边、凸度 / 对称性 / 中线等有效与离群规则），默认值与 OpenComet 一致。
- **导出记录**：可逐条删除、取消正在进行的导出、多选删除、一键清除已完成。
- **新的首页与导航**：文件 · 查看 · 编辑 · 分析 · 导出 · 设置；首页按任务进入，并列出最近的编辑项目和分析。

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
   预览还会缓存在用户浏览器本地（IndexedDB）：导入的文件准备好后自动下载到本地，之后浏览、刷新页面都直接从本地读取，不再走网络。
   右键文件或文件夹选“重建缓存”可重新生成预览（勾选多个文件时作用于全部勾选的文件），各浏览器中的旧副本会自动更新。
   “设置 → 本地预览缓存”显示本浏览器已缓存的数量，可一键清除；退出登录时自动清除。
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
   - 预览缓存：是否开启浏览器本地缓存、导入后是否自动建立缓存、是否允许普通用户右键重建缓存（管理员始终可以）、每个浏览器的本地缓存上限（默认 2 GB，超出时先删除最久未看的）。关闭本地缓存后，各浏览器中已保存的预览会被清除。
   - 卡片上方实时显示服务器 CPU 核心数、内存、缓存占用和导出任务情况。参数保存在 `data/performance.json`。

TIFF / PNG / JPEG 是 8 位显示图，不能用来定量。定量请导出 OME-TIFF：
`*.ome.tif` 保留原始像素值（12 位数据存放在 16 位文件中，普通看图软件里会很暗），供 Fiji / QuPath / napari 分析；
同名的 `*.tif` 是应用了显示 LUT 的 8 位图，可直接用系统看图或放入 PPT。在高级模式中隐藏的通道不会被导出为文件。


## English

Lucida (formerly ND2Utils) is a self-hosted microscopy workbench: drop ND2 / LIF / OME-TIFF / TIFF files into the browser, organise them like a file manager, inspect channels, optics and acquisition data, measure, compose figures, quantify comet assays, and batch-export. Advanced mode follows NIS-Elements Viewer workflows (LUT, histogram, ND bar, scale bar, MIP, ROI).

### New in v1.1 (beta)

- Responsive while importing: per-file open locks, uploads written off the event loop, exports on their own pool, previews of files still being prepared answer at once and jump the queue; the UI no longer re-renders everything on each poll.
- Bundled Noto Sans SC + Inter, larger type, and a text size setting (standard / large / extra large).
- File manager: drag files and folders onto folders, Ctrl/⌘+X / Ctrl/⌘+V, “Move to…”, Shift/Ctrl multi-select, undo; opening a folder shows its contents as a list or thumbnails.
- Optics metadata (objective, confocal zoom, calibration) and magnification-aware scale bars shared by previews, crops, Studio and exports; uncalibrated images get no bar.
- “Sort by magnification…” puts files into `100x` / `100x zoom3` subfolders (preview, undo), optionally right after import. “Regroup everything”: existing magnification folders are dissolved and every file in the tree is placed again by its current magnification (experiment subfolders are kept, emptied magnification folders removed), after a second confirmation and with undo.
- Comet assay analysis (OpenComet re-implementation): comets, heads, tail DNA %, tail moment, Olive moment and more; click to remove comets; per-group statistics and box plots; CSV tables and overlay images.
- EdU proliferation: nuclei segmented in DAPI / Hoechst (touching nuclei split by a distance-transform watershed), EdU+ judged in the red or green channel, EdU+ ratio = EdU+ cells / nuclei. Count per nucleus (mean EdU intensity above a threshold; Li by default, pooled over all images; drag it on the histogram) or count each channel separately — switchable at any time. Nuclear and EdU images saved separately (e.g. EVOS `…_DAPI.tiff` + `…_GFP.tiff`) are paired by name. Click nuclei to flip or exclude them; per-group statistics; `fields.csv`, `nuclei.csv`, `edu_objects.csv`, `summary.csv` and overlays.
- Tune first, then analyse: comet and EdU analyses open in set-up mode with a live, unsaved preview of the current image; the batch runs when you start it. Comet analysis gains advanced parameters (threshold method/offset, filter radii, opening, area limits, border handling, validity and outlier rules) with OpenComet's values as defaults.
- Export records can be deleted (running exports are cancelled), in bulk, or cleared.
- New start page and navigation: Files · Inspect · Edit · Analyze · Exports · Settings.

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
- Browsers also keep previews locally (IndexedDB): prepared previews are downloaded in the background right after import, so browsing and reloading need no network. Right-click a file or folder → Rebuild cache to prepare previews again; local copies update automatically. Settings → Local preview cache shows what this browser holds and clears it; signing out clears it too. Administrators turn the local cache, automatic caching after import and rebuilding by non-admin users on or off, and set the per-browser size limit (default 2 GB, least recently viewed dropped first), under Settings → Performance.
- Administrators can copy or move files and folders between any two workspaces (Settings → Access codes → Copy / move files, or the workspace context menu).
- Leica `.lif` files are whole projects: uploading one creates a folder named after the file (`BRD9 VECTOR.lif` → `BRD9 VECTOR/`) with one workspace file per image (series); the project's own folders become subfolders. The images work like ND2 files (preview, Advanced mode with Z/T/mosaic positions, projections, measurements, batch export) with channel names, LUT colors, wavelengths, objective, pixel size and scan settings taken from the LIF metadata. All images of a project share one copy of the uploaded data (hard links). Uploading the same .lif again replaces images with the same name. Raw FLIM histogram data is not supported.
- OME-TIFF keeps native bit depth in `*.ome.tif` (12-bit data looks dark in ordinary viewers). Each one has an 8-bit `*.tif` with the same name and the display LUT applied. TIFF / PNG / JPEG are 8-bit display images. Hidden channels are not exported.
- Comet assay: images should show comets lying horizontally with the head on the left (other directions are rotated first, see the “tail direction” parameter). Per-comet numbers follow OpenComet, including its pixel units for lengths and areas; µm columns are added for calibrated images. Summary medians are computed correctly (OpenComet's are off for even counts).
- The local `ND2demo/` directory is a development-only fixture and is not included in git. The application does not read it at runtime, and Docker excludes it from the build context.
