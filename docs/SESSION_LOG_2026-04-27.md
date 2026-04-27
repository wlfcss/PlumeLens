# 开发日志 — 2026-04-27

> 本日进行了一次大规模整改：物种识别架构重构、内存爆炸修复、Mac 加速路径落地、审计修复。
> 13 个 commit，~3000 行净改动，dmg 重打 7 次。

---

## 整体目标与成果

| # | 目标 | 结果 |
|---|------|------|
| 1 | 接入 dino 子项目新训的 DINOv3 species v3（91.5% top-1） | ✅ 切到 torch + transformers 路径 |
| 2 | 修复 plumelens 进程吃 300 GB RAM 卡死系统的问题 | ✅ 4 处根因全修，单进程 RSS 稳定 1.73 GB |
| 3 | 验证并落地 Mac CoreML 硬件加速（之前以为不可用） | ✅ ANE 真凶定位 + 关 ANE 走 GPU，YOLO 3.5× / pose 2.8× 加速 |
| 4 | 接入新 bird_visibility v1.1 模型 | ✅ ONNX 替换 + 同样关 ANE |
| 5 | 全面代码审计修隐藏 bug | ✅ 修了 3 轮共 11 处问题 |

---

## 时间线（commit 顺序）

### 1. `5deab5f feat(review): 深度复核 EXIF + bbox/姿态点 toggle（P1）`

**起点**：用户反馈深度复核弹窗信息不全，要求显示 bbox / 姿态点 / EXIF。

**改动**：
- `engine/api/routes/library.py` PhotoRow 新增 `best_detection`（bbox + pose + species_candidates） + `exif`
- `engine/services/scanner.py` EXIF 提取从只读 IFD0 改为 IFD0 + ExifIFD 合并（之前缺 ExposureTime/FNumber/ISO/LensModel）
- `renderer/src/App.tsx` ReviewModal 加 toggle 控制 bbox / pose 显示
- 新建 ExifPanel 显示相机 / 镜头 / 曝光参数

---

### 2. `393e9da fix(audit): 5 处隐藏 bug`

**起点**：用户要求"全面审计"。

**修复**：
1. `getBackendUrl` 6s 后抛错 → useAnalysisProgress promise 永久 reject。改为无限轮询。
2. SSE useEffect cleanup race（cancelled flag 缺失）
3. ProcessManager 健康检查 catch 后吞掉错误，崩溃后从不重启。改为 3 次连续失败触发 handleCrash。
4. `plumelens://` 协议路径穿越漏洞（单层 decode 不够防 `%252e%252e/`）。改为双重 decode + path.resolve() 边界检查。
5. `useEffect [allDetails]` 死循环（每次 render 返回新数组）。改为 stable allDetailsKey 字符串依赖。

---

### 3. `bea4ac8 perf(pipeline): 并发 1→2 + 每阶段 timing 日志`

**起点**：用户反馈"识别速度还是挺慢的"。

**改动**：
- `analysis_concurrency` 1 → 2（CoreML EP 多 session 共享 ANE/GPU 资源，并发 2 ≈ 1.5-1.8× 吞吐）
- `manager.py::_analyze_sync` 每阶段计时（load/yolo/pose/iqa/species）打日志便于性能调优

⚠ 用户明确反对 `species_min_grade='usable'→'select'`：保持 usable 不改。

---

### 4. `4c990c2 fix(yolo): YOLO 强制 CPU — CoreML EP 输出 bbox 数值严重错位`

**起点**：用户反馈"yolo 识别裁切的 bbox检测框的坐标是否有误？很多照片都没有正确框选"。

**根因**：CoreML EP 跑 YOLO26 输出 letterboxed bbox 超过 1280 边界（如 x1=-80, x2=1296），detector clamp 到 0/imgw 后框成"右下半张图"。

**修复**：`yolo_provider: cpu`。代价：单图 ~620ms（vs CoreML ~100ms）。
（**后来在 8a936c6 通过 CoreML CPUAndGPU 关 ANE 找回 3.5× 加速**）

---

### 5. `86cb52c feat(sort): 组内排序改为'档位优先 + 档位内分数降序'`

**起点**：用户："组内的排序逻辑也需要调整，应该先从最优档往下排"。

**改动**：sortPhotos 加 GRADE_RANK，先比 grade（精选>可用>记录>淘汰），同档再比 finalScore。

---

### 6. `089db2f feat(review): 深度复核重构为双图布局 + 紧凑 panel`

**起点**：用户："深度复核界面图太模糊了，应当加载全分辨率的原图，原图和裁切图（2.5 倍裁切图）"。

**改动**：
- ReviewModal 改双图：左原图 + 右 IQA 裁切（2.5× expand 区域）
- 原图加 loupe（按住放大 2.5×，跟鼠标平移）
- bbox 颜色从白改黄
- 右侧 panel 紧凑化：score-header（grade 颜色左条 + 大数字）+ 3×2 指标格 + EXIF 4 列
- `computeIqaCropBox` 端口自后端 `expand_for_iqa`（前后端裁切口径一致）

---

### 7. `06d0a6e fix(audit): 组间排序档位优先 + 弹窗放大 + concurrency 从 settings 读`

**审计发现 3 处真问题**：
1. **组间排序回归** — folderGroups.toSorted 只比 finalScore，导致 grade=usable@0.9 排在 grade=select@0.7 前面。
2. **弹窗过小** — 1180×viewport → 100vw-32 × 100vh-32（max 1920×1280）。
3. **concurrency 形同虚设** — 定义了 `settings.analysis_concurrency=2` 但代码用硬编码 `DEFAULT_CONCURRENCY`。改为从 settings 读取（含 lifespan resume 路径）。

---

### 8. `e052266 fix(review): EXIF orientation 偏移 + 双图自适应布局 + AF 对焦点 + 多项审计修复`

**最大单次改动**：8 文件 +453/-26 行。

**6 项内容**：

1. **bbox/姿态点偏移根因**（高严重性）：
   - `pipeline/preprocess.py::_load_pillow` 加 `ImageOps.exif_transpose`
   - `services/scanner.py::_probe_image_meta` 在 EXIF Orientation ∈ {5,6,7,8} 时交换 width/height
   - 之前 inference 用未旋转图（6000×4000），缩略图已 transpose 为旋转图（4000×6000）→ 前端 overlay 必然偏移

2. **ReviewModal 自适应布局**：横版上下、竖版左右；原图无 overlay；overlay 仅在 IQA 裁切图

3. **Canon AFInfo MakerNote 解析**：
   - `services/scanner.py::_parse_canon_afinfo2` 解析 0x0026（AFAreaXPositions/YPositions + AFPointsInFocus 位掩码）
   - 取 in-focus 点几何中心 → 原图像素坐标
   - 仅 Make=="canon" 时调用，避免错解 Nikon/Sony MakerNote
   - 注入到 exif_json 的 af_point 字段
   - UI：默认 ON，绿色（rgba(74,222,128)）方框 + 中心十字（DSLR 风格 + Nothing UI）

4. **姿态点视觉简化**：5×5px 白点（之前 10×10），统一颜色，无语义区分（之前用绿色突出眼部，user 说"颜色意义不明"）

5. **EXIF 自动 backfill**：`lifespan._refresh_all_thumbnails` 加 Step 3，扫所有 library 重抽 incomplete EXIF（无 FNumber **或** 缺 ExposureTime）。修复了 5deab5f 之前导入的旧数据缺曝光参数。

6. **缩略图动态加载**（user feedback "首次进入加载不出来"）：
   - `useLibraryDetail` / `useAllLibraryDetails` 加 `refetchInterval` — 任一 photo 缺 thumb_grid/preview/scene_id → 3s 轮询
   - `useLibraries` 加 5s 轮询让"已分析 X/Y"实时跳

7. **Make+Model 重复显示**：Canon "Canon EOS R5m2" + Make "Canon" 拼出 "Canon Canon EOS R5m2"。检测 model 以 make 开头则只用 model。

---

### 9. `a56b80a feat(species): 去掉 grade 门 — record/reject 也跑物种识别`

**起点**：用户反馈大量照片"未识别物种"。

**诊断**：物种识别有 3 道门 — pose head_visible AND eye_visible + grade ≥ usable + species_min_confidence ≥ 0.01。

**用户选 D**：去掉 grade 门，所有 head+eye 可见的鸟都识别。

**改动**：`species_min_grade: "usable" → "reject"`（即所有等级都跑）。代价：每张多 30-80% 物种推理时间（DINOv3 ~150ms/张）。

---

### 10. `bd5cdb7 feat(species): 升级到 DINOv3 v3（torch + transformers）`

**起点**：用户提供新训物种识别模型（dino/deploy_v3）。明确要求："去除掉这条约束（CLAUDE.md 写的不装 torch），转 onnx 已被证明不可行"。

**架构变化**：
- ONNX 双尺度（512+640 拼特征）→ torch + transformers 单尺度 480
- 1516 类（1018 训练）→ 1535 类（1301 训练 + 234 ghost mask）
- bf16 on MPS/CUDA, fp32 on CPU
- 测试 top-1：91.93% → **91.5%**（类数 +19，准确率小幅下降可接受）
- 推理速度：CPU EP ~1500ms（CoreML 不可用）→ **MPS bf16 ~63ms**（24× 加速）

**实施**：
1. CLAUDE.md 删除"不装 torch"约束 + 重写架构
2. pyproject.toml 加 torch 2.11 / torchvision 0.26 / transformers 5.6 / safetensors / pyinstaller
3. engine/pipeline/species.py 完全重写：
   - `HeadOnlyClassifier` 镜像 v3 deploy/bird_predictor 结构（LayerNorm + MLP-2048 + species/order/family/genus）
   - `SpeciesTaxonomy` 读 canonical_extended.parquet + species_list_1301.parquet（model_output_id 跳号 → trained_mask）
   - `SpeciesClassifier` auto 选 device（mps/cuda/cpu），bf16 防 RoPE NaN
4. engine/pipeline/manager.py：load 新 deploy_dir，把 5 个 model checksum（backbone safetensors + 8 head + 2 parquet）全部纳入 pipeline_version
5. engine/core/config.py：`species_provider="auto"`，`preprocess_version=3`
6. PyInstaller spec：去掉 torch/transformers 的 excludes，加 hidden imports + collect_dynamic_libs；engine 体积 9MB → 741MB（torch 730MB）
7. electron-builder.yml extraResources 加 species/ 子目录

**验证**：本地 5Y3A6889 实测装载 1.3s，warm 推理 **63.5ms**，dmg 1.7 GB。

---

### 11. `9a6ba5a chore(models): 删除已弃用的 v2 ONNX species 文件`

**起点**：用户问"为啥 dmg 是 3.05 GB？应该 1.6 GB 啊"。

**诊断**：bd5cdb7 切到 v3 时只 .gitignore 旧文件但没真删，electron-builder 的 `*.onnx` 通配符把：
- `dinov3_backbone.onnx` (1.13 GB)
- `species_ensemble.onnx` (83 MB)

也打进了 dmg → 体积多了 1.35 GB 全是僵尸数据。

**修复**：删除 5 个旧文件，dmg 3.05 GB → 1.7 GB。

---

### 12. `2ccb0db fix(memory): 300GB 内存爆炸 — 4 处根因修复`

**起点**：**"plumelens 的进程占用了将近 300 个 GB 的内存，直接把我系统卡死了，请找到原因！"** + "退出应用后进程似乎没有关闭"

**根因（4 处联动）**：

1. **🔴 `engine/__main__.py` 缺 `multiprocessing.freeze_support()`**（最关键）
   - PyInstaller frozen 二进制 + macOS 'spawn' 默认模式下，torch/transformers/pyarrow 内部 spawn 子进程时**重新执行整个二进制**
   - 没有 freeze_support()，子进程不知道自己是 helper，会跑完整 main() → **加载完整 845MB 模型 + 启动 uvicorn 听新端口**
   - smoke test 验证：之前单次启动 = **5+ 个完整 engine** 同时活，每个 ~2GB；修复后 = 1 个进程 RSS 稳定 1.73 GB

2. **🔴 `process-manager.ts handleCrash()` 不杀老进程**
   - 原代码 health 检查 3 次失败 → `setTimeout(start)` → 直接 `spawn` 新进程**覆盖 this.process 引用**，老进程没收到任何 kill 信号
   - 每次"假性崩溃"都留下一个孤儿 engine（带 845MB 模型 + 累积的 MPS 缓存）
   - 修复：新增 `killCurrentProcess(reason)` 在 handleCrash 之前显式杀；用 `detached:true` + `process.kill(-pgid)` 杀整个进程组（含 multiprocessing resource_tracker 等 helper 进程）

3. **🔴 `species.py classify()` 不释放 MPS 缓存**
   - Apple Silicon 上 MPS 用统一内存（= 系统 RAM）。PyTorch MPS allocator cache 临时张量复用，**永不主动释放**
   - 连续推理上千张照片 → 缓存累积 → 系统 RAM 缓涨到 swap 爆
   - 修复：每次 classify() finally 中调 `torch.mps.synchronize() + torch.mps.empty_cache()`（CUDA 同理）

4. **🔴 `process-manager.ts` health check 阈值过严**
   - 原 3 次失败（30s）触发重启，但 species v3 第一次冷启推理 ~1.5s 就可能 starve asyncio 主循环 → 误判崩溃 → 触发重启 → 配合 #2 产生孤儿 → 配合 #3 累积内存
   - 修复：阈值 3→6（60s 持续无响应才算真崩）+ 单次 fetch 加 8s timeout

**附加修复**：
- `electron/main.ts` macOS `window-all-closed` 不再误杀 engine（关窗 != 退出）
- 加 `process.on('SIGINT/SIGTERM/exit')` 兜底 cleanup（detached 子进程必须显式回收）
- uvicorn 显式 `workers=1` 防意外 multi-worker

**验证**：smoke test 单次启动只 1 个 PLUMELENS_PORT + 1 个 server process，RSS 稳定 1.73 GB。

---

### 13. `055e9e6 fix(yolo+audit): letterbox 对齐 MODEL_CARD + bird_visibility v1.1 + 3 处审计修复`

**用户提供 yolo26l-bird v1.0 包**。读 MODEL_CARD §5.5.9 发现："CoreML EP vs CPU EP 大多数图一致，少数（~5%）边缘检测差 +/- 1 个，bbox 几何偏差最多 ~250 px"。

**改动**：

1. **letterbox 对齐参考**：PIL LANCZOS + int 截断 → cv2.resize INTER_LINEAR + int(round)。直接对 float32 输入 resize（cv2 原生支持），消除 float32→uint8→float32 round-trip 量化噪声。
2. **bird_visibility v1.1 替换**：从 `yolo-split/dist/bird_visibility_pkg_v1.1.zip`，配置/阈值完全一致，仅 ONNX 重导出。
3. **审计修 3 处中风险**：
   - species.py classify() finally 异常掩盖（NameError 掩盖 OOM 真因）
   - process-manager setTimeout 关停竞态（stop 中残留 timer 触发 spawn 孤儿）
   - 同 #1 量化往返

**关键发现**：实测 5Y3A7448.JPG（8K Canon），即使预处理对齐参考实现，CoreML EP 仍输出 letterbox bbox `(-80, 211, 626, 1095)` vs CPU `(431, 504, 597, 746)` —— **错位 700+ px 远超 250 px**。维持 yolo_provider="cpu"，正确性优先。

---

### 14. `8a936c6 feat(yolo): 启用 CoreML EP CPUAndGPU 模式 — 关 ANE 拿到 3.5× 加速`

**用户重大发现**：CoreML EP 有 `MLComputeUnits='CPUAndGPU'` 选项 — 关掉 ANE 只走 Metal GPU + CPU 兜底。**ANE 是 advanced indexing 精度 bug 的真凶**，Metal GPU 实现是对的。

**实测对比**（5Y3A7448.JPG 8K Canon）：

| EP | letterbox bbox | conf | ms | 几何 |
|---|---|---|---|---|
| CPU | (431,504,597,746) | 0.943 | 395 | ✅ |
| CoreML default(含 ANE) | (-80,212,623,1095) | 0.944 | 87 | ❌ 越界 |
| **CoreML CPUAndGPU** | **(431,504,597,746)** | 0.942 | **112** | **✅** |

**实施**：
- `engine/pipeline/manager.py::resolve_providers` 增加 `coreml_compute_units` 关键字参数，给定时把 CoreMLExecutionProvider 注入为 `(name, options)` 元组
- 定义 `_COREML_DEFAULT_COMPUTE_UNITS_YOLO = "CPUAndGPU"`，YOLO 加载时自动注入
- `engine/core/config.py::yolo_provider` 'cpu' → 'coreml'

**端到端验证**：5Y3A7448 跑完，best bbox `(2761, 1862, 3821, 3409)` 与 CPU EP 反算位置一致。

---

### 15. `024a395 fix(pose): 关 ANE — pose 走 CoreML CPUAndGPU 与 YOLO 一致`

**起点**：详读 `bird_visibility_pkg_v1.1` INTEGRATION_GUIDE.md §14.2 实测表：

| Backend | Box IoU 均值 | Box IoU 最差 | KP 漂移均值 | P95 |
|---|---|---|---|---|
| PyTorch MPS | 0.99999963 | 0.99999908 | 0.00005 px | 0.00013 px |
| ONNX CPU | 0.99999951 | 0.99999915 | 0.00008 px | 0.00025 px |
| **CoreML EP** | **0.983** | **0.495** ⚠ | **2.40 px** | **8.13 px** |

§5.3 警告："CoreML 关键点位置有 ~2.4 像素的轻微漂移"。

**实测 PlumeLens crop 场景**：CoreML default(ANE) KP drift < 0.6 px（crop 输入更"干净"，不容易触发 ANE 边角 case）。但 YOLO26l-pose 与 YOLO26l-bird 同架构家族，同 ANE 风险。

**用户决定 B 方案**：pose 也走 `MLComputeUnits='CPUAndGPU'` 关 ANE。代价：单图 +18ms（20→38ms）；收益：永不踩 ANE 精度坑。

---

## 最终架构状态

### 推理路径

```
原片
  ↓ letterbox1280 (114 填充, cv2 INTER_LINEAR + int(round)) → YOLO26l-bird-det v1.0
  │   CoreML EP CPUAndGPU (关 ANE) ~112 ms
  ↓ 鸟类 bbox 列表（NMS-free 300 候选，conf 阈值过滤）
  ├─ 逐框裁切 (+10% padding)
  │    ↓ bird_visibility v1.1 (imgsz=640) — CoreML EP CPUAndGPU (关 ANE) ~38 ms
  │    ↓ head/eye 可见性 + 5 关键点（在原图坐标系）
  │    ↓ IQA expand 2.5× 大裁切 → CLIPIQA+(×0.35) + HyperIQA(×0.65) — CoreML EP default ~110 ms
  │    ↓ pose 降档（head 不可见 -2 / eye 不可见 -1）→ 4 档分级
  │    ↓ (head+eye 可见时) DINOv3 ViT-L/16 (480) — torch + transformers MPS bf16 ~70 ms
  └─ 选最高综合分 → PipelineResult
```

每张耗时：~330 ms warm。1607 张库 ~9 分钟。

### Provider 配置

| 模型 | EP | 选项 | 速度 | 备注 |
|---|---|---|---|---|
| YOLO | CoreML | CPUAndGPU（关 ANE） | ~112 ms | 3.5× 加速 |
| pose | CoreML | CPUAndGPU（关 ANE） | ~38 ms | 2.8× 加速 |
| CLIPIQA+ | CoreML | default（ANE 安全） | ~60 ms | 7× 加速 |
| HyperIQA | CoreML | default（ANE 安全） | ~50 ms | 27× 加速 |
| DINOv3 species | torch | MPS bf16 | ~70 ms | 24× 加速 |

### 模型清单

| 文件 | 大小 | git | 说明 |
|---|---|---|---|
| `yolo26l-bird-det.onnx` | 99.9 MB | ✓ | YOLO26l-bird v1.0（NMS-free） |
| `bird_visibility.onnx` | 102.8 MB | ✓ | YOLO26l-pose v1.1 |
| `clipiqa_plus.onnx` | 306 MB | ✓ | CLIP IQA |
| `hyperiqa.onnx` | 109 MB | ✓ | HyperNet IQA |
| `species/backbone/model.safetensors` | 578 MB | ✗ (.gitignore) | DINOv3 ViT-L/16 fp16 |
| `species/heads/seed*.pt` × 8 | 8 × 33 MB | ✗ (.gitignore) | 8 head ckpt |
| `species/canonical_extended.parquet` | 64 KB | ✓ | 1535 类 metadata |
| `species/species_list_1301.parquet` | 38 KB | ✓ | 1301 trained classes mask |
| `species/backbone/config.json` | small | ✓ | HF config |
| `species_wiki.parquet` | 947 KB | ✓ | 物种百科补充数据 |

### 体积

| 项 | 大小 |
|---|---|
| engine/ (PyInstaller frozen) | 754 MB（torch 288 MB / pyarrow 116 MB / cv2 108 MB / onnxruntime 61 MB / transformers 38 MB / 其他 143 MB） |
| engine/models/ | 1.4 GB |
| 其他（Electron + Frameworks + app.asar） | ~280 MB |
| **dmg 压缩后** | **1.7 GB** |

### 关键修复后的不变量

1. ✅ 单进程模型（freeze_support 修好）
2. ✅ MPS 内存稳定（每次 classify 后 empty_cache）
3. ✅ 进程退出时杀整个进程组（detached + kill -pgid）
4. ✅ macOS 关窗不杀 engine（保留 dock 行为）
5. ✅ Health check 容忍冷启 starve（6 次 / 60s 才判崩）
6. ✅ 健康检查触发重启时杀老进程（不留孤儿）
7. ✅ ANE 完全绕开（YOLO + pose）
8. ✅ EXIF orientation 一致（inference / 缩略图 / DB width 全部 post-rotation）
9. ✅ pipeline_version 含完整输入向量（5 个模型 checksum + 全部超参 + ORT/EP）

---

## 体量统计

| 类别 | 数字 |
|---|---|
| Commit | 13（5deab5f → 024a395） |
| 文件改动 | ~25 个独立文件 |
| 净改动行数 | ~3000 行 |
| dmg 重打次数 | 7 |
| PyInstaller 重打次数 | 5 |
| 自动化测试 | 158 个 pytest 全过 + ruff All passed + typecheck 通过 |
| 实测对比验证 | 5Y3A7448.JPG (8K Canon) 对照 4 次 |
| Smoke test | 单进程行为 1 次 + 完整 pipeline 端到端 2 次 |

---

## 知识沉淀

### 1. macOS Apple Silicon 推理加速完整路径

| 模型类型 | 加速路径 | 风险点 |
|---|---|---|
| YOLO26 / 派生（NMS-free + advanced indexing head） | **CoreML EP + MLComputeUnits='CPUAndGPU' 关 ANE** | ANE advanced indexing 精度 bug |
| 标准 CNN（CLIP / HyperNet 等） | CoreML EP default（含 ANE） | 通常无 |
| ViT 大模型（DINOv3 等） | torch + MPS bf16（不要 ONNX） | RoPE fp16 NaN；CoreML EP 算子覆盖 ~30%；ONNX 转换准确率退化 |

### 2. PyInstaller frozen + macOS 多进程库的坑

任何用 `multiprocessing.spawn`（macOS 默认）的库（torch、transformers、pyarrow…）打包到 PyInstaller frozen 时，**必须**在 `if __name__ == "__main__"` 块顶部调用 `multiprocessing.freeze_support()`。否则子进程会重新执行整个 main()，每次启动产生 N 个完整 worker 实例，内存几何爆炸。

### 3. MPS 统一内存的 cache 行为

Apple Silicon MPS = 系统 RAM。PyTorch MPS allocator 默认 cache 临时 buffer 复用，永不主动归还。长时间运行需在每次推理后显式 `torch.mps.synchronize() + torch.mps.empty_cache()`。CUDA 同理。

### 4. EXIF orientation 一致性

`Image.open(path).width/height` 返回的是 **未应用 EXIF Orientation** 的原始尺寸。`ImageOps.exif_transpose` 才是用户在相机/查看器看到的方向。整个 inference 链 + 缩略图链 + DB 存储的 width/height 必须**全程一致用 transposed 版本**，否则 bbox/keypoints 在前端显示会偏移。

### 5. Electron 子进程清理

`spawn` 默认 `detached: false` → 子进程随父进程死，但无法 `kill -pgid` 杀其 helper 子进程。改 `detached: true` + `process.kill(-pid, signal)` 杀整个进程组才能干净清理 multiprocessing resource_tracker、torch worker 等 helper。代价：父进程被强杀时（force-kill）孤儿 engine 不会自动死，需要 `process.on('exit')` 兜底。

---

## 待办（未完成）

| 项 | 优先级 | 说明 |
|---|---|---|
| 重新分析 | 用户操作 | pipeline_version 已多次 bump，DB 缓存全 miss，用户安装新 dmg 后点开始分析才能看到新结果 |
| ReviewModal 原图加载全分辨率 | 中 | 当前 loupe 用 1920px preview，全 res 8K 原图需后端开 plumelens://original 协议（路径穿越保护）|
| 物种识别覆盖率统计 | 低 | grade 门去掉后，理论 head+eye 可见的鸟全识别。可加 dashboard 展示"未识别物种"原因（pose 不可见 / 无 bbox）|
| Canon AFInfo 跨品牌支持 | 低 | 当前只 Canon。Nikon / Sony 有自己 MakerNote 格式，需各自解析器 |

---

_文档生成日期：2026-04-27_
