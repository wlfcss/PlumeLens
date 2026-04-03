"""Analysis result caching service."""

# TODO: 缓存键: (file_hash, prompt_version, model_name)
# TODO: 命中缓存时跳过 VLM 调用
# TODO: prompt 或模型变更时自动失效
