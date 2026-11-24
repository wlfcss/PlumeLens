"""Authoritative selection filters and photo-level facets."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SelectionGrade = Literal["select", "usable", "record", "reject"]


class SelectionQueryRequest(BaseModel):
    """Empty species keys means no species restriction; empty grades matches none."""

    model_config = ConfigDict(extra="forbid")

    species_keys: list[str] = Field(default_factory=list, max_length=2048)
    include_review: bool = True
    grades: list[SelectionGrade] = Field(default_factory=lambda: ["select", "usable", "record"])
    include_no_bird: bool = False
    include_failed: bool = False
    only_flying: bool = False
    photo_query: str = Field(default="", max_length=500)
    sort: Literal["score", "time", "name"] = "score"

    @field_validator("species_keys")
    @classmethod
    def normalize_species_keys(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for raw in value:
            key = raw.strip()
            if key != "state:unidentified" and not (
                key.startswith("sci:") and key[4:].strip() and len(key) <= 256
            ):
                raise ValueError("Invalid species key")
            if key.startswith("sci:"):
                key = f"sci:{' '.join(key[4:].split())}"
            if key not in normalized:
                normalized.append(key)
        return normalized

    @field_validator("grades")
    @classmethod
    def normalize_grades(cls, value: list[SelectionGrade]) -> list[SelectionGrade]:
        return list(dict.fromkeys(value))

    @field_validator("photo_query")
    @classmethod
    def normalize_query(cls, value: str) -> str:
        return value.strip()


class SelectionSpeciesFacet(BaseModel):
    key: str
    name: str
    latin_name: str | None = None
    english_name: str | None = None
    search_aliases: list[str] = Field(default_factory=list)
    photo_count: int
    review_photo_count: int


class SelectionQueryResponse(BaseModel):
    library_id: str
    projection_revision: str
    query: SelectionQueryRequest
    matched_photo_ids: list[str]
    matched_count: int
    total_count: int
    pending_count: int
    failed_count: int
    no_bird_count: int
    facets: list[SelectionSpeciesFacet]
    offset: int = 0
    limit: int | None = None
    next_offset: int | None = None
