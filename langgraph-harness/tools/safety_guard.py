"""Safety guard: block destructive shell commands.

Patterns are sourced from ``meta/guards.json`` (SSOT shared with the JS
``hooks/scripts/safety-guard.js``).  ``--force-with-lease`` is explicitly
allowed via negative lookahead inside the JSON patterns.
"""

from __future__ import annotations

from typing import Literal

from tools.guards_loader import get_destructive_patterns

_DESTRUCTIVE_PATTERNS = [pattern for pattern, _label in get_destructive_patterns("py")]

GuardResult = Literal["allow", "deny"]


def check_command(command: str) -> GuardResult:
    """Return ``'allow'`` or ``'deny'`` for the given shell command string."""
    for pattern in _DESTRUCTIVE_PATTERNS:
        if pattern.search(command):
            return "deny"
    return "allow"


def is_safe(command: str) -> bool:
    """Return ``True`` when the command passes the safety check."""
    return check_command(command) == "allow"
