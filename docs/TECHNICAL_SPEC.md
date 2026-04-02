# PlumeLens / 鉴翎 — 技术规划

## 1. 产品定位

辅助鸟类摄影爱好者快速筛选鸟类照片的桌面应用。

核心场景：摄影师外拍回来，导入数百至数千张照片，由 VLM 自动分析每张照片的物种、画质、构图等维度，快速筛选出最佳作品。

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
│  uvicorn · Pydantic · aiosqlite (WAL) · openai    │
│                                                    │
│  ┌────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐  │
│  │ API    │ │ Services │ │Prompts │ │Provider │  │
│  │ Routes │→│ 业务逻辑  │→│ 版本化  │→│ Adapter │  │
│  └────────┘ └──────────┘ └────────┘ └────┬────┘  │
│                                          │        │
└──────────────────────────────────────────┼────────┘
                                           │ OpenAI-compatible API
                                           ▼
┌──────────────────────────────────────────────────┐
│       Ollama / vLLM / LM Studio / 云端 API        │
│              (Qwen2.5-VL-4B 等)                    │
└──────────────────────────────────────────────────┘
```

### 2.1 架构原则

- **推理运行时与应用逻辑彻底解耦**：Python 后端不内嵌 torch/transformers，通过 OpenAI 兼容协议调用外部推理服务
- **Python 后端保持轻量**：核心依赖控制在 100MB 以内
- **用户照片目录只读不写**：应用数据存储在 `~/.plumelens/`
- **前端不承担业务逻辑**：所有分析、筛选、排序逻辑在 Python 后端完成；Zustand 严格限于纯 UI 状态（选中态、布局模式、面板展开等），筛选条件的计算逻辑不得渗透到前端

## 3. 技术栈明细

### 3.1 Electron 层

| 关注点 | 选型 | 说明 |
|--------|------|------|
| 构建工具 | electron-vite | Vite 统一管理 main/preload/renderer 三端构建 |
| 打包分发 | electron-builder | 跨平台打包（macOS DMG / Windows EXE） |
| 主进程职责 | 生命周期 + 安全 + 守护 | 子进程管理、窗口管理、context isolation、preload 最小暴露面 |

### 3.2 Renderer 前端

| 关注点 | 选型 | 说明 |
|--------|------|------|
| 框架 | React 19 + TypeScript | 成熟生态，组件化开发 |
| 构建 | Vite（electron-vite 内置） | 快速 HMR |
| 样式 | Tailwind CSS v4 | 照片类 UI 需大量自定义布局 |
| 组件库 | shadcn/ui | 基于 Radix UI，源码级引入可自定义 |
| 服务端状态 | TanStack Query | 管理 FastAPI 请求的缓存/重试/loading |
| 客户端状态 | Zustand | **严格限于纯 UI 状态**（选中态、布局模式、面板展开等） |
| 虚拟列表 | @tanstack/react-virtual | 数千张照片场景下必须虚拟化渲染 |

**TanStack Query 与 Zustand 的边界**：

- TanStack Query：所有来自 Python 后端的数据（照片列表、分析结果、筛选结果）
- Zustand：仅管理前端 UI 交互状态，不做任何数据计算或筛选逻辑
- 筛选/排序/评分等业务逻辑一律通过 API 请求交给后端处理

### 3.3 Python 后端

| 关注点 | 选型 | 说明 |
|--------|------|------|
| Web 框架 | FastAPI | async 原生，Pydantic 类型严格，自带 Swagger |
| ASGI 服务器 | uvicorn | 标准 ASGI，配合 FastAPI |
| VLM 客户端 | openai (Python SDK) | 异步调用，兼容所有 OpenAI 协议后端 |
| 数据库 | SQLite + aiosqlite | 单用户桌面应用，零部署成本，**启用 WAL 模式** |
| 图像处理 | Pillow + rawpy | JPEG/PNG 及 RAW 格式（CR2/CR3/NEF/ARW） |
| EXIF 读取 | exifread | 纯 Python，无外部依赖 |
| 配置管理 | pydantic-settings | 类型安全，支持 .env |

### 3.4 推理后端兼容矩阵

所有推理后端通过 OpenAI 兼容协议接入，Python 后端代码零改动。

| 后端 | 安装方式 | 适合场景 |
|------|---------|---------|
| Ollama（默认） | 一键安装 + `ollama pull` | 大多数用户 |
| LM Studio | GUI 安装 | 偏好图形界面的用户 |
| vLLM | pip install | 有独显的高级用户 |
| 云端 API | 填写 API key + base_url | 无 GPU 用户 |

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
│   │   └── App.tsx
│   ├── index.html
│   └── tailwind.config.ts
│
├── engine/                      # Python 后端
│   ├── api/
│   │   ├── routes/
│   │   │   ├── analysis.py      # 分析任务（单张/批量）
│   │   │   ├── library.py       # 照片库管理
│   │   │   ├── health.py        # 健康检查 + 诊断
│   │   │   └── settings.py      # 配置接口
│   │   └── schemas/             # Pydantic 请求/响应模型
│   ├── services/
│   │   ├── scanner.py           # 文件夹扫描、EXIF 读取
│   │   ├── analyzer.py          # VLM 调用编排
│   │   ├── ranker.py            # 筛选/排序逻辑
│   │   ├── queue.py             # 批量任务队列（状态机 + 持久化）
│   │   ├── thumbnail.py         # 缩略图生成（双级 + worker 池）
│   │   └── cache.py             # 结果缓存（文件哈希 + prompt 版本）
│   ├── llm/
│   │   ├── client.py            # OpenAI 兼容客户端（唯一出口）
│   │   ├── provider.py          # Provider 适配层（能力声明）
│   │   └── parser.py            # VLM 输出解析-修复-验证
│   ├── prompts/
│   │   ├── v1/
│   │   │   ├── analyze.py       # 单张分析 prompt
│   │   │   ├── compare.py       # 对比筛选 prompt
│   │   │   └── schema.py        # 期望输出的 JSON Schema
│   │   └── registry.py          # prompt 版本注册
│   ├── core/
│   │   ├── config.py            # 配置（Pydantic Settings）
│   │   ├── database.py          # SQLite 连接管理（WAL 模式）
│   │   ├── logging.py           # 统一日志（结构化 JSON）
│   │   └── lifespan.py          # FastAPI 启动/关闭生命周期
│   ├── main.py                  # FastAPI 入口
│   └── pyproject.toml           # Python 项目配置（uv）
│
├── evals/                       # 质量评测集
│   ├── dataset/                 # 固定照片集（Git LFS）
│   ├── golden/                  # 预期结果基线
│   ├── run_eval.py              # 评测脚本
│   └── report.py                # 评测报告生成
│
├── tests/
│   ├── engine/                  # 后端测试
│   │   ├── test_api/            # API 路由测试
│   │   ├── test_services/       # 业务逻辑测试
│   │   └── test_llm/            # VLM 客户端/解析器/Provider 测试
│   ├── renderer/                # 前端单元测试 (Vitest)
│   └── e2e/                     # Playwright E2E 测试
│       └── fixtures/            # Mock VLM 响应数据
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
├── config.json                  # 用户配置（推理后端地址、模型、偏好）
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
| id | TEXT PK | 文件内容哈希（SHA-256 前 16 字节） |
| file_path | TEXT NOT NULL | 原始文件绝对路径 |
| file_name | TEXT NOT NULL | 文件名 |
| file_size | INTEGER | 文件大小（字节） |
| file_hash | TEXT UNIQUE | 完整 SHA-256 哈希 |
| format | TEXT | 文件格式（JPEG/CR3/NEF/ARW 等） |
| width | INTEGER | 原图宽度 |
| height | INTEGER | 原图高度 |
| exif_json | TEXT | EXIF 数据（JSON） |
| thumb_grid | TEXT | 网格缩略图路径 |
| thumb_preview | TEXT | 预览缩略图路径 |
| created_at | TEXT | 记录创建时间 |
| library_id | TEXT FK | 所属照片库 |

索引：`(library_id, created_at)`, `(file_hash)`

#### analysis_results 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| photo_id | TEXT FK | 关联 photos |
| prompt_version | TEXT NOT NULL | 使用的 prompt 版本（如 "v1"） |
| model_name | TEXT NOT NULL | 使用的模型名（如 "qwen2.5-vl:4b"） |
| result_json | TEXT NOT NULL | VLM 分析结果（JSON） |
| species | TEXT | 物种名称（冗余字段，加速筛选） |
| quality_score | REAL | 画质评分 0-1（冗余字段，加速排序） |
| raw_response | TEXT | VLM 原始返回（调试用） |
| created_at | TEXT | 分析时间 |
| version | INTEGER DEFAULT 1 | 结果版本号（重新分析时递增） |

索引：`(photo_id, prompt_version, model_name)`, `(species)`, `(quality_score)`

**缓存键**：`(file_hash, prompt_version, model_name)` — 同一张照片 + 同一 prompt + 同一模型不重复分析。换 prompt 或换模型后自动重新分析。

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

- **Context Isolation**：`contextIsolation: true`，`nodeIntegration: false`
- **Preload 最小暴露面**：preload 仅暴露必要的 API 桥接方法，不暴露 `ipcRenderer` 本身
- **CSP**：renderer 严格 Content Security Policy，禁止 inline script / eval
- **协议注册**：自定义 `plumelens://` 协议提供缩略图访问，不直接暴露 file:// 路径

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
{"ts": "2026-04-03T10:00:00Z", "level": "INFO", "module": "analyzer", "msg": "分析完成", "photo_id": "abc123", "duration_ms": 1200}
```

- Python 后端：`structlog` 或 Python 标准 logging + JSON formatter
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
| Ollama 连通性 | base_url 是否可访问 |
| 模型可用性 | 配置的模型是否已拉取 |
| VLM 功能验证 | 发送一张测试图片验证推理流程 |
| 磁盘空间 | ~/.plumelens/ 所在磁盘剩余空间 |
| RAW 格式支持 | libraw 版本及支持的格式列表 |
| 日志/崩溃转储路径 | 是否可写 |

启动异常或用户反馈问题时，引导用户打开此页面。诊断结果可一键导出为文本。

## 7. Provider 适配层

在 openai SDK 之上增加一层能力声明，不替换底层 SDK。

```python
# engine/llm/provider.py

@dataclass(frozen=True)
class ProviderCapabilities:
    """推理后端能力声明"""
    supports_vision: bool            # 是否支持图片输入
    supports_streaming: bool         # 是否支持流式响应
    supports_json_schema: bool       # 是否支持 response_format: json_schema
    max_image_pixels: int            # 最大图片像素数（宽 × 高）
    max_image_size_bytes: int        # 单张图片最大字节数
    max_context_tokens: int          # 最大上下文长度
    json_reliability: float          # JSON 格式遵从可靠性（0-1，决定重试策略）
    retry_strategy: RetryStrategy    # 错误重试策略

@dataclass(frozen=True)
class RetryStrategy:
    max_retries: int = 3             # 最大重试次数
    base_delay: float = 1.0          # 基础延迟（秒）
    backoff_factor: float = 2.0      # 退避因子
    retryable_errors: tuple = (      # 可重试的错误类型
        "timeout", "rate_limit", "server_error"
    )
```

**预置 Profile**：

| Provider | vision | streaming | json_schema | json_reliability | max_image |
|----------|--------|-----------|-------------|-----------------|-----------|
| Ollama (Qwen2.5-VL) | true | true | false | 0.7 | 4096×4096 |
| vLLM | true | true | true | 0.9 | 4096×4096 |
| OpenAI API | true | true | true | 0.99 | 2048×2048 |
| LM Studio | true | true | false | 0.6 | 因模型而异 |

**适配逻辑**：

- `json_reliability < 0.8`：VLM 输出解析器启用更激进的修复策略（正则提取 + 重试）
- `supports_json_schema = true`：请求时附带 `response_format`，减少解析开销
- `max_image_pixels`：缩略图自动缩放到 Provider 支持的最大尺寸以内
- 发送图片前检查 `supports_vision`，不支持则直接报错而非让推理后端返回不可理解的错误

## 8. 性能控制面

### 8.1 图像处理并发控制

```python
# engine/core/config.py

class PerformanceConfig(BaseSettings):
    # RAW 解码（CPU 密集，rawpy 底层是 C）
    raw_decode_workers: int = 2          # RAW 解码并发数（默认 CPU 核心数 / 2，最大 4）

    # 缩略图生成
    thumbnail_workers: int = 4           # 缩略图生成 worker 池大小

    # VLM 分析
    analysis_concurrency: int = 1        # VLM 分析并发数（受推理后端吞吐限制）
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
| VLM 分析 | 每张图完成后检查 | 当前图分析完成后停止，不中断正在进行的推理 |
| 批量导出 | 每张图导出后检查 | 已导出部分保留 |

### 8.4 缩略图双级策略

| 级别 | 长边 | 大小 | 用途 |
|------|------|------|------|
| grid | 384px | ~30KB | 网格浏览，虚拟列表大量渲染 |
| preview | 1920px | ~200KB | 单张预览 + VLM 分析输入 |

网格浏览时只加载 grid 级别，切换到单张预览时按需加载 preview 级别。显著降低前端内存占用。

## 9. 关键设计决策

### 9.1 VLM 输出解析防御层

小参数 VLM 的格式遵从能力较弱，需要多层防御：

1. 尝试直接 JSON 解析
2. 失败则用正则提取 JSON 块（`\{[\s\S]*\}` 贪婪匹配最外层）
3. 仍失败则重新调用 VLM 要求修正格式（附上原始输出）
4. 最终用 Pydantic 模型验证字段完整性

防御策略强度由 `ProviderCapabilities.json_reliability` 决定：
- 高可靠（>= 0.9）：步骤 1 + 4 即可
- 低可靠（< 0.8）：完整 1-4 全走，且步骤 3 最多重试 2 次

### 9.2 Prompt 版本管理

Prompt 是产品核心竞争力，按版本目录管理：

- 不同模型可能需要不同版本的 prompt
- 支持通过配置切换 prompt 版本
- 便于 A/B 测试对比输出质量
- 分析结果缓存键包含 prompt 版本，换 prompt 自动重新分析

### 9.3 批量任务队列

- 状态机严格管控（见 5.1 节状态机定义），非法转换抛异常
- 任务状态持久化到 SQLite，支持暂停/恢复/取消/断点续跑
- 应用关闭后再打开，`processing` 状态的任务回退为 `pending` 自动续跑
- 通过 SSE 实时推送分析进度到前端，**同时前端做轮询降级**
- 缓存键 `(file_hash, prompt_version, model_name)` 避免重复分析

### 9.4 首次启动引导

```
启动应用
├── 检测 Ollama → 已安装 → 检测模型 → 已拉取 → 就绪
├── 检测 Ollama → 已安装 → 无模型 → 引导一键拉取
├── 检测 Ollama → 未安装 → 引导安装 + 提供云端 API 备选
└── 用户已配置自定义 base_url → 测试连通性
```

### 9.5 图像预处理流水线

```
原图 (RAW/JPEG, 30-50MB)
  ↓ rawpy 解码（RAW）或 Pillow 读取（JPEG/PNG）
  ↓ 并发控制：raw_decode_workers 限制 RAW 解码并发
  ├── → grid 缩略图（长边 384px, JPEG 80%）→ 缓存
  └── → preview 缩略图（长边 1920px, JPEG 85%）→ 缓存
                                                  ↓
                                          VLM 分析时 base64 编码发送
```

缩略图在文件夹扫描阶段由 worker 池异步生成，不阻塞 UI 和后续分析流程。

**RAW 格式兼容性**：
- rawpy 底层依赖 libraw，CR3（Canon R5/R6/R7 等）需要 libraw >= 0.20
- 文档和诊断页面注明最低 libraw 版本要求
- 不支持的格式优雅降级（跳过并提示用户）

### 9.6 SSE + 轮询降级

分析进度推送的主路径是 SSE，但需要轮询作为降级方案：

- 正常情况：前端建立 SSE 连接接收实时进度
- SSE 连接断开（系统休眠恢复、网络波动等）：前端自动检测并切换到轮询模式
- 轮询间隔：2 秒
- SSE 恢复后自动切回

## 10. 质量评测集

### 10.1 目的

量化"模型换了 / 提示词换了 / 解析器改了"对分析结果质量的影响。

### 10.2 结构

```
evals/
├── dataset/                     # 固定照片集（Git LFS）
│   ├── species_known/           # 已知物种的照片（用于准确率评测）
│   │   ├── 白鹭_001.jpg
│   │   ├── 翠鸟_001.jpg
│   │   └── ...
│   ├── quality_gradient/        # 同一物种不同画质（用于排序评测）
│   └── edge_cases/              # 边界情况（模糊、遮挡、多只鸟、非鸟）
│
├── golden/                      # 预期结果基线（人工标注）
│   ├── species_labels.json      # {"白鹭_001.jpg": {"species": "白鹭", "quality": 0.9}}
│   └── ranking_order.json       # 质量排序的期望顺序
│
├── run_eval.py                  # 评测脚本
│   # 输入：prompt_version + model_name
│   # 输出：逐张分析结果 + 聚合指标
│
└── report.py                    # 对比报告生成
    # 对比两次评测结果，输出：
    # - 物种识别准确率变化
    # - 质量评分相关性变化（Spearman）
    # - 回归项（之前对的现在错了）
```

### 10.3 指标

| 指标 | 说明 | 计算方式 |
|------|------|---------|
| 物种准确率 | 物种识别正确的比例 | correct / total |
| 质量排序相关性 | 模型评分与人工排序的一致性 | Spearman rank correlation |
| JSON 解析成功率 | VLM 输出能被成功解析的比例 | parsed / total |
| 回归数 | 本次比上次"变差"的数量 | diff against baseline |
| 平均延迟 | 单张分析平均耗时 | mean(duration_ms) |

### 10.4 触发方式

- 手动：`python evals/run_eval.py --prompt v1 --model qwen2.5-vl:4b`
- CI：`.github/workflows/eval.yml`（手动触发 / prompt 变更时触发）

## 11. 打包与分发

### 11.1 痛点

Python 后端作为 Electron 子进程，打包分发需要把 Python 运行时 + 依赖一起打包。

### 11.2 方案

| 阶段 | 方案 | 说明 |
|------|------|------|
| 开发期 | 系统 Python + uv | 开发者自行安装 Python 和 uv |
| 分发期 | PyInstaller 单目录模式 | 将 engine/ 打包为独立可执行目录，随 Electron 一起分发 |

**关键注意事项**：
- PyInstaller 打包后体积约 50-80MB（不含 torch，体积可控）
- macOS 和 Windows 需要分别打包（CI 中完成）
- **尽早验证**：项目骨架搭建完成后即做一次打包测试，避免后期踩坑
- rawpy 依赖的 libraw 是 C 库，需确保 PyInstaller 能正确捕获

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

| 工具 | 用途 |
|------|------|
| uv | 包管理 + 虚拟环境 |
| ruff | lint + format（line-length = 100） |
| pyright (strict) | 静态类型检查 |
| pytest + pytest-asyncio | 测试框架 |

### 12.2 前端

| 工具 | 用途 |
|------|------|
| ESLint + Prettier | 代码规范 |
| Vitest | 组件/逻辑单元测试 |
| Playwright | Electron 全流程 E2E 测试 |

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

本地 HTTP（`http://localhost:{动态端口}`），FastAPI 启动后通过 stdout 通知 Electron 实际端口。

- 常规请求：REST API（JSON）
- 分析进度：SSE（Server-Sent Events）+ 轮询降级
- 缩略图访问：自定义 `plumelens://` 协议或静态文件服务

### 13.2 Python Backend ↔ 推理后端

OpenAI Chat Completions API（`/v1/chat/completions`）。

- 图片通过 base64 data URL 传入 `image_url` 字段
- 支持流式响应（streaming）以获取实时输出
- 发送前由 Provider 适配层根据能力声明预处理（图片缩放、格式选择等）
