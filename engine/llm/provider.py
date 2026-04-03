"""Provider adapter layer — capability declarations for inference backends."""

from dataclasses import dataclass


@dataclass(frozen=True)
class RetryStrategy:
    """Error retry strategy."""

    max_retries: int = 3
    base_delay: float = 1.0
    backoff_factor: float = 2.0
    retryable_errors: tuple[str, ...] = ("timeout", "rate_limit", "server_error")


@dataclass(frozen=True)
class ProviderCapabilities:
    """Inference backend capability declaration."""

    name: str
    supports_vision: bool
    supports_streaming: bool
    supports_json_schema: bool
    max_image_pixels: int
    max_image_size_bytes: int
    max_context_tokens: int
    json_reliability: float  # 0-1, drives parser defense strategy
    retry_strategy: RetryStrategy


# Pre-configured provider profiles
OLLAMA_QWEN = ProviderCapabilities(
    name="ollama-qwen2.5-vl",
    supports_vision=True,
    supports_streaming=True,
    supports_json_schema=False,
    max_image_pixels=4096 * 4096,
    max_image_size_bytes=20 * 1024 * 1024,
    max_context_tokens=32768,
    json_reliability=0.7,
    retry_strategy=RetryStrategy(),
)

VLLM = ProviderCapabilities(
    name="vllm",
    supports_vision=True,
    supports_streaming=True,
    supports_json_schema=True,
    max_image_pixels=4096 * 4096,
    max_image_size_bytes=20 * 1024 * 1024,
    max_context_tokens=32768,
    json_reliability=0.9,
    retry_strategy=RetryStrategy(),
)

LMSTUDIO = ProviderCapabilities(
    name="lmstudio",
    supports_vision=True,  # Depends on loaded model
    supports_streaming=True,
    supports_json_schema=False,
    max_image_pixels=4096 * 4096,
    max_image_size_bytes=20 * 1024 * 1024,
    max_context_tokens=32768,
    json_reliability=0.6,
    retry_strategy=RetryStrategy(max_retries=2),
)

OPENAI_API = ProviderCapabilities(
    name="openai-api",
    supports_vision=True,
    supports_streaming=True,
    supports_json_schema=True,
    max_image_pixels=2048 * 2048,
    max_image_size_bytes=20 * 1024 * 1024,
    max_context_tokens=128000,
    json_reliability=0.99,
    retry_strategy=RetryStrategy(max_retries=5, base_delay=2.0),
)
