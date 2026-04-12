# PlumeLens / 鉴翎

辅助鸟类摄影爱好者快速筛选拍摄的鸟类照片。

通过本地 ONNX 三模型管线（YOLO 鸟类检测 + CLIPIQA+/HyperIQA 画质评估）对照片进行智能分析，帮助摄影师从大量素材中快速挑选最佳作品。无需 GPU，无需联网，全部推理在本地完成。

## 功能

- 导入照片文件夹，自动扫描并生成缩略图
- 本地 ONNX 管线：鸟类检测 + 双模型画质评估 + 4 档自动分级
- 多维度筛选与排序
- 支持 RAW 格式（CR2/CR3/NEF/ARW 等）
- 批量分析，支持暂停/恢复/断点续跑

## 分析管线

```
原片 → 缩放1440px → YOLOv26l-bird-det (conf≥0.35)
                        ↓ bbox
         裁切 → CLIPIQA+(×0.35) + HyperIQA(×0.65) → 4档分级
```

| 分级 | 分数范围 | 含义 |
|------|---------|------|
| 淘汰 (reject) | < 0.33 | 画质不可接受 |
| 记录 (record) | 0.33 – 0.43 | 仅供记录 |
| 可用 (usable) | 0.43 – 0.60 | 可使用 |
| 精选 (select) | ≥ 0.60 | 最佳作品 |

## 技术架构

- **前端**：Electron 35 + React 19 + TypeScript + Tailwind CSS v4
- **后端**：Python 3.11+ + FastAPI + uvicorn + structlog
- **推理**：本地 ONNX 三模型管线（onnxruntime，macOS 支持 CoreML 加速）
- **存储**：SQLite（WAL 模式）

详细技术规划参见 [docs/TECHNICAL_SPEC.md](docs/TECHNICAL_SPEC.md)

## 前置要求

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.11+
- [uv](https://docs.astral.sh/uv/) (Python 包管理)

## 开发状态

项目初始化中，管线模块已完成。

## 许可证

[GPL-3.0](LICENSE)
