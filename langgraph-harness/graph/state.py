"""TypedDict schemas for the harness state machine."""

from __future__ import annotations

from typing import Any, TypedDict


class HarnessState(TypedDict, total=False):
    """Mutable runtime state threaded through every graph node."""

    task: str
    pipeline_id: str
    pipeline_steps: list[str]
    current_step: str
    agent_output: str
    tester_retries: int
    reviewer_retries: int
    tester_max_retries: int
    reviewer_max_retries: int
    tester_passed: bool
    reviewer_passed: bool
    release_done: bool
    retro_draft: str
    error: str | None
    metadata: dict[str, Any]


class HarnessContext(TypedDict, total=False):
    """Immutable configuration injected at graph compile time (context_schema)."""

    pipelines_path: str
    agents_dir: str
    logs_dir: str
    max_tester_retries: int
    max_reviewer_retries: int
    user_model: str | None
    dry_run: bool
