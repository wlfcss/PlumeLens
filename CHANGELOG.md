# 更新日志

按版本记录主要功能、修复与兼容性变化。

## 未发布

### 新增

- **客户端日志与诊断模块**：
  - **匿名设备标识**：根据系统机器码（macOS `IOPlatformUUID` / Windows `MachineGuid`）经单向 `HMAC-SHA256` 派生唯一设备标识 `pl-*`，不落盘或暴露原始硬件序列号，并与后端会话标识 `session_id`、请求追踪头 `X-PlumeLens-Request-Id` 贯穿全链路。
  - **硬件与运行环境画像**：异步采集程序所在磁盘与数据缓存盘（文件系统、容量/余量、SSD/HDD 介质、总线协议与型号）、CPU（含 Apple Silicon 性能核/能效核与缓存）、内存（含统一内存与进程占用）及显卡（含 macOS GPU 核数/Metal、Windows 64 位显存与推理后端绑定状态）。
  - **全任务节点耗时与匿名图片特征**：在启动初始化、文件夹扫描、缩略图生成、单张照片推理（细分指纹校验、缓存查询、解码、YOLO、裁切、姿态、飞版分类、CLIPIQA+、HyperIQA、物种识别与入库耗时）、批量导出及活跃任务资源心跳中记录结构化指标；所有照片文件名均按设备盐做不可逆短哈希匿名（配对 JPG+RAW 同 stem 对齐），并就地脱敏本地路径、访问令牌与地图密钥。
  - **知情同意、热开关与设置页分栏**：首次打开应用时以清晰的中文弹窗说明日志范围与隐私边界，允许用户自由选择开启或暂不开启（未同意前不写日志文件）；设置弹窗升级为左侧四分栏导航，新增独立「日志与诊断」分栏，支持无需重启引擎即时开关日志、切换标准/调试级别、复制匿名设备标识、清空历史日志及**一键导出脱敏 ZIP 日志包**（内含中文 `SUMMARY.txt` 速览、硬件配置、任务耗时统计与脱敏数据库摘要）。

### 修复与加固

- **全栈审计稳定性与安全加固**：
  - **缓存版本白名单与资产校验**：`PipelineManager._compute_version()` 切换为显式 31 字段白名单，彻底避免运行期日志开关、设备/会话标识变动触发推理缓存失效；加载 species v4 PyTorch 权重前先执行 `manifest.json` 完整性校验；为检测、姿态与画质坐标补齐 NaN/Inf 及零宽高边界防护。
  - **Windows 内存限流死锁修复**：修复 `windows_resources.py` 在可用内存落在保留线以上不足 1 GiB 区间时，入场准入与限流条件不一致导致的永久阻塞。
  - **主进程与跨桥安全收紧**：全量收紧敏感 IPC 的 `senderFrame === mainFrame` 校验；`shell.openPath` 显式拦截 macOS 可执行应用包（`.app`/`.pkg`/`.workflow` 等）；移除 `entitlements.mac.plist` 中的 `allow-dyld-environment-variables`；系统硬件探测与外部打开命令统一改用绝对系统路径；前后端脱敏正则全部改为严格线性时间语法消除 ReDoS 风险，并将 `SUMMARY.txt` 与 `system-profile.json` 纳入脱敏范围；客户端日志补充排空与退避重试，后端原生 stderr 增加体积上限并与日志开关联动；配置、设备标识与硬件画像改用统一原子写盘。
  - **打包与 CI 防护**：修复 `plumelens-engine.spec` 清理规则误删 `torch/testing` 与 `numpy/_pytesttester` 的冲突，并改为基于 `SPECPATH` 定位仓库根目录；`build-engine.cjs` 增补 `engine/data/` 数据资产追踪与 Python 版本戳校验；PR CI 纳入 `npm run build` 生产构建验证，实包冒烟测试加强真实检出与分档断言。

### 性能与架构

- **数据库与并发吞吐升级（Schema v14）**：
  - SQLite 升级至 **Schema v14**，补充 7 条高频复合与部分索引（场景/地理/时间排序/待补哈希/队列领取与卡死扫描），启用 `cache_size = -64000` 与 `mmap_size = 256 MB`，读连接升级为 4 连接有界 `query_only=ON` 连接池并将业务只读路径全面迁移至非阻塞 `read_snapshot()`；羽迹 JSON 投影与地理聚合移入工作线程并消除冗余 Pydantic 往返校验；诊断统计改用 `os.scandir` + 10s TTL 缓存。
  - 队列入队改写为 500 条分块集合化 SQL；删除图库前联动取消活跃分析与导出任务；`pause`/`resume`/`cancel` 按库加锁串行化；FastAPI 鉴权与追踪中间件由 `BaseHTTPMiddleware` 重构为纯 ASGI 中间件，且生产态彻底禁用 URL 查询串 token。
- **推理与解码内存/速度优化**：
  - RAW 解码新增纯 NumPy `orient_array()` 就地转正，避免 PIL 整幅 48MP 拷贝，峰值内存降低 **50%+**；`SpeciesClassifier` 加载期将 48 层 LoRA 权重融合至主干矩阵并新增 `classify_batch()` 多鸟批量推理；YOLO CPU 回退模型改为首次 GPU 失败时按需懒加载（常驻内存节省约 300 MB）；限流 CUDA/ROCm `empty_cache` 并关闭 OpenCV 内部多线程争用。
- **前端大库流畅度与跨桥取消**：
  - 网格卡片不再请求 1920px 预览图，缩略图缓存升级为有界 LRU（4096）并合并为单全局焦点/可见性监听；移除全局无限网格漂移背景动画与卡片入场 `blur()` 滤镜；滚动锚点捕获改为 180ms 停止后防抖；消除物种聚合与地图点位中的 $O(K^2)$ 查重；实现跨 Electron preload 边界的真实 `AbortSignal` 请求取消与 SSE 指数退避重连（1s→15s）。
  - 异步化诊断 ZIP 打包（启用 Node 24 原生 `zlib.crc32` 与非阻塞文件读取）、物种封面索引内存缓存及 `Cache-Control: immutable`。
- **工程解耦与包体优化**：
  - 新增 `shared/ipc.ts` 统一主进程/Preload/渲染层 IPC 契约；将更新检查、外部编辑器、关闭确认与原子写盘从 `electron/main.ts` 拆分独立（主文件精简 600+ 行）；将后端后台分析 worker 从路由层抽离至 `engine/services/analysis_worker.py` 消除循环依赖；`electron.vite.config.ts` 配置 `manualChunks` 拆分第三方依赖，主入口包体由 **1,373 kB 降至 756 kB（-45%）**。

## 0.7.9

发布日期：2026-11-24。桌面运行时升级至 Electron 45.4.1（macOS 最低基线 14.0+），全面升级 Python/JS 依赖，大幅提升 Apple Silicon 推理吞吐并完成全栈审计与 CI/测试体系重构。[发布说明](docs/releases/0.7.9.md)

### 新增

- 深度复核新增同组 A/B 两帧并排对照（快捷键 `C` 开关），支持同步放大平移、`A`/`B` 焦点切换独立评级、帧 B 前后步进及 `Esc` 返回原复核位置；同时在复核面板直观解释当前有效档位、姿态升降档、人工覆盖及无鸟/失败原因。
- 导出面板新增面向 Lightroom 的内置导出预设（标准导入 / 精选分档 / 仅 XMP 边车）及自定义命名预设管理。
- 新增后端全局羽迹物种聚合接口 `/archive/species/summary`；羽迹页在已有个人确认记录时默认优先展示个人收集视图，保留一键切换完整图鉴，地图补齐离线待解析与加载失败重试状态。
- 新增按 ID 批量水合接口 `POST /library/{id}/photos/batch`、服务端选片查询分页参数（`limit`/`offset`/`next_offset`）以及 `compact-v1` 紧凑摘要编码，并统一服务端响应预算与观测头（`X-PlumeLens-Projection-Ms`/`Photo-Count`/`Payload-Bytes`）。

### 升级与兼容

- 升级 Electron 运行时至 `45.4.1`（Chromium 156 / Node 24.22），并将 macOS 最低系统版本基线提升至 **`14.0`（Sonoma）**以支持 PyTorch 2.14.x MPS 加速：
  - 适配 Electron 42+ 取消 postinstall 下载机制，新增 `npm run ensure:electron` 与 CI 显式安装步骤，修复开发态 Electron 二进制路径解析。
  - 适配 Electron 43+ 原生文件夹选择器默认目录变化，独立持久化导入/导出最近路径并传入 `defaultPath`。
  - 迁移 `electron/user-settings.ts` 至 Electron 45+ 异步 `safeStorage` API（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync` 及 `shouldReEncrypt` 自动重加密），并改为 `0o600` 原子写盘与损坏容错。
  - 启用 `electron-vite` main/preload/renderer `esbuild` 压缩与显式 `node24`/`chrome156` 编译目标。
- **历史版本原地升级兼容**：
  - 升级后对已有图库执行「开始分析」（`force_rerun=false`）默认跳过已有有效 `is_active=1` 且源输入未变的历史分析结果（即使推理依赖升级导致 `pipeline_version` 变化），仅分析新增或变更照片；显式传 `force_rerun=true` 仍可用新版本引擎全量重跑。
  - 新版 CoreML 编译缓存加载成功后自动清理历史 `cache/coreml/ort-*` 旧版本缓存目录，防止升级累积磁盘占用。
- 全面升级 Python 与前端依赖（OSV 复扫 Python 73 个包 **0 漏洞**，前端生产依赖 **0 漏洞**）：
  - **图像与相机解码**：升级 `pillow 12.2.0 → 13.0.0`（修复数十个图像解码器 Critical/High 漏洞）、`rawpy 0.26.1 → 0.28.0`（底层 LibRaw `0.22.2`，新增 Nikon Z6 III/Z8/Z9 HE*、Canon R6 Mark III、Sony A7 V/A7R VI、OM-3 与 DNG 1.7 等机身格式支持）。
  - **推理引擎**：升级 `onnxruntime 1.25.0 → 1.32.0`（macOS/Linux CoreML 初始化与内存优化）、`torch 2.11.0 → 2.14.1` + `torchvision 0.26.0 → 0.29.2`（锁定 `<2.15` 保持 macOS 14+ 兼容，获得 AOT Metal shaders / FlexAttention / `bf16` GEMV 与 MPS allocator 优化）、`transformers 5.6.2 → 5.24.0`、`safetensors 0.7.0 → 0.8.0`。
  - **Web / 安全 / 序列化栈**：升级 `fastapi 0.165.0`、`starlette 1.10.0`、`anyio 4.16.0`、`pydantic 2.14.4`、`pydantic-core 2.50.5`、`pydantic-settings 2.16.3`、`certifi 2026.11.20`、`idna 3.20`、`filelock 4.3.1`、`uvicorn 0.54.0`、`structlog 26.1.0`、`pyinstaller 6.22.3`。
  - **前端与工具链**：升级 `echarts 6.1.0`（修复 tooltip XSS 并优化轴缩放性能）、`i18next 26.7.2`、`react 19.3.1`、`@tanstack/react-query 5.108.4`、`@tanstack/react-virtual 3.14.28`、`zustand 5.1.0`、`tailwindcss 4.3.5`、`vite 7.3.8`、`vitest 4.1.12`、`electron-builder 26.18.0`、`@playwright/test 1.65.1`、`@types/node 24`。

### 修复

- **安全与主进程加固**：彻底移除向渲染层泄露 Bearer Token 的 `window.plumelens.engineSseUrl`；收紧 `isTrustedAppNavigation` 仅允许应用 `index.html`、`open-path-in-finder` 对文件改走 `showItemInFolder`、`open-in-editor` 校验常规文件；校验敏感 IPC sender；修复 `preload.ts` `ensureAuth()` 竞态、401 缓存失效与 SSE reader 清理；修复 `ProcessManager.restart()` 与崩溃重启竞态及日志流句柄泄漏；修复最小化窗口触发关闭确认弹窗卡死问题；收紧 macOS CI workflow 权限并将发布拆分至独立 `publish` job。
- **后端全量审计修复**：修复并发数据库关闭锁顺序与停机清理顺序；修复多线程推理器热重载/关闭空指针；修复多鸟重排时清除人工物种误删他鸟标注；为羽迹缓存加入代际版本号防陈旧快照回写，并将地理聚合切换至非阻塞 WAL 只读快照；修复导出目标重名拼接、缺图/未使用同伴文件误中断与 XMP XML 1.0 控制字符清洗；修复清空本地历史残留 `selection_projections` 与导出任务；修复扫描器跨库路径冲突与大库哈希补算游标分页；修复批处理启动锁、暂停态库状态与 SSE 心跳/断连退出。
- **前端逻辑与 UI/UX 优化**：修复首页因 `.start-screen` 纵向滚动与底部装饰鸟图负边距溢出导致页面可竖滚及 `.pipeline-bar` 脱离底边问题（改用 `overflow: clip` + 独立裁切容器 + 最近文件夹自适应内滚）；修复删除当前图库 404/SSE 残留、健康检查与队列轮询频率控制、物种墙与选片网格虚拟列表滚动偏移重排；修复导出预设样式、导出前检失败锁死表单、未定义 CSS 变量与动画名；修复深度复核 A/B 对照右栏未跟随帧 B 与双栏头高度错位、羽迹窄屏右侧详栏截断不可滚动、堆叠卡片嵌套按钮键盘陷阱；将全屏复核与地图点位详卡统一迁移至原生 `<dialog>`；补齐 IME 组合态保护、焦点环、ARIA 状态与中英文 i18n 文案。

- 重新关联图库时验证照片及同伴文件的身份。同内容迁移可继续复用已有分析和人工修正，内容变化或身份无法核验的条目需要重扫。
- 导出 JPEG 与 RAW `.xmp` 边车时均安全合并已有标准 XMP，保留原有 Lightroom 调色、关键词与编辑字段；遇到扩展、超限或损坏 XMP 时原样保留原文件/原边车，并在导出清单明确标注未写入新元数据。
- 修复 macOS 锁定原片导致导出副本无法发布，以及 Windows 只读属性导致的 JPEG 元数据写入和暂存文件清理问题。
- 当前筛选发生变化后，导出预览使用同一修订的照片和筛选结果更新数量。
- 统一连拍封面、深度复核「本组最佳」、组内名次及后端选片/导出排序（按有效档位、综合分、拍摄时间升序、文件名与照片 ID 确定性排序）。深度复核按当前筛选成员计算连拍与名次，明确提示筛选范围及移出当前筛选状态，绑定保存回执至照片与请求防止快速换图串提示，并修复首尾帧按钮禁用时方向键无法切换照片的问题。
- 修复底部任务栏在扫描、哈希、更新与导出阶段误用已分析比例的问题，改为展示各阶段真实计数或不定进度，并区分分析暂停与停止中状态。
- 选片页在同文件夹切换筛选、排序或视图时保留滚动与照片锚点，锚点被筛掉时自动回退至最近存活邻图，结果为空时引导焦点至清除筛选入口，并在跨文件夹切换时恢复离开前的位置。

### 性能

- **macOS Apple Silicon 推理管线大幅提速与冷启动优化**：
  - CoreML Execution Provider 全面切换为 CoreML 5+ `ModelFormat=MLProgram`（保持 YOLO/Pose/Flight `CPUAndGPU` 关 ANE，IQA 默认 `ALL`），将 YOLO 与 Pose 的 CoreML 子图分区从 11 段压减至 3 段（596/605 与 630/640 节点覆盖），同时 TopK/GatherElements 后处理自动留 CPU（仅 0.27 ms），单模型提速 **2.4×–5.5×** 且与 CPU 基准零漂移（YOLO IoU `1.0000` / Pose 关键点误差 `0.00 px`）；新增按 ORT 版本隔离的持久化 `ModelCacheDirectory`（损坏自愈回退），二次冷启动从 ~4.5s 缩短至 **~1.5s（-66%）**。
  - 优化 `SpeciesClassifier.classify`：将 CPU 侧 PIL 缩放归一化移出 `_infer_lock` 锁，取消每只鸟都触发 `torch.mps.empty_cache()` 改为每 64 次周期性清理，并发下额外提速 **+20%** 且输出比特级一致。
  - 新增 macOS 统一内存与核心数自适应并发（`configure_macos`：≥32 GB 且 ≥10 核默认 4 并发、16–31 GB 默认 3 并发），并限制 macOS 并发下 ONNX CPU 回退线程自旋。
  - 全链路改用 `uint8` 惰性转 `float32` 图像管线（45 MP 照片单图内存从 536 MB 降至 **134 MB**，解码+letterbox 提速 **38%**），并在 `analyzer.py` 复用未变更主文件的已存 SHA-256 避免重复全盘读盘哈希；Apple M5 Max 实测常规鸟图吞吐从 ~212–224 提升至 **~390 张/分（+75%）**，24 MP 大分辨率 JPEG 从 148 提升至 **236 张/分（+59%）**。
- 拆离 1,591 种鸟类百科正文为按需动态加载 chunk（`species-wiki-bodies.json`），首屏主 bundle 从 4.2 MB 缩减至 1.36 MB（-68%）；结合 `compact-v1` 紧凑 NDJSON 摘要大幅降低 5 万张大库首屏传输体积。
- 图库投影使用独立 SQLite 只读快照，减少大库读取占用写锁时对分析入库的阻塞。
- 合并后台分析引起的图库详情刷新。选片按所显示的图库修订计算筛选成员和计数，导出时继续校验实时修订。
- 图库首屏读取轻量摘要，保留筛选、分组与列表展示所需信息。进入深度复核时按照片加载完整 EXIF、关键点和鸟种候选。
- 选片页随主应用加载，缩短从最近文件夹进入选片时的首屏等待。
- 大图库的整库摘要分批编码并发送，给筛选请求留出处理时间。
- 分批计算图库修订，刷新选片工作区时复用未变化的照片记录，减少后台分析期间的筛选停顿。
- 刷新大图库时复用未变化照片的筛选快照记录。Electron 分批接收与解析大图库摘要，完整校验后一次更新选片结果。
- 大图库摘要按完整场景分批投影，提前释放照片模型。Electron 在接收摘要时复用相同的照片记录，降低后台分析期间的筛选延迟和渲染内存峰值。

### 工程与测试

- 重构 GitHub Actions 流水线：新增独立 `ci.yml`（`ubuntu-latest` 统一执行静态检查、单测与 Web Playwright E2E）、新增 `release.yml` 协同 macOS/Windows 构建并在 `ubuntu-latest` 原子发布双端安装包与合并 SHA-256 校验表；macOS 构建改用 `ULFO`（LZFSE）压缩 DMG 并直接挂载最终 DMG 执行跨平台打包端到端冒烟测试；Windows 打包校验与冒烟合并为单遍哈希与单运行器执行。
- 清理后端与前端冗余/空转/硬编码路径用例，注册 `pytest` `integration` 标记并在构建流水线中用确定性鸟图跑通真实 6 模型集成测试；补齐 `PipelineManager._analyze_sync`、`lifespan` 任务恢复、`/analysis` 暂停/恢复/SSE 上限、`archive_cache` 代际防陈旧回写与 `geocoder.reverse()` 降级链核心单测。
- 修复 `playwright.config.ts` 视口覆盖与并发配置，用跨平台几何/布局断言替代易抖动的 macOS 专属全屏像素快照，将文档截图与手动压测脚本迁至 `scripts/`，统一跨平台 `packaged-smoke.spec.ts` 验收套件。

## 0.7.8

2026-11-19 已发布 macOS arm64 DMG 和 Windows x64 便携包，两份安装包均提供 SHA-256 校验文件。[正式下载](https://github.com/wlfcss/PlumeLens/releases/tag/v0.7.8)

### 新增

- 增加 Windows x64 自动构建，覆盖质量检查、可信模型恢复、AMD 运行库冻结、便携包启动验证、压缩包完整性校验和 SHA-256 校验文件；版本标签可发布 Windows 产物。
- Windows 与 macOS 共用模型恢复脚本，支持 Release 大模型与代码资产合并校验；延长依赖下载超时，避免大文件下载中断。
- Windows 启动脚本与说明仅随 Windows 包分发，macOS 许可文件放入 Resources，保证应用签名和严格校验通过。
- 支持 Windows ML 原生 AMD 检测后端与持久编译缓存，结合 DirectML、ROCm 执行其他模型；提供随发行包运行的 AMD 初始化脚本。
- 按 CPU 可用核心、物理内存及可用显存设置分析、预览和线程上限；内存紧张时减少任务，恢复后提高到配置上限，并保留手动覆盖。

### 修复

- Windows 引擎冷启动等待上限统一为 3 分钟，避免慢盘上仍在迁移数据库或加载模型时提前报告失败。
- 修复 Windows 父进程存活检查导致的闪退，完善后端启动、优雅关闭、中文与特殊字符路径、缓存路径和外部编辑器调用。
- 修复 Windows 用户目录使用短路径或目录联接时，首次启动的缩略图被路径校验误拦截的问题。
- 改善 Windows 中文字体、深色原生标题栏、高 DPI 图片和紧凑窗口布局，保留系统窗口按钮与贴靠行为。
- 加快 RAW 内嵌预览解码，减少全分辨率分析的临时内存；跨图库共享处理上限，取消后等待底层解码结束再回收名额。
- 修复同一毫秒写入多条分析历史时排序不稳定的问题。

### 兼容与交付

- Windows 自动构建在独立运行器上解压并测试最终 ZIP，覆盖冷启动、历史恢复和分析导出。
- 锁定经过 Windows 实测的 ONNX Runtime Windows ML 版本；ROCm 鸟种识别使用 FP32 与 eager attention，避免已发现的精度和驱动兼容问题。
- 移除发行包中的 SDK 编译工具、未使用的 attention 内核归档与重复前端依赖，保留推理库、设备内核、模型和许可文件。
- 在 Windows 11 / RX 7900 XTX 上验证 300 张 JPG、CR3 的分析、续跑和导出；补充资源采样、CPU/GPU 输出对照及 100%–150% 显示缩放测试。
- 同步 README、模型说明和 Windows 使用、构建与验证文档；其他硬件及 RAW 格式仍需对应实机验证。

## 0.7.7

发布日期：2026-11-17。

### 新增

- 选片页增加鸟种搜索与多选，支持待审判断、未识别鸟、去重计数和同鸟飞版筛选。
- 导出可选择当前筛选或整个文件夹，后端固定匹配照片、有效鸟种及输入修订。
- 保留分析任务的暂停和取消状态，使失败重试与重启恢复遵守用户操作。

### 修复

- 源文件变化后使旧分析与派生信息失效，阻止旧输入、旧标注或在途结果被错误复用。
- 隔离并发任务的事务与缓存读取，防止误提交、误回滚、读取未提交数据及重复入队。
- 导出文件先写入临时路径，校验后生成最终文件；核对分析时读取的源文件，并支持复制中取消、断线恢复与重启中断提示。
- 修复切换文件夹后的评级保存、旧导出进度覆盖新任务、缩略图重建和筛选结果刷新问题。
- 保留筛选命中的单张照片，复核改种后保持当前照片与导航顺序。
- 修复键盘目标、弹窗焦点、界面重载、引擎连接恢复和应用关闭；照片悬停不再改变色彩或缩放。

### 兼容与交付

- 数据库 schema 升至 13，预处理版本升至 12；完善分析缓存标识，修正 RAW 方向、CoreML 回退处理与鸟种候选校准。
- 输入变化时保留人工评级并归档旧分析，旧输入物种框不再自动套用；新规则在重新分析后生效。
- Electron 保持 41.6.0；CI 统一使用 Node.js 24、Python 3.11 和锁定依赖，增加 PR 质量检查和可信模型清单校验。
- 修复 macOS 安装包制作时的临时卷卸载失败，完善重试、状态确认和资源清理。
- 更新 README、界面截图、模型图示和发布说明。

## 0.7.6

- 导出改为后台任务，增加进度、取消和同图库并发保护。
- 按源文件夹实际照片格式选择导出范围，显示数量及预计体积。
- 改善空间不足等错误提示，修复文案截断。
- 增加工作集文件夹移除，清理对应缩略图缓存，保留源照片。

## 0.7.5

- 拆分前端组件、数据投影和公共工具，改善虚拟列表及缩略图稳定性。
- 鸟种封面改为随包离线资源，补齐来源归因。
- 完善 API/SSE 鉴权、IPC 校验、引擎关闭和质量检查。
- Electron 从 39.8.10 升至 41.6.0，同步架构与开发文档。

## 0.7.0

- 鸟种识别升级为 DINOv3 species v4，支持 1591 类与三态识别。
- 姿态升级为 11 关键点，增加独立飞版分类，调整双画质评分权重。
- 改善连拍分组、深度复核、仅飞版筛选、拍摄报告及鸟种资料。
- 完善羽迹、地理分布、设置、模型版本查看和源文件夹重关联。
- 增加模型清单校验、自定义 DMG 与打包后测试。

历史变更与技术细节可通过 Git 提交记录查看。
