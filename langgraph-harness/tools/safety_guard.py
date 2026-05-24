"""Safety guard: block destructive shell commands."""

from __future__ import annotations

import re
from typing import Literal

# Patterns that are considered destructive.
# ``--force-with-lease`` is explicitly allowed (safe force-push variant).
_DESTRUCTIVE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\brm\s+-[^\s]*r[^\s]*f", re.IGNORECASE),  # rm -rf
    re.compile(r"\brm\s+-[^\s]*f[^\s]*r", re.IGNORECASE),  # rm -fr
    re.compile(r"\bdrop\s+table\b", re.IGNORECASE),
    re.compile(r"\bdrop\s+database\b", re.IGNORECASE),
    re.compile(r"\bgit\s+push\s+--force\b(?!\s*-with-lease)", re.IGNORECASE),
    re.compile(r"\bgit\s+reset\s+--hard\b", re.IGNORECASE),
    re.compile(r"\bgit\s+push\s+-f\b", re.IGNORECASE),
    re.compile(r"\bformat\s+[a-z]:", re.IGNORECASE),  # Windows format drive
    re.compile(r"\bdel\s+/[sq]", re.IGNORECASE),       # Windows del /s /q
    re.compile(r"\brd\s+/[sq]", re.IGNORECASE),         # Windows rd /s /q
]

GuardResult = Literal["allow", "deny"]


def check_command(command: str) -> GuardResult:
    """Return ``'allow'`` or ``'deny'`` for the given shell command string.

    ``git push --force-with-lease`` is always allowed despite matching the
    force-push heuristic.
    """
    for pattern in _DESTRUCTIVE_PATTERNS:
        if pattern.search(command):
            return "deny"
    return "allow"


def is_safe(command: str) -> bool:
    """Return ``True`` when the command passes the safety check."""
    return check_command(command) == "allow"
