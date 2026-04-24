# PlumeLens / 鉴翎 — 项目交接文档

> 本文档记录截至 2026-04-24 的所有已完成工作、待实现事项和背景知识，供新环境下的 Claude Code 会话完整接续。

## 1. 项目定位

**PlumeLens / 鉴翎**：辅助鸟类摄影爱好者快速筛选鸟类照片的桌面应用。

核心场景：摄影师外拍回来，导入数百至数千张照片，应用自动分析每张照片的质量与物种信息，快速筛选出最佳作品。产品拆分为两条主业务线：

1. **选片**（高频主线）：以文件夹为单位的筛片工作台
2. **羽迹**（长期资产）：跨文件夹物种沉淀 + 物种墙 + 地理分布

顶层路由定型为 `开始 / 选片 / 羽迹`（见 [docs/PRODUCT_UX_PLAN.md](./PRODUCT_UX_PLAN.md)）。

GitHub: https://github.com/wlfcss/PlumeLens

## 2. 开发者背景

- **GitHub**: wlfcss
- **背景**：鸟类摄影爱好者 + ML 应用开发经验
- **前项目**：
  - **lingjian-v2**：Electron 34 + Python subprocess (JSON-RPC stdio) + ONNX 多模型管线
  - **ProjectKestrel-zh**：PyWebView + PyTorch + YOLO 检测 + TensorFlow 质量模型，中文 fork
- **开发方式**：主要使用 AI 工具编码，前端能力较弱，后端 / ML 管线较强
- **偏好**：UI 中文，commit 中文描述，不添加 Co-Authored-By 行；不用 Git LFS（速度差）

## 3. 已完成的工作

### 3.1 分析管线（5 模型 ONNX，全部就位）

```
原片
  ↓ letterbox1280 (114 填充) → YOLOv26l-bird-det v1.0 (conf≥0.5, NMS-free)
  ↓ 鸟类 bbox 列表
  ├─ 逐框裁切 (+10% padding)
  │    ↓ bird_visibility v1.0 (imgsz=640) → head_visible / eye_visible + 5 关键点
  │    ↓ CLIPIQA+(×0.35) + HyperIQA(×0.65) → 综合分 → 4 档分级
  │    ↓ (仅 head+eye 可见时) DINOv3 backbone + 7-head ensemble → top-K 物种
  └─ 选最高综合分的鸟 → 照片结果
```

| 模型 | 文件 | 大小 | 关键指标 |
|------|------|------|---------|
| YOLOv26l-bird-det v1.0 | `engine/models/yolo26l-bird-det.onnx` | 99.9 MB | Test mAP@0.5 = 0.9364, Recall = 0.9021 |
| bird_visibility v1.0 | `engine/models/bird_visibility.onnx` | 98.0 MB | Val Eye F1 = 99.31%, Head F1 = 99.88% |
| CLIPIQA+ | `engine/models/clipiqa_plus.onnx` | 1.2 MB | 0.35 权重 |
| HyperIQA | `engine/models/hyperiqa.onnx` | 0.4 MB | 0.65 权重 |
| DINOv3 backbone | `engine/models/dinov3_backbone.onnx` | 1.2 GB | **不入 git**（超 100MB），Test top-1 = 91.93% |
| DINOv3 ensemble heads | `engine/models/species_ensemble.onnx` | 83 MB | 7-head (4×512 + 3×640), 1516 种 |

配套元数据：`bird_visibility_config.json`（姿态阈值），`species_taxonomy.parquet`（1516 种分类表）。完整清单见 [`engine/models/README.md`](../engine/models/README.md)。

4 档分级：`<0.33` 淘汰 / `0.33-0.43` 记录 / `0.43-0.60` 可用 / `≥0.60` 精选

### 3.2 代码结构

**管线模块** (`engine/pipeline/`, 7 文件，**已集成 YOLO det + 画质，待集成姿态/物种**)：
- `models.py` — Pydantic 数据模型（BoundingBox, QualityScores, QualityGrade, BirdAnalysis, PipelineResult）
- `preprocess.py` — 图像加载（Pillow + rawpy）、letterbox 缩放（YOLO 标准 114 填充）、bbox 裁切、CHW/batch 变换
- `detector.py` — BirdDetector: YOLO ONNX 推理封装（1280, conf=0.5）
- `quality.py` — QualityAssessor: CLIPIQA+ & HyperIQA 双模型评分
- `grader.py` — score → 4 档分级
- `manager.py` — PipelineManager: 生命周期 + 编排 + 版本计算（含 5 模型 checksum + 姿态阈值 + 预处理版本 + ORT/EP）
- `__init__.py` — 导出 PipelineManager 和所有数据模型

**待新增**：
- `pose.py` — PoseDetector（bird_visibility ONNX 封装 + 决策规则）
- `species.py` — SpeciesClassifier（DINOv3 backbone + ensemble 编排）
- `BirdAnalysis` 需扩展 `pose` 与 `species_candidates` 字段

**Electron 主进程** (4 文件)：
- `electron/main.ts` — BrowserWindow + sandbox: true + dev/prod 分段 CSP + IPC handlers
- `electron/preload.ts` — 最小暴露面
- `electron/process-manager.ts` — Python 子进程启动/守护/重启(3 次)/健康检查(10s)
- `electron/diagnostics.ts` — placeholder

**React Renderer** (前端重构已完成，三路由高保真原型)：
- `App.tsx` — 1889 行，包含全部 29 个组件（待按 pages/components 拆分）
- `app.css` — 1815 行，自定义设计令牌（Doto / Space Grotesk / Noto Sans SC 字体栈）
- `lib/mock-workspace.ts` — 831 行虚构数据 + 领域类型定义（**过渡期技术债**，见 PRODUCT_UX_PLAN §20.3）
- `stores/ui-store.ts` — Route/ArchiveTab/QuickFilter/ViewMode 等 UI 状态
- `hooks/use-backend.ts` — `/health` 查询（含完整 `BackendHealth` 类型 pipeline.ready/version/models）
- `i18n/locales/*.json` — 中英双语 276 行
- `env.d.ts` — `window.plumelens` 类型（必须带 `export {}`）

**Python 后端** (当前阶段)：
- `engine/main.py` — FastAPI app + lifespan + health router
- `engine/core/config.py` — Pydantic Settings（含 5 模型 + 姿态/物种参数）
- `engine/core/logging.py` — structlog 配置
- `engine/core/lifespan.py` — 生命周期（日志初始化、数据目录创建、PipelineManager 加载）
- `engine/core/database.py` — placeholder (WAL 模式待实现)
- `engine/api/routes/health.py` — GET /health → 含 pipeline 状态（模型加载、EP、版本）
- 其余 services/ 均为 placeholder（含 TODO 注释描述职责）

**脚本** (`scripts/`)：
- `export_dinov3_backbone.py` — 从 PyTorch 包导出 DINOv3 backbone + ensemble heads ONNX（一次性离线工具）

**测试** (30 个测试通过)：
- `tests/engine/conftest.py` — httpx AsyncClient fixture + mock PipelineManager
- `tests/engine/test_api/test_health.py` — health 端点测试（含 pipeline 状态检查）
- `tests/engine/test_pipeline/test_detector.py` — 4 个检测器测试
- `tests/engine/test_pipeline/test_quality.py` — 3 个画质评估测试
- `tests/engine/test_pipeline/test_grader.py` — 7 个分级测试
- `tests/engine/test_pipeline/test_preprocess.py` — 13 个预处理测试（含 114 填充值锁定）
- `tests/renderer/app.test.tsx` — App 冒烟测试
- Playwright 配置就绪

**CI**：
- `.github/workflows/ci.yml` — backend (ruff + pyright + pytest) + frontend (eslint + tsc + vitest)
- `.github/workflows/eval.yml` — 管线质量评测（手动触发 placeholder）

### 3.3 产品与交互规划

[`docs/PRODUCT_UX_PLAN.md`](./PRODUCT_UX_PLAN.md) 已冻结以下决策：

- 顶层三路由：`开始 / 选片 / 羽迹`
- 以**文件夹**为主组织单位（不用"批次"）
- **中心存储 + 显式导出**：结果统一存 `~/.plumelens/`，原始目录只读
- **扫描两阶段**：轻指纹 (path+size+mtime) 先建库 → 后台补强 SHA-256
- **5 模型目标态**已确定
- **模型评级 vs 用户决定分离**：淘汰/记录/可用/精选（模型）vs 待看/已选/待定/淘汰（用户）
- 工程底线（§20.4）：typecheck 必须真实执行、ES2023、sandbox: true、window.plumelens 类型齐全等

### 3.4 验证状态（2026-04-24）

所有检查已通过：
- ruff check engine/ tests/ ✅
- pyright engine/ tests/ ✅
- pytest tests/engine/ (**30 passed**) ✅
- vitest run (1 passed) ✅
- eslint . ✅
- `npm run typecheck`（tsc --build --noEmit）✅

## 4. 待实现功能

按 PRODUCT_UX_PLAN §21 优先级：

### 4.1 P0 — 打通"选片"主工作台真实闭环

- `engine/core/database.py` — SQLite WAL 模式，建表（photos / analysis_results / task_queue）
- `engine/pipeline/pose.py` — 姿态模型封装 + 决策规则（复用 bird_visibility MODEL_CARD §6.2）
- `engine/pipeline/species.py` — DINOv3 编排（双尺度 backbone + ensemble heads + taxonomy 查询）
- `BirdAnalysis` 数据模型扩展：`pose`（keypoints + head_visible / eye_visible）、`species_candidates`（top-K + confidence + metadata）
- `engine/services/scanner.py` — 文件夹扫描（递归、EXIF、轻指纹 + 后台 hash）
- `engine/services/analyzer.py` — 管线编排（缓存检查、PipelineManager 调用、SSE 进度推送）
- `engine/services/queue.py` — 批量任务队列（状态机、断点续跑）
- `engine/services/cache.py` — 结果缓存 `(file_hash, pipeline_version)`
- `engine/services/thumbnail.py` — RAW embedded preview 优先 + 双级缩略图
- `engine/api/routes/library.py` + `analysis.py` — 图库 / 分析任务 / 进度 SSE API
- 前端替换 `mock-workspace` 为真 API + TanStack Query mutations

### 4.2 P1 — 羽迹模块接入 + App.tsx 拆分

- `engine/services/ranker.py` — 筛选/排序服务
- 羽迹页跨文件夹真实查询 + 物种中心库
- 物种详情真实代表作 / 时间线 / 地点
- 地理分布图（科普向 + 个人足迹）
- 前端 `App.tsx` 按 `pages/` + `components/` 拆分

### 4.3 P2 — 新增种确认流 + 打磨

- 新增种候选确认 UI
- 更完整的物种资料源（不写死 Wiki）
- 更强的时间线与足迹回顾
- 移除多层 `t` prop 传递（子组件内直接 `useTranslation()`）
- 动效系统与可访问性细节

### 4.4 里程碑 0（未验证，阻塞发布）

技术规划明确要求在骨架搭建完即做的打包验证，**目前仍未执行**，需尽早确认：

- [ ] Electron 能启动
- [ ] Python 子进程能拉起
- [ ] 能加载至少一个 ONNX InferenceSession
- [ ] 能打开一张 RAW 文件
- [ ] structlog 日志能写入
- [ ] `scripts/export_dinov3_backbone.py` 能在 CI 环境正确产出 backbone（或改为 release artifact 策略）

## 5. 技术栈快速参考

### 前端

| 组件 | 版本 | 注意事项 |
|------|------|---------|
| Electron | ~35.0.0 | **E2E 基线 pin 35.x**（Playwright 在 36 上失败），按季度评估升级 |
| electron-vite | ^5.0.0 | alex8088 版本 |
| React | ^19.0.0 | defaultProps 已移除；全局 `JSX` namespace → `React.JSX` |
| TypeScript | ^5.8.0 | `target/lib` 至少 ES2023（`Array.toSorted` 等） |
| Tailwind CSS | v4 | `@theme` + `@tailwindcss/vite`，不用 tailwind.config.ts |
| shadcn/ui | latest | **tw-animate-css**（非 tailwindcss-animate）+ @custom-variant dark |
| Zustand | v5 | **返回对象的 selector 必须 `useShallow`** |
| TanStack Query | v5 | React 19 完全兼容 |
| i18next | ^26.0.0 | react-i18next ^17.0.0 |
| 图标 | lucide-react | 前端重构使用 |
| 字体 | Doto / Space Grotesk / Space Mono / Noto Sans SC | via @fontsource |

### 后端

| 组件 | 版本 | 注意事项 |
|------|------|---------|
| Python | >=3.11 | 当前开发环境为 3.12 |
| FastAPI | >=0.132.0 | 0.132 起默认严格 Content-Type |
| uvicorn | >=0.34.0 | PyInstaller 需 collect_submodules；Windows console=False 需重定向 stdout |
| onnxruntime | >=1.24.0 | CoreML EP 有 bug（IQA/ViT 暂走 CPU） |
| numpy | >=2.0.0 | ONNX 输入输出 |
| Pillow | >=12.0.0 | 图像加载，用 `Image.Resampling.LANCZOS` |
| rawpy | >=0.23.0 | RAW 格式，macOS arm64 原生 wheel |
| aiosqlite | >=0.22.0 | WAL 模式 + busy_timeout=5000，显式 close |
| structlog | >=25.0.0 | JSON 日志，接管 uvicorn 日志 |
| pyright | strict | **API 路由层及 ONNX 推理层 basic 模式** |
| ruff | >=0.9.0 | line-length=100 |
| uv | 系统工具 | pyproject.toml 在项目根目录 |

### 关键文件位置

| 文件 | 用途 |
|------|------|
| `pyproject.toml` | **在项目根目录**（非 engine/ 内），Python 依赖 + 工具配置 |
| `electron.vite.config.ts` | 三端构建（main/preload/renderer），自定义路径 |
| `docs/TECHNICAL_SPEC.md` | 完整技术规划（架构、数据库设计、5 模型管线详细说明） |
| `docs/PRODUCT_UX_PLAN.md` | 产品与交互方案（顶层路由、页面职责、UX 原则） |
| `engine/pipeline/manager.py` | PipelineManager（ONNX 管线生命周期 + 编排 + 版本哈希） |
| `engine/models/README.md` | 5 个模型清单与指标 |
| `scripts/export_dinov3_backbone.py` | DINOv3 backbone ONNX 导出脚本（一次性） |

## 6. 开发环境搭建

```bash
# 1. 克隆仓库
git clone https://github.com/wlfcss/PlumeLens.git
cd PlumeLens

# 2. 安装 Node 依赖
npm install

# 3. 安装 Python 依赖（pyproject.toml 在项目根目录）
uv sync
uv pip install -e ".[dev]"          # ruff/pyright/pytest/httpx

# 4. (可选) 导出 DINOv3 backbone ONNX — 仅需要物种识别时
#    需要原始 PyTorch 包 + 临时 torch/transformers 环境
#    见 scripts/export_dinov3_backbone.py 顶部 docstring

# 5. 验证
npm run typecheck                   # tsc --build --noEmit
npx eslint .
npx vitest run
uv run ruff check engine/ tests/
uv run python -m pyright engine/ tests/
uv run python -m pytest tests/engine/ -v  # 30 passed

# 6. 启动开发（Electron + Vite HMR + Python 后端）
npm start
```

注意：`npm start` 会通过 electron-vite 启动 Electron，主进程自动 spawn Python 后端（`uv run uvicorn engine.main:app`）。

## 7. 关键技术决策（历史记录）

- **VLM 架构已完全放弃**（原 lingjian-v2 探索结果），改为纯 ONNX 多模型管线
- **YOLO v1.0 的 letterbox 填充必须是 114/255**（非 0.5），与训练分布一致
- **DINOv3 backbone 不能纯 fp16**（ViT-L 的 LayerNorm/Softmax 溢出），必须 fp32
- **DINOv3 backbone 不入 git**（1.2 GB 超限，不用 LFS），通过导出脚本 + 分发打包解决
- **Mac 当前走 CPU ORT**，不用 CoreML（ViT 覆盖差反而更慢），等 onnxruntime 1.26+ 再评估
- **analysis_results 表语义**：`(photo_id, pipeline_version)` UNIQUE + 部分唯一索引保证单 active
- **两阶段扫描**：避免全量 SHA-256 首扫拖死体验
- **RAW 缩略图优先用 `rawpy.extract_thumb()`**，完整解码仅作 fallback

## 8. 协作偏好（写入 Claude Code memory）

- commit 以 wlfcss 身份提交，不加 Co-Authored-By
- commit 格式：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:` + 中文描述
- 前端必须有 Playwright E2E 测试（用户依赖 AI 编码，需要安全网）
- 不要建议砍掉 E2E 测试
- UI 文案通过 i18next，不硬编码
- 代码注释中英文均可
- 避免 Git LFS
