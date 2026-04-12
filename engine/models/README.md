# PlumeLens ONNX Models

本目录包含 PlumeLens 鸟类照片分析管线所使用的 ONNX 模型。

## 模型列表

| 模型 | 文件 | 大小 | 用途 |
|------|------|------|------|
| YOLOv26l-bird-det | `yolo26l-bird-det.onnx` | 95.4 MB | 鸟类目标检测 |
| CLIPIQA+ | `clipiqa_plus.onnx` | 1.2 MB | 语义画质评估 |
| HyperIQA | `hyperiqa.onnx` | 0.4 MB | 技术画质评估 |

## 版权说明

- **yolo26l-bird-det.onnx**：由 [wlfcss](https://github.com/wlfcss) 个人训练产出，他人使用需注明来源。
- **clipiqa_plus.onnx** / **hyperiqa.onnx**：基于公开 IQA 研究模型（CLIPIQA+、HyperIQA）导出的 ONNX 格式，遵循原始论文及代码仓库的许可协议。
