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
│  │ 管理      │   │   Zustand (客户端状态)        │  │
│  └────┬─────┘   └────────────┬────────────────┘  │
│       │                      │                    │
└───────┼──────────────────────┼────────────────────┘
        │ 启动/停止子进程        │ HTTP / SSE
        ▼                      ▼
┌──────────────────────────────────────────────────┐
│            Python Backend (FastAPI)                │
│  uvicorn · Pydantic · aiosqlite · openai SDK      │
│                                                    │
│  ┌────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐  │
│  │ API    │ │ Services │ │Prompts │ │  LLM    │  │
│  │ Routes │→│ 业务逻辑  │→│ 版本化  │→│ Client  │  │
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
- **前端不承担业务逻辑**：所有分析、筛选、排序逻辑在 Python 后端完成

## 3. 技术栈明细

### 3.1 Electron 层

| 关注点 | 选型 | 说明 |
|--------|------|------|
| 构建工具 | electron-vite | Vite 统一管理 main/preload/renderer 三端构建 |
| 打包分发 | electron-builder | 跨平台打包（macOS DMG / Windows EXE） |
| 主进程职责 | 仅生命周期管理 | 启动/停止 FastAPI 子进程，检测 Ollama 连通性，窗口管理 |

### 3.2 Renderer 前端

| 关注点 | 选型 | 说明 |
|--------|------|------|
| 框架 | React 19 + TypeScript | 成熟生态，组件化开发 |
| 构建 | Vite（electron-vite 内置） | 快速 HMR |
| 样式 | Tailwind CSS v4 | 照片类 UI 需大量自定义布局 |
| 组件库 | shadcn/ui | 基于 Radix UI，源码级引入可自定义 |
| 服务端状态 | TanStack Query | 管理 FastAPI 请求的缓存/重试/loading |
| 客户端状态 | Zustand | 管理 UI 状态（选中照片、筛选条件、布局模式） |
| 虚拟列表 | @tanstack/react-virtual | 数千张照片场景下必须虚拟化渲染 |

### 3.3 Python 后端

| 关注点 | 选型 | 说明 |
|--------|------|------|
| Web 框架 | FastAPI | async 原生，Pydantic 类型严格，自带 Swagger |
| ASGI 服务器 | uvicorn | 标准 ASGI，配合 FastAPI |
| VLM 客户端 | openai (Python SDK) | 异步调用，兼容所有 OpenAI 协议后端 |
| 数据库 | SQLite + aiosqlite | 单用户桌面应用，零部署成本 |
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
│   ├── main.ts                  # 入口，窗口管理
│   └── preload.ts               # 预加载脚本
│
├── renderer/                    # 前端 UI (React)
│   ├── src/
│   │   ├── components/          # UI 组件
│   │   ├── pages/               # 页面
│   │   ├── stores/              # Zustand stores
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
│   │   │   └── settings.py      # 配置接口
│   │   └── schemas/             # Pydantic 请求/响应模型
│   ├── services/
│   │   ├── scanner.py           # 文件夹扫描、EXIF 读取
│   │   ├── analyzer.py          # VLM 调用编排
│   │   ├── ranker.py            # 筛选/排序逻辑
│   │   ├── queue.py             # 批量任务队列（持久化到 SQLite）
│   │   ├── thumbnail.py         # 缩略图生成与缓存
│   │   └── cache.py             # 结果缓存
│   ├── llm/
│   │   ├── client.py            # OpenAI 兼容客户端（唯一出口）
│   │   └── parser.py            # VLM 输出解析-修复-验证
│   ├── prompts/
│   │   ├── v1/
│   │   │   ├── analyze.py       # 单张分析 prompt
│   │   │   ├── compare.py       # 对比筛选 prompt
│   │   │   └── schema.py        # 期望输出的 JSON Schema
│   │   └── registry.py          # prompt 版本注册
│   ├── core/
│   │   ├── config.py            # 配置（Pydantic Settings）
│   │   ├── database.py          # SQLite 连接管理
│   │   └── lifespan.py          # FastAPI 启动/关闭生命周期
│   ├── main.py                  # FastAPI 入口
│   └── pyproject.toml           # Python 项目配置（uv）
│
├── tests/
│   ├── engine/                  # 后端测试
│   │   ├── test_api/            # API 路由测试
│   │   ├── test_services/       # 业务逻辑测试
│   │   └── test_llm/            # VLM 客户端/解析器测试
│   ├── renderer/                # 前端单元测试 (Vitest)
│   └── e2e/                     # Playwright E2E 测试
│       └── fixtures/            # Mock VLM 响应数据
│
├── docs/                        # 项目文档
│   └── TECHNICAL_SPEC.md        # 本文件
│
├── .github/
│   └── workflows/
│       └── ci.yml               # CI 流水线
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
├── plumelens.db                 # SQLite 数据库
│   ├── photos                   # 照片元数据（路径、EXIF、缩略图路径）
│   ├── analysis_results         # VLM 分析结果
│   ├── task_queue               # 批量任务队列（支持断点续跑）
│   └── prompt_versions          # prompt 版本记录
└── cache/
    └── thumbnails/              # 缩略图缓存（JPEG, 长边 1024px）
```

## 6. 关键设计决策

### 6.1 VLM 输出解析防御层

小参数 VLM 的格式遵从能力较弱，需要多层防御：

1. 尝试直接 JSON 解析
2. 失败则用正则提取 JSON 块
3. 仍失败则重新调用 VLM 要求修正格式
4. 最终用 Pydantic 模型验证字段完整性

### 6.2 Prompt 版本管理

Prompt 是产品核心竞争力，按版本目录管理：

- 不同模型可能需要不同版本的 prompt
- 支持通过配置切换 prompt 版本
- 便于后续 A/B 测试对比输出质量

### 6.3 批量任务队列

- 任务状态持久化到 SQLite，支持暂停/恢复/取消
- 应用关闭后再打开自动续跑未完成任务
- 通过 SSE 实时推送分析进度到前端
- 已分析的照片不重复处理（基于文件哈希判断）

### 6.4 首次启动引导

```
启动应用
├── 检测 Ollama → 已安装 → 检测模型 → 已拉取 → 就绪
├── 检测 Ollama → 已安装 → 无模型 → 引导一键拉取
├── 检测 Ollama → 未安装 → 引导安装 + 提供云端 API 备选
└── 用户已配置自定义 base_url → 测试连通性
```

### 6.5 图像预处理流水线

```
原图 (RAW/JPEG, 30-50MB)
  ↓ rawpy 解码（RAW）或 Pillow 读取（JPEG/PNG）
  ↓ resize 到长边 1024px
缩略图 (JPEG, ~200KB)
  ↓ 缓存到 ~/.plumelens/cache/thumbnails/
  ├── 前端网格展示
  └── base64 编码发送给 VLM 分析
```

缩略图在文件夹扫描阶段即生成，不阻塞后续分析流程。

## 7. 开发工具链

### 7.1 Python

| 工具 | 用途 |
|------|------|
| uv | 包管理 + 虚拟环境 |
| ruff | lint + format（line-length = 100） |
| pyright (strict) | 静态类型检查 |
| pytest + pytest-asyncio | 测试框架 |

### 7.2 前端

| 工具 | 用途 |
|------|------|
| ESLint + Prettier | 代码规范 |
| Vitest | 组件/逻辑单元测试 |
| Playwright | Electron 全流程 E2E 测试 |

### 7.3 CI (GitHub Actions)

```
push / PR 触发:
  ├── backend: ruff check → pyright → pytest
  ├── frontend: eslint → tsc --noEmit → vitest
  └── e2e: Playwright（PR 时 / 手动触发）
```

## 8. 通信协议

### 8.1 Electron ↔ Python Backend

本地 HTTP（`http://localhost:{动态端口}`），FastAPI 启动后通过 stdout 通知 Electron 实际端口。

- 常规请求：REST API（JSON）
- 分析进度：SSE（Server-Sent Events）流式推送
- 图片数据：缩略图 URL 或 base64

### 8.2 Python Backend ↔ 推理后端

OpenAI Chat Completions API（`/v1/chat/completions`）。

- 图片通过 base64 data URL 传入 `image_url` 字段
- 支持流式响应（streaming）以获取实时输出
