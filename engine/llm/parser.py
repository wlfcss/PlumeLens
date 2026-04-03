"""VLM output parse-repair-validate pipeline."""

# TODO: 多层防御解析
# 1. 直接 JSON 解析
# 2. 正则提取 JSON 块
# 3. 重新调用 VLM 要求修正（json_reliability < 0.8 时启用）
# 4. Pydantic 模型验证
# 防御强度由 ProviderCapabilities.json_reliability 决定
