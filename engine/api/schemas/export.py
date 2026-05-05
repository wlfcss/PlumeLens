"""Pydantic schemas for export endpoints."""

from __future__ import annotations

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ExportGrade = Literal["select", "usable", "record", "reject"]
ExportLayout = Literal["merged", "by_grade"]


class ExportLibraryRequest(BaseModel):
    """Request body for exporting one library to a user-selected directory."""

    target_dir: str = Field(..., min_length=1)
    grades: list[ExportGrade] = Field(
        default_factory=lambda: ["select", "usable", "record"],
        min_length=1,
    )
    min_score: float | None = Field(default=None, ge=0, le=100)
    max_score: float | None = Field(default=None, ge=0, le=100)
    include_companions: bool = True
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

    @model_validator(mode="after")
    def _validate_score_bounds(self) -> Self:
        if (
            self.min_score is not None
            and self.max_score is not None
            and self.min_score > self.max_score
        ):
            msg = "min_score must be <= max_score"
            raise ValueError(msg)
        return self


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
    skipped_missing: int
    failed_count: int
    manifest: ExportManifestPaths
