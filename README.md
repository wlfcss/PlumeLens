# PlumeLens / 鉴翎

辅助鸟类摄影爱好者快速筛选拍摄的鸟类照片。

通过本地 ONNX 多模型管线（鸟类检测 + 姿态/可见性 + 双模型画质评估 + 鸟种识别）对照片进行智能分析，帮助摄影师从大量素材中快速挑选最佳作品。无需 GPU，无需联网，全部推理在本地完成。

## 功能

- 导入照片文件夹，自动扫描并生成缩略图
- 本地 ONNX 管线：检测 / 姿态 / 画质评估 / 鸟种识别 / 4 档自动分级
- 物种沉淀"羽迹"：跨文件夹物种墙 + 地理分布
- 多维度筛选、分组、对比、复核
- 支持 RAW 格式（CR2/CR3/NEF/ARW 等）
- 批量分析，支持暂停/恢复/断点续跑

## 分析管线

```
原片
  ↓ letterbox1280 (114 填充) → YOLOv26l-bird-det v1.0 (conf≥0.5, NMS-free)
  ↓ 鸟类 bbox 列表
  ├─ 逐框裁切 (+10% padding)
  │    ↓ bird_visibility v1.0 (imgsz=640) → head_visible / eye_visible
  │    ↓ CLIPIQA+(×0.35) + HyperIQA(×0.65) → 综合分 → 4 档分级
  │    ↓ (可选：仅 head+eye 可见时) DINOv3 鸟种识别 → top-K 物种
  └─ 选最高综合分的鸟 → 照片结果
```

| 分级 | 分数范围 | 含义 |
|------|---------|------|
| 淘汰 (reject) | < 0.33 | 画质不可接受 |
| 记录 (record) | 0.33 – 0.43 | 仅供记录 |
| 可用 (usable) | 0.43 – 0.60 | 可使用 |
| 精选 (select) | ≥ 0.60 | 最佳作品 |

完整模型清单与指标见 [engine/models/README.md](engine/models/README.md)。

## 技术架构

- **前端**：Electron 35 + React 19 + TypeScript + Tailwind CSS v4
- **后端**：Python 3.11+ + FastAPI + uvicorn + structlog（轻量，不内嵌 torch）
- **推理**：本地 ONNX 多模型管线（onnxruntime）
- **存储**：SQLite（WAL 模式）
- **顶层路由**：`开始 / 选片 / 羽迹`（以文件夹为主要组织单位）

详细技术规划参见 [docs/TECHNICAL_SPEC.md](docs/TECHNICAL_SPEC.md)；产品与交互方案见 [docs/PRODUCT_UX_PLAN.md](docs/PRODUCT_UX_PLAN.md)。

## 前置要求

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.11+
- [uv](https://docs.astral.sh/uv/) (Python 包管理)

## 开发状态

- ✅ 5 个 ONNX 模型已就位（检测 + 姿态 + 双画质 + 鸟种识别）
- ✅ 前端三路由高保真工作台（开始 / 选片 / 羽迹）已完成
- ✅ 后端管线模块（检测 + 画质）已就绪
- 🟡 姿态 + 物种推理封装待并入 PipelineManager
- 🟡 后端 services（扫描 / 分析 / 队列 / 缩略图 / 缓存）待实现
- 🟡 前端 mock 数据待替换为真 API + TanStack Query

## 许可证

[GPL-3.0](LICENSE)
