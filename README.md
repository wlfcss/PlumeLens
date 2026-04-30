# PlumeLens / 鉴翎

辅助鸟类摄影爱好者快速筛选拍摄的鸟类照片的桌面应用。

通过本地混合推理管线（ONNX 鸟类检测 + 姿态/可见性 + 双模型画质评估，以及 torch/transformers DINOv3 鸟种识别）对照片进行智能分析，帮助摄影师从大量素材中快速挑选最佳作品。**所有推理在本地完成，无需联网**。

---

## 功能

- 导入照片文件夹，自动扫描并生成缩略图（RAW 内嵌 JPEG 优先，回退完整解码）
- 本地 hybrid 管线：YOLO 检测 + bird_visibility 姿态 + 双 IQA 画质评估 + DINOv3 鸟种识别
- 4 档自动分级（精选 / 可用 / 记录 / 淘汰）+ pose 降档（头不可见 -2 / 眼不可见 -1）
- 群内共识"识别修正"：单鸟图同 scene 共识修正模型偏差
- "model_unconfirmed"待审：head 不可见仍跑识别但标待审，用户在深度复核确认才进羽迹
- 顶层路由 `开始 / 选片 / 羽迹`：选片工作流 + 长期物种沉淀
- "羽迹"模块：1535 种物种墙 + 保护等级分组 + 物种详情（中文百科 + 时间线 + 地理分布）
- 多维度筛选 / 排序 / 分组 / 对比 / 深度复核
- 支持 RAW 格式（CR2/CR3/NEF/ARW 等）
- 批量分析支持暂停 / 恢复 / 断点续跑

---

## 分析管线

```
原片 (RAW/JPEG)
  ↓ Pillow/rawpy → EXIF 转正后的原图（所有裁切均基于原图坐标）
  ↓ letterbox 1280 (114 fill)
  ↓ YOLOv26l-bird-det v1.0 (conf≥0.5, NMS-free)
  ↓ N 个 bbox
  ↓ 对每个 bbox:
  │   ├─ bbox + 10% padding 紧主体裁切
  │   │     ├─ bird_visibility v1.1 (640) → 5 keypoints + head_visible/eye_visible
  │   │     └─ HyperIQA → 技术分 s_hyper
  │   ├─ bbox 2.5× 语义裁切 → CLIPIQA+ → 语义分 s_clip
  │   ├─ 综合分 = 0.35·s_clip + 0.65·s_hyper → 4 档分级
  │   ├─ pose 降档（head 不可见 -2 / eye 不可见 -1）
  │   └─ DINOv3 species v3 (480px ViT-L + 8-head ensemble) → top-K 物种
  ↓ 选最高综合分的鸟 → 照片代表结果
```

### 分级阈值（综合分 0-1）

| 分级 | 分数范围 | 含义 |
|---|---|---|
| 淘汰 (reject) | < 0.45 | 画质不可接受 |
| 记录 (record) | 0.45 – 0.60 | 仅供记录 |
| 可用 (usable) | 0.60 – 0.75 | 可使用 |
| 精选 (select) | ≥ 0.75 | 最佳作品 |

完整模型清单与指标见 [engine/models/README.md](engine/models/README.md)。

---

## 技术架构

| 层 | 选型 |
|---|---|
| 桌面外壳 | Electron 35 + 主进程子进程守护 + 一次性 token 安全边界 |
| 前端 | React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui + i18next + TanStack Query + Zustand |
| 后端 | Python 3.11 + FastAPI + uvicorn + structlog |
| 推理 | onnxruntime（YOLO / pose / IQA） + torch + transformers（DINOv3 species） |
| 存储 | SQLite WAL 模式 + `~/Library/Application Support/PlumeLens/`（packaged）/ `~/.plumelens/`（dev） |
| 通信 | localhost HTTP（动态端口，仅绑 127.0.0.1） + SSE 事件总线（library-scoped） |

**关键架构原则**：

- 推理完全本地化，无网络依赖
- 业务逻辑全在后端；前端 Zustand 严格限于纯 UI 状态
- 用户照片目录只读，不写回源目录
- 所有分析数据 / 缩略图 / 缓存写入应用数据目录

---

## 前置要求

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.11+
- [uv](https://docs.astral.sh/uv/) (Python 包管理)
- macOS (Apple Silicon / Intel) 或 Windows 10+

模型文件需单独获取：YOLO / bird_visibility / CLIPIQA+ / HyperIQA 共 ~300MB 直接入仓；DINOv3 species v3 backbone (~580MB safetensors) 与 8 个 head ckpt (~270MB) 不入 git，由打包脚本注入到 `engine/models/species/`。

---

## 安装与开发

```bash
# 克隆 + 安装依赖
git clone <repo>
cd PlumeLens
npm install
uv sync

# 开发启动（Vite + Electron + Python backend）
npm start

# 类型检查
npm run typecheck
uv run pyright

# 测试
npx vitest run                       # 前端单元
uv run pytest tests/engine            # 后端 + 真模型集成
npx playwright test tests/e2e/        # E2E

# 打包 macOS arm64
npm run build
npm run dist:mac                      # → release/PlumeLens-x.y.z-arm64.dmg
```

更多命令与开发约束（commit 风格 / 兼容性矩阵 / 安全约束 / 测试策略）见仓库内开发文档。

---

## 项目状态

- ✅ Hybrid 管线全部就位：ONNX 检测 + 姿态 + 双画质 + torch DINOv3 species v3
- ✅ 前端三路由高保真工作台（开始 / 选片 / 羽迹）
- ✅ 后端：scanner / thumbnail / cache / analyzer / queue / decisions / scene_grouper + event_bus + 全部 API 路由
- ✅ 数据：SQLite WAL + 双指纹（path+mtime → SHA-256）+ pipeline_version 缓存键
- ✅ 物种百科本地化：1535 种元数据 + 中文 Wikipedia 介绍 + Wikimedia Commons 摄影封面
- ✅ macOS arm64 打包：PyInstaller + electron-builder dmg 全链路通过
- ✅ 测试：~187 后端 pytest + 12 前端 vitest + 8 个 Playwright E2E
- 🟡 App.tsx 仍在按 pages/components 拆分中
- 🟡 Windows 打包尚未验证
- 🟡 AF 对焦点 Canon 区域 / Nikon / Sony 完整解析待校准

---

## 模型版权

- `yolo26l-bird-det.onnx`（v1.0）/ `bird_visibility.onnx`（v1.1）/ DINOv3 分类 heads：由项目作者训练产出，他人使用需注明来源。完整模型卡见 `engine/models/*.MODEL_CARD.md`
- `clipiqa_plus.onnx` / `hyperiqa.onnx`：基于公开 IQA 研究模型的 ONNX 导出
- DINOv3 backbone：Meta DINOv3 LVD-1689M 预训练权重，遵循 [DINOv3 License](https://github.com/facebookresearch/dinov3)（非商业限制，商业使用须与 Meta 确认）
- `species/canonical_extended.parquet`：基于《中国鸟类名录 v12.0》整理（中国观鸟年报）

---

## 许可证

[GPL-3.0](LICENSE)
