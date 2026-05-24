"""Pipeline logger: append step events to pipeline.jsonl."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

_DEFAULT_LOG_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "logs", "pipeline.jsonl")
)


def log_step(
    pipeline_id: str,
    step_name: str,
    output: str,
    *,
    log_path: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Append a single pipeline step record to *pipeline.jsonl*.

    Creates the log file (and parent directories) if they do not exist.
    """
    record: dict[str, Any] = {
        "ts": datetime.now(tz=timezone.utc).isoformat(),
        "pipeline_id": pipeline_id,
        "step": step_name,
        "output": output,
    }
    if extra:
        record.update(extra)

    path = log_path or _DEFAULT_LOG_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
