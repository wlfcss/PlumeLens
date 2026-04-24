# PlumeLens / 鉴翎 — 项目交接文档

> 本文档记录截至 2026-04-12 的所有已完成工作、待决策事项和背景知识，供新环境下的 Claude Code 会话完整接续。

## 1. 项目定位

**PlumeLens / 鉴翎**：辅助鸟类摄影爱好者快速筛选鸟类照片的桌面应用。

核心场景：摄影师外拍回来，导入数百至数千张照片，应用自动分析每张照片的画质，快速筛选出最佳作品。

GitHub: https://github.com/wlfcss/PlumeLens

## 2. 开发者背景

- **GitHub**: wlfcss
- **背景**：鸟类摄影爱好者 + ML 应用开发经验
- **前项目**：
  - **lingjian-v2**：Electron 34 + Python subprocess (JSON-RPC stdio) + ONNX 多模型管线（YOLO 检测 + 物种分类 + 质量评估），GPL-3.0
  - **ProjectKestrel-zh**：PyWebView + PyTorch + YOLO 检测 + TensorFlow 质量模型，中文 fork
- **开发方式**：主要使用 AI 工具编码，前端能力较弱，后端 / ML 管线较强
- **偏好**：UI 中文，commit 中文描述，不添加 Co-Authored-By 行

## 3. 已完成的工作

### 3.1 管线架构（已确定）

经过 lingjian-v2 项目 15+ 轮评测验证，**纯 ONNX 三模型管线**已确定为最终方案，VLM 方案已完全放弃：

```
原片 → letterbox1280 (114 填充) → YOLOv26l-bird-det.onnx v1.0 (conf≥0.5, NMS-free)
                        ↓ bbox
         box×1.0 裁切 → CLIPIQA+(×0.35) + HyperIQA(×0.65) → 4档分级
```

| 模型 | 文件 | 大小 | 用途 |
|------|------|------|------|
| YOLOv26l-bird-det v1.0 | `engine/models/yolo26l-bird-det.onnx` | 99.9 MB | 鸟类目标检测（wlfcss 个人训练，Test mAP@0.5=0.936） |
| CLIPIQA+ | `engine/models/clipiqa_plus.onnx` | 1.2 MB | 语义画质评估 |
| HyperIQA | `engine/models/hyperiqa.onnx` | 0.4 MB | 技术画质评估 |

4 档分级：`<0.33` 淘汰 / `0.33-0.43` 记录 / `0.43-0.60` 可用 / `≥0.60` 精选

性能：v1.0 Test Recall 90.2%, mAP@0.5 93.6%；YOLO ONNX CPU ~534ms/张（M5 Max，整体管线待重测）

### 3.2 项目骨架 + 管线模块

**管线模块** (`engine/pipeline/`, 7 文件)：
- `models.py` — Pydantic 数据模型（BoundingBox, QualityScores, QualityGrade, BirdAnalysis, PipelineResult）
- `preprocess.py` — 图像加载（Pillow + rawpy）、letterbox 缩放、bbox 裁切、CHW/batch 变换
- `detector.py` — BirdDetector: YOLO ONNX 推理封装
- `quality.py` — QualityAssessor: CLIPIQA+ & HyperIQA 双模型评分
- `grader.py` — score → 4 档分级
- `manager.py` — PipelineManager: 生命周期 + 编排 + 版本计算
- `__init__.py` — 导出 PipelineManager 和所有数据模型

**Electron 主进程** (4 文件)：
- `electron/main.ts` — BrowserWindow + context isolation + CSP + IPC handlers
- `electron/preload.ts` — 最小暴露面 (getBackendUrl, getAppVersion, openFolder, onBackendReady, onBackendError)
- `electron/process-manager.ts` — Python 子进程启动/守护/重启(3 次)/健康检查(10s)
- `electron/diagnostics.ts` — placeholder

**React Renderer** (11 文件)：
- `renderer/src/main.tsx` — React 入口 + QueryClientProvider + i18next
- `renderer/src/App.tsx` — 应用标题(i18n) + 后端连接状态指示灯
- `renderer/src/app.css` — Tailwind v4 @theme inline + --pl-* 暗色主题变量
- `renderer/src/env.d.ts` — window.plumelens 类型定义
- `renderer/src/lib/utils.ts` — cn() (clsx + tailwind-merge)
- `renderer/src/i18n/` — i18next 配置 + zh-CN / en 翻译文件
- `renderer/src/stores/ui-store.ts` — Zustand v5 最小 store + useShallow 导出
- `renderer/src/hooks/use-backend.ts` — TanStack Query 健康检查 hook

**Python 后端** (25+ 文件)：
- `engine/main.py` — FastAPI app + lifespan + health router
- `engine/core/config.py` — Pydantic Settings（含管线配置：模型目录、EP、阈值、权重）
- `engine/core/logging.py` — structlog 配置
- `engine/core/lifespan.py` — 生命周期（日志初始化、数据目录创建、PipelineManager 加载）
- `engine/core/database.py` — placeholder (WAL 模式待实现)
- `engine/api/routes/health.py` — GET /health → 含 pipeline 状态（模型加载、EP、版本）
- 其余 services/ 均为 placeholder（含 TODO 注释描述职责）

**测试** (28 个测试通过)：
- `tests/engine/conftest.py` — httpx AsyncClient fixture + mock PipelineManager
- `tests/engine/test_api/test_health.py` — health 端点测试（含 pipeline 状态检查）
- `tests/engine/test_pipeline/test_detector.py` — 4 个检测器测试（mock ONNX session）
- `tests/engine/test_pipeline/test_quality.py` — 3 个画质评估测试
- `tests/engine/test_pipeline/test_grader.py` — 7 个分级测试
- `tests/engine/test_pipeline/test_preprocess.py` — 11 个预处理测试
- `tests/renderer/app.test.tsx` — App 冒烟测试
- Playwright 配置就绪（`playwright.config.ts`）

**CI**：
- `.github/workflows/ci.yml` — backend (ruff + pyright + pytest) + frontend (eslint + tsc + vitest)
- `.github/workflows/eval.yml` — 管线质量评测（手动触发 placeholder）

### 3.3 已删除的 VLM 代码

以下目录在管线改造中已完全删除：
- `engine/llm/` — VLM Provider 适配层（provider.py, client.py, parser.py）
- `engine/prompts/` — VLM Prompt 模板（registry.py, v1/analyze.py 等）

### 3.4 验证状态

所有检查已通过：
- ruff check engine/ ✅
- pyright engine/ ✅
- pytest tests/engine/ (28 passed) ✅
- vitest run (1 passed) ✅
- eslint . ✅
- tsc --noEmit ✅

## 4. 待实现功能

以下按优先级排列：

### 4.1 后端核心（必须）
- `engine/core/database.py` — SQLite WAL 模式，建表（photos / analysis_results / task_queue）
- `engine/services/scanner.py` — 文件夹扫描（递归、EXIF 读取、file hash）
- `engine/services/analyzer.py` — 管线编排（缓存检查、调用 PipelineManager、写入结果）
- `engine/services/queue.py` — 批量任务队列（状态机、断点续跑）
- `engine/services/cache.py` — 缓存管理（键：file_hash + pipeline_version）
- `engine/services/ranker.py` — 排序服务
- `engine/services/thumbnail.py` — 缩略图生成

### 4.2 API 路由
- `engine/api/routes/library.py` — 图库管理（导入、列表、筛选）
- `engine/api/routes/analysis.py` — 分析任务（启动、进度 SSE、结果查询）
- `engine/api/routes/settings.py` — 设置管理

### 4.3 前端 UI
- 图库浏览页面
- 分析进度页面
- 照片详情页面
- 设置页面

### 4.4 未来增强
- 物种分类模型（`engine/models/species.onnx`，slot 已预留）
- Eval 框架（`evals/run_eval.py`，目前为 placeholder）

## 5. 技术栈快速参考

### 前端

| 组件 | 版本 | 注意事项 |
|------|------|---------|
| Electron | ~35.0.0 | **锁定 35.x**，Playwright 在 36 上失败 |
| electron-vite | ^5.0.0 | alex8088 版本，非 vite-plugin-electron |
| React | ^19.0.0 | defaultProps 已移除，用 ES6 默认参数 |
| Tailwind CSS | v4 | **@theme 指令 + @tailwindcss/vite**，不用 tailwind.config.ts |
| shadcn/ui | latest | **tw-animate-css**（非 tailwindcss-animate）+ @custom-variant dark |
| Zustand | v5 | **返回对象的 selector 必须用 useShallow** |
| TanStack Query | v5 | React 19 完全兼容 |
| i18next | ^26.0.0 | react-i18next ^17.0.0（需 26+ 解决 peer dep） |

### 后端

| 组件 | 版本 | 注意事项 |
|------|------|---------|
| Python | >=3.11 | 当前开发环境为 3.12 |
| FastAPI | >=0.135.0 | 默认严格 Content-Type，前端 fetch 带 application/json |
| uvicorn | >=0.34.0 | PyInstaller 需 collect_submodules |
| onnxruntime | >=1.24.0 | CoreML EP 有 bug（model_path），IQA 暂用 CPU |
| numpy | >=2.0.0 | 图像处理 + ONNX 推理数据 |
| Pillow | >=12.0.0 | 图像加载，用 `Image.Resampling.LANCZOS` |
| rawpy | >=0.23.0 | RAW 格式支持 |
| aiosqlite | >=0.22.0 | WAL 模式 + busy_timeout=5000，需显式 close |
| structlog | >=25.0.0 | JSON 日志，需配置接管 uvicorn 日志 |
| pyright | strict | **API 路由层及 ONNX 推理层 basic 模式** |
| ruff | >=0.9.0 | line-length=100 |
| uv | 系统工具 | pyproject.toml 在项目根目录，packages=["engine"] |

### 关键文件位置

| 文件 | 用途 |
|------|------|
| `pyproject.toml` | **在项目根目录**（非 engine/ 内），Python 依赖 + 工具配置 |
| `electron.vite.config.ts` | 三端构建，自定义路径（electron/ + renderer/） |
| `docs/TECHNICAL_SPEC.md` | 完整技术规划（架构、数据库设计、管线详细说明） |
| `开发指引` | 本地开发指引（简版约束） |
| `engine/pipeline/manager.py` | PipelineManager（ONNX 管线生命周期 + 编排） |

## 6. 开发环境搭建

```bash
# 1. 克隆仓库
git clone https://github.com/wlfcss/PlumeLens.git
cd PlumeLens

# 2. 安装 Node 依赖
npm install

# 3. 安装 Python 依赖（pyproject.toml 在项目根目录）
uv sync
uv pip install -e ".[dev]"    # 安装 dev 依赖（ruff/pyright/pytest/httpx）

# 4. 验证
npx eslint .                  # ESLint
npx tsc --noEmit              # TypeScript
npx vitest run                # 前端测试
uv run ruff check engine/     # Python lint
uv run python -m pytest tests/engine/ -v  # 后端测试（28 个）

# 5. 启动开发（Electron + Vite HMR + Python 后端）
npm start
```

注意：`npm start` 会通过 electron-vite 启动 Electron，Electron 主进程会自动 spawn Python 后端（`uv run uvicorn engine.main:app`）。

## 7. lingjian-v2 参考

管线方案源自 lingjian-v2 的评测验证，以下文件可供参考：

| 文件 | 内容 |
|------|------|
| `benchmark/ranking/run_hybrid_v4.py` | hybrid v4 管线实现 |
| `benchmark/ranking/analyze_weighting.py` | CLIPIQA+/HyperIQA 权重优化分析 |
| `benchmark/ranking/ground_truth_v2.json` | 95 张照片人工标注 |
| `benchmark/ranking/results/benchmark_summary.json` | 多模型对比摘要 |
| `engine/ml/quality_clf.py` | ONNX 质量评估实现参考 |

## 8. 协作偏好（写入 Claude Code memory）

- commit 以 wlfcss 身份提交，不加 Co-Authored-By
- commit 格式：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:` + 中文描述
- 前端必须有 Playwright E2E 测试（用户依赖 AI 编码，需要安全网）
- 不要建议砍掉 E2E 测试
- UI 文案通过 i18next，不硬编码
- 代码注释中英文均可
