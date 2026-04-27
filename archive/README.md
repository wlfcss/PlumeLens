# Archive — 已废弃的代码和资源

此目录归档项目演进过程中**不再使用但保留作历史参考**的代码和资源。
所有内容**不会进入打包产物**（PyInstaller / electron-builder），也通常**不入 git**。

> 如要回滚到这些版本，参考 `archive/<subdir>/README.md` 或 git 历史。

---

## scripts-v2/

DINOv3 species v2 ONNX 路径相关脚本，已被 `bd5cdb7 feat(species): 升级到
DINOv3 v3（torch + transformers）` 弃用。

| 文件 | 旧用途 | 弃用原因 |
|---|---|---|
| `export_dinov3_backbone.py` | 把 DINOv3 backbone 导出为 ONNX（双尺度 512+640 拼特征）| v3 改用 PyTorch + transformers 直接推理（safetensors backbone + 8 head .pt）。ONNX 路线已验证不可行（RoPE fp16 NaN + CoreML EP ViT 覆盖度差，准确率显著下降） |
| `identify_trained_species.py` | 通过 species_head 权重 L2 范数识别 1018 个有训练数据的类（v2 是 1516 类）| v3 改为 1535 类 + 显式 `species_list_1301.parquet` 提供 trained mask（model_output_id 跳号），不再需要从权重反推 |

**模型文件**（v2 ONNX）：
- `dinov3_backbone.onnx` (1.13 GB) — 在 commit `9a6ba5a` 中删除
- `species_ensemble.onnx` (83 MB) — 同上
- `species_taxonomy.parquet` — 同上
- `species_trained.json` — 同上

如需 v2 模型重现，从 git history 取回（`git show bd5cdb7^:engine/models/dinov3_backbone.onnx`
不行因为 .gitignore，需要从 lingjian-v2 / dino 子项目重新导出）。

---

_最后更新：2026-04-27_
