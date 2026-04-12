"""Analysis result caching service."""

# TODO: 缓存键: (file_hash, pipeline_version)
# TODO: 命中缓存时跳过 ONNX 推理
# TODO: 管线版本变更时自动失效（模型文件或评分参数变化）
