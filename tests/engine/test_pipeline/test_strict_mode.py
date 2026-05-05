"""Strict-mode startup behavior.

Packaged 应用注入 PLUMELENS_REQUIRE_IQA=1，缺 IQA 模型必须启动失败，
不允许悄悄 fallback 0.5 中性分（grade 全部被打成 USABLE 用户感知不到）。
开发期 require_iqa=False（默认），缺模型走 detection-only 友好降级。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from engine.core.config import Settings
from engine.pipeline.manager import PipelineManager


@pytest.mark.asyncio
async def test_strict_mode_refuses_to_start_when_iqa_missing(tmp_path: Path) -> None:
    empty_models = tmp_path / "models"
    empty_models.mkdir()

    settings = Settings(
        data_dir=tmp_path,
        models_dir=empty_models,
        yolo_provider="cpu",
        pose_provider="cpu",
        iqa_provider="cpu",
        species_provider="cpu",
        require_iqa=True,
    )
    pipeline = PipelineManager(settings)

    with pytest.raises(RuntimeError, match="IQA models required"):
        await pipeline.initialize()


@pytest.mark.asyncio
async def test_default_mode_allows_missing_iqa(tmp_path: Path) -> None:
    empty_models = tmp_path / "models"
    empty_models.mkdir()

    settings = Settings(
        data_dir=tmp_path,
        models_dir=empty_models,
        yolo_provider="cpu",
        pose_provider="cpu",
        iqa_provider="cpu",
        species_provider="cpu",
        # require_iqa default False
    )
    pipeline = PipelineManager(settings)

    # 默认模式：IQA 缺失也应正常 init（graceful degrade，分析时走 0.5 fallback）
    await pipeline.initialize()
    assert pipeline.quality_available is False
