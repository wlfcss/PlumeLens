# PlumeLens / 鉴翎 — 项目交接文档

> 本文档记录截至 2026-04-11 的所有已完成工作、待决策事项和背景知识，供新环境下的 Claude Code 会话完整接续。

## 1. 项目定位

**PlumeLens / 鉴翎**：辅助鸟类摄影爱好者快速筛选鸟类照片的桌面应用。

核心场景：摄影师外拍回来，导入数百至数千张照片，应用自动分析每张照片的画质、构图等维度，快速筛选出最佳作品。

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

### 3.1 Git 提交历史

```
3ea09bd feat: 搭建完整项目骨架
58eae68 docs: 整合用户反馈及全栈兼容性验证
b4afadf docs: 整合五大补充项及细节建议到技术规划
4dfedda docs: 完整技术规划存档
00fbcb0 chore: 初始化 PlumeLens / 鉴翎 项目
```

### 3.2 技术规划（已完成、已存档）

完整技术规划见 `docs/TECHNICAL_SPEC.md`，涵盖：

- 系统架构图（Electron + FastAPI + 推理后端三层）
- 技术栈明细（含版本号和每个组件的已知兼容性问题）
- 项目目录结构
- SQLite 数据库设计（photos / analysis_results / task_queue 三表 + 索引）
- 运行时硬化（context isolation、子进程守护、统一日志、崩溃转储、诊断页）
- Provider 适配层设计（ProviderCapabilities 数据类 + 4 个预置 Profile）
- 性能控制面（并发控制、backpressure、可中断点）
- 质量评测集结构
- 打包分发方案（PyInstaller 注意事项）
- 兼容性风险矩阵（15 项，按严重性分级，附对策）

### 3.3 项目骨架（已完成，75 个文件）

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

**Python 后端** (25 文件)：
- `engine/main.py` — FastAPI app + lifespan + health router
- `engine/core/config.py` — Pydantic Settings (PLUMELENS_ 前缀)
- `engine/core/logging.py` — structlog 配置
- `engine/core/lifespan.py` — 生命周期（日志初始化、数据目录创建）
- `engine/core/database.py` — placeholder (WAL 模式待实现)
- `engine/api/routes/health.py` — GET /health → {"status": "ok"}
- `engine/llm/provider.py` — ProviderCapabilities + RetryStrategy + 4 预置 Profile（Ollama/vLLM/LMStudio/OpenAI）
- 其余 services/ prompts/ llm/ 均为 placeholder（含 TODO 注释描述职责）

**测试**：
- `tests/engine/conftest.py` — httpx AsyncClient fixture
- `tests/engine/test_api/test_health.py` — health 端点测试（已通过）
- `tests/renderer/app.test.tsx` — App 冒烟测试（已通过）
- Playwright 配置就绪（`playwright.config.ts`）

**CI**：
- `.github/workflows/ci.yml` — backend (ruff + pyright + pytest) + frontend (eslint + tsc + vitest)
- `.github/workflows/eval.yml` — 质量评测（手动触发 placeholder）

**配置**：
- `electron.vite.config.ts` — 三端构建（main/preload/renderer 自定义路径）
- `tsconfig.json` + `tsconfig.node.json` + `tsconfig.web.json` — TypeScript 项目引用
- `eslint.config.js` — v9 flat config + typescript-eslint
- `vitest.config.ts` — jsdom + @/ 别名
- `components.json` — shadcn/ui (new-york style, Tailwind v4)
- `electron-builder.yml` — appId, extraResources engine/
- `pyproject.toml` — 在项目根目录（非 engine/ 内），hatchling 构建，packages=["engine"]

### 3.4 验证状态

所有检查已通过：
- ruff check engine/ ✅
- pytest tests/engine/ (1 passed) ✅
- vitest run (1 passed) ✅
- eslint . ✅
- tsc --noEmit ✅

## 4. 待决策：主处理管线

**这是当前最重要的未决事项。**

### 4.1 背景

开发者在 lingjian-v2 中做了大量 VLM + IQA 管线对比测试（162 个结果文件，15+ 轮 prompt 迭代）。经多轮验证后确认的最佳管线为 **hybrid v4**：

```
原片 → Qwen3.5-2B (768px) 检测 → box×1.0 裁切 → CLIPIQA+ & HyperIQA 评分
```

关键参数（来自 lingjian-v2/benchmark/ranking/）：
- 检测模型：Qwen3.5-2B @ 768px
- 裁切：box × 1.0（紧裁切）
- IQA 权重：0.3 × CLIPIQA+ + 0.7 × HyperIQA
- 分级阈值：<0.33 淘汰 / 0.33-0.43 记录 / 0.43-0.60 可用 / ≥0.60 精选
- 测试数据：95 张标注 ground truth（ground_truth_v2.json + v2_crop.json）

### 4.2 架构冲突

该管线中 CLIPIQA+ 和 HyperIQA 依赖 `pyiqa`（底层是 torch），与"Python 后端不装 torch"的轻量原则冲突。

### 4.3 讨论中的方向

最近讨论了三个演进方向：

**方向 A：用 YOLO 替代 2B VLM 做检测**
- 开发者提出考虑自行标注数据微调 YOLO 替代 Qwen3.5-2B
- lingjian-v2 已有 `yolo26x-seg.onnx` 可直接使用
- 优势：YOLO ONNX 推理 ~50ms（vs VLM ~800ms），无需 Ollama，确定性输出无需解析

**方向 B：三个模型全部 ONNX 化**
- YOLO (检测) + CLIPIQA+ (ONNX) + HyperIQA (ONNX) = 纯 ONNX 管线
- 整条管线不依赖 torch、不依赖 Ollama
- 单张 ~300ms，千张 ~5 分钟
- 完美符合"快速筛选"定位

**方向 C：VLM 降级为可选增强**
- 主管线为纯 ONNX 快速筛选
- VLM 作为二阶段可选功能（物种识别、构图评价等文字解读）
- 但开发者最后一条消息是 "vlm 已经没有意义了看起来？"

### 4.4 待确认

开发者说"先不急，我再考虑一下"。需要确认：

1. **主管线方案**：纯 ONNX（YOLO + IQA）还是保留 VLM 在某个环节？
2. **YOLO 模型来源**：复用 lingjian-v2 的 yolo26x-seg.onnx，还是自行标注微调？
3. **IQA 模型 ONNX 转换**：CLIPIQA+ 和 HyperIQA 能否成功转 ONNX？需要验证
4. **VLM 是否保留**：完全砍掉 Provider 适配层/Prompt 版本管理，还是保留为可选模块？

**一旦管线确定，以下文件需要更新：**
- `docs/TECHNICAL_SPEC.md` — 架构图、技术栈（可能删除 openai SDK，新增 onnxruntime）
- `开发指引` — 关键约束部分
- `engine/llm/` — 可能重构为 `engine/inference/` 或 `engine/ml/`
- `engine/prompts/` — 如果砍掉 VLM 则删除
- `pyproject.toml` — 依赖变更

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
| aiosqlite | >=0.22.0 | WAL 模式 + busy_timeout=5000，需显式 close |
| structlog | >=25.0.0 | JSON 日志，需配置接管 uvicorn 日志 |
| pyright | strict | **API 路由层用 basic**（Depends/Field 误报） |
| ruff | >=0.9.0 | line-length=100, 0.15 有 style guide 变化 |
| uv | 系统工具 | pyproject.toml 在项目根目录，packages=["engine"] |

### 关键文件位置

| 文件 | 用途 |
|------|------|
| `pyproject.toml` | **在项目根目录**（非 engine/ 内），Python 依赖 + 工具配置 |
| `electron.vite.config.ts` | 三端构建，自定义路径（electron/ + renderer/） |
| `docs/TECHNICAL_SPEC.md` | 完整技术规划（架构、数据库设计、兼容性矩阵） |
| `开发指引` | 本地开发指引（简版约束） |
| `engine/llm/provider.py` | Provider 适配层（唯一有实际代码的 placeholder，含 4 个预置 Profile） |

## 6. 开发环境搭建（新电脑）

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
uv run python -m pytest tests/engine/ -v  # 后端测试

# 5. 启动开发（Electron + Vite HMR + Python 后端）
npm start
```

注意：`npm start` 会通过 electron-vite 启动 Electron，Electron 主进程会自动 spawn Python 后端（`uv run uvicorn engine.main:app`）。

## 7. lingjian-v2 测试数据参考路径

后续管线开发可能需要参考的 lingjian-v2 文件：

| 文件 | 内容 |
|------|------|
| `benchmark/ranking/run_hybrid_v4.py` | hybrid v4 管线实现（2B 检测 + CLIPIQA+ + HyperIQA） |
| `benchmark/ranking/run_v4_new1.py` | v4 在完整数据集上的运行（含 0.3C+0.7H 权重） |
| `benchmark/ranking/analyze_weighting.py` | CLIPIQA+/HyperIQA 权重优化分析 |
| `benchmark/ranking/ground_truth_v2.json` | 95 张照片人工标注 |
| `benchmark/ranking/ground_truth_v2_crop.json` | 77 张裁切版本标注 |
| `benchmark/ranking/results/benchmark_summary.json` | 多模型对比摘要 |
| `benchmark/ranking/prompts.py` | v9.1 prompt（最优 VLM prompt，如果保留 VLM） |
| `benchmark/ranking/schema.py` | v9.1 输出 schema（8 字段） |
| `engine/ml/quality_clf.py` | ONNX Sobel 边缘质量评估实现 |
| `engine/models/yolo26x-seg.onnx` | 现有 YOLO 鸟类检测模型 |

## 8. 协作偏好（写入 Claude Code memory）

- commit 以 wlfcss 身份提交，不加 Co-Authored-By
- commit 格式：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:` + 中文描述
- 前端必须有 Playwright E2E 测试（用户依赖 AI 编码，需要安全网）
- 不要建议砍掉 E2E 测试
- UI 文案通过 i18next，不硬编码
- 代码注释中英文均可
