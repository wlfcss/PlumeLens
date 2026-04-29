# PlumeLens / 鉴翎

辅助鸟类摄影爱好者快速筛选拍摄的鸟类照片。

通过本地混合推理管线（ONNX 鸟类检测 + 姿态/可见性 + 双模型画质评估，以及 torch/transformers DINOv3 鸟种识别）对照片进行智能分析，帮助摄影师从大量素材中快速挑选最佳作品。无需联网，全部推理在本地完成。

## 功能

- 导入照片文件夹，自动扫描并生成缩略图
- 本地混合管线：ONNX 检测 / 姿态 / 画质评估 + torch DINOv3 鸟种识别 / 4 档自动分级
- 物种沉淀"羽迹"：跨文件夹物种墙 + 地理分布
- 多维度筛选、分组、对比、复核
- 支持 RAW 格式（CR2/CR3/NEF/ARW 等）
- 批量分析，支持暂停/恢复/断点续跑

## 分析管线

```
原片
  ↓ letterbox1280 (114 填充) → YOLOv26l-bird-det v1.0 (conf≥0.5, NMS-free)
  ↓ 鸟类 bbox 列表
  ├─ 逐框裁切（均基于原片）
  │    ├─ bbox +10% padding → bird_visibility v1.1 (imgsz=640) → head_visible / eye_visible
  │    ├─ bbox 2.5× 语义裁切 → CLIPIQA+(×0.35)
  │    └─ bbox +10% 技术裁切 → HyperIQA(×0.65) → 综合分 → 4 档分级
  │    ↓ (head+eye 可见时) DINOv3 ViT-L/16 (480px) + 8-head ensemble → top-K 物种
  └─ 选最高综合分的鸟 → 照片结果
```

| 分级 | 分数范围 | 含义 |
|------|---------|------|
| 淘汰 (reject) | < 0.45 | 画质不可接受 |
| 记录 (record) | 0.45 – 0.60 | 仅供记录 |
| 可用 (usable) | 0.60 – 0.75 | 可使用 |
| 精选 (select) | ≥ 0.75 | 最佳作品 |

完整模型清单与指标见 [engine/models/README.md](engine/models/README.md)。

## 技术架构

- **前端**：Electron 35 + React 19 + TypeScript + Tailwind CSS v4
- **后端**：Python 3.11+ + FastAPI + uvicorn + structlog
- **推理**：本地 hybrid 管线：YOLO / pose / IQA 走 ONNX Runtime，DINOv3 species v3 走 torch + transformers（MPS/CUDA bf16，CPU fp32）
- **存储**：SQLite（WAL 模式）
- **本地安全**：后端只绑定 `127.0.0.1`；Electron 每次启动生成一次性 API token
- **顶层路由**：`开始 / 选片 / 羽迹`（以文件夹为主要组织单位）

详细技术规划参见 [docs/TECHNICAL_SPEC.md](docs/TECHNICAL_SPEC.md)；产品与交互方案见 [docs/PRODUCT_UX_PLAN.md](docs/PRODUCT_UX_PLAN.md)。

## 前置要求

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.11+
- [uv](https://docs.astral.sh/uv/) (Python 包管理)

## 开发状态（2026-04-27）

- ✅ 5 模型 hybrid 管线全部就位并联调通过（ONNX 检测 + 姿态 + 双画质，torch DINOv3 species v3）
- ✅ 前端三路由高保真工作台（开始 / 选片 / 羽迹）
- ✅ 后端完整：database / scanner / thumbnail / cache / analyzer / queue / decisions + 全部 API 路由
- ✅ 前端 TanStack Query 接入真 API：libraries / decisions mutations
- ✅ 物种 Wikipedia 介绍本地打包（1535 种元数据补充，无需联网）
- ✅ 里程碑 0：PyInstaller + electron-builder macOS arm64 打包验证通过（dmg 约 1.7 GB）
- ✅ 测试覆盖：158 pytest（含真模型加载集成测试）+ renderer / Playwright E2E
- 🟡 App.tsx 仍需继续按 pages/components 拆分
- 🟡 Windows 打包（当前只在 macOS 验证）

## 许可证

[GPL-3.0](LICENSE)
