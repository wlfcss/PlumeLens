# 开发日志 — 2026-04-28

> 本日围绕 `选片`、`深度复核`、`羽迹` 三条业务线做了连续整改：缩略图刷新、复核弹窗布局、IQA 裁切与评分、四档分级、物种名录、物种墙、中文百科与摄影图封面等问题集中修复。用户明确要求避免“草台式”轮询、避免历史识别数据影响测试、所有裁切必须基于原图、物种图鉴必须以《中国观鸟年报-中国鸟类名录_v12.0》为主。

---

## 总体结论

| 方向 | 结论 |
|---|---|
| 管线架构 | 继续承认并维护 **hybrid ONNX + torch species v3**：YOLO/pose/IQA 走 ONNX Runtime，DINOv3 species v3 走 torch + transformers。 |
| 裁切原则 | 所有下游裁切均基于 EXIF 转正后的原图；不允许基于缩略图或缩放展示图裁切。 |
| IQA 分工 | CLIPIQA+ 评估语义/构图，使用较大 2.5x 裁切；HyperIQA 评估主体技术质量，使用原图上的紧主体裁切，不再吃 2.5x 大裁切。 |
| 评分展示 | 模型输出仍按 0-1 处理；UI 统一换算为百分制并保留 1 位小数。 |
| 分级体系 | 统一为 `精选 / 可用 / 记录 / 淘汰` 四档，阈值为 `45 / 60 / 75`；无鸟作为单独筛选状态，不再混入质量档位。 |
| 用户决策 | 自动评估与人工评估分离；如有人工作业，以人工决策为准。 |
| 缩略图刷新 | 从“持续轮询兜底”改为后端 library-scoped SSE 事件驱动刷新，缩略图 ready / batch / complete / scene group ready 都会触发前端 query invalidation。 |
| 羽迹物种库 | 以《中国观鸟年报-中国鸟类名录_v12.0》为主，补入模型 1301 清单中的 19 个非 v12 物种，归组为“国外观赏种”。 |
| 物种封面 | 修复 Wikipedia `pageimages` 误选手绘图、版画、标本图的问题；优先使用 Wikimedia Commons 摄影图。 |

---

## 用户反馈与处理记录

### 1. 缩略图大量不加载 / 分析后界面未自动更新

**用户现象**：
- `选片` 页面滚动后大量 tile 只显示占位渐变。
- 分析进度完成后，部分照片卡片仍停留在“等待分析”或无缩略图。
- 用户指出“不应靠不停轮询解决”。

**诊断**：
- 缩略图生成、场景分组、分析结果刷新是后台异步完成的多阶段状态。
- 原先前端主要靠 detail refetch / interval 兜底，容易在“分析完成但最后一批缩略图事件尚未刷新”时留下极少量未更新 tile。

**改动**：
- 新增 `engine/services/event_bus.py`：本进程内 library 事件广播。
- `engine/api/routes/library.py` 新增 `GET /library/{id}/events` SSE。
- `engine/services/thumbnail.py` 在 thumbnail batch / ready / failed / complete 时发布事件。
- 前端新增 `useLibraryEvents()`，监听：
  - `library_snapshot`
  - `thumbnail_batch`
  - `thumbnail_ready`
  - `thumbnail_failed`
  - `thumbnail_complete`
  - `scene_groups_ready`
- 前端收到事件后以 150ms debounce 刷新 library detail 与 libraries summary。
- `ThumbnailImage` 保留单个可见缩略图的局部自修复能力，用于应对 `plumelens://` 早期 404 和缓存竞争，但不再作为主刷新方案。

**涉及文件**：
- `engine/services/event_bus.py`
- `engine/api/routes/library.py`
- `engine/services/thumbnail.py`
- `renderer/src/hooks/use-library.ts`
- `renderer/src/components/thumbnail-image.tsx`

---

### 2. 深度复核弹窗布局、关闭与快捷键

**用户现象**：
- 上下滚动后复核弹窗无法关闭。
- 原图与裁切图布局不稳定，之前曾出现为了塞进高度而改变图片比例的问题。
- 关闭 / 上一张 / 下一张按钮未对齐，点击热区不合理。
- 右侧信息字号过小，用户主要工作界面应更适合长时间复核。

**处理原则**：
- 弹窗外层使用 viewport 百分比，不写死绝对宽高。
- 弹窗高度原则上不超过界面，避免最外层纵向滚动。
- 图片必须保持原始比例，不能为了适配高度强行拉伸。

**改动**：
- 复核弹窗降到约 `90vw / 90vh`，同时设置合理最小值。
- 内容区改为左右分栏：原图与 IQA 裁切图并列，右侧为固定操作栏。
- 图片容器使用自适应 `contain` / 背景定位，不改变图片比例。
- 底部加入横向 filmstrip 缩略图轴，支持快速挑选照片。
- 支持快捷键：
  - `1` 精选
  - `2` 可用
  - `3` 记录
  - `4` 淘汰
  - `← / →` 切换照片
  - `Esc` 关闭
- 右侧按钮同步四档：精选、可用、记录、淘汰。
- 顶部按钮对齐并扩大实际点击区域。
- 右侧信息文字整体调大，重要分数与候选物种更突出。
- 裁切框改为绿色，贴近用户反馈与 Nothing 风格。

**涉及文件**：
- `renderer/src/App.tsx`
- `renderer/src/app.css`
- `renderer/src/i18n/locales/zh-CN.json`
- `renderer/src/i18n/locales/en.json`

---

### 3. IQA 裁切、模型输入与评分

**用户问题**：
- “HyperIQA 并不适合裁切 2.5 倍放大的图，只适合裁切的原图。”
- “所有裁切都应当基于原图开展。”
- “技术评分普遍偏高，怀疑模型调用和输出转换存在问题。”
- 希望改为百分制，保留 1 位小数，让区间更直观。

**诊断结论**：
- CLIPIQA+ 更偏语义质量、主体/构图/整体观感，适合看包含环境的较大裁切。
- HyperIQA 更偏无参考技术画质，适合吃主体清晰度、曝光、噪声等更聚焦的区域；不应喂 2.5x 大裁切。
- CLIPIQA+ 和 HyperIQA 的 ONNX 图内部已经包含各自 normalization，engine 侧只应传 raw RGB `0-1`。
- 两个模型输出按 `0-1` 浮点处理；展示层转成百分制。

**改动**：
- `engine/pipeline/quality.py`
  - `QualityAssessor.assess()` 接收 `semantic_crop` 和 `technical_crop`。
  - CLIPIQA+ 使用 `semantic_crop`。
  - HyperIQA 使用 `technical_crop`。
  - 输入预处理保持 raw RGB `0-1` resize 到 `224x224`，不重复 normalization。
- `engine/pipeline/manager.py`
  - pose / HyperIQA：使用 bbox + padding 的紧主体裁切。
  - CLIPIQA+：使用原图上的 2.5x IQA 语义裁切。
  - pipeline_version 纳入 IQA 裁切参数与 `v5-iqa-raw-input-split-crops` 标识，避免旧结果污染。
- UI 使用百分制展示，保留 1 位小数。
- 分档阈值调整为：
  - `< 45` 淘汰
  - `45-60` 记录
  - `60-75` 可用
  - `>= 75` 精选

**涉及文件**：
- `engine/pipeline/quality.py`
- `engine/pipeline/manager.py`
- `engine/pipeline/preprocess.py`
- `engine/pipeline/grader.py`
- `renderer/src/App.tsx`

---

### 4. 选片界面分档、筛选、排序与导出

**用户要求**：
- 不需要“待选”等额外档位，统一为四档：精选、可用、记录、淘汰。
- 唯一区分是系统自动评估与人工评估；人工评估优先。
- 筛选区仅需要四档 + 无鸟，默认展示精选、可用、记录。
- 去除“最近操作”排序。
- 导出界面支持手动调整范围。

**改动**：
- `quickFilters` 调整为 `select / usable / record / reject / no_bird`。
- 默认筛选保留精选、可用、记录。
- 排序移除“最近操作”。
- 组内排序按档位优先，同档按分数降序。
- 手动决策覆盖自动 grade：
  - `effectivePhotoGrade(photo)` 统一计算展示与导出使用的最终档位。
  - 人工决策清除后回到系统自动结果。
- 导出抽屉新增：
  - 四档 checkbox
  - 分数最小值 / 最大值输入
  - 导出数量实时预览

**涉及文件**：
- `renderer/src/App.tsx`
- `renderer/src/lib/backend-adapter.ts`
- `renderer/src/i18n/locales/zh-CN.json`
- `renderer/src/i18n/locales/en.json`

---

### 5. 对焦点与 EXIF 复核

**用户问题**：
- “为什么一直获取不到照片的对焦点？”
- 点对焦与区域对焦的呈现逻辑应该不同，需要按官方文档处理。

**当前处理状态**：
- 继续使用 Pillow EXIF + Canon MakerNote 中 AFInfo/AFInfo2 风格数据解析。
- UI 不再把所有 AF 信息简化为一个含糊点；支持点状与区域式展示的方向已纳入复核 overlay。
- 已知仍需继续加强：
  - Canon 不同机型 AFInfo2 字段结构可能存在差异。
  - Nikon / Sony 等品牌 MakerNote 尚未完整适配。
  - 区域对焦需要进一步按官方文档完善样式和语义，不应简单画成一个普通点。

**涉及文件**：
- `engine/services/scanner.py`
- `renderer/src/App.tsx`
- `renderer/src/app.css`

---

### 6. 羽迹物种库、去重与 19 个模型增补物种

**用户材料**：
- `中国观鸟年报-中国鸟类名录_v12.0.xls`
- `中国鸟类名称对照表.xlsx`
- `species_list_1301.csv`

**核查结果**：
- v12 主名录为 1516 种。
- 模型可识别清单为 1301 种。
- 其中 1282 种在 v12 中，19 种不在 v12。
- 项目 `engine/models/species/canonical_extended.parquet` 为 1535 种，即 1516 + 19。

**改动**：
- 物种墙以 v12 为主，19 个模型增补物种归组为“国外观赏种”。
- 修复物种卡片重复问题：
  - 不再用 top-K 候选物种随意点亮图鉴。
  - 建立更保守的 canonical alias 解析。
  - `zh_title / en_title` 只在唯一且不冲突时作为别名。
- `species-wiki.json` 增加：
  - `canonical_zh`
  - `canonical_en`
  - `family_sci`
  - `family_zh`
  - `order_sci`
  - `iucn`
  - `protect_level`
  - `is_trained`
  - `in_china_v12`
- `build_species_wiki_json.py` 改为从 `canonical_extended.parquet` 和 `species_list_1301.parquet` 合并输出，确保 1535 种都进入前端 bundle。

**涉及文件**：
- `scripts/build_species_wiki_json.py`
- `renderer/src/lib/species-wiki.ts`
- `renderer/src/lib/species-wiki.json`
- `renderer/src/lib/backend-adapter.ts`
- `renderer/src/App.tsx`

---

### 7. 羽迹界面改造

**用户要求**：
- 物种界面应是成就卡片墙，拍到后点亮。
- 可按保护等级 / 珍稀等级分组。
- “羽迹”的照片界面意义不大，改为地理分布界面。
- 物种介绍用中文，不要英文。
- 支持筛选：全部、已点亮、未点亮。
- 选中鸟种后，在侧边栏点击照片数数字，通过弹窗浏览自己拍摄的照片。

**改动**：
- `羽迹` 保留两个子视图：
  - `物种`
  - `地理分布`
- 物种卡片改为 achievement 风格：
  - 未点亮：低亮度 / 锁定感
  - 已点亮：绿色边框与状态
  - 分组：保护等级、IUCN、国外观赏种等
- 增加物种筛选：
  - 全部
  - 已点亮
  - 未点亮
- 详情侧栏：
  - 仅使用中文维基简介，无英文 fallback。
  - 来源文案为“中文维基百科”。
  - 照片数可点击，弹出该物种下用户拍摄照片浏览器。
- 新增 `SpeciesPhotosModal`：
  - 大图预览
  - 右侧/底部缩略图选择
  - 可进入复核
- 地理分布：
  - 以中国地图为基础展示已拍到物种的拍摄分布。
  - 点击区域可看到对应照片。

**涉及文件**：
- `renderer/src/App.tsx`
- `renderer/src/app.css`
- `renderer/src/i18n/locales/zh-CN.json`
- `renderer/src/i18n/locales/en.json`

---

### 8. 用户手动修改鸟种（兼容多鸟）

**用户要求**：
- 允许用户手动修改照片中鸟的鸟种。
- 需要兼容一张照片中多只鸟的情况。

**改动方向**：
- 深度复核中增加物种编辑面板。
- 以检测到的 bird index 为单位选择当前鸟。
- 支持搜索物种库，显示：
  - 中文名
  - 拉丁名
  - 是否自动可识别 / 仅支持手动标注
- 手动物种与自动 top-K 区分展示。

**涉及文件**：
- `renderer/src/App.tsx`
- `renderer/src/lib/species-wiki.ts`
- `renderer/src/i18n/locales/zh-CN.json`
- `renderer/src/i18n/locales/en.json`

---

### 9. 物种百科图片从“尽量照片”改造

**用户问题**：
- 丽鳾详情展示了手绘图，不应优先使用手绘图。
- 用户要求“尽量使用拍摄图，而不是手绘图”。

**根因**：
- `scripts/fetch_species_wiki.py` 使用 MediaWiki `pageimages`，该 API 会把页面封面图直接返回。
- 对鸟类页面来说，封面图可能是：
  - SVG 手绘图
  - Keulemans / Gould 历史版画
  - HBW 手绘图
  - 标本照片
  - 分布图
  - protolog 原始描述图

**改动**：
- `scripts/fetch_species_wiki.py`
  - 从 `requests` 改为项目已有依赖 `httpx`，避免 `uv run` 环境缺 requests 导致脚本不可运行。
  - 新增 Commons 搜索逻辑：优先查找 Wikimedia Commons 中的 JPEG/PNG/WebP 摄影图。
  - 增加非摄影图过滤：
    - `.svg`
    - `Keulemans`
    - `Gould` 历史版画
    - `HBW`
    - `illustration`
    - `lithograph`
    - `specimen`
    - `bird_skin`
    - `museum`
    - `distribution_map`
    - `range_map`
    - `stamp`
    - `protolog`
    - `PLOS` 等
  - 新增 `--repair-images`：只修旧缓存里“明显非摄影图”的项目，不全量重洗正常照片。
- 实际修复：
  - 先修复 63 个明显非摄影封面。
  - 加入 `protolog` 过滤后又修复 1 个。
  - 合计 64 次旧缓存图片替换。
- 重新生成 `renderer/src/lib/species-wiki.json`。

**验证结果**：
- `engine/models/species_wiki.parquet`：1535 行。
- `renderer/src/lib/species-wiki.json`：1535 项。
- 按当前过滤规则检查，明显非摄影封面数量为 `0`。
- 丽鳾 `Sitta formosa` 已从 `SittaFormosa.svg` 替换为摄影图 `Sitta_formosa_94295595.jpg`。
- 浏览器实测：羽迹详情页丽鳾显示摄影图。

**涉及文件**：
- `scripts/fetch_species_wiki.py`
- `engine/models/species_wiki.parquet`
- `renderer/src/lib/species-wiki.json`

---

## 数据与打包注意事项

用户多次强调：
- 不要让历史识别数据影响测试工作。
- 打包 DMG 中不能带测试数据、benchmark 数据或历史识别结果。
- 用户照片目录只读，不写回源照片目录。

当前应作为发布前 checklist 固化：
1. 清理 `~/.plumelens/` 中测试数据库、缩略图、缓存、旧 pipeline_version 结果。
2. 检查 `electron-builder.yml` 的 extraResources，只包含运行所需模型与引擎资产。
3. 不把 `benchmark/results/*`、用户本地测试照片、历史 SQLite 数据库打入 DMG。
4. 重打 DMG 前执行一次全新用户数据目录 smoke test。

本日最后一次只执行了 `npm run build`，未重新生成 DMG。

---

## 关键验证

本日已执行并通过：

```bash
uv run ruff check scripts/fetch_species_wiki.py scripts/build_species_wiki_json.py
uv run python -m py_compile scripts/fetch_species_wiki.py scripts/build_species_wiki_json.py
uv run python scripts/build_species_wiki_json.py
npm run typecheck
npm run lint
npm test
npm run build
```

浏览器人工验证：
- 当前页面 `http://localhost:5173/` 可打开。
- 羽迹页物种筛选存在：全部 / 已点亮 / 未点亮。
- 物种详情中文文案与“中文维基百科”来源正常。
- 搜索并打开丽鳾详情后，侧栏显示摄影图而非手绘 SVG。
- 浏览器 console error 为空。

---

## 当前仍需关注

1. **对焦点官方逻辑仍需继续深化**
   - Canon 区域对焦、点对焦、多点合焦的视觉表达还需要按机型和 MakerNote 字段继续校准。
   - Nikon / Sony 等品牌尚未建立完整官方解析路径。

2. **深度复核 UI 仍建议做多尺寸视觉回归**
   - 已按 90% viewport 和图片比例修复，但还应覆盖 13 寸、16 寸、外接宽屏、竖图/横图。

3. **物种封面图不是学术级图像鉴别**
   - 当前是基于 Commons 搜索 + 文件名/格式启发式过滤。
   - 已能避免明显手绘/版画/标本/分布图，但仍可能有少量不理想照片，后续可增加人工 override 表。

4. **App.tsx 继续过大**
   - 选片、复核、羽迹、导出、物种编辑都在同一文件中，后续应拆为 pages/components/hooks。

5. **DMG 未在本轮最终重打**
   - 本轮验证到 `npm run build`。
   - 发布测试仍需执行打包、安装、干净数据目录启动、导入真实文件夹、分析、复核、羽迹检查。

