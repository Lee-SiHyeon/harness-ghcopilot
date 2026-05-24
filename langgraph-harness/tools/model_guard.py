"""Model guard: validate and optionally override the LLM model selection."""

from __future__ import annotations

import re
import warnings
from typing import Any

# Regex fallback for extracting ``model:`` from YAML-like frontmatter.
_MODEL_RE: re.Pattern[str] = re.compile(
    r"^model\s*:\s*['\"]?(.+?)['\"]?\s*$", re.MULTILINE
)


def _parse_yaml_safe(text: str) -> dict[str, Any] | None:
    """Parse YAML text, returning ``None`` when PyYAML is unavailable."""
    try:
        import yaml  # type: ignore[import-untyped]

        return yaml.safe_load(text)  # type: ignore[no-any-return]
    except ImportError:
        warnings.warn(
            "pyyaml is not installed; using regex frontmatter fallback. "
            "Install with: pip install 'pyyaml>=6.0'",
            UserWarning,
            stacklevel=3,
        )
        return None


def extract_model_from_frontmatter(frontmatter_text: str) -> str | None:
    """Return the model name from an agent frontmatter block, or ``None``."""
    parsed = _parse_yaml_safe(frontmatter_text)
    if parsed is not None:
        model_val = parsed.get("model")
        if isinstance(model_val, list):
            return str(model_val[0]) if model_val else None
        if model_val:
            return str(model_val)
        return None

    # Regex fallback
    match = _MODEL_RE.search(frontmatter_text)
    if match:
        return match.group(1).strip().strip("[]\"'")
    return None


def resolve_model(
    agent_model: str | None,
    user_model: str | None,
) -> str | None:
    """Return the effective model to use.

    The user-specified model always wins when provided.
    """
    if user_model:
        return user_model
    return agent_model
