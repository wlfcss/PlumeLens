"""Pydantic schemas for export endpoints."""

from __future__ import annotations

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ExportGrade = Literal["select", "usable", "record", "reject"]
ExportLayout = Literal["merged", "by_grade"]


class ExportFormatStat(BaseModel):
    """源图库里某一种文件格式的存量统计。"""

    ext: str
    count: int
    bytes: int
    is_raw: bool


class ExportFormatsResponse(BaseModel):
    formats: list[ExportFormatStat]


class ExportLibraryRequest(BaseModel):
    """Request body for exporting one library to a user-selected directory."""

    target_dir: str = Field(..., min_length=1)
    grades: list[ExportGrade] = Field(
        default_factory=lambda: ["select", "usable", "record"],
        min_length=1,
    )
    # 格式白名单(大写、不含点,如 ["JPG", "CR3"])。None = 不限格式。
    # 主文件与同伴文件各自判定:只选 JPG 时,JPG 主文件照导,配套 CR3 会被跳过。
    formats: list[str] | None = None
    min_score: float | None = Field(default=None, ge=0, le=100)
    max_score: float | None = Field(default=None, ge=0, le=100)
    copy_files: bool = True
    include_companions: bool = True
    include_xmp_sidecars: bool = False
    layout: ExportLayout = "merged"
    preserve_structure: bool = True
    include_manifest: bool = True

    @field_validator("grades")
    @classmethod
    def _dedupe_grades(cls, value: list[ExportGrade]) -> list[ExportGrade]:
        out: list[ExportGrade] = []
        for grade in value:
            if grade not in out:
                out.append(grade)
        return out

    @field_validator("formats")
    @classmethod
    def _normalize_formats(cls, value: list[str] | None) -> list[str] | None:
        """归一为大写去点去重。空列表视作 None(不限格式)而不是"一个都不导"。"""
        if value is None:
            return None
        out: list[str] = []
        for raw in value:
            ext = raw.strip().lstrip(".").upper()
            if ext and ext not in out:
                out.append(ext)
        return out or None

    @model_validator(mode="after")
    def _validate_score_bounds(self) -> Self:
        if (
            self.min_score is not None
            and self.max_score is not None
            and self.min_score > self.max_score
        ):
            msg = "min_score must be <= max_score"
            raise ValueError(msg)
        if not self.copy_files and not self.include_xmp_sidecars:
            msg = "At least one of copy_files or include_xmp_sidecars must be enabled"
            raise ValueError(msg)
        return self


class ExportJobStartResponse(BaseModel):
    """``POST /export/library/{id}`` 的即时响应 — 导出已在后台开跑。

    真正的进度与结果走 ``GET /export/jobs/{job_id}/events`` (SSE)。
    """

    job_id: str
    library_id: str
    total: int
    total_bytes: int


class ExportJobCancelResponse(BaseModel):
    job_id: str
    status: str


class ExportManifestPaths(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    json_path: str | None = Field(default=None, alias="json")
    csv: str | None = None


class ExportLibraryResponse(BaseModel):
    library_id: str
    output_dir: str
    selected_count: int
    exported_count: int
    companion_count: int
    xmp_count: int = 0
    skipped_missing: int
    failed_count: int
    manifest: ExportManifestPaths
