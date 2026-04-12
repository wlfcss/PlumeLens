# PlumeLens / 鉴翎 — 技术规划

## 1. 产品定位

辅助鸟类摄影爱好者快速筛选鸟类照片的桌面应用。

核心场景：摄影师外拍回来，导入数百至数千张照片，由本地 ONNX 管线自动分析每张照片的鸟类检测和画质评估，快速筛选出最佳作品。

## 2. 系统架构

```
┌──────────────────────────────────────────────────┐
│                   Electron                        │
│  ┌──────────┐   ┌─────────────────────────────┐  │
│  │   Main   │   │         Renderer             │  │
│  │ Process  │   │   React 19 + TypeScript      │  │
│  │          │   │   Tailwind CSS v4 + shadcn   │  │
│  │ 生命周期  │   │   TanStack Query (服务端状态) │  │
│  │ 子进程守护 │   │   Zustand (纯 UI 状态)       │  │
│  │ 崩溃转储  │   │   SSE + 轮询降级             │  │
│  └────┬─────┘   └────────────┬────────────────┘  │
│       │                      │                    │
└───────┼──────────────────────┼────────────────────┘
        │ 启动/守护/重启         │ HTTP / SSE (轮询降级)
        ▼                      ▼
┌──────────────────────────────────────────────────┐
│            Python Backend (FastAPI)                │
│  uvicorn · Pydantic · aiosqlite (WAL)             │
│                                                    │
│  ┌────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │ API    │ │ Services │ │    Pipeline       │    │
│  │ Routes │→│ 业务逻辑  │→│ ONNX Runtime     │    │
│  └────────┘ └──────────┘ │ (本地推理)         │    │
│                           └────────┬─────────┘    │
│                                    │               │
└────────────────────────────────────┼───────────────┘
                                     │ onnxruntime
                                     ▼
┌──────────────────────────────────────────────────┐
│         本地 ONNX 模型（97 MB）                    │
│  YOLOv26l-bird-det + CLIPIQA+ + HyperIQA         │
└──────────────────────────────────────────────────┘
```

### 2.1 架构原则

- **推理完全本地化**：所有 ONNX 推理在本机完成，无需外部推理服务，零网络依赖
- **Python 后端保持轻量**：不内嵌 torch/transformers，仅依赖 onnxruntime（~150MB）
- **用户照片目录只读不写**：应用数据存储在 `~/.plumelens/`
- **前端不承担业务逻辑**：所有分析、筛选、排序逻辑在 Python 后端完成；Zustand 严格限于纯 UI 状态（选中态、布局模式、面板展开等），筛选条件的计算逻辑不得渗透到前端

## 3. 技术栈明细

### 3.1 Electron 层

| 关注点 | 选型 | 版本约束 | 说明 |
|--------|------|---------|------|
| Electron | electron | **E2E 基线 pin 35.x** | Playwright 在 Electron 36 上有已知启动失败问题；按季度评估升级，避免 Chromium 版本滞后 |
| 构建工具 | electron-vite (alex8088) 5.x | 基于 Vite 6 | 注意 npm 上有两个同名包，使用 alex8088 版本 |
| 打包分发 | electron-builder 26.x | | macOS arm64 需设置 `com.apple.security.cs.allow-jit` entitlement |
| 主进程职责 | 仅生命周期 + 安全 + 守护 | | 子进程管理、窗口管理、context isolation、preload 最小暴露面 |

### 3.2 Renderer 前端

| 关注点 | 选型 | 版本 | 注意事项 |
|--------|------|------|---------|
| 框架 | React + TypeScript | 19.x | `defaultProps` 已移除，用 ES6 默认参数；全局 `JSX` namespace 移除，用 `React.JSX` |
| 构建 | Vite（electron-vite 内置） | 6.x | |
| 样式 | Tailwind CSS | **v4** | **重大变更**：不再使用 `tailwind.config.ts`，改为 CSS 内 `@theme` 指令；用 `@tailwindcss/vite` 插件；`@import "tailwindcss"` 替代 `@tailwind` 指令 |
| 组件库 | shadcn/ui | latest | **必须用 `tw-animate-css`** 替代 `tailwindcss-animate`；需添加 `@custom-variant dark (&:is(.dark *))` |
| 服务端状态 | TanStack Query | v5 | React 19 完全兼容 |
| 客户端状态 | Zustand | v5 | **陷阱**：selector 返回新对象引用会导致死循环，必须用 `useShallow` |
| 虚拟列表 | @tanstack/react-virtual | 3.x | 设置 `useFlushSync: false` 避免控制台警告 |
| 国际化 | i18next + react-i18next | i18next 24.x / react-i18next 17.x | **从项目初始化即引入**，文案放 JSON 文件不硬编码 |

**TanStack Query 与 Zustand 的边界**：

- TanStack Query：所有来自 Python 后端的数据（照片列表、分析结果、筛选结果）
- Zustand：仅管理前端 UI 交互状态，不做任何数据计算或筛选逻辑
- 筛选/排序/评分等业务逻辑一律通过 API 请求交给后端处理

### 3.3 Python 后端

| 关注点 | 选型 | 版本 | 注意事项 |
|--------|------|------|---------|
| Web 框架 | FastAPI | 0.132+ | **注意**：0.132 起默认严格 Content-Type 检查，前端 fetch 必须带 `Content-Type: application/json` |
| ASGI 服务器 | uvicorn | 0.42+ | PyInstaller 需 `collect_submodules('uvicorn')`；Windows `console=False` 会崩溃需重定向 stdout |
| ONNX 推理 | onnxruntime | 1.24+ | 支持 CPU/CoreML/CUDA Execution Provider；CoreML 在 1.24 有 IQA 模型 bug，暂用 CPU |
| 数值计算 | numpy | 2.0+ | ONNX 输入输出均为 numpy ndarray |
| 数据库 | SQLite + aiosqlite | 0.22+ | **WAL 模式 + busy_timeout=5000**；0.22 起必须显式 close 连接 |
| 图像处理 | Pillow + rawpy | Pillow 12.x / rawpy 0.23+ | rawpy 0.23.1 已有 macOS arm64 原生 wheel |
| EXIF 读取 | Pillow 内置 `Image.getexif()` | | 已有 Pillow 依赖，不额外引入 exifread |
| 配置管理 | pydantic-settings | 2.13+ | 与 Pydantic v2 + FastAPI 无缝集成 |
| 结构化日志 | structlog | 25.x | 支持 JSON/logfmt/console 多格式输出，可接管 uvicorn 日志 |

### 3.4 ONNX 模型与 Execution Provider

三个 ONNX 模型，全部本地推理，无需外部服务。

| 模型 | 文件 | 大小 | 输入 | 输出 | 用途 |
|------|------|------|------|------|------|
| YOLOv26l-bird-det | `yolo26l-bird-det.onnx` | 95.4 MB | float32 [1,3,1440,1440] RGB 0-1 | [1,300,6] (x1,y1,x2,y2,conf,cls) | 鸟类目标检测 |
| CLIPIQA+ | `clipiqa_plus.onnx` | 1.2 MB | float32 [1,3,H,W] 动态尺寸 | [1,1] score 0-1 | 语义画质评估 |
| HyperIQA | `hyperiqa.onnx` | 0.4 MB | float32 [1,3,H,W] 动态尺寸 | [1,1,1] score 0-1 | 技术画质评估 |

**Execution Provider 配置**：

| 模型 | 推荐 Provider | 备注 |
|------|--------------|------|
| YOLO | `auto`（macOS arm64 → CoreML，CUDA 可用 → CUDA，否则 CPU） | CoreML 加速 ~3.8x |
| CLIPIQA+ | `cpu` | onnxruntime 1.24 CoreML bug：model_path must not be empty |
| HyperIQA | `cpu` | 同上 |

**性能基准**（M5 Max, onnxruntime 1.24）：

| 模型 | CoreML | CPU |
|------|--------|-----|
| YOLO | 130ms | 497ms |
| CLIPIQA+ | — | 138ms |
| HyperIQA | — | 315ms |
| **全管线** | **~573ms** | **~950ms** |

**模型版权**：
- `yolo26l-bird-det.onnx`：由 wlfcss 个人训练产出，他人使用需注明来源
- `clipiqa_plus.onnx` / `hyperiqa.onnx`：基于公开 IQA 研究模型的 ONNX 导出

## 4. 项目目录结构

```
PlumeLens/
├── electron/                    # Electron 主进程
│   ├── main.ts                  # 入口，窗口管理，子进程守护
│   ├── preload.ts               # 预加载脚本（最小暴露面）
│   ├── process-manager.ts       # Python 子进程启动/守护/重启
│   └── diagnostics.ts           # 安装后诊断页
│
├── renderer/                    # 前端 UI (React)
│   ├── src/
│   │   ├── components/          # UI 组件
│   │   ├── pages/               # 页面
│   │   ├── stores/              # Zustand stores（仅纯 UI 状态）
│   │   ├── hooks/               # 自定义 hooks
│   │   ├── lib/                 # 工具函数
│   │   ├── i18n/                # 国际化
│   │   │   ├── locales/         # 翻译文件 (zh-CN.json, en.json)
│   │   │   └── index.ts         # i18next 初始化
│   │   └── App.tsx
│   ├── index.html
│   └── app.css                  # Tailwind v4 入口（@import "tailwindcss" + @theme）
│
├── engine/                      # Python 后端
│   ├── api/
│   │   ├── routes/
│   │   │   ├── analysis.py      # 分析任务（单张/批量）
│   │   │   ├── library.py       # 照片库管理
│   │   │   ├── health.py        # 健康检查 + 管线状态
│   │   │   └── settings.py      # 配置接口
│   │   └── schemas/             # Pydantic 请求/响应模型
│   ├── services/
│   │   ├── scanner.py           # 文件夹扫描、EXIF 读取
│   │   ├── analyzer.py          # ONNX 管线调用编排
│   │   ├── ranker.py            # 筛选/排序逻辑
│   │   ├── queue.py             # 批量任务队列（状态机 + 持久化）
│   │   ├── thumbnail.py         # 缩略图生成（双级 + worker 池）
│   │   └── cache.py             # 结果缓存（文件哈希 + 管线版本）
│   ├── pipeline/                # ONNX 推理管线
│   │   ├── manager.py           # 生命周期管理 + 编排（PipelineManager）
│   │   ├── detector.py          # YOLO 鸟类检测封装
│   │   ├── quality.py           # CLIPIQA+ & HyperIQA 双模型画质评估
│   │   ├── grader.py            # 综合分 → 4 档分级
│   │   ├── preprocess.py        # 图像加载/缩放/裁切/归一化
│   │   └── models.py            # Pydantic 数据模型（BoundingBox, QualityScores 等）
│   ├── models/                  # ONNX 模型文件（随项目版本控制）
│   │   ├── yolo26l-bird-det.onnx
│   │   ├── clipiqa_plus.onnx
│   │   └── hyperiqa.onnx
│   ├── core/
│   │   ├── config.py            # 配置（Pydantic Settings，含管线参数）
│   │   ├── database.py          # SQLite 连接管理（WAL 模式）
│   │   ├── logging.py           # 统一日志（结构化 JSON）
│   │   └── lifespan.py          # FastAPI 启动/关闭 + ONNX 模型加载
│   ├── main.py                  # FastAPI 入口
│   └── pyproject.toml           # Python 项目配置（uv）
│
├── evals/                       # 质量评测集
│   ├── dataset/                 # 固定照片集
│   ├── golden/                  # 预期结果基线
│   ├── run_eval.py              # 评测脚本
│   └── report.py                # 评测报告生成
│
├── tests/
│   ├── engine/                  # 后端测试
│   │   ├── test_api/            # API 路由测试
│   │   ├── test_services/       # 业务逻辑测试
│   │   └── test_pipeline/       # 管线模块测试（检测/画质/分级/预处理）
│   ├── renderer/                # 前端单元测试 (Vitest)
│   └── e2e/                     # Playwright E2E 测试
│       └── fixtures/            # Mock 推理响应数据
│
├── docs/                        # 项目文档
│   └── TECHNICAL_SPEC.md        # 本文件
│
├── .github/
│   └── workflows/
│       ├── ci.yml               # CI 流水线
│       └── eval.yml             # 质量评测（手动触发）
│
├── package.json                 # Electron + 前端依赖
├── electron-builder.yml         # 打包配置
├── 开发指引                    # 本地开发指引
├── README.md
└── LICENSE                      # GPL-3.0
```

## 5. 数据存储

```
~/.plumelens/
├── config.json                  # 用户配置（管线参数、偏好）
├── plumelens.db                 # SQLite 数据库（WAL 模式）
├── logs/                        # 结构化日志 + 崩溃转储
│   ├── engine.log               # Python 后端日志（JSON 格式）
│   ├── electron.log             # Electron 主进程日志
│   └── crash/                   # 崩溃转储文件
└── cache/
    └── thumbnails/
        ├── grid/                # 网格缩略图（长边 384px, ~30KB）
        └── preview/             # 预览大图（长边 1920px, ~200KB）
```

### 5.1 SQLite 数据库设计

**启用 WAL 模式**：批量分析时队列状态更新和结果写入频率较高，WAL 避免写锁阻塞读操作。

#### photos 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID（首扫时生成） |
| file_path | TEXT NOT NULL | 原始文件绝对路径 |
| file_name | TEXT NOT NULL | 文件名 |
| file_size | INTEGER NOT NULL | 文件大小（字节） |
| file_mtime | TEXT NOT NULL | 文件修改时间 |
| file_hash | TEXT | 完整内容 SHA-256（后台补算，初始为 NULL） |
| format | TEXT | 文件格式（JPEG/CR3/NEF/ARW 等） |
| width | INTEGER | 原图宽度 |
| height | INTEGER | 原图高度 |
| exif_json | TEXT | EXIF 数据（JSON） |
| thumb_grid | TEXT | 网格缩略图路径 |
| thumb_preview | TEXT | 预览缩略图路径 |
| created_at | TEXT | 记录创建时间 |
| library_id | TEXT FK | 所属照片库 |

索引：`(library_id, created_at)`, `(file_hash)`, `(file_path)` UNIQUE

**两阶段导入策略**：

首扫体验优先，避免全量 SHA-256 阻塞导入流程（数千张 30-50MB RAW 全量哈希非常耗时）：

- **阶段 1 — 轻指纹**：`path + size + mtime`，快速建库、生成缩略图、即可浏览
- **阶段 2 — 后台补强哈希**：后台 worker 逐张计算完整 SHA-256，用于去重和强缓存
- 分析任务在 `file_hash` 可用前不启动，前端提示"正在准备中"

#### analysis_results 表

分析结果由 **pipeline_version** 控制。pipeline_version 是模型校验和 + 评分参数的确定性哈希，任何模型或参数变更自动使缓存失效。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| photo_id | TEXT FK | 关联 photos |
| pipeline_version | TEXT NOT NULL | 管线版本（如 "v1-a3b2c1d4"） |
| result_json | TEXT NOT NULL | 序列化的 PipelineResult |
| quality_score | REAL | 最佳鸟的综合画质分 0-1（冗余字段，加速排序） |
| grade | TEXT | 最佳鸟的分级：reject/record/usable/select |
| bird_count | INTEGER | 检测到的鸟数量 |
| species | TEXT | 物种名称（预留，当前为 NULL） |
| created_at | TEXT | 分析时间 |
| is_active | BOOLEAN DEFAULT true | 是否为当前展示版本 |

索引：`(photo_id, pipeline_version)` UNIQUE, `(quality_score)`, `(grade)`

```sql
-- 保证每张照片只有一条 active 结果
CREATE UNIQUE INDEX uq_analysis_active
ON analysis_results(photo_id)
WHERE is_active = 1;
```

**缓存键**：`(file_hash, pipeline_version)` — 同一张照片 + 同一管线版本只保留一条结果。ONNX 推理是确定性的，同一输入必得同一输出。

**版本控制语义**：

- `(photo_id, pipeline_version)` UNIQUE：同版本同照片只保留一条结果，确定性推理不需要多条
- 管线版本变更后（模型/参数/预处理变更），新分析结果插入新行并标记为 active，旧版本 `is_active` 置 false
- 用户手动"重新分析"：当前 pipeline_version 已有结果时，直接覆盖该行（`INSERT OR REPLACE`）
- 旧版本结果永久保留，可用于评测对比和回溯
- 部分唯一索引 `uq_analysis_active` 在数据库层保证"每张照片至多一条 active"，不依赖应用逻辑

**触发重新分析的场景**：

1. 模型文件更新 → pipeline_version 自动变更 → 新版本插入新行
2. 评分参数调整（IQA 权重/分级阈值/预处理参数变更）→ pipeline_version 变更
3. 用户手动"重新分析" → 同版本覆盖（理论结果相同，供用户确认用）

#### task_queue 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| photo_id | TEXT FK | 关联 photos |
| library_id | TEXT FK | 所属批次 |
| status | TEXT NOT NULL | 状态机（见下文） |
| priority | INTEGER DEFAULT 0 | 优先级 |
| attempts | INTEGER DEFAULT 0 | 已重试次数 |
| error_message | TEXT | 最近一次错误信息 |
| created_at | TEXT | 入队时间 |
| started_at | TEXT | 开始处理时间 |
| completed_at | TEXT | 完成时间 |

索引：`(status, priority, created_at)`, `(library_id, status)`

**任务状态机**：

```
pending → processing → completed
                   ↘ failed → pending (自动重试, max 3 次)
                          ↘ dead (超过重试次数)

任意状态 → cancelled (用户取消)
processing → paused (用户暂停) → pending (用户恢复)
```

合法状态转换严格限制，非法转换抛异常。

## 6. 运行时硬化

### 6.1 Electron 安全

- **Sandbox**：`sandbox: true` 显式声明（Electron 20+ 默认开启，但不应依赖默认值）
- **Context Isolation**：`contextIsolation: true`，`nodeIntegration: false`
- **Preload 最小暴露面**：preload 仅暴露必要的 API 桥接方法，不暴露 `ipcRenderer` 本身
- **CSP**：renderer 严格 Content Security Policy，禁止 inline script / eval
- **协议注册**：自定义 `plumelens://` 协议提供缩略图访问，不直接暴露 file:// 路径；注意 `protocol.handle` 的路径编码和 scheme 注册策略
- **本地 HTTP 信任边界**（详见 §13.1）：后端仅绑定 `127.0.0.1`，Electron 启动时生成一次性 token，后端所有请求必须在 header 中携带该 token 验证身份

```typescript
// preload.ts — 仅暴露这些方法
contextBridge.exposeInMainWorld('plumelens', {
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  onBackendReady: (cb: () => void) => ipcRenderer.on('backend-ready', cb),
  onBackendError: (cb: (msg: string) => void) => ipcRenderer.on('backend-error', (_, msg) => cb(msg)),
})
```

### 6.2 子进程守护与重启

```
Electron Main Process
  ├── 启动 Python 子进程 (uvicorn)
  ├── 监听 stdout 获取端口号
  ├── 健康检查心跳（每 10 秒 GET /health）
  ├── 子进程异常退出 → 自动重启（最多 3 次，间隔递增 2s/5s/10s）
  ├── 超过重启次数 → 展示诊断页面
  └── 应用退出 → 优雅关闭（SIGTERM → 等待 5s → SIGKILL）
```

### 6.3 统一日志

**后端日志**：结构化 JSON 格式，便于机器解析和排障。

```json
{"ts": "2026-04-03T10:00:00Z", "level": "INFO", "module": "pipeline", "msg": "分析完成", "photo_id": "abc123", "duration_ms": 573, "bird_count": 2}
```

- Python 后端：`structlog`，JSON 格式输出
- Electron 主进程：`electron-log`，写入 `~/.plumelens/logs/electron.log`
- 日志轮转：单文件 10MB 上限，保留最近 5 份

**崩溃转储**：
- Electron：`crashReporter` 写入 `~/.plumelens/logs/crash/`
- Python：未捕获异常写入 `~/.plumelens/logs/crash/engine-{timestamp}.txt`（含完整 traceback + 系统信息）

### 6.4 安装后诊断页

应用内置诊断页面（`/diagnostics` 或 Electron 内置页面），检测项目：

| 检测项 | 说明 |
|--------|------|
| Python 后端连通性 | 是否启动成功，端口是否可达 |
| ONNX 模型文件 | 三个模型文件是否存在且完整 |
| Execution Provider | 可用的 EP 列表（CPU/CoreML/CUDA） |
| 管线功能验证 | 加载一张测试图片验证推理流程 |
| 磁盘空间 | ~/.plumelens/ 所在磁盘剩余空间 |
| RAW 格式支持 | libraw 版本及支持的格式列表 |
| 日志/崩溃转储路径 | 是否可写 |

启动异常或用户反馈问题时，引导用户打开此页面。诊断结果可一键导出为文本。

## 7. ONNX 分析管线

### 7.1 管线流程

```
原图 (RAW/JPEG, 30-50MB)
  ↓ Pillow/rawpy 读取 → float32 [H,W,3] RGB 0-1
  ↓ letterbox 缩放至 1440×1440
  ↓ YOLOv26l-bird-det.onnx (conf ≥ 0.35)
  ↓ 输出 N 个鸟类 bounding box
  ↓ 对每个 bbox:
  │   ├── box×1.0 裁切
  │   ├── CLIPIQA+.onnx → 语义画质分
  │   └── HyperIQA.onnx → 技术画质分
  │   └── 综合分 = 0.35 × CLIPIQA+ + 0.65 × HyperIQA
  │   └── 4 档分级
  ↓ 选最高综合分的鸟 → PipelineResult
```

### 7.2 分级阈值

| 分级 | 综合分范围 | 含义 |
|------|-----------|------|
| 淘汰 (REJECT) | < 0.33 | 画质差，不建议保留 |
| 记录 (RECORD) | 0.33 - 0.43 | 画质一般，可作记录 |
| 可用 (USABLE) | 0.43 - 0.60 | 画质较好，可使用 |
| 精选 (SELECT) | ≥ 0.60 | 画质优秀，推荐作品 |

阈值和 IQA 权重通过 `engine/core/config.py` 配置，支持环境变量覆盖。

### 7.3 PipelineManager 生命周期

```python
# engine/pipeline/manager.py

class PipelineManager:
    """单例，创建于 FastAPI lifespan startup，挂载到 app.state.pipeline"""

    async def initialize(self) -> None
        # 加载 3 个 ONNX InferenceSession
        # 计算 pipeline_version（模型校验和 + 参数哈希）
        # 模型缺失时不崩溃，is_ready = False

    async def analyze(self, image_path: Path, photo_id: str) -> PipelineResult
        # 通过 asyncio.to_thread() 在线程池执行，不阻塞事件循环

    @property
    def pipeline_version(self) -> str
        # "v1-{hash[:8]}" — 确定性版本串，用于缓存键

    @property
    def is_ready(self) -> bool
        # True 当且仅当 YOLO + CLIPIQA+ + HyperIQA 全部加载成功
```

### 7.4 Pipeline 版本计算

```python
pipeline_version = f"v1-{sha256(
    # 模型身份
    yolo_checksum + clipiqa_checksum + hyperiqa_checksum
    # 评分参数
    + clipiqa_weight + hyperiqa_weight + grade_thresholds
    # 检测参数
    + yolo_confidence + yolo_input_size
    # 裁切策略
    + crop_expand_ratio
    # 预处理版本（任何 resize/letterbox/normalization/color 变更需递增）
    + preprocess_version
    # 运行时环境
    + onnxruntime_version + execution_providers
)[:8]}"
```

**版本输入的完整清单**：

| 输入 | 说明 | 变更影响 |
|------|------|---------|
| 三模型 SHA-256 checksum | 模型文件身份 | 模型替换 → 结果变化 |
| IQA 权重 (clipiqa/hyperiqa) | 综合分计算 | 权重调整 → 评分变化 |
| 分级阈值 (3 档) | 分级逻辑 | 阈值调整 → 分级变化 |
| 检测置信度阈值 | YOLO 过滤 | 阈值调整 → 检测数量变化 |
| YOLO 输入尺寸 | letterbox 目标尺寸 | 尺寸变更 → 检测结果变化 |
| 裁切策略 (expand ratio) | bbox 裁切范围 | 裁切比例 → IQA 输入变化 |
| 预处理版本号 | resize/normalize/color 代码版本 | 代码变更需手动递增 |
| onnxruntime 版本 | 推理引擎 | 版本升级可能改变浮点结果 |
| Execution Provider 组合 | 实际推理后端 | CoreML vs CPU 可能产生微小浮点差异 |

**设计原理**：同一模型文件 ≠ 同一运行语义。onnxruntime 官方将 CPU/CUDA/CoreML 视为不同执行后端；CoreML 存在平台相关的浮点行为差异。将 EP 纳入版本计算可保证"结果可重现"的承诺。

### 7.5 物种分类（预留）

当前物种分类模型空缺（旧模型覆盖 498 种北美鸟类，不适用）。设计上预留：

- `PipelineManager` 有 `species_classifier` 属性，启动时检查 `models_dir/species.onnx`
- `BirdAnalysis.species` 字段为 `str | None`，当前恒为 `None`
- 前端据此决定是否显示物种信息
- 未来添加模型后重启即自动生效，pipeline_version 变更触发缓存失效

## 8. 性能控制面

### 8.1 图像处理并发控制

```python
# engine/core/config.py (Settings)

# RAW 解码（CPU 密集，rawpy 底层是 C）
raw_decode_workers: int = 2          # RAW 解码并发数（默认 CPU 核心数 / 2，最大 4）

# 缩略图生成
thumbnail_workers: int = 4           # 缩略图生成 worker 池大小

# ONNX 分析
analysis_concurrency: int = 2        # ONNX 分析并发数（本地推理，可适度并行）
analysis_queue_max_pending: int = 100 # 队列最大待处理数（backpressure 阈值）
```

### 8.2 Backpressure 机制

当 `task_queue` 中 `status = 'pending'` 的任务数超过 `analysis_queue_max_pending` 时：
- 暂停新任务入队
- 前端提示"分析队列已满，等待处理中"
- 待队列消化到阈值 50% 以下后自动恢复

### 8.3 可中断点

长耗时操作必须支持取消/暂停，中断点设计：

| 操作 | 中断点 | 行为 |
|------|--------|------|
| 文件夹扫描 | 每扫描 50 个文件检查一次 | 已扫描部分保留 |
| 缩略图生成 | 每张图完成后检查 | 已生成的缩略图保留 |
| ONNX 分析 | 每张图完成后检查 | 当前图分析完成后停止，不中断正在进行的推理 |
| 批量导出 | 每张图导出后检查 | 已导出部分保留 |

### 8.4 缩略图双级策略

| 级别 | 长边 | 大小 | 用途 |
|------|------|------|------|
| grid | 384px | ~30KB | 网格浏览，虚拟列表大量渲染 |
| preview | 1920px | ~200KB | 单张预览 |

网格浏览时只加载 grid 级别，切换到单张预览时按需加载 preview 级别。显著降低前端内存占用。

**RAW 缩略图优化**：RAW 文件内嵌有相机生成的 JPEG 预览图（rawpy `extract_thumb()`），通常分辨率足够用于 grid 甚至 preview 级别。应优先使用内嵌预览，避免完整 RAW 解码的高 CPU 开销：

```
RAW 文件 → rawpy.extract_thumb()
  ├── 成功 → 用内嵌 JPEG 生成 grid/preview 缩略图
  └── 失败/尺寸不够 → 回退完整 rawpy 解码
```

这会显著改善首次扫描出图速度和缩略图 worker 的 CPU 占用。

### 8.5 ORT 线程调优

ONNX Runtime 提供 `intra_op_num_threads` 和 `inter_op_num_threads` 调优入口。当分析 worker、RAW 解码 worker、缩略图 worker 并发运行时，线程争抢会成为吞吐瓶颈。

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `ort_intra_op_threads` | 0 (ORT 自动) | 单个 OP 的并行线程数 |
| `ort_inter_op_threads` | 0 (ORT 自动) | OP 间并行线程数 |

**性能目标**应从"单张延迟"扩展为"按硬件档位的 photos/hour"：

| 硬件档位 | 单张延迟 | 预估吞吐 (photos/hour) |
|---------|---------|----------------------|
| Apple Silicon (CoreML) | ~573ms | ~4,000+ |
| 中端 x86 (CPU only) | ~950ms | ~2,500+ |
| 低端 / 老旧设备 | ~2,000ms | ~1,000+ |

实际吞吐需在并发场景下实测验证（RAW 解码、JPEG 编码、SQLite 写入、ORT 线程争抢会同时消耗 CPU）。

## 9. 关键设计决策

### 9.1 Pipeline 版本管理

分析管线版本是数据一致性的核心：

- pipeline_version 由完整输入向量的 SHA-256 哈希生成（详见 §7.4）
- 完整输入包括：模型校验和、评分参数、检测参数、裁切策略、预处理版本、ORT 版本、EP 组合
- 确定性：相同输入向量 = 相同 pipeline_version = 相同分析结果
- 缓存键 `(file_hash, pipeline_version)` 保证结果一致性
- 版本变更自动触发：模型文件替换、参数调整、ORT 升级、EP 切换

### 9.2 批量任务队列

- 状态机严格管控（见 5.1 节状态机定义），非法转换抛异常
- 任务状态持久化到 SQLite，支持暂停/恢复/取消/断点续跑
- 应用关闭后再打开，`processing` 状态的任务回退为 `pending` 自动续跑
- 通过 SSE 实时推送分析进度到前端，**同时前端做轮询降级**
- 缓存键 `(file_hash, pipeline_version)` 避免重复分析

### 9.3 首次启动引导

```
启动应用
├── 检测 ONNX 模型文件 → 全部存在 → 管线加载成功 → 就绪
├── 检测 ONNX 模型文件 → 部分缺失 → 诊断页提示缺少的模型
└── 管线加载失败 → 展示错误信息 + 诊断页面
```

### 9.4 图像预处理流水线

```
扫描阶段（阶段 1 — 轻指纹）：
  文件系统遍历 → path + size + mtime → 建库 → 即可浏览
  ↓ 并行启动缩略图 worker

缩略图生成：
  RAW 文件:
    ├── rawpy.extract_thumb() → 内嵌 JPEG 预览（优先）
    └── 失败/尺寸不够 → rawpy 完整解码（回退）
  JPEG/PNG:
    └── Pillow 读取
  ↓ 并发控制：thumbnail_workers 限制并发
  ├── → grid 缩略图（长边 384px, JPEG 80%）→ 缓存
  └── → preview 缩略图（长边 1920px, JPEG 85%）→ 缓存

后台补强（阶段 2）：
  逐张计算完整 SHA-256 → 写入 photos.file_hash → 解锁分析任务
```

缩略图在文件夹扫描阶段由 worker 池异步生成，不阻塞 UI。分析任务在 `file_hash` 就绪后才可启动。

**RAW 格式兼容性**：
- rawpy 底层依赖 libraw，CR3（Canon R5/R6/R7 等）需要 libraw >= 0.20
- 文档和诊断页面注明最低 libraw 版本要求
- 不支持的格式优雅降级（跳过并提示用户）

### 9.5 SSE + 轮询降级

分析进度推送的主路径是 SSE，但需要轮询作为降级方案：

- 正常情况：前端建立 SSE 连接接收实时进度
- SSE 连接断开（系统休眠恢复、网络波动等）：前端自动检测并切换到轮询模式
- 轮询间隔：2 秒
- SSE 恢复后自动切回

## 10. 质量评测集

### 10.1 目的

量化"模型换了 / 评分参数改了"对分析结果质量的影响。

### 10.2 结构

```
evals/
├── dataset/                     # 固定照片集
│   ├── quality_gradient/        # 同一物种不同画质（用于排序评测）
│   └── edge_cases/              # 边界情况（模糊、遮挡、多只鸟、非鸟）
│
├── golden/                      # 预期结果基线（人工标注）
│   └── ranking_order.json       # 质量排序的期望顺序
│
├── run_eval.py                  # 评测脚本
│   # 输入：pipeline_version（自动从当前管线获取）
│   # 输出：逐张分析结果 + 聚合指标
│
└── report.py                    # 对比报告生成
    # 对比两次评测结果，输出：
    # - 检测 Recall / Precision 变化
    # - 质量评分相关性变化（Spearman）
    # - 回归项（之前对的现在错了）
```

### 10.3 指标

| 指标 | 说明 | 计算方式 |
|------|------|---------|
| 检测 Recall | 鸟类检测召回率 | detected / total_birds |
| 检测 Precision | 鸟类检测精确率 | true_positive / total_detections |
| 质量排序相关性 | 管线评分与人工排序的一致性 | Spearman rank correlation |
| 回归数 | 本次比上次"变差"的数量 | diff against baseline |
| 平均延迟 | 单张分析平均耗时 | mean(duration_ms) |

### 10.4 触发方式

- 手动：`python evals/run_eval.py`
- CI：`.github/workflows/eval.yml`（手动触发 / 模型变更时触发）

## 11. 打包与分发

### 11.1 痛点

Python 后端作为 Electron 子进程，打包分发需要把 Python 运行时 + 依赖一起打包。

### 11.2 方案

| 阶段 | 方案 | 说明 |
|------|------|------|
| 开发期 | 系统 Python + uv | 开发者自行安装 Python 和 uv |
| 分发期 | PyInstaller 单目录模式 | 将 engine/ 打包为独立可执行目录，随 Electron 一起分发 |

**⚠️ 里程碑 0 — 打包验收项（必须在骨架完成后立即验证）**：

不通过此验证，后续所有 UI 和功能开发都没有意义。最小闭环打包测试清单：

- [ ] 能启动 Electron
- [ ] 能拉起 Python 后端进程
- [ ] 能加载至少一个 ONNX InferenceSession
- [ ] 能打开一张 RAW 文件
- [ ] 能写入 structlog 日志

**关键注意事项**：
- PyInstaller 打包后体积约 200-250MB（含 onnxruntime，不含 torch，体积可控）
- ONNX 模型文件（97MB）作为 extraResources 随 Electron 一起分发
- macOS 和 Windows 需要分别打包（CI 中完成，PyInstaller 不支持交叉编译）
- rawpy 的 libraw C 库：`pyinstaller-hooks-contrib` 提供了 hook，但需实测确认 `.dylib` / `.dll` 被正确捕获
- uvicorn 必须配置 `collect_submodules('uvicorn')` 隐藏导入
- onnxruntime 的 C++ 共享库需确保被 PyInstaller 正确捕获
- Windows 特有问题：`console=False` 会导致 uvicorn 因无 stdout 而崩溃，需重定向 stdout/stderr
- macOS 分发需要代码签名 + 公证

### 11.3 CI 打包流水线

```yaml
# .github/workflows/build.yml（后期）
jobs:
  build-mac:
    - uv sync
    - pyinstaller engine/main.py --name plumelens-engine
    - electron-builder --mac
  build-win:
    - uv sync
    - pyinstaller engine/main.py --name plumelens-engine
    - electron-builder --win
```

## 12. 开发工具链

### 12.1 Python

| 工具 | 用途 | 注意事项 |
|------|------|---------|
| uv 0.11+ | 包管理 + 虚拟环境 | lockfile 为 `uv.lock`（TOML），PyInstaller 阶段可 `uv export --format requirements-txt` |
| ruff 0.15+ | lint + format（line-length = 100） | 0.15 引入 2026 style guide，建议锁定版本避免大 diff |
| pyright | 静态类型检查 | **FastAPI 路由层及 ONNX 推理层用 basic 模式**（第三方库缺少类型存根），其余代码 strict |
| pytest + pytest-asyncio | 测试框架 | |
| structlog 25.x | 结构化日志 | 需配置接管 uvicorn 日志（见 structlog stdlib integration 文档） |

### 12.2 前端

| 工具 | 用途 | 注意事项 |
|------|------|---------|
| ESLint + Prettier | 代码规范 | |
| Vitest | 组件/逻辑单元测试 | |
| Playwright | Electron 全流程 E2E | **锁定 Electron 35.x**；Tracing 不支持 Electron；不支持测试原生菜单/系统托盘 |

### 12.3 CI (GitHub Actions)

```
push / PR 触发:
  ├── backend: ruff check → pyright → pytest
  ├── frontend: eslint → tsc --noEmit → vitest
  └── e2e: Playwright（PR 时 / 手动触发）

手动触发:
  ├── eval: 质量评测集
  └── build: 打包分发（macOS / Windows）
```

## 13. 通信协议

### 13.1 Electron ↔ Python Backend

本地 HTTP（`http://127.0.0.1:{动态端口}`），FastAPI 启动后通过 stdout 通知 Electron 实际端口。

- 常规请求：REST API（JSON）
- 分析进度：SSE（Server-Sent Events）+ 轮询降级
- 缩略图访问：自定义 `plumelens://` 协议或静态文件服务

**本地信任边界**：

"本地所以安全"是不够的。本机其他进程也可以调用 localhost API，需要主动防御：

1. **后端仅绑定 `127.0.0.1`**：`uvicorn --host 127.0.0.1`，拒绝非本机连接
2. **一次性 token 验证**：Electron 启动时生成随机 token，通过环境变量传递给 Python 子进程；后端中间件校验所有请求的 `Authorization: Bearer {token}` header
3. **备选方案**：Unix domain socket (macOS/Linux) / Named pipe (Windows)，彻底消除端口暴露

当前方案选择"绑定 127.0.0.1 + 一次性 token"，兼顾安全性和调试便利性。

### 13.2 Python Backend ↔ ONNX Runtime

本地函数调用，无网络通信。

- `PipelineManager` 在 FastAPI lifespan startup 阶段加载 ONNX InferenceSession
- 推理通过 `onnxruntime.InferenceSession.run()` 直接调用
- 输入输出均为 numpy ndarray，无序列化开销
- 通过 `asyncio.to_thread()` 包装，不阻塞事件循环

## 14. 异常状态处理

### 14.1 管线不可用

| 场景 | 行为 |
|------|------|
| 模型文件缺失 | 启动时 `pipeline.is_ready = False`；health 端点报告降级；分析 API 返回 503 |
| 模型加载失败 | 记录错误日志；诊断页面展示具体错误 |
| 推理异常 | 任务标记为 failed，根据重试策略自动重试（max 3 次） |
| 内存不足 | 记录 OOM 日志；建议用户减小 analysis_concurrency |

### 14.2 已有数据离线浏览

管线不可用时，已分析的结果正常浏览（数据在本地 SQLite），仅新分析功能不可用。前端需明确区分：
- 管线就绪：全功能
- 管线未就绪：浏览/筛选/导出正常，分析功能灰置并提示原因

## 15. 兼容性风险矩阵

经逐一查阅官方文档确认的已知风险，按严重性排序：

### 15.1 高风险（必须在开发初期解决）

| 风险 | 组件 | 影响 | 对策 |
|------|------|------|------|
| Playwright 启动失败 | Electron 36 + Playwright | E2E 测试无法运行 | E2E 基线 pin Electron 35.x，按季度评估升级 |
| selector 死循环 | Zustand v5 | 前端页面卡死 | 所有返回对象的 selector 使用 `useShallow` |
| PyInstaller 打包 uvicorn | PyInstaller + uvicorn | 打包后启动崩溃 | `collect_submodules('uvicorn')` + Windows stdout 重定向 |
| PyInstaller 打包 rawpy | PyInstaller + libraw C 库 | RAW 图片无法解码 | 尽早验证，必要时手动添加 binaries |
| CoreML IQA bug | onnxruntime 1.24 + CoreML | IQA 模型推理失败 | IQA 模型暂用 CPUExecutionProvider |

### 15.2 中风险（需留意但有明确解决路径）

| 风险 | 组件 | 影响 | 对策 |
|------|------|------|------|
| 配置格式大改 | Tailwind CSS v4 | 配置方式完全不同 | 使用 CSS `@theme` 指令 + `@tailwindcss/vite`，不创建 tailwind.config.ts |
| 动画包更换 | shadcn/ui + Tailwind v4 | 组件动画失效 | 安装 `tw-animate-css` 替代 `tailwindcss-animate` |
| pyright 误报 | pyright strict + FastAPI/onnxruntime | 大量类型错误噪音 | API 路由层及 ONNX 推理层降为 basic 模式 |
| Content-Type 严格检查 | FastAPI 0.132+ | 前端请求被拒 | fetch 请求统一带 `Content-Type: application/json` |
| CR3 格式支持 | rawpy (libraw) | 部分 Canon 新机型照片无法打开 | rawpy 0.23+ 内置 libraw 0.21（支持 CR3），但需实测具体机型 |
| PyInstaller 打包 onnxruntime | PyInstaller + onnxruntime C++ 库 | 推理功能不可用 | 尽早验证，确认 .dylib/.dll 被正确捕获 |

### 15.3 低风险（已有解决方案）

| 风险 | 组件 | 对策 |
|------|------|------|
| React 19 类型变更 | react-i18next | 升级至 react-i18next 17.x |
| flushSync 警告 | @tanstack/react-virtual | 设置 `useFlushSync: false` |
| aiosqlite 连接清理 | aiosqlite 0.22+ | 使用 context manager 或显式 `await conn.close()` |
| electron-builder arm64 | electron-builder + macOS | 设置 JIT entitlement |
| SQLite 写并发 | aiosqlite + WAL | 单写连接 + `PRAGMA busy_timeout=5000` |
