"""Loader for meta/guards.json SSOT shared with hooks/scripts JS guards."""

from __future__ import annotations

import json
import os
import re
from typing import Any

_GUARDS_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "meta", "guards.json")
)

_FALLBACK: dict[str, Any] = {
    "protectedDirs": [],
    "protectedFiles": [],
    "sensitiveExtensions": [],
    "envFilenamePattern": r"\.env(\.[a-z]+)?$",
    "lockFiles": [],
    "destructiveCommands": [],
}

_cache: dict[str, Any] | None = None


def load_guards(path: str | None = None) -> dict[str, Any]:
    """Return the parsed guards.json content. Results are cached per default path."""
    global _cache
    if _cache is not None and path is None:
        return _cache
    resolved = path or _GUARDS_PATH
    try:
        with open(resolved, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        data = dict(_FALLBACK)
    if path is None:
        _cache = data
    return data


def _compile_flags(flag_str: str) -> int:
    """Map JS-style regex flag string to Python re flags. Only 'i' is honoured."""
    flags = 0
    if "i" in (flag_str or "").lower():
        flags |= re.IGNORECASE
    return flags


def get_destructive_patterns(
    lang: str, guards: dict[str, Any] | None = None
) -> list[tuple[re.Pattern[str], str]]:
    """Return ``(compiled_regex, label)`` pairs that apply to *lang* (e.g. "py")."""
    data = guards or load_guards()
    cmds = data.get("destructiveCommands", [])
    out: list[tuple[re.Pattern[str], str]] = []
    for entry in cmds:
        if not isinstance(entry, dict):
            continue
        applies = entry.get("appliesTo")
        if isinstance(applies, list) and lang not in applies:
            continue
        regex = entry.get("regex")
        if not isinstance(regex, str):
            continue
        try:
            compiled = re.compile(regex, _compile_flags(entry.get("flags", "")))
        except re.error:
            # Skip patterns that don't compile in Python (likely language-specific syntax).
            continue
        out.append((compiled, entry.get("name") or regex))
    return out
