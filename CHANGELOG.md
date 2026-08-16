# Changelog

所有值得用户或维护者感知的版本变化记录在这里。更细的内部交接与完整提交台账见 `docs/releases/`。

## 0.7.6

范围：`v0.7.5..HEAD`。导出流程修复与增强版本，另修一处缩略图缓存泄漏。

### 版本定位

0.7.6 起因是真实使用中的导出失败：964 张 / 80 GB 的导出在界面上反复报「导出失败」，而后台其实一直在复制文件。根因是导出被塞在单个 HTTP 请求里完成，所以这一版把导出改成可观测、可取消的后台任务，并补上用户实际需要的格式筛选与文件夹移除。

### 导出不再假失败

- 导出改为后台任务：`POST /export/library/{id}` 只做预检并立即返回 `job_id`，进度经 `GET /export/jobs/{id}/events`（SSE）推送，面板显示已处理张数、已复制体积与当前文件名。
- 此前导出在单个 HTTP 请求内跑完，实测 964 张 / 80 GB 需约两小时，前端 60 秒超时后 UI 报「导出失败」，后端复制循环却感知不到客户端断开，会一直跑到底；用户重试又叠加一个并发导出抢同一个卷的 IO，表现为反复失败。
- 新增「取消导出」。取消检查点落在照片之间（`shutil.copy2` 不可中断），因此取消后不会留下大小不对的半截文件，已完成的文件保留在输出目录。
- 同一图库并发导出返回 409，杜绝重试叠加。
- 应用关停时先置取消位再等线程池收干。此前非 daemon 的复制线程会堵死 `thread_pool.shutdown(wait=True)`，让 SIGTERM 失效、只能被 SIGKILL——那才是半截文件的真正来源。
- 导出全链路补 structlog：启动、完成、失败、取消都会落日志。此前导出失败在日志里查不到任何记录。

### 导出可选照片格式

- 新增 `GET /export/library/{id}/formats`，按扩展名聚合库内张数与体积（含同伴文件），按体积降序展示，直接告诉用户哪种格式最占地方。
- 导出面板按源文件夹里**实际存在**的格式展示多选。主文件与同伴各自判定：只勾 CR3 时 JPG 主文件跳过而配套 RAW 照导，只勾 JPG 则反过来。
- 这解决了此前 `include_companions` 硬编码为 `true` 导致的问题：只想导 25 GB 的 JPG 会被强制搭上 56 GB 的 CR3，预检算出需 84.85 GB 而磁盘可用 83.22 GB，直接判定空间不足。
- 「仅 XMP sidecar」模式不复制照片文件，格式选择不参与筛选。

### 导出报错可读

- 后端错误改为结构化 `{code, message, ...}`，前端按 code 走 i18next 渲染中文；空间不足会说明「约需 X，可用 Y，还差 Z」并提示可关闭 RAW 或收窄分数区间。
- 修复错误提示被裁成半句的问题：`.export-sidecar p` 给顶部长路径做单行省略的规则（`max-width:300px` + `nowrap` + `overflow:hidden`）命中了面板里每一个 `<p>`，用户只看得到 `400 Bad Request: {"detail":"Export` 就没了。单行省略已收窄到路径专用选择器。

### 工作集文件夹可移除

- 文件夹右键菜单新增「移除文件夹」，接确认弹窗，明确说明只清理应用内记录，源文件夹与照片原文件不动。
- 修复 `DELETE /library/{id}` 的缩略图泄漏：此前只删数据库行，`derived/thumbnails/` 下的 grid/preview 文件在 CASCADE 之后失去全部引用、永久残留（实测单机已积累 3.2 GB）。现在删行前先取 photo_id，删完清理对应文件并记入日志。

## 0.7.5

范围：`v0.7.0..HEAD` 的 post-release 技术债清理，并同步应用版本号到 0.7.5。

### 版本定位

0.7.5 是 0.7.0 发布后的全栈技术债清理版本。目标是全面清理前端、服务端、测试、文档在之前快速开发过程中遗留的结构债，确保架构稳定、代码整洁、质量闸门可信。

### 前端结构清理

- `App.tsx` 拆分继续推进，从 7000+ 行降到约 990 行，Start / Selection / Archive / Export / Review 等子树、workspace projection 纯函数、thumbnail repair queue 与 library workspace sync 已迁出根组件。
- 历史 `mock-workspace.ts` 已拆为 `workspace-types.ts`、`workspace-projection.ts` 与 `workspace-fixtures.ts`，生产代码和测试不再从 mock 命名模块导入领域类型。
- `SettingsModal`、`ExportDrawer`、`ReviewModal`、`ArchiveScreen`、`SelectionScreen` 改为 lazy loading，起始屏首包减负。
- `ReviewImageStage` 与 `SpeciesOverrideEditor` 拆出独立文件，消除 review-modal 反向 import App 的旧依赖。
- `SelectionScreen` 的滚动状态、紧凑头部、更多菜单和回顶按钮抽为 `useSelectionScrollState`。
- 选片网格与羽迹物种墙共用 `lib/virtual-grid.ts`，补齐空容器恢复、ResizeObserver rAF throttle 和单元测试。
- 羽迹物种墙修复滚动到底部后卡片图片消失、只剩黑色占位的问题；搜索/筛选仍会回到顶部，普通数据刷新不再误重置滚动。
- 公用展示逻辑迁出到 `components/common/*` 与 `lib/photo-display.ts`、`lib/photo-helpers.ts`、`lib/photo-grid-helpers.ts`、`lib/archive-collection.ts`、`lib/species-source.ts`。
- 新增 renderer logger 与 ErrorBoundary，收口散落日志和页面级错误恢复。
- 移除未使用依赖 `class-variance-authority`。

### 羽迹离线资源

- 羽迹物种封面图改为随包 WebP 资源，1591 个物种全部通过 `plumelens://species-artwork/<canonical>` 本地协议加载，渲染器不再依赖 `image_url` 或远程 Wikimedia 图片。
- 新增 `scripts/download_species_artwork.py`、`scripts/optimize_species_artwork.py` 与 `scripts/generate_species_artwork_attributions.py`，下载节流为 1 秒 1 次且带非空 User-Agent，统一转 WebP，并生成 Commons 第三方归因清单。
- `electron-builder.yml` 将 `resources/species-artwork/*.webp`、`manifest.json` 与 `THIRD_PARTY_ATTRIBUTIONS.md` 打入 DMG；packaged E2E 增加 `plumelens://species-artwork` 协议加载与“无远程图片请求”覆盖。

### 服务端与测试清理

- packaged Electron 启动时显式要求 `PLUMELENS_API_TOKEN`，后端在 `PLUMELENS_REQUIRE_API_TOKEN=1` 且缺 token 时拒绝启动，避免生产态退回无鉴权 loopback API。
- packaged SSE 改为 preload fetch stream 注入 Authorization header，query token 仅保留为 vite/native EventSource legacy fallback。
- `open-in-editor` IPC 增加 renderer/preload/main 三层参数校验，非法 tool/path 以 `invalid_args` 明确返回。
- engine shutdown 会先取消分析 worker、恢复 transient queue 状态，再等待默认线程池收干，降低 `PROCESSING` 任务和推理线程残留风险。
- 修复 `/settings/models` manifest fallback 的 assets 类型收窄问题，`uv run pyright` 恢复通过。
- 清理 packaged E2E fixture generator 的未使用 import，全仓库 `uv run ruff check` 恢复通过。
- 清理未接入空壳 stub，并把 `evals/run_eval.py` / `evals/report.py` 补成可执行的数据集清单与 manifest diff 工具。
- macOS 主窗口关闭确认后改为退出整个应用并停止本地引擎，避免 Dock 残留运行态与从 Dock 二次启动初始化异常；packaged cold-start smoke 增加该回归覆盖。
- Electron 从 39.8.10 升级到 41.6.0（39.x 已 EOL），依赖图保持最小变化：除 `electron` 本体外仅新增其嵌套的 Node 24 types，不带动 electron-builder / electron-vite / Playwright / Vite / React。
- 当前基础检查重新拉绿：`npm run typecheck`、`npm run lint`、`npm run test`、`npm audit --audit-level=high`、`uv run pyright`、`uv run ruff check`、`uv run pytest tests/engine -q`、`npx playwright test`、`npx playwright test --config=tests/e2e-electron/playwright.config.ts`、`npm run build`、`npm run dist:mac:bundle`；另补 packaged thumbnail 与 species-artwork smoke 覆盖 `plumelens://thumb` / `plumelens://species-artwork`。
- `npm audit fix` 只更新 `brace-expansion` 与 `ws` 的传递依赖补丁版本，当前 `npm audit` 为 0 vulnerabilities。

### 文档同步

- README、架构、开发、交接、审计文档同步到 0.7.5 真实状态。
- 0.7.0 release note 保留为历史快照，0.7.5 的当前状态以 `docs/HANDOVER.md` 和本节为准。

## 0.7.0

范围：`v0.6.0..e77ff04`，共 58 个提交。
正式 macOS arm64 产物由 GitHub Actions 在 `v0.7.0` tag 推送时自动构建，DMG 与 SHA-256 校验文件随 GitHub Release 一同发布。

### 升级提示

从 0.6.x 升级到 0.7.0 后，所有现有图库会自动按新管线后台重算：检测、姿态、飞版、IQA 权重与鸟种识别这一轮整体换代，`pipeline_version` 由模型 SHA 与阈值组合而成，与 0.6 完全不一致。**人工评级、人工物种、入羽迹决策、导出快照与缩略图缓存全部保留不会丢**，只有自动评分和自动物种结果会按新管线重新计算。重算在后台异步进行，可在分析进度面板查看。

### 模型与分析管线

- 鸟种识别切换到 DINOv3 species v4：1591 类，LoRA adapter + reject head，输出 `recognized / uncertain / unrecognized` 三态。
- 姿态模型升级为 `bird_visibility v2.0`：11 个关键点、头/眼/身/尾/翼 5 项可见性、view angle 与 facing。
- 新增 `bird_flight_classifier v1`，用 `P(fly) >= 0.35` 判定飞版，并在头眼齐全的飞版照片上自动升档。
- YOLO 鸟类检测切到 `YOLOv26l-bird-det v1.1`，针对真实林鸟/绶带鸟场景做 fine-tune。
- IQA 综合分最终调整为 `0.40 * CLIPIQA+ + 0.60 * HyperIQA`，更偏向主体清晰度、噪声、曝光等技术质量。
- 眼部可见阈值按真实复核反馈调整为 `0.42`，UI 文案统一为“眼可见 / 眼不可见”。
- pipeline version 纳入模型 SHA、评分权重、姿态阈值、预处理版本、ORT/EP 与 torch device，模型或阈值变化会触发结果重算。

### 选片与复核体验

- 选片列表重构为更稳的大列表虚拟化，修复折叠连拍、筛选切换、回到顶部、滚动位置保持、头部压缩后高度计算等连续回归。
- 顶部信息栏滚动后切换为精简固定栏：只保留高频指标、常用筛选与“更多”菜单，减少滚动时的视觉抖动。
- 快速筛选保持多选语义，新增“仅飞版”特征筛选；高频等级保留在外侧，低频项收进更多菜单。
- 连拍堆叠按时间、物种、主体连续性切分；唯一堆叠默认展开，收起/展开后列表高度稳定重测量。
- 右侧信息抽屉重构：未选照片时显示拍摄报告，选中照片时显示轻量复核摘要；点击空白区回到拍摄报告。
- 拍摄报告改为“本次拍摄成就清单”：拍摄时间、照片张数、平均分、保留候选、新增鸟种、刷新历史最高分。
- 深度复核右侧栏精简，固定评级操作区，补齐姿态/可见性、物种待审原因、filmstrip 顺序和多鸟切换体验。
- 物种“待审”文案按实际成因区分，组内共识可以覆盖 `model_unconfirmed` 的物种待审。
- 鸟种名增加拼音：羽迹详情单独展示拼音，其他位置 hover tooltip 展示拼音。
- 选片与深度复核右侧栏的鸟种名可点击打开鸟种资料浮窗，展示 Wiki 摘要与 Wikimedia Commons 风格照片。

### 羽迹与物种资料

- 羽迹百科补齐到 DINOv3 species v4 的 1591 种分类表，并修正 `Lanius giganteus` 学名。
- 羽迹封面图补齐到 100%，补全青藏楔尾伯劳 Commons 摄影图。
- 羽迹地理分布修复缓存失效、直辖市钻取、Nominatim 超时与未解析统计。
- 地图与物种聚合严格使用有效入羽迹口径：精选/可用/记录，且来源为 `manual / group_consensus / model`。
- 物种详情加入中文简介、照片浏览入口、保护等级、IUCN、目科信息和拼音展示。
- 羽迹物种封面图改为 `plumelens://species-artwork` 随包 WebP 资源加载，渲染器不再直连 Wikimedia 图片。

### 设置、桌面集成与发布体验

- 设置面板加入作者、邮箱、GitHub、个人博客、GPL-3.0 与版权说明。
- 新增 GitHub Release 更新检查，比较最新 tag 与当前应用版本。
- 新增模型版本面板，从模型 manifest 显示语义版本、SHA 短修订号、加载状态和 pipeline version。
- 新增清理本地识别记录功能，带二次确认；仅删除应用数据库、分析结果、人工决策、任务和缩略图，不删除原始照片。
- 页面左上角使用当前应用 logo，开始页最近文件夹超过 4 个时改为内部滚动列表。
- 关闭窗口和退出应用增加二次确认；E2E 可用环境变量跳过确认。
- Topaz / Photoshop 外部编辑路径检测更稳，源文件夹失联时会禁用源文件操作并提示重新关联。

### 导出、打包与工程质量

- 导出会话锁定启动时的文件夹快照，切换工作集不影响进行中的导出。
- JPEG 写入内嵌 XMP APP1，RAW companion 使用 sidecar；报告中的源文件路径脱敏为相对图库根路径。
- macOS DMG 改为自定义 Finder 布局，背景图升级为 HiDPI multi-rep TIFF，并在打包前 detach stale volume。
- 新增模型 manifest 构建与 SHA 校验，engine 启动时拒绝加载 hash 不匹配模型。
- `dist:mac` 现在包含 bundle + packaged cold-start smoke，打包链路会校验 Electron Framework、DMG 背景与 `.DS_Store` 布局。
- 修复后端启动/关闭、孤儿任务复活、SSE 静默卡死、冷启动 query 永久 error、任务队列状态机等可靠性问题。
- 完整发布前验证：`npm run typecheck`、`npm run lint`、`npm run test`、关键 Electron E2E、`npm run build`、`npm run dist:mac:bundle`。

### 完整提交清单

| Commit    | 日期       | 类型     | 说明                                                                          |
| --------- | ---------- | -------- | ----------------------------------------------------------------------------- |
| `9d954a5` | 2026-05-08 | feat     | 优化连拍分组与复核体验                                                        |
| `1713e1a` | 2026-05-08 | feat     | 切换鸟种识别模型至 dino v4                                                    |
| `ce8191c` | 2026-05-08 | fix      | 加固后端启动与监听清理                                                        |
| `fdd98a9` | 2026-05-08 | fix      | 加固后端关闭与日志清理                                                        |
| `3a70c43` | 2026-05-08 | fix      | 修复地理解析未解状态统计                                                      |
| `c67744f` | 2026-05-08 | perf     | 限制跨图库详情请求并发                                                        |
| `31b2159` | 2026-05-08 | fix      | 修复羽迹缓存失效、mac CI 模型清单、英文导出翻译                               |
| `078b635` | 2026-05-08 | feat     | 补齐羽迹百科至 DINOv3 species v4 全 1591 种                                   |
| `f1f617a` | 2026-05-08 | feat     | 羽迹封面图 100%，补齐青藏楔尾伯劳 Commons 摄影图                              |
| `494d58f` | 2026-05-08 | fix      | 修正学名 Lanius giganteu 到 Lanius giganteus，并升级老 override 到 schema v10 |
| `001c258` | 2026-05-08 | feat     | 升级 bird_visibility v1 到 v2，接入 11 关键点与飞版自动升档                   |
| `3df4f24` | 2026-05-08 | feat     | 深度复核屏展示姿态信息                                                        |
| `b21768b` | 2026-05-08 | refactor | 移除选片对比功能                                                              |
| `416b83a` | 2026-05-08 | feat     | IQA 综合分权重重平衡并做全面审计修复                                          |
| `9ac2351` | 2026-05-08 | fix      | 全代码审计修复 11 处真隐患                                                    |
| `4a860c6` | 2026-05-08 | fix      | IQA 综合分权重再次调整为 0.40 CLIPIQA / 0.60 HyperIQA                         |
| `83ab16f` | 2026-05-08 | fix      | 核心安全与供应链 6 项加固                                                     |
| `bc469f3` | 2026-05-08 | fix      | 9 项高/中风险安全与健壮性加固                                                 |
| `802f6a9` | 2026-05-08 | fix      | 修复 5 项审计发现的新隐患                                                     |
| `0f0d802` | 2026-05-08 | chore    | 自定义 DMG 安装窗口外观、中文品牌背景与图标布局                               |
| `3ddecce` | 2026-05-08 | chore    | DMG 背景升级到 HiDPI multi-rep TIFF                                           |
| `a3ec2c8` | 2026-05-08 | fix      | 后台任务栏点阵进度条改用绿色                                                  |
| `333698c` | 2026-05-08 | fix      | 孤儿 PENDING tasks 兜底自动复活 worker                                        |
| `dbb9369` | 2026-05-08 | fix      | 修复两处 SSE / 后台任务静默卡死                                               |
| `5fcd191` | 2026-05-08 | fix      | 物种待审文案按实际成因区分                                                    |
| `4068b67` | 2026-05-08 | fix      | 修复 5 项数据正确性硬伤                                                       |
| `7f90834` | 2026-05-08 | fix      | 数值正确性与队列守门 3 项修复                                                 |
| `68a0474` | 2026-05-08 | fix      | SSE、轮询、启动状态 4 项 P1 收紧                                              |
| `3b28576` | 2026-05-08 | fix      | 羽迹直辖市钻取、Nominatim 超时、pose 序列化补全                               |
| `12dcf1c` | 2026-05-08 | fix      | 引擎冷启时核心 query 永久 error 导致历史库不显示                              |
| `5341f76` | 2026-05-08 | fix      | 根除 8 项瞬态失败导致永久卡死的反模式                                         |
| `5153002` | 2026-05-09 | feat     | 真 E2E 测试、dist:mac 强制 smoke 与打包闸门                                   |
| `c415495` | 2026-05-09 | fix      | E2E fixture 改为从用户真照片库拷贝缩放                                        |
| `1929bf8` | 2026-05-09 | fix      | 打包前 detach stale volume，防 Finder layout 失效                             |
| `fc1cbb4` | 2026-05-09 | fix      | 搜索/列表重排时缩略图不再闪渐变占位                                           |
| `f1acf78` | 2026-05-09 | fix      | loupe 放大改为 hold-to-zoom 语义                                              |
| `bdb81d6` | 2026-05-09 | fix      | 分析失败照片不混入场景组，顶部统计加失败 cell，修复进度停滞                   |
| `189b6f3` | 2026-05-09 | fix      | 去掉场景上方“记录片”标签，新增种 chip 移到标题内联                            |
| `138e91c` | 2026-05-09 | fix      | 连拍堆叠改整卡 focus + badge 单独展开，多帧采样修漂移                         |
| `b7297af` | 2026-05-09 | fix      | 物种识别默认折叠，地点去省国，多鸟切换不展开                                  |
| `a69b01f` | 2026-05-09 | fix      | 右侧信息栏紧凑结构重构                                                        |
| `eed8eea` | 2026-05-09 | fix      | 修复最近 4 次提交引入的 4 处 UI 隐患                                          |
| `0ede6a8` | 2026-05-10 | fix      | 更新模型管线与分组逻辑                                                        |
| `c9bd2d6` | 2026-05-10 | fix      | 优化选片列表与复核交互                                                        |
| `c16865b` | 2026-05-10 | chore    | 准备 0.7.0 打包资源                                                           |
| `7a0d40f` | 2026-05-10 | fix      | 同步复核胶片条顺序                                                            |
| `3ec0535` | 2026-05-10 | fix      | 完善选片复核与信息抽屉体验                                                    |
| `509fe55` | 2026-05-10 | fix      | 优化选片复核与滚动体验                                                        |
| `c23f0c1` | 2026-05-10 | fix      | 优化 DMG 背景抗锯齿                                                           |
| `921bc68` | 2026-05-10 | fix      | 修正选片虚拟列表滚动高度                                                      |
| `e46f8c3` | 2026-05-10 | fix      | 保持选片筛选滚动位置                                                          |
| `902f874` | 2026-05-10 | fix      | 调整眼部可见性提示文案                                                        |
| `0b9477d` | 2026-05-10 | fix      | 调整眼部可见阈值与标签                                                        |
| `06e8ae3` | 2026-05-10 | fix      | 修复选片回到顶部滚动归零                                                      |
| `1851658` | 2026-05-10 | feat     | 增加仅飞版筛选                                                                |
| `842b869` | 2026-05-10 | fix      | 修复连拍收起后的列表虚拟高度                                                  |
| `10a60bc` | 2026-05-10 | feat     | 完善设置与鸟种资料交互                                                        |
| `e77ff04` | 2026-05-11 | fix      | 优化发布前交互与首页展示                                                      |

内部交接详版见 `docs/releases/0.7.0.md`。
