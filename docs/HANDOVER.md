# PlumeLens / 鉴翎 — 项目交接文档

> 当前交接时间：2026-04-29 16:10 CST  
> 当前应用版本：`0.3.0`  
> 当前打包产物：`release/PlumeLens-0.3.0-arm64.dmg`  
> 当前状态：推理主线、选片主线、深度复核、羽迹物种墙、地理分布雏形、组内识别修正、0.3.0 打包均已进入可继续测试状态。

---

## 1. 项目定位

**PlumeLens / 鉴翎** 是面向鸟类摄影爱好者的本地桌面应用，目标是帮助用户在一次外拍后的数百至数千张照片中，快速完成：

- 鸟类检测
- 姿态与可见性判断
- 鸟种识别
- 画质评分
- 分档筛选
- 人工深度复核
- 鸟种收集与地理沉淀

产品顶层路由：

- `开始`
- `选片`
- `羽迹`

核心原则：

- 以文件夹作为工作集。
- 用户照片目录只读，不写回源目录。
- 所有分析数据、数据库、缩略图、缓存写入应用数据目录。
- 推理全本地运行。
- UI 主语言为中文。

---

## 2. 当前版本与产物

版本号：

```text
0.3.0
```

已更新文件：

- `package.json`
- `package-lock.json`

当前发布产物：

```text
release/PlumeLens-0.3.0-arm64.dmg
release/mac-arm64/PlumeLens.app
```

验证结果：

```text
CFBundleShortVersionString = 0.3.0
CFBundleVersion            = 0.3.0
```

产物大小：

```text
DMG: 1.6G
App: 2.4G
```

当前 `release/` 下未发现旧版 `0.2.0` DMG。

---

## 3. 架构总览

```text
Electron Renderer (React)
  -> preload window.plumelens
  -> Electron Main
  -> local FastAPI backend over HTTP / SSE
  -> SQLite WAL
  -> hybrid inference pipeline
       - ONNX Runtime: YOLO / pose / CLIPIQA+ / HyperIQA
       - torch + transformers: DINOv3 species v3
```

技术栈：

- Electron 35
- React 19
- TypeScript
- Tailwind CSS v4
- shadcn/ui
- i18next
- FastAPI
- SQLite WAL
- ONNX Runtime
- PyTorch / transformers
- PyInstaller
- electron-builder

关键约束：

- Electron sandbox / context isolation 保持开启。
- 后端只绑定本机。
- `PLUMELENS_DATA_DIR` 在 Electron 运行时注入为 `app.getPath('userData')`。
- `plumelens://thumb` 协议与缩略图目录同根。
- 推理唯一出口是 `engine/pipeline/`。

---

## 4. 项目目录

完整目录说明见 [`PROJECT_STRUCTURE.md`](./PROJECT_STRUCTURE.md)。

当前顶层目录边界：

| 路径 | 用途 |
|---|---|
| `electron/` | Electron 主进程、preload、Python 后端子进程管理 |
| `renderer/` | React 前端 |
| `engine/` | FastAPI 后端、SQLite、推理管线、模型 |
| `scripts/` | 打包、签名、DMG、物种资料、benchmark 脚本 |
| `tests/` | pytest / vitest / Playwright 测试 |
| `docs/` | 技术方案、产品方案、交接文档、开发日志、目录说明 |
| `resources/species/` | 中国鸟类名录、名称对照表、1301 模型物种清单等上游资料源 |
| `evals/` | 评测脚本与评测集占位 |
| `archive/` | 历史路线归档，仅作参考 |
| `build/` | 图标/entitlements + 可再生成 PyInstaller 中间产物 |
| `dist/` / `out/` / `release/` | 构建与发布产物，忽略不入 git |

本轮已将根目录散落的物种源文件移动到 `resources/species/`，并补充 `resources/species/README.md`。

---

## 5. 数据目录与清理

standalone 默认数据目录：

```text
~/.plumelens
```

Electron 运行时数据目录：

```text
~/Library/Application Support/PlumeLens
```

当前本机核查：

```text
~/.plumelens                               不存在
~/Library/Application Support/PlumeLens    存在
~/Library/Application Support/plumelens    存在
```

这两个 Application Support 目录包含 Electron 运行时缓存、SQLite 数据库、缩略图等本机测试数据，不会被打包进 DMG。

如果要做完全干净的安装测试，需要先清理：

```bash
rm -rf "$HOME/Library/Application Support/PlumeLens"
rm -rf "$HOME/Library/Application Support/plumelens"
```

注意：这是破坏性操作，只应在明确要清空本机测试数据时执行。

---

## 6. 推理管线

当前正式架构为 **hybrid ONNX + torch species v3**。

```text
原片
  -> EXIF 转正
  -> letterbox1280
  -> YOLOv26l-bird-det
  -> bbox 列表
  -> 每个 bbox 均基于原图裁切
       -> bbox + padding 紧主体裁切
            -> bird_visibility
            -> HyperIQA
       -> bbox 2.5x 语义裁切
            -> CLIPIQA+
       -> head + eye 可见时
            -> DINOv3 species v3 torch ensemble
  -> 选最高综合分的鸟作为照片代表结果
```

模型分工：

| 模型 | 用途 | 运行时 |
|---|---|---|
| YOLOv26l-bird-det | 鸟类检测 | ONNX Runtime |
| bird_visibility | 头/眼可见性与 5 关键点 | ONNX Runtime |
| CLIPIQA+ | 语义画质、主体与构图观感 | ONNX Runtime |
| HyperIQA | 技术画质、清晰度、噪声、曝光 | ONNX Runtime |
| DINOv3 species v3 | 鸟种识别 | torch + transformers |

裁切原则：

- 所有裁切基于原图。
- CLIPIQA+ 使用 2.5x 语义裁切。
- HyperIQA 使用 bbox + padding 的紧主体裁切。
- 不允许基于缩略图、展示缩放图、前端 CSS 尺寸反推裁切。

评分：

- 模型输出按 `0-1` 浮点处理。
- UI 展示为百分制，保留 1 位小数。
- 综合分权重当前为：
  - CLIPIQA+ `0.35`
  - HyperIQA `0.65`

分档：

| 综合分 | 档位 |
|---|---|
| `>= 75` | 精选 |
| `60 - 75` | 可用 |
| `45 - 60` | 记录 |
| `< 45` | 淘汰 |

---

## 7. 数据与业务优先级

### 7.1 质量档位

应用只使用四个质量档位：

- 精选
- 可用
- 记录
- 淘汰

`无鸟` 是独立筛选状态，不是质量档位。

人工决策优先级：

```text
人工评估 -> 自动评估
```

如果用户人工设置了档位，所有 UI、统计、导出应以人工档位为准。

### 7.2 鸟种来源

鸟种取数优先级：

```text
人工标注 -> 识别修正（组内共识） -> 自动识别
```

展示规则：

- `识别修正` 不作为照片质量标签。
- `识别修正` 放在鸟种名称旁边。
- 羽迹统计必须使用同一优先级。

### 7.3 羽迹统计口径

羽迹只统计：

- 精选
- 可用
- 记录

不统计：

- 淘汰
- 无鸟

---

## 8. 选片页面状态

主要能力：

- 文件夹工作集列表。
- 进度与统计。
- 四档筛选 + 无鸟筛选。
- 分组视图 / 平铺视图。
- 综合评分、拍摄时间、文件名排序。
- 进入深度复核。
- 对比队列。
- 导出入口。

当前默认筛选：

- 精选
- 可用
- 记录

快捷键：

- 选中照片后按 `Space` 进入深度复核。

Tile 样式：

- 分档标签为半透明玻璃质感。
- 色点、文字、外框同色。
- 精选绿色、可用白色、记录黄色、淘汰红色。
- `识别修正` 在鸟种名旁边显示，不和分档标签混用。

相关文件：

- `renderer/src/App.tsx`
- `renderer/src/app.css`
- `renderer/src/components/thumbnail-image.tsx`
- `renderer/src/hooks/use-library.ts`
- `renderer/src/lib/backend-adapter.ts`

---

## 9. 深度复核页面状态

深度复核是用户主要工作界面。

当前布局：

- 弹窗尺寸基于 viewport 百分比，约 90%。
- 原图与 IQA 裁切图左右分栏。
- 右侧为信息与操作栏。
- 底部为横向缩略图 filmstrip。
- 不应为了适配高度改变图片比例。

快捷键：

- `1` 精选
- `2` 可用
- `3` 记录
- `4` 淘汰
- `← / →` 切换照片
- `Esc` 关闭

Overlay 分工：

- 原图展示：
  - 鸟类检测框
  - 对焦点 / 对焦区域
- IQA 裁切图展示：
  - 姿态点
  - 裁切预览
- 姿态点保持在裁切图上。

当前仍需关注：

- 区域对焦的标准样式还可继续对齐相机官方逻辑。
- 13 寸、16 寸、外接宽屏、横图、竖图都应继续做视觉回归。

相关文件：

- `renderer/src/App.tsx`
- `renderer/src/app.css`
- `engine/services/scanner.py`

---

## 10. 缩略图刷新方案

用户明确不接受草率轮询。

当前方案：

- 后端通过 `event_bus` 发布 library 级事件。
- 前端通过 SSE 订阅。
- 缩略图 ready / batch / failed / complete 会触发前端刷新。
- 场景分组完成也触发刷新。
- 单 tile 局部 retry 只作为局部恢复能力，不是主刷新机制。

相关文件：

- `engine/services/event_bus.py`
- `engine/api/routes/library.py`
- `engine/services/thumbnail.py`
- `renderer/src/hooks/use-library.ts`
- `renderer/src/components/thumbnail-image.tsx`

后续建议：

- packaged app 中用 1000+ 张照片复测 SSE 稳定性。
- 在分析完成事件后确认最后一批 thumbnail ready 不会丢。

---

## 11. 组内识别修正

业务假设：

- 同一场景组内的单鸟图大概率是同一物种。
- 自动识别偶尔会把同一只鸟识别成近似物种，或个别照片未识别。
- 因此组内应存在一个“识别修正”层。

当前 UI 规则：

- 自动识别保留。
- 组内共识命名为 `识别修正`。
- 人工标注仍高于识别修正。
- 识别修正不改变质量分档。

当前仍需重点排查：

- 用户在 `new1` 场景中仍观察到组内修正似乎未完全生效。
- 需要从后端写库、API detail、前端 adapter、UI 展示四层逐项验证。

排查入口：

- `engine/pipeline/scene_grouping.py`
- `engine/services/scene_grouper.py`
- `renderer/src/lib/backend-adapter.ts`
- `renderer/src/App.tsx`

---

## 12. 羽迹页面状态

羽迹包含两个子视图：

- 物种
- 地理分布

### 12.1 物种图鉴

当前总数：

```text
1535
```

来源：

- 中国观鸟年报 v12：1516 种。
- 模型 1301 清单中不在 v12 的 19 种：归为 `国外观赏种`。

分组：

- 国家一级保护
- 国家二级保护
- 受胁或近危
- 常规物种
- 国外观赏种

筛选：

- 全部
- 已点亮
- 未点亮

顶部统计：

- 已点亮
- 图鉴总数
- 国家一级保护
- 国家二级保护
- 受胁或近危
- 常规物种
- 国外观赏种

已移除：

- 收集进度

### 12.2 视觉设计

当前方向：

- 物种照片作为整张卡片背景。
- 从上到下渐隐。
- 未点亮卡片低亮度 / 低饱和。
- 已点亮卡片更明亮并带细边框。
- 横图 / 竖图根据纵横比做不同适配。

右侧鸟志：

- 使用同一张鸟图作为整个详情面板背景。
- 不额外单独放图片容器。
- 从上到下渐隐到底色。
- 中文简介优先。

### 12.3 物种资料

主要文件：

- `resources/species/中国观鸟年报-中国鸟类名录_v12.0.xls`
- `resources/species/中国鸟类名称对照表.xlsx`
- `resources/species/species_list_1301.csv`
- `engine/models/species/canonical_extended.parquet`
- `engine/models/species/species_list_1301.parquet`
- `engine/models/species_wiki.parquet`
- `renderer/src/lib/species-wiki.json`

脚本：

- `scripts/fetch_species_wiki.py`
- `scripts/build_species_wiki_json.py`

当前图片策略：

- 优先 Wikimedia Commons 摄影图。
- 过滤 SVG、手绘、版画、标本、分布图、邮票等非摄影封面。

---

## 13. 地理分布

当前实现：

- 后端扫描 EXIF `GPSInfo`。
- 前端解析 GPS 经纬度。
- 投影到简化中国地图。
- 有 GPS 且在中国范围内才展示定位点。
- 没有 GIS 信息不展示定位点。

当前限制：

- 不是精确 GIS 地图，目前是简化中国区域轮廓。
- 没有手动地点标注。
- 无 GPS 照片只进入未定位计数。

后续建议实现手动地理标注：

- 使用带搜索的下拉框。
- A-Z 排序。
- 支持城市 / 区县。
- 最细到区县，例如 `长沙市 - 雨花区`。
- 同一场景组可批量设置地点。

建议数据字段：

- `manual_location_code`
- `manual_location_name`
- `manual_location_level`
- `manual_lat`
- `manual_lon`

地图取数优先级：

```text
手动地点 -> EXIF GPS
```

---

## 14. 手动物种标注

当前支持方向：

- 深度复核内修改鸟种。
- 支持多鸟检测结果。
- 每个 detection 可独立设置 / 清除手动物种。
- 手动物种用于羽迹统计和展示。

仍需继续验证：

- 后端持久化是否覆盖所有多鸟情况。
- UI optimistic update 与后端回包是否一致。
- 羽迹是否避免同一张照片同物种重复计数。

---

## 15. 导出

当前导出界面已支持用户手动调整范围：

- 四档 checkbox。
- 分数最小值。
- 分数最大值。
- 可导出数量预览。

仍需补齐：

- 真正执行导出文件复制。
- 目录命名与冲突策略。
- 报告文件格式。
- 导出后打开 Finder。

---

## 16. 关键代码地图

### Electron

| 文件 | 作用 |
|---|---|
| `electron/main.ts` | BrowserWindow、安全配置、协议注册、userData 路径 |
| `electron/preload.ts` | 渲染进程最小 API 暴露 |
| `electron/process-manager.ts` | Python 后端子进程启动、端口握手、模型目录注入 |

### 后端

| 文件 | 作用 |
|---|---|
| `engine/main.py` | FastAPI app |
| `engine/core/database.py` | SQLite WAL 与 schema |
| `engine/core/config.py` | 配置与模型路径 |
| `engine/pipeline/manager.py` | 推理管线编排 |
| `engine/pipeline/quality.py` | CLIPIQA+ / HyperIQA |
| `engine/pipeline/species.py` | DINOv3 species v3 |
| `engine/pipeline/pose.py` | 姿态与可见性 |
| `engine/pipeline/grader.py` | 分数到四档 |
| `engine/pipeline/scene_grouping.py` | 场景分组 / 组内修正相关逻辑 |
| `engine/services/scanner.py` | 扫描照片、EXIF / GPS / AF 元数据 |
| `engine/services/thumbnail.py` | 缩略图生成 |
| `engine/services/event_bus.py` | SSE 事件总线 |
| `engine/services/scene_grouper.py` | 分组服务 |
| `engine/services/decisions.py` | 人工决策 |

### 前端

| 文件 | 作用 |
|---|---|
| `renderer/src/App.tsx` | 当前主要 UI，包含选片、复核、羽迹、导出等 |
| `renderer/src/app.css` | Nothing 风格视觉与动画样式 |
| `renderer/src/hooks/use-library.ts` | library 查询与 SSE 刷新 |
| `renderer/src/hooks/use-decisions.ts` | 人工决策 mutation |
| `renderer/src/hooks/use-analysis.ts` | 分析任务 |
| `renderer/src/lib/backend-adapter.ts` | 后端数据到前端领域模型映射 |
| `renderer/src/lib/species-wiki.ts` | 物种资料类型与加载 |
| `renderer/src/lib/species-wiki.json` | 前端包内 1535 种物种资料 |
| `renderer/src/components/thumbnail-image.tsx` | 缩略图展示与局部恢复 |
| `renderer/src/i18n/locales/zh-CN.json` | 中文文案 |
| `renderer/src/i18n/locales/en.json` | 英文文案 |

### 脚本与打包

| 文件 | 作用 |
|---|---|
| `scripts/build-engine.cjs` | 打包前构建 PyInstaller 后端 |
| `scripts/plumelens-engine.spec` | PyInstaller spec |
| `scripts/build-dmg.cjs` | 自定义 DMG 构建 |
| `scripts/fetch_species_wiki.py` | 抓取 / 修复物种百科与图片 |
| `scripts/build_species_wiki_json.py` | 生成前端物种 JSON |
| `electron-builder.yml` | electron-builder 配置 |

---

## 17. 常用命令

前端开发：

```bash
npm start
```

类型检查：

```bash
npm run typecheck
```

构建：

```bash
npm run build
```

打包 macOS arm64：

```bash
npm run dist:mac
```

前端测试：

```bash
npm test
npm run test:e2e
```

Lint：

```bash
npm run lint
```

后端测试：

```bash
uv run pytest tests/engine
```

物种资料生成：

```bash
uv run python scripts/build_species_wiki_json.py
```

---

## 18. 当前验证状态

最近已通过：

```bash
npm run typecheck
npm run build
npm run dist:mac
```

当前未在最后一轮重新跑全量：

- `npm run lint`
- `npm test`
- `npm run test:e2e`
- `uv run pytest tests/engine`

建议下一轮在安装 DMG 后执行真实 smoke：

1. 清空 Application Support 运行时数据。
2. 安装 `release/PlumeLens-0.3.0-arm64.dmg`。
3. 导入 `new / new1 / new2`。
4. 等待分析全部完成。
5. 检查缩略图是否全部刷新。
6. 检查 `new1` 场景 #40 是否应用识别修正。
7. 检查深度复核 overlay：
   - bbox / AF 在原图。
   - 姿态点在裁切图。
8. 检查羽迹统计：
   - 只统计精选 / 可用 / 记录。
   - 鸟种优先级为人工 -> 识别修正 -> 自动。
9. 检查地理分布：
   - 无 GPS 不显示定位点。
   - 有 GPS 的照片正确映射。

---

## 19. 当前主要风险

### P0

1. **组内识别修正 packaged app 仍需确认**
   - 用户已反馈重新安装 DMG 后似乎仍未完全生效。
   - 必须用实际 DB/API/UI 三层核查。

2. **本机旧运行时数据可能影响测试**
   - 当前 Application Support 下仍有缓存/DB。
   - 纯净测试前需要删除。

3. **AF 对焦点解析仍需官方逻辑校准**
   - Canon 区域对焦、点对焦、多点合焦需要继续对样张验证。
   - 非 Canon 机型尚未完整支持。

4. **App.tsx 过大**
   - 继续堆功能会显著增加维护风险。

### P1

1. 手动地理位置标注尚未实现。
2. 导出还缺真正的文件复制与报告生成。
3. 羽迹地图仍是简化中国地图，不是完整 GIS。
4. 物种图片仍是启发式过滤，不是人工审核级别。

---

## 20. 建议下一步

1. 先做 `0.3.0` 干净安装 smoke test。
2. 立即核查 `new1` 组内识别修正链路。
3. 增加一个后端/前端测试，锁住 `人工 -> 识别修正 -> 自动` 优先级。
4. 完成手动地理位置标注。
5. 拆分 `renderer/src/App.tsx`：
   - `pages/SelectionPage.tsx`
   - `pages/ArchivePage.tsx`
   - `components/review/ReviewModal.tsx`
   - `components/archive/SpeciesCard.tsx`
   - `components/archive/ArchiveMap.tsx`
   - `components/export/ExportDrawer.tsx`
6. 为深度复核和选片 tile 增加视觉回归截图。

---

## 21. 交接注意事项

- 当前 worktree 很脏，包含大量连续开发修改，不要随意 reset 或 checkout。
- 不要把用户照片目录作为输出目录。
- 不要把本机测试数据打进 DMG。
- 不要恢复旧 ONNX species 路线，species v3 现在是 torch/transformers。
- 不要再用粗暴轮询作为缩略图主刷新方案。
- 不要让 `识别修正` 和质量分档混在同一个标签体系中。
- 不要在图片容器里强行改变照片比例。
- 不要在羽迹统计中纳入淘汰或无鸟照片。
