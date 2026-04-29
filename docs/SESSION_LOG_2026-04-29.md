# 开发日志 — 2026-04-29

> 本日志承接 [`SESSION_LOG_2026-04-27.md`](./SESSION_LOG_2026-04-27.md) 与 [`SESSION_LOG_2026-04-28.md`](./SESSION_LOG_2026-04-28.md)，记录最近一轮围绕 `选片 / 深度复核 / 羽迹 / 组内识别修正 / 打包发布` 的完整整改。
>
> 当前版本：`0.3.0`  
> 当前打包产物：`release/PlumeLens-0.3.0-arm64.dmg`  
> 当前记录时间：2026-04-29 16:10 CST

---

## 总体状态

| 方向 | 当前结论 |
|---|---|
| 产品主线 | `选片` 是高频筛片工作台，`深度复核` 是主要人工决策界面，`羽迹` 是长期物种资产与地理沉淀。 |
| 推理架构 | 正式维持 **hybrid ONNX + torch species v3**：YOLO / pose / IQA 走 ONNX Runtime，DINOv3 species v3 走 torch + transformers。 |
| 裁切原则 | 所有检测、姿态、IQA、物种相关裁切均基于 EXIF 转正后的原图，不允许基于缩略图或展示缩放图裁切。 |
| IQA 分工 | CLIPIQA+ 使用 2.5x 语义裁切；HyperIQA 使用基于原图 bbox 的紧主体技术裁切。 |
| 分数展示 | 模型分数仍按 `0-1` 处理，UI 统一展示为百分制并保留 1 位小数。 |
| 分档体系 | 四档固定为 `精选 / 可用 / 记录 / 淘汰`，阈值为 `75 / 60 / 45`。 |
| 人工优先 | 人工评估优先于系统评估；鸟种取数优先级为 `人工标注 -> 识别修正 -> 自动识别`。 |
| 组内共识 | 组内共识在 UI 中命名为 `识别修正`，不再作为分档标签展示，改为贴近鸟种名称展示。 |
| 羽迹统计 | 只统计 `精选 / 可用 / 记录` 照片，不统计 `淘汰 / 无鸟`。 |
| 发布状态 | 已完成 `0.3.0` 版本号更新、构建与 DMG 打包。 |

---

## 1. 版本与打包

### 1.1 版本号更新

已将应用版本更新为 `0.3.0`：

- `package.json`
- `package-lock.json`

验证结果：

```bash
node -p "require('./package.json').version"
# 0.3.0
```

### 1.2 构建与 DMG

已执行：

```bash
npm run typecheck
npm run build
npm run dist:mac
```

结果：

- TypeScript project references 检查通过。
- electron-vite renderer/main/preload 构建通过。
- PyInstaller 后端打包链路通过。
- Electron app 产物生成成功。
- DMG 产物生成成功。

当前产物：

```text
release/PlumeLens-0.3.0-arm64.dmg
release/mac-arm64/PlumeLens.app
```

大小：

```text
PlumeLens-0.3.0-arm64.dmg    1.6G
PlumeLens.app                2.4G
```

`Info.plist` 验证：

```text
CFBundleShortVersionString = 0.3.0
CFBundleVersion            = 0.3.0
```

当前 `release/` 下只保留了 `PlumeLens-0.3.0-arm64.dmg`，未发现旧 `0.2.0` DMG。

### 1.3 打包数据边界

`electron-builder.yml` 当前通过 `extraResources` 引入运行所需模型和后端资产：

- `dist/plumelens-engine`
- `engine/models`
- `engine/models/species`

需继续坚持的发布底线：

- 不把 `benchmark/results/*` 打入 DMG。
- 不把用户本地照片、测试数据库、历史 SQLite、缩略图缓存打入 DMG。
- 发布前以干净 `userData` 目录做一次安装后 smoke test。

本机运行时数据核查结果：

```text
~/.plumelens                               不存在
~/Library/Application Support/PlumeLens    存在运行时缓存/数据库
~/Library/Application Support/plumelens    存在运行时缓存/数据库
```

这些目录属于本机 Electron 运行时数据，不会进入 DMG；但如果要做“完全纯净安装测试”，仍应在测试前清掉这两个 Application Support 目录。

---

## 2. 选片界面

### 2.1 四档分级统一

用户明确要求不再区分“待选”等额外状态，选片主界面统一使用：

- 精选
- 可用
- 记录
- 淘汰
- 无鸟

默认展示：

- 精选
- 可用
- 记录

无鸟作为独立筛选项，不混入质量档位。

排序中已去除“最近操作”，保留更稳定的排序维度：

- 综合评分
- 拍摄时间
- 文件名

### 2.2 快捷键

选片界面新增快捷键：

- 选中照片后按 `Space` 进入深度复核。

实现要点：

- 使用 `focusedPhotoId` 记录当前选中 tile。
- `isPlainSpaceKey()` 过滤输入框、组合键、弹窗状态，避免误触。
- 仅在 `selection` 路由且没有复核/导出/对比弹窗时生效。

### 2.3 Tile 动作图标清理

用户指出 tile 上一排动作图标中部分动作已经没有意义。

调整方向：

- 去除与当前业务流重复或已失效的 hover 操作。
- 保留核心动作：进入复核、加入对比、必要的决策动作。
- 避免一张照片卡片上出现过多小按钮，减少视觉噪声。

### 2.4 分档标签样式

用户多轮反馈后，当前接受的 tile 分档标签样式为：

- 半透明浅色玻璃质感。
- 左侧色点、外框、文字三者使用同一档位色。
- 不再使用明显黑底色块。
- 更贴近 Nothing UI 的细线、轻透明、低装饰风格。

当前色彩规则：

| 档位 | 色彩方向 |
|---|---|
| 精选 | 绿色 |
| 可用 | 白色 / 浅灰 |
| 记录 | 黄色 |
| 淘汰 | 红色 |
| 无鸟 / 待分析 | 灰色 |

涉及样式：

- `renderer/src/app.css`
  - `.photo-preview__top .status-pill`
  - `.photo-preview__top .status-pill--success`
  - `.photo-preview__top .status-pill--neutral`
  - `.photo-preview__top .status-pill--warning`
  - `.photo-preview__top .status-pill--accent`
  - `.photo-preview__top .status-pill--muted`

---

## 3. 缩略图与自动刷新

用户多次反馈：

- 缩略图大量不加载。
- 分析完成后仍有极少量照片保持旧展示。
- 不能靠持续轮询草率兜底。

当前方案：

- 后端新增 library-scoped 事件总线。
- 缩略图 ready / batch / failed / complete 通过 SSE 通知前端。
- 场景分组完成也通过事件通知前端。
- 前端收到事件后 debounce 刷新 library detail 和 summary。
- 单个 tile 的 `ThumbnailImage` 仅做可见区域内的局部恢复，不作为主刷新机制。

涉及文件：

- `engine/services/event_bus.py`
- `engine/api/routes/library.py`
- `engine/services/thumbnail.py`
- `renderer/src/hooks/use-library.ts`
- `renderer/src/components/thumbnail-image.tsx`

当前仍需继续关注：

- 打包 App 安装后是否能稳定建立 SSE。
- 大批量照片分析完成瞬间，是否仍有最后一批 thumbnail 事件晚到。
- 前端 query invalidation 是否在所有路由都覆盖到。

---

## 4. 深度复核弹窗

### 4.1 布局原则

用户明确指出：

- 不允许为了塞进高度而改变图片比例。
- 弹窗应为界面的 90% 左右，而不是写死宽高。
- 原图与 2.5x 裁切图应左右分栏。
- 整体原则上不应出现纵向滚动条。

当前实现：

- 最外层容器使用 viewport 百分比和最小值约束。
- 原图、IQA 裁切图、右侧操作栏组成三栏布局。
- 图片保持原比例，不强行拉伸。
- 底部提供横向 filmstrip 缩略图轴。
- 右侧操作区使用四档按钮：精选、可用、记录、淘汰。

快捷键：

- `1` 精选
- `2` 可用
- `3` 记录
- `4` 淘汰
- `← / →` 切换照片
- `Esc` 关闭

### 4.2 Overlay 分工修正

最新用户要求：

> 调整一下对焦点和裁切框的展示位置，在原图上展示，不要再裁切图上展示，姿态点保持原样不变。

已调整为：

- 原图左侧展示：
  - 鸟类检测框 bbox
  - 对焦点 / 对焦区域
- 右侧 IQA 裁切图展示：
  - 姿态点
  - IQA 裁切区域本身
- 右侧裁切图不再叠加检测框和对焦点。

涉及文件：

- `renderer/src/App.tsx`
  - `ReviewModal`
  - `ReviewImageStage`

验证：

- `npm run typecheck` 通过。
- 生成过本地视觉检查截图：
  - `/tmp/plumelens-review-overlay-layering.png`

### 4.3 对焦点处理

当前实现状态：

- 后端通过 Pillow `Image.getexif()` 读取 EXIF。
- 支持读取 `GPSInfo`。
- 对 Canon MakerNote / AFInfo / AFInfo2 风格数据已有解析与前端展示基础。
- 前端支持点对焦与区域对焦 overlay 的不同形态。

仍需继续深化：

- Canon 不同机型 AFInfo2 字段存在差异，需要继续按官方文档与真实样张校准。
- Nikon / Sony MakerNote 尚未完整实现。
- 区域对焦的标准视觉形态仍需继续打磨，不应与单点对焦混淆。

---

## 5. IQA、裁切与分数

用户关键判断：

> HyperIQA 不适合裁切 2.5 倍放大的图，只适合裁切的原图。

当前管线：

```text
原片
  -> YOLO bbox
  -> bbox + padding 原图紧主体裁切
       -> pose / HyperIQA
  -> bbox 2.5x 原图语义裁切
       -> CLIPIQA+
  -> 综合分
```

当前分数逻辑：

- CLIPIQA+：偏语义、主体、构图、整体观感。
- HyperIQA：偏技术质量、清晰度、噪声、曝光等无参考质量。
- 模型输出按 `0-1` 处理。
- UI 展示为 `0-100`，保留 1 位小数。
- 综合分权重：
  - CLIPIQA+ `0.35`
  - HyperIQA `0.65`

当前四档：

| 分数 | 档位 |
|---|---|
| `>= 75` | 精选 |
| `60 - 75` | 可用 |
| `45 - 60` | 记录 |
| `< 45` | 淘汰 |

涉及文件：

- `engine/pipeline/quality.py`
- `engine/pipeline/manager.py`
- `engine/pipeline/grader.py`
- `renderer/src/App.tsx`

---

## 6. 组内识别修正

### 6.1 用户背景

用户指出：

- 根据拍摄时间间隔和照片相似度分组后，同组内单鸟图大概率是同一物种。
- 实测 `new1` 中同一组同一只鸟偶尔会被识别成相近鸟种，或个别照片显示“未识别物种”。
- 组内共识应作为对自动识别的修正层。

### 6.2 当前策略

UI 和羽迹取数优先级已经统一为：

```text
人工标注 -> 识别修正（组内共识） -> 自动识别结果
```

展示规则：

- `识别修正` 不再作为照片档位标签。
- `识别修正` 放在鸟种名称旁边，作为物种来源标记。
- 文案从“组内共识”改为“识别修正”。
- 分档标签只表达质量档位，不混入物种来源。

涉及文件：

- `renderer/src/App.tsx`
  - `effectiveSpeciesEntries()`
  - `displaySpeciesName()`
  - `displaySpeciesLatinName()`
  - `speciesSourceKind()`
  - `speciesSourceLabel()`
  - `speciesSourceDetail()`
- `renderer/src/i18n/locales/zh-CN.json`
  - `selection.speciesSource.groupConsensus = 识别修正`

### 6.3 当前仍需验证

用户在重新安装 DMG 后仍观察到 `new1` 个别分组看似未生效。

需继续重点核查：

1. packaged app 是否使用了最新前端 bundle。
2. 新旧 pipeline_version 是否导致旧结果仍 active。
3. scene group 的 `group_species` / `group_species_latin` 是否确实写入后端 detail。
4. 前端 `buildFragmentFromDetail()` 是否完整映射 group consensus 字段。
5. 羽迹是否按照 `人工 -> 识别修正 -> 自动` 聚合。

---

## 7. 羽迹

### 7.1 物种墙

用户要求：

- 鸟种界面应像游戏成就卡片。
- 已拍到即点亮。
- 可按保护等级或珍稀等级分组。
- 卡片要有鸟照片，并保持统一风格。
- 物种介绍使用中文。

当前实现：

- 物种总数：`1535`
  - 中国观鸟年报 v12 主名录：`1516`
  - 模型清单额外 19 种：归组为 `国外观赏种`
- 物种筛选：
  - 全部
  - 已点亮
  - 未点亮
- 分组：
  - 国家一级保护
  - 国家二级保护
  - 受胁或近危
  - 常规物种
  - 国外观赏种
- 顶部统计已同步增加：
  - 已点亮
  - 图鉴总数
  - 国家一级保护
  - 国家二级保护
  - 受胁或近危
  - 常规物种
  - 国外观赏种
- `收集进度` 被移除，避免和已点亮/总数重复。

### 7.2 物种卡片视觉

当前方向：

- 物种照片作为整张卡片背景。
- 从上到下渐隐，保证文字可读。
- 不额外叠两层背景容器。
- 横图 / 竖图根据纵横比使用不同的定位和尺寸策略。
- 未点亮卡片降低亮度和饱和度，保留可识别轮廓。

用户此前指出“鸟图被裁切、鸟头露不出来”，因此当前重点是：

- 尽量保留鸟体完整信息。
- 纵向鸟图优先保证高度完整。
- 横向鸟图优先避免上下空白过大。

### 7.3 右侧鸟志详情

当前方向：

- 右侧鸟志不再单独放一个图片容器。
- 直接将同一张鸟图作为整张详情面板背景。
- 背景从上到下渐隐到底色。
- 文案置于背景渐隐后的可读区域。
- 兼容横向照片和纵向照片。

### 7.4 物种百科与图片源

当前物种资料源：

- 主名录：`resources/species/中国观鸟年报-中国鸟类名录_v12.0.xls`
- 名称对照：`resources/species/中国鸟类名称对照表.xlsx`
- 模型训练清单：`resources/species/species_list_1301.csv`
- 前端包内资料：`renderer/src/lib/species-wiki.json`

已完成：

- 修复物种重复。
- 物种介绍优先中文维基。
- 图片尽量使用 Wikimedia Commons 摄影图。
- 过滤手绘、版画、标本、分布图、SVG 等非摄影封面。

涉及文件：

- `scripts/fetch_species_wiki.py`
- `scripts/build_species_wiki_json.py`
- `engine/models/species_wiki.parquet`
- `renderer/src/lib/species-wiki.json`
- `renderer/src/lib/species-wiki.ts`

### 7.5 物种照片浏览

用户要求：

- 选中鸟种后，在右侧点击照片数数字，通过弹窗浏览自己拍摄的照片。

当前实现：

- 支持从物种详情侧栏打开该物种照片浏览弹窗。
- 支持大图预览和缩略图切换。
- 该入口使用羽迹统计口径：
  - 只统计精选 / 可用 / 记录。
  - 物种优先级为人工标注 -> 识别修正 -> 自动识别。

---

## 8. 地理分布

### 8.1 GPS 读取

当前后端扫描阶段读取 EXIF：

- `Image.getexif()`
- `ExifTags.IFD.GPSInfo`
- 保留 `GPSLatitude / GPSLatitudeRef / GPSLongitude / GPSLongitudeRef` 等字段。

前端转换：

- 支持 rational / tuple 等常见 EXIF GPS 值。
- 转换为十进制度。
- 落在中国范围内时投影到简化中国地图。

### 8.2 当前展示规则

用户指出：

> 没有 GIS 信息就不展示。

当前规则：

- 没有 GPS 的照片不会生成地图定位点。
- 无 GPS / 坐标越界照片只计入下方提示，不在地图上伪造点。
- 地图右侧列表只显示有定位点的物种照片。

### 8.3 手动地理标注方案

用户提出可接受的方案：

- 搜索下拉框。
- A-Z 排序。
- 可选城市或区县。
- 最细到区县，例如 `长沙市 - 雨花区`。

当前尚未实现。建议后续设计：

- 新增行政区划静态数据表。
- 手动地点字段独立于 EXIF GPS：
  - `manual_location_code`
  - `manual_location_name`
  - `manual_location_level`
  - `manual_lat`
  - `manual_lon`
- 地图取数优先级：
  - 手动地点 -> EXIF GPS。
- UI 入口：
  - 深度复核右侧信息栏。
  - 羽迹地图未定位照片列表。
  - 批量对同一场景组设置地点。

---

## 9. 人工鸟种标注

用户要求：

- 支持手动修改照片中鸟的鸟种。
- 兼容多鸟。

当前实现：

- 深度复核中提供物种编辑器。
- 按检测到的鸟个体切换。
- 支持搜索物种库。
- 支持设置 / 清除手动物种。
- 手动物种在羽迹统计中优先级最高。

当前仍需关注：

- 后端持久化与前端 optimistic update 的一致性。
- 多鸟图中每个 detection 的手动物种是否都能完整回放到 UI。
- 羽迹聚合是否不会重复计算同一张照片中的多个同物种个体。

---

## 10. 导出

用户要求：

- 导出界面支持手动调整范围。

当前实现方向：

- 导出抽屉保留导出范围提示。
- 增加四档 checkbox。
- 增加分数最小值 / 最大值输入。
- 根据当前筛选实时计算可导出数量。

仍需后续补齐：

- 真正执行文件复制 / sidecar 报告导出。
- 导出目录冲突处理。
- 导出报告格式确认。

---

## 11. Nothing UI 与动态效果

用户要求：

- 全面检查各页面 UI 样式。
- 基于 Nothing UI 规范优化。
- 引入动画，提高动态效果。

当前调整方向：

- 细线边框、低饱和深色背景、网格纹理、数据字体。
- 避免厚重黑色块。
- 使用半透明玻璃感组件表达状态。
- 卡片 hover / focus 增加轻微位移、边框亮度、图片亮度变化。
- 羽迹卡片与详情面板使用图片背景 + 渐隐。
- 选片 tile 的状态标签回归轻质、边框化表达。

需要继续控制：

- 动效不能影响长时间筛片效率。
- 卡片、弹窗、按钮的 hover 动画应保持短促。
- 不要把工作台做成营销页，不做大 hero、渐变球、装饰性卡片堆叠。

---

## 12. 当前验证

已执行并通过：

```bash
npm run typecheck
npm run build
npm run dist:mac
```

已核查：

- `package.json` version 为 `0.3.0`。
- `release/mac-arm64/PlumeLens.app/Contents/Info.plist` version 为 `0.3.0`。
- `release/PlumeLens-0.3.0-arm64.dmg` 存在。
- `release/` 下未发现旧版本 DMG。

尚未在本日志阶段重新跑全量测试：

- `npm run lint`
- `npm test`
- `npm run test:e2e`
- 后端 `uv run pytest`
- 安装 DMG 后的真实导入/分析/复核/羽迹全链路 smoke test

---

## 13. 当前风险与下一步

### P0 风险

1. **组内识别修正仍需 packaged app 真实复核**
   - 用户在 `new1` 中观察到个别组仍似乎未应用修正。
   - 需要从 DB active result、library detail API、前端 adapter 三层确认。

2. **本机 Application Support 仍有运行时数据**
   - 不会进入 DMG，但会影响本机重复测试。
   - 纯净测试前应清理：
     - `~/Library/Application Support/PlumeLens`
     - `~/Library/Application Support/plumelens`

3. **AF 对焦点官方适配仍未完结**
   - Canon 区域对焦可继续校准。
   - Nikon / Sony 暂未完整覆盖。

4. **App.tsx 体积过大**
   - 选片、复核、羽迹、地图、导出、物种编辑均在同一文件中。
   - 后续维护风险明显，应拆分。

### P1 建议

1. 打包安装 `0.3.0`，用空 userData 重新导入 `new / new1 / new2`。
2. 对 `new1` 场景 #40 逐层检查识别修正是否写入、传输、展示、计入羽迹。
3. 增加手动地理位置标注。
4. 为深度复核增加更多 viewport 视觉回归：13 寸、16 寸、外接宽屏、横图、竖图。
5. 拆分 `renderer/src/App.tsx`。

---

## 14. 项目目录整理

用户要求全面整理项目目录，并同步更新开发日志与交接文档。

### 已完成

- 新增目录说明文档：
  - `docs/PROJECT_STRUCTURE.md`
- 新增物种资料源目录：
  - `resources/species/`
- 将根目录散落的物种源资料移动到 `resources/species/`：
  - `resources/species/species_list_1301.csv`
  - `resources/species/中国观鸟年报-中国鸟类名录_v12.0.xls`
  - `resources/species/中国鸟类名称对照表.xlsx`
- 为物种资料源补充说明：
  - `resources/species/README.md`
- 清理无意义本地缓存：
  - `.DS_Store`
  - Python `__pycache__`
- 删除空的 `engine/build` 与 `engine/dist` 目录。
- 保留当前发布产物：
  - `release/PlumeLens-0.3.0-arm64.dmg`

### 当前目录边界

| 目录 | 定位 |
|---|---|
| `electron/` | Electron 主进程与后端子进程管理 |
| `renderer/` | React 前端 |
| `engine/` | FastAPI 后端、推理管线、模型 |
| `scripts/` | 打包、签名、物种资料、benchmark 工具 |
| `tests/` | 后端、前端、E2E 测试 |
| `docs/` | 技术文档、交接文档、开发日志、目录说明 |
| `resources/species/` | 上游物种资料源 |
| `evals/` | 评测脚本与评测集占位 |
| `archive/` | 历史路线归档 |
| `build/` | 图标/entitlements 与可再生成中间产物 |
| `dist/` / `out/` / `release/` | 构建和发布产物，不入 git |

### 未移动的内容

- `release/`：保留 0.3.0 DMG，便于用户手动安装。
- `dist/` / `out/` / `build/plumelens-engine`：均为可再生成产物，当前只记录边界，不在本次删除。
- `.venv/` / `node_modules/`：开发依赖目录，保持原样。

### 后续建议

1. 拆分 `renderer/src/App.tsx`，当前 UI 主文件仍过大。
2. 将 `renderer/src/lib/mock-workspace.ts` 中的领域类型拆出到单独文件。
3. 为 `resources/species/` 建立从 Excel / CSV 到 parquet 的明确生成脚本。
4. 在打包流程中加入发布产物内容检查，自动防止测试数据进入 DMG。
