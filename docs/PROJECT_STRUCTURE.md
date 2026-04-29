# 项目目录说明

> 当前整理时间：2026-04-29  
> 目的：明确源码、运行时模型、资料源、测试、打包产物和历史归档的边界，减少根目录噪声，避免把测试数据或构建产物误认为业务源码。

---

## 顶层目录

| 路径 | 类型 | 当前用途 | 处理原则 |
|---|---|---|---|
| `electron/` | 源码 | Electron 主进程、preload、Python 子进程管理 | 正式源码 |
| `renderer/` | 源码 | React 19 前端 UI | 正式源码，后续应拆分 `App.tsx` |
| `engine/` | 源码 + 模型 | FastAPI 后端、SQLite、推理管线、模型文件 | 正式核心目录 |
| `scripts/` | 工具 | 打包、签名、DMG、物种资料、IQA 导出、benchmark | 正式工具目录 |
| `tests/` | 测试 | 后端、前端、E2E、packaged app 测试 | 正式测试目录 |
| `docs/` | 文档 | 技术方案、产品方案、交接文档、开发日志、目录说明 | 正式文档目录 |
| `resources/` | 资料源 | 上游物种源文件、名录、对照表 | 资料源，不是运行时入口 |
| `evals/` | 评测 | 评测脚本、golden / dataset 占位 | 正式评测目录 |
| `archive/` | 历史归档 | 旧 DINOv3 ONNX 路线脚本等历史参考 | 只读参考，不作为当前主线 |
| `build/` | 混合 | 图标/entitlements + PyInstaller 中间产物 | 图标保留；`build/plumelens-engine` 等为可再生成产物 |
| `dist/` | 产物 | electron-vite / PyInstaller 构建输出 | 忽略，不入 git，可重建 |
| `out/` | 产物 | electron-vite 编译输出 | 忽略，不入 git，可重建 |
| `release/` | 产物 | packaged app 与 DMG | 忽略，不入 git，发布时手动交付 |
| `node_modules/` | 依赖 | npm 依赖 | 忽略，不入 git |
| `.venv/` | 依赖 | Python 本地虚拟环境 | 忽略，不入 git |
| `.pytest_cache/` / `.ruff_cache/` | 缓存 | Python 工具缓存 | 忽略，可删除 |
| `test-results/` | 产物 | Playwright 截图和测试产物 | 忽略，可删除 |

---

## 当前推荐树

```text
PlumeLens/
├── electron/                 # Electron 主进程、安全边界、后端子进程管理
├── renderer/                 # React 前端
│   └── src/
│       ├── components/       # 可复用组件，目前含 ThumbnailImage
│       ├── hooks/            # TanStack Query / 后端联动 hooks
│       ├── i18n/             # 中文与英文文案
│       ├── lib/              # API client、adapter、species wiki、mock workspace
│       ├── pages/            # 页面拆分预留
│       ├── stores/           # Zustand 纯 UI 状态
│       ├── App.tsx           # 当前主 UI，后续重点拆分
│       └── app.css           # Nothing 风格视觉与动画样式
├── engine/                   # Python FastAPI 后端与推理管线
│   ├── api/                  # HTTP / SSE 路由与 schemas
│   ├── core/                 # config / database / lifespan / logging
│   ├── models/               # ONNX + torch species v3 模型与模型资料
│   ├── pipeline/             # 唯一推理出口
│   └── services/             # scanner / queue / analyzer / thumbnail / decisions 等业务服务
├── scripts/                  # 打包、模型、百科、benchmark 脚本
├── tests/                    # pytest / vitest / playwright
├── docs/                     # 文档与开发记录
├── resources/
│   └── species/              # 中国鸟类名录、名称对照表、1301 模型物种清单
├── evals/                    # 评测脚本与评测集占位
├── archive/                  # 历史路线归档
├── build/                    # 图标/entitlements + 可再生成的 PyInstaller 中间产物
├── dist/                     # 构建输出，忽略
├── out/                      # electron-vite 输出，忽略
└── release/                  # DMG / packaged app，忽略
```

---

## 运行时模型与资料边界

`engine/models/` 是当前打包时会进入应用资源的模型目录。

```text
engine/models/
├── yolo26l-bird-det.onnx
├── bird_visibility.onnx
├── bird_visibility_config.json
├── clipiqa_plus.onnx
├── hyperiqa.onnx
├── species_wiki.parquet
└── species/
    ├── canonical_extended.parquet
    ├── species_list_1301.parquet
    ├── backbone/
    │   ├── config.json
    │   └── model.safetensors
    └── heads/
        └── seed*.pt
```

`resources/species/` 是上游资料源，不应被运行时代码直接依赖。

---

## 打包产物边界

当前 DMG：

```text
release/PlumeLens-0.3.0-arm64.dmg
```

发布检查：

- `release/` 不入 git。
- `dist/` 不入 git。
- `out/` 不入 git。
- 本机 `Application Support` 中的 SQLite、缩略图、缓存不进入 DMG。
- `benchmark/results/*`、用户照片、测试库不得进入 DMG。

---

## 已完成的目录整理

2026-04-29 已完成：

- 新增 `resources/species/`。
- 将根目录散落的物种源资料移动到 `resources/species/`：
  - `species_list_1301.csv`
  - `中国观鸟年报-中国鸟类名录_v12.0.xls`
  - `中国鸟类名称对照表.xlsx`
- 清理 `.DS_Store` 与 Python `__pycache__` 缓存。
- 删除空的 `engine/build` 与 `engine/dist` 占位目录。
- 保留 `release/PlumeLens-0.3.0-arm64.dmg`。

---

## 后续整理建议

1. 拆分 `renderer/src/App.tsx`：
   - `pages/SelectionPage.tsx`
   - `pages/ArchivePage.tsx`
   - `components/review/ReviewModal.tsx`
   - `components/archive/SpeciesCard.tsx`
   - `components/archive/ArchiveMap.tsx`
   - `components/export/ExportDrawer.tsx`
2. 将前端领域类型从 `mock-workspace.ts` 中拆出到 `renderer/src/lib/domain.ts`。
3. 给 `resources/species/` 增加生成 parquet 的明确脚本入口，避免后续手工流程漂移。
4. 清理或压缩旧 Playwright 截图基线，只保留当前 UI 基线。
5. 在发布脚本中增加 “DMG 不包含测试数据 / benchmark 数据” 的自动检查。

