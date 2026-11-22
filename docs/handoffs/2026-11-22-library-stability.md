# 鉴翎图库与导出交接

2026-11-22 · 基线 `9e3f558` · 正式版 0.7.8 · 本轮列入未发布变更

## 已交付

| 范围         | 行为与维护入口                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 图库重新关联 | 用文件身份或 SHA-256 核验主文件和实际相关的同伴文件。已核验的同内容迁移可复用分析与人工修正，异内容或核验不足进入重扫路径。提交前再检查并发变化。原片目录保持只读。 [关联路由](../../engine/api/routes/library.py) · [文件核验](../../engine/services/library_relink.py)                                                                                   |
| JPEG 导出    | 安全合并已有标准 XMP，保留原关键词和编辑字段。在扩展、损坏或超限场景下复制原字节，并在清单中记录元数据写入结果。回归覆盖 macOS 锁定原片和模拟 Windows 只读属性。 [导出器](../../engine/services/exporter.py) · [XMP 合并](../../engine/services/xmp.py)                                                                                                    |
| 筛选和导出   | SQLite WAL 读快照独立于写锁。后台进度合并刷新。选片将照片与筛选结果绑定到同一修订，导出冻结前校验该修订，过期预览返回 409 后重建。 [数据库](../../engine/core/database.py) · [筛选快照](../../engine/services/selection.py) · [界面协调](../../renderer/src/hooks/use-selection.ts)                                                                        |
| 首屏与复核   | 选片随主应用加载。大库摘要按完整场景分批投影、编码和接收，保持 SQL 照片顺序与场景共识。Electron 核对末帧和行数后原子提交，接收时共享未变记录。深度复核按照片读取完整 EXIF、关键点和候选。 [摘要准备](../../engine/services/library_summary.py) · [客户端](../../renderer/src/lib/api-client.ts) · [复核读取](../../renderer/src/hooks/use-photo-review.ts) |

本轮沿用数据库 schema 13、现有分页和 API 修订契约。新格式由 Electron 协商，现有 JSON 客户端继续走原接口。用户可见变更见 [CHANGELOG](../../CHANGELOG.md)。

## 验证与性能

2026-11-22 提交前复核为后端 555 项通过、2 项跳过，renderer 105 项通过，Chromium 定向回归 9 项通过。TypeScript、Pyright、Ruff、相关 ESLint 及 Electron 构建均通过。

原生性能复测于 2026-11-20 在 Apple M5 Max 的 macOS arm64 和 Electron 41.6.0 下完成。使用相同的合成图库与两个真实后台分析任务，比较前后各 72 次大库筛选和 9 次小库冷开。

| 指标                          |       对照 → 最终 |
| ----------------------------- | ----------------: |
| 5 万张后台界面筛选 p95        |  513.8 → 228.6 ms |
| 摘要准备阶段最长二代 GC 停顿  |  250.3 → 107.6 ms |
| 5 万张渲染 RSS 单轮峰值中位数 | 0.868 → 0.597 GiB |
| 5 万张渲染 RSS 跨轮最高采样   | 0.971 → 0.775 GiB |
| 1 千张空闲首次首屏 p50        |  207.7 → 202.7 ms |

两项性能改动在同一构建中测量。RSS 包含 Chromium 原生内存，表内峰值来自约 250 ms 间隔的采样。同批真实用户照片、原生 Windows 和正式安装包上的本轮交付验证仍待进行。超大单场景仍需整体计算共识，其尾延迟继续跟踪。

## 复测入口

仓库中的 [后端](../../scripts/benchmark_library_backend.py) 和 [Electron 驱动](../../scripts/benchmark-library.mjs) 可在本机运行。先构建，再使用临时目录启动后端。以下两段在同一初始目录的两个终端运行，并将第二段的 `bench` 指向第一段输出的目录。

```bash
npm run build
bench="$(mktemp -d -t plumelens-library)"
printf '%s\n' "$bench"
PLUMELENS_BENCHMARK_PROFILING=1 .venv/bin/python scripts/benchmark_library_backend.py \
  --data-dir "$bench/data" --photos 50000 --mode analysis --port-file "$bench/port.json"
```

```bash
node scripts/benchmark-library.mjs --data-dir "$bench/data" \
  --port-file "$bench/port.json" --output "$bench/ui.json" --trace \
  --cold-runs 1 --warm-runs 1 --filters 8 --sample-ms 250 --timeout-ms 90000
```

重复时为每轮建立新临时目录。1 千张空闲用 `--photos 1000 --mode idle`。精确复现前后对照顺序和阶段分类，可用当前工作区 `docs/audits/assets/library-scene-projection-20261120/raw.tar.gz` 内的串行脚本。基准结束后在第一终端按 Ctrl-C 关闭隔离后端。

当前工作区另保留动态交接 `docs/HANDOVER.md`、审计路线图及原始性能归档。这些内部材料由本地忽略规则管理，供复盘时查阅。
