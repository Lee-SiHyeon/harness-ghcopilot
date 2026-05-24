"""Prompt loader: read prompt files and optionally wrap with LangChain."""

from __future__ import annotations

import os
import warnings
from pathlib import Path
from typing import Any

_PROMPTS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "prompts")
)


def load_raw_prompt(filename: str, prompts_dir: str | None = None) -> str:
    """Read a raw prompt file and return its text content.

    Paths escaping the base prompts directory are blocked and return an empty
    string to prevent path traversal.

    Returns an empty string when the file cannot be found.
    """
    base = Path(prompts_dir or _PROMPTS_DIR).resolve()
    candidate = (base / filename).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        warnings.warn(
            f"Prompt path escape blocked: {filename!r}",
            UserWarning,
            stacklevel=2,
        )
        return ""
    try:
        with open(candidate, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def load_prompt_template(
    filename: str,
    prompts_dir: str | None = None,
    input_variables: list[str] | None = None,
) -> Any | None:
    """Return a LangChain ``PromptTemplate``, or ``None`` when unavailable.

    Falls back to ``None`` when ``langchain-core`` is not installed, emitting
    a ``UserWarning``.
    """
    raw = load_raw_prompt(filename, prompts_dir)
    if not raw:
        return None

    try:
        from langchain_core.prompts import PromptTemplate  # type: ignore[import-untyped]
    except ImportError:
        warnings.warn(
            "langchain-core is not installed; returning None for PromptTemplate. "
            "Install with: pip install 'langchain-core>=0.3'",
            UserWarning,
            stacklevel=2,
        )
        return None

    vars_: list[str] = input_variables or []
    return PromptTemplate(template=raw, input_variables=vars_)
