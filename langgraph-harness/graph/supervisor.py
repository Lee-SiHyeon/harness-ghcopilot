"""Supervisor node: pipeline classification and routing logic."""

from __future__ import annotations

import json
import os
import re
from typing import Any

from graph.state import HarnessState

_PIPELINES_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "..",
    "meta",
    "pipelines.json",
)


def _load_pipelines(path: str | None = None) -> dict[str, Any]:
    """Load and return pipelines.json content.

    Falls back to an empty-pipelines dict on any IO/parse error.
    """
    resolved = os.path.normpath(path or _PIPELINES_PATH)
    try:
        with open(resolved, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "pipelines": [],
            "defaultPipeline": "A",
            "maxTesterRetries": 3,
            "maxReviewerRetries": 3,
            "_load_error": str(exc),
        }


def classify_pipeline(
    task: str,
    pipelines_data: dict[str, Any] | None = None,
) -> tuple[str, list[str]]:
    """Return (pipeline_id, steps) for *task*.

    Scans each pipeline's keyword list in order; returns the first match.
    Falls back to ``defaultPipeline`` when no keyword matches.
    """
    data = pipelines_data or _load_pipelines()
    pipelines: list[dict[str, Any]] = data.get("pipelines", [])
    default_id: str = data.get("defaultPipeline", "A")

    task_lower = task.lower()
    for pipeline in pipelines:
        for kw in pipeline.get("keywords", []):
            if kw.lower() in task_lower:
                return pipeline["id"], pipeline["steps"]

    # fallback
    for pipeline in pipelines:
        if pipeline["id"] == default_id:
            return default_id, pipeline["steps"]

    # last resort: return id only with empty steps
    return default_id, []


def supervisor_node(state: HarnessState) -> HarnessState:
    """Classify the incoming task and populate pipeline routing fields."""
    task = state.get("task", "")
    pipeline_id, steps = classify_pipeline(task)
    return {
        **state,
        "pipeline_id": pipeline_id,
        "pipeline_steps": steps,
        "current_step": steps[0] if steps else "",
        "tester_retries": state.get("tester_retries", 0),
        "reviewer_retries": state.get("reviewer_retries", 0),
        "tester_passed": state.get("tester_passed", False),
        "reviewer_passed": state.get("reviewer_passed", False),
        "release_done": state.get("release_done", False),
        "retro_draft": state.get("retro_draft", ""),
        "error": state.get("error"),
        "metadata": state.get("metadata", {}),
    }


def should_retry_tester(
    state: HarnessState,
    max_retries: int = 3,
) -> str:
    """Conditional edge: retry Tester or proceed to Reviewer."""
    if state.get("tester_passed"):
        return "reviewer"
    retries = state.get("tester_retries", 0)
    if retries < max_retries:
        return "tester"
    return "reviewer"


def should_retry_reviewer(
    state: HarnessState,
    max_retries: int = 3,
) -> str:
    """Conditional edge: retry Reviewer or proceed to Critic."""
    if state.get("reviewer_passed"):
        return "critic"
    retries = state.get("reviewer_retries", 0)
    if retries < max_retries:
        return "reviewer"
    return "critic"
