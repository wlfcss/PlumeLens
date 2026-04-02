# PlumeLens / 鉴翎

辅助鸟类摄影爱好者快速筛选拍摄的鸟类照片。

利用视觉语言模型（VLM）对鸟类照片进行智能分析，帮助摄影师从大量拍摄素材中快速挑选出最佳作品。

## 功能

- 导入照片文件夹，自动扫描并生成缩略图
- VLM 智能分析：物种识别、画质评估、构图评价
- 多维度筛选与排序
- 支持 RAW 格式（CR2/CR3/NEF/ARW 等）
- 批量分析，支持暂停/恢复/断点续跑

## 技术架构

- **前端**：Electron + React + TypeScript + Tailwind CSS
- **后端**：Python + FastAPI
- **推理**：通过 OpenAI 兼容协议接入 VLM（默认 Ollama + Qwen2.5-VL）
- **存储**：SQLite

详细技术规划参见 [docs/TECHNICAL_SPEC.md](docs/TECHNICAL_SPEC.md)

## 前置要求

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.11+
- [uv](https://docs.astral.sh/uv/) (Python 包管理)
- [Ollama](https://ollama.ai/)（或其他 OpenAI 兼容推理后端）

## 开发状态

项目初始化中。

## 许可证

[GPL-3.0](LICENSE)
