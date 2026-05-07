<p align="center">
  <img src="build/icon.png" width="128" alt="PlumeLens logo">
</p>

<h1 align="center">PlumeLens / 鉴翎</h1>

<p align="center">
  面向鸟类摄影爱好者的本地智能选片工作台：检测鸟、识别鸟、评估画质、辅助复核，并把每一次外拍沉淀成自己的鸟种图鉴。
</p>

<p align="center">
  <a href="https://github.com/wlfcss/PlumeLens/actions/workflows/mac-build.yml"><img alt="macOS build" src="https://github.com/wlfcss/PlumeLens/actions/workflows/mac-build.yml/badge.svg"></a>
  <img alt="version" src="https://img.shields.io/badge/version-0.6.0-white">
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20arm64-111111">
  <img alt="local inference" src="https://img.shields.io/badge/inference-local-74F69C">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0-FFD45A"></a>
</p>

![PlumeLens selection workspace](assets/readme/selection-screen.png)

## 为什么做它

一次鸟类外拍常常带回几百到几千张照片。真正耗时的不是拍摄，而是回家后反复判断：

| 痛点                     | PlumeLens 的处理方式                             |
| ------------------------ | ------------------------------------------------ |
| 照片太多，翻看成本高     | 自动检测鸟类主体，按综合质量先分档               |
| 同一场景连拍重复         | 按场景/时间组织照片，优先展示更值得复核的图      |
| 远鸟、遮挡、焦点判断费眼 | 给出检测框、姿态点、IQA 裁切与对焦证据           |
| 鸟种识别容易受角度影响   | DINOv3 species v3 给出候选，组内共识修正常见偏差 |
| 选完以后还要整理输出     | 支持按文件夹别名导出、JPG/RAW 同伴文件、中文报告 |
| 拍过哪些鸟很难长期沉淀   | 羽迹模块按物种、保护等级和地理位置形成长期图鉴   |
| 源文件夹改名或挪走       | 保留缓存与筛选结果，提示重新关联新的源路径       |

核心原则很朴素：**照片分析在本地完成，用户照片目录只读，人工判断永远优先于模型判断。**

## 界面预览

| 开始                                            | 选片                                                    | 羽迹                                                |
| ----------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| ![Start screen](assets/readme/start-screen.png) | ![Selection screen](assets/readme/selection-screen.png) | ![Archive screen](assets/readme/archive-screen.png) |

## 0.6.0 更新重点

- **源文件夹失联保护**：图库根目录被改名或挪走时标记为失联，缓存缩略图、评分和人工筛选结果仍可查看；分析、导出和外部编辑会暂停，用户可在界面中重新关联新路径。
- **导出链路稳定化**：导出会话锁定启动时的文件夹快照，切换工作集不会改变正在导出的内容；支持多文件夹并行导出、收起侧栏、JPG/RAW companion、XMP sidecar 与中文报告。
- **羽迹地理分布重构**：只统计有效入羽迹照片，按物理地点合并拍摄点，地点详情支持鸟种筛选，地图 tooltip 做 HTML escape。
- **深度复核与外部编辑**：复核图像支持倍率选择、拖动、全屏查看；Topaz / Photoshop 检测与启动路径更稳。
- **性能与可靠性**：大列表虚拟化、地图按需加载、缩略图缺失自动修复、IQA 非有限分数防护、队列并发和暂停/取消状态机修复。

## 核心能力

- **本地 hybrid 推理**：ONNX Runtime 负责 YOLO 检测、姿态/可见性、双 IQA 画质评估；torch/transformers 负责 DINOv3 鸟种识别。
- **四档选片**：精选、可用、记录、淘汰；无鸟是独立状态，不混入质量档位。
- **深度复核**：原图舞台、IQA 裁切、检测框、姿态点、对焦点、倍率选择、全屏查看、filmstrip 快速切换。
- **场景共识**：同一场景内的单鸟照片可互相校正物种结果，降低单张照片角度/遮挡导致的误识别。
- **导出工作流**：多文件夹并行导出，支持合并导出与按评级分类导出，JPG/RAW companion 同步复制，附中文 manifest/CSV 报告。
- **羽迹图鉴**：1535 种物种墙、保护等级分组、物种详情、本地百科、拍摄时间线和地理分布。
- **文件夹重关联**：源文件夹失联时可选择移动/改名后的新目录，保留既有照片身份、分析结果、人工决策和缩略图。
- **桌面集成**：最近文件夹、Finder 打开、Topaz / Photoshop 外部编辑入口、macOS arm64 自动构建。

## 模型管线

![PlumeLens model pipeline](assets/readme/model-pipeline.svg)

PlumeLens 的模型不是一个单点分类器，而是一条以摄影筛选为目标的流水线：先判断画面里有没有鸟，再判断鸟的姿态与画质，最后识别物种，并把模型结果与人工复核、场景共识合并成稳定业务口径。

| 阶段          | 模型 / 模块              | 输入与输出                        | 作用                                              |
| ------------- | ------------------------ | --------------------------------- | ------------------------------------------------- |
| 1. 原片解码   | Pillow / rawpy           | RAW/JPEG → EXIF 转正 RGB 图像     | 读取照片、补齐元数据、生成可分析图像              |
| 2. 鸟类检测   | `YOLOv26l-bird-det v1.0` | `1280×1280` letterbox → bird bbox | 找到照片中的鸟类主体，支持多鸟图                  |
| 3. 姿态可见性 | `bird_visibility v1.1`   | bbox crop → 5 个头部关键点        | 判断头部/眼睛是否可见，给复核和鸟种可信度提供证据 |
| 4. 语义画质   | `CLIPIQA+`               | 2.5× 语义裁切 → 0-1 分            | 判断构图、主体语义质量和整体观感                  |
| 5. 技术画质   | `HyperIQA`               | bbox +10% 技术裁切 → 0-1 分       | 判断清晰度、噪声、曝光和主体技术质量              |
| 6. 鸟种识别   | `DINOv3 species v3`      | 480px crop → 1535 类 top-K        | 识别中文名/拉丁名/英文名，接入保护等级与百科      |
| 7. 业务融合   | grader + consensus       | detections → photo result         | 计算分级、物种来源、场景共识、羽迹有效性          |

### 当前模型资产

| 模型资产                   | 文件                                                  | 规模      | 状态                       |
| -------------------------- | ----------------------------------------------------- | --------- | -------------------------- |
| YOLOv26l-bird-det v1.0     | `engine/models/yolo26l-bird-det.onnx`                 | 约 100 MB | 入仓                       |
| bird_visibility v1.1       | `engine/models/bird_visibility.onnx`                  | 约 98 MB  | 入仓                       |
| CLIPIQA+                   | `engine/models/clipiqa_plus.onnx`                     | 约 293 MB | 大文件，打包时由模型包恢复 |
| HyperIQA                   | `engine/models/hyperiqa.onnx`                         | 约 104 MB | 大文件，打包时由模型包恢复 |
| DINOv3 species v3 backbone | `engine/models/species/backbone/model.safetensors`    | 约 578 MB | 大文件，不入 git           |
| DINOv3 species v3 heads    | `engine/models/species/heads/seed*.pt` × 8            | 约 267 MB | 大文件，不入 git           |
| 分类与百科元数据           | `canonical_extended.parquet` / `species_wiki.parquet` | 1535 种   | 入仓                       |

更多模型细节见 [engine/models/README.md](engine/models/README.md)、[YOLO model card](engine/models/yolo26l-bird-det.MODEL_CARD.md) 和 [bird visibility model card](engine/models/bird_visibility.MODEL_CARD.md)。

### 分级口径

综合分由 `0.35 × CLIPIQA+ + 0.65 × HyperIQA` 得到，再结合姿态可见性与人工决策进入业务层。

| 档位 | 分数范围      | 含义                   |
| ---- | ------------- | ---------------------- |
| 精选 | `≥ 0.75`      | 推荐作品，优先进入导出 |
| 可用 | `0.60 - 0.75` | 质量较好，可正常使用   |
| 记录 | `0.45 - 0.60` | 画质一般，但有记录价值 |
| 淘汰 | `< 0.45`      | 不建议保留             |

羽迹统计只接收有效入库结果：精选/可用/记录，且物种来源属于 `manual`、`group_consensus` 或可信 `model`。`model_unconfirmed`、`conflict`、无鸟和淘汰不会被计入已点亮物种。

## 技术架构

![PlumeLens system architecture](assets/readme/system-architecture.svg)

| 层       | 技术选型                                                  | 职责                                           |
| -------- | --------------------------------------------------------- | ---------------------------------------------- |
| 桌面外壳 | Electron 35、electron-vite、electron-builder              | 窗口、菜单、安全边界、Python 后端子进程守护    |
| 前端     | React 19、TypeScript、Tailwind CSS v4、shadcn/ui、i18next | 开始/选片/羽迹三大工作区与本地化界面           |
| 服务端态 | TanStack Query、SSE                                       | 后端数据同步、分析进度、导出进度和事件通知     |
| 后端     | Python 3.11、FastAPI、Pydantic、structlog                 | API、扫描、队列、导出、地理回填、业务聚合      |
| 推理     | onnxruntime、torch、transformers                          | YOLO / pose / IQA / DINOv3 species v3          |
| 存储     | SQLite WAL、aiosqlite                                     | 图库、照片、任务队列、分析结果、人工决策和缓存 |
| 图片资产 | `plumelens://thumb` 协议                                  | 安全加载缩略图，不暴露 `file://`               |

### 数据与隐私

- 分析推理在本机运行，不需要把照片上传到云端。
- 用户选择的照片目录保持只读，PlumeLens 不写回原始照片。
- 数据库、日志、缩略图与导出记录写入应用数据目录。
- Electron renderer 通过一次性 token 调用仅绑定 `127.0.0.1` 的后端 API。
- 反地理编码可由后台回填，地图与羽迹读取持久化后的地点结果。

## 工作流

1. **选择照片文件夹**：扫描 RAW/JPEG，识别 JPG/RAW companion，生成缩略图。
2. **开始分析**：任务队列按优先级执行，支持暂停、恢复和断点续跑。
3. **快速筛选**：按精选/可用/记录/淘汰/无鸟过滤，支持组视图和平铺视图。
4. **深度复核**：按空格打开复核，检查检测框、姿态点、IQA 裁切、物种候选和 EXIF。
5. **人工确认**：人工评分和人工鸟种覆盖模型结果，并贯穿统计、排序、导出、羽迹。
6. **导出交付**：合并导出为 `文件夹/照片`，或按评级分类为 `文件夹/评级/照片`。
7. **沉淀羽迹**：跨文件夹查看已点亮鸟种、保护等级和拍摄地点。

如果源文件夹被改名或移动，PlumeLens 会把工作集标记为 `路径失效`。此时历史缩略图和筛选结果仍可浏览；重新关联到移动后的目录后，原 photo id、分析记录、人工评级、人工鸟种和场景分组都会继续沿用。

## 开发启动

### 前置要求

- Node.js 20+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- macOS arm64 是当前主要打包目标；Windows 构建暂时停用

### 安装与运行

```bash
git clone https://github.com/wlfcss/PlumeLens.git
cd PlumeLens

npm install
uv sync --extra dev

npm start
```

### 常用检查

```bash
npm run typecheck
npm run lint
npx vitest run

uv run pyright
uv run ruff check engine
uv run pytest tests/engine

npx playwright test tests/e2e
```

### 打包 macOS

```bash
npm run dist:mac
```

打包产物输出到 `release/`。`release/` 不入 git。

## 模型资产与自动构建

GitHub Actions 当前只保留 macOS arm64 自动构建流程：

- workflow：`.github/workflows/mac-build.yml`
- push 到 `main`、推送 `v*` tag 或手动触发时构建
- tag 构建会发布 GitHub Release asset
- Windows / Linux 自动构建暂时停用

完整应用需要恢复未入 git 的模型大文件。CI 默认从同仓库 `models-v3` Release 下载 `plumelens-models-v3.tar.gz`，也可以通过以下配置覆盖：

| 配置                                           | 用途                                          |
| ---------------------------------------------- | --------------------------------------------- |
| secret `PLUMELENS_MODELS_URL`                  | 指向 `.tar.gz` / `.zip` 模型包                |
| repo variable `PLUMELENS_MODELS_RELEASE_TAG`   | 模型 Release tag，默认 `models-v3`            |
| repo variable `PLUMELENS_MODELS_RELEASE_ASSET` | 模型包名称，默认 `plumelens-models-v3.tar.gz` |

## 项目状态

- 已完成：本地 hybrid 推理、选片工作台、深度复核、导出、羽迹物种墙、地理分布、macOS arm64 自动构建。
- 已完成：源文件夹失联检测与重新关联、导出快照锁定、JPG/RAW/XMP 导出、中文报告、大列表虚拟化、缩略图自动修复。
- 持续优化：App.tsx 拆分、连拍/场景业务讨论、更多真实相机样张覆盖。
- 待验证：Windows 打包、更多相机品牌的 AF 对焦点解析、更多 RAW 组合样本。

## 许可证与模型版权

代码采用 [GPL-3.0](LICENSE)。

模型与数据资产遵循各自来源许可：

- `yolo26l-bird-det.onnx`、`bird_visibility.onnx`、DINOv3 species heads 由项目作者训练产出，使用时需注明来源。
- DINOv3 backbone 遵循 Meta DINOv3 许可，商业使用需自行确认许可边界。
- CLIPIQA+ / HyperIQA 基于公开 IQA 研究模型导出，需遵循原始论文与代码仓库许可。
- 分类表基于《中国鸟类名录 v12.0》整理。
