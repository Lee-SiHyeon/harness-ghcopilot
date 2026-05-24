"""Retro collector: write retrospective drafts compatible with retro.jsonl."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

_DEFAULT_RETRO_JSONL = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "logs", "retro.jsonl")
)
_DEFAULT_RETRO_DRAFT = os.path.normpath(
    os.path.join(
        os.path.dirname(__file__), "..", "..", "logs", "retrospective-draft.json"
    )
)


def append_retro(
    pipeline_id: str,
    retro_draft: str,
    *,
    jsonl_path: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Append a retro record to *retro.jsonl*."""
    record: dict[str, Any] = {
        "ts": datetime.now(tz=timezone.utc).isoformat(),
        "pipeline_id": pipeline_id,
        "retro": retro_draft,
    }
    if extra:
        record.update(extra)

    path = jsonl_path or _DEFAULT_RETRO_JSONL
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_retro_draft(
    pipeline_id: str,
    retro_draft: str,
    *,
    draft_path: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Overwrite *retrospective-draft.json* with the latest retro draft."""
    payload: dict[str, Any] = {
        "ts": datetime.now(tz=timezone.utc).isoformat(),
        "pipeline_id": pipeline_id,
        "retro": retro_draft,
    }
    if extra:
        payload.update(extra)

    path = draft_path or _DEFAULT_RETRO_DRAFT
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
