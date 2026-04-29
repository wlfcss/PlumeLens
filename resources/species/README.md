# 物种资料源

这里放置用于构建 PlumeLens 物种图鉴、模型识别范围与中文资料的上游源文件。

这些文件是**资料源**，不是运行时直接读取入口。当前运行时主要使用：

- `engine/models/species/canonical_extended.parquet`
- `engine/models/species/species_list_1301.parquet`
- `engine/models/species_wiki.parquet`
- `renderer/src/lib/species-wiki.json`

## 文件

| 文件 | 用途 |
|---|---|
| `中国观鸟年报-中国鸟类名录_v12.0.xls` | 中国鸟类名录主来源，作为 1516 种中国鸟类基准 |
| `中国鸟类名称对照表.xlsx` | 中文名、别名、拉丁名等名称对照参考 |
| `species_list_1301.csv` | species v3 模型可识别的 1301 种物种清单 |

## 使用约定

- v12 名录是物种图鉴主基准。
- 模型 1301 清单中不在 v12 的 19 种归入 `国外观赏种`。
- 更新这些源文件后，需要重新生成 `engine/models/species/*.parquet` 或 `species_wiki.parquet`，再执行：

```bash
uv run python scripts/build_species_wiki_json.py
```

