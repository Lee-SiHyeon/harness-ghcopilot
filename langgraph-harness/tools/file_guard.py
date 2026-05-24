"""File guard: protect sensitive files from agent writes.

Protected directories, protected files, sensitive extensions, and the env
filename pattern are loaded from ``meta/guards.json`` (SSOT shared with the
JS ``hooks/scripts/file-guard.js``).
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Literal

from tools.guards_loader import load_guards

_guards = load_guards()
_PROTECTED_DIRS: list[str] = list(_guards.get("protectedDirs", []))
_PROTECTED_FILES: list[str] = list(_guards.get("protectedFiles", []))
_SENSITIVE_EXTENSIONS: frozenset[str] = frozenset(
    ext.lower() for ext in _guards.get("sensitiveExtensions", [])
)
_ENV_PATTERN: re.Pattern[str] = re.compile(
    _guards.get("envFilenamePattern", r"\.env(\.[a-z]+)?$"), re.IGNORECASE
)

FileGuardResult = Literal["allow", "ask", "deny"]

_GITHUB_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..")
)


def _normalise(path: str) -> str:
    """Normalise *path* to an absolute POSIX-style lower-case string."""
    return os.path.normpath(os.path.abspath(path)).replace("\\", "/").lower()


def check_file(path: str, github_dir: str | None = None) -> FileGuardResult:
    """Return the guard decision for a proposed file write at *path*.

    Paths outside the workspace base are unconditionally denied to prevent
    path traversal attacks.

    Returns:
        ``'allow'``  — safe to write.
        ``'ask'``    — ask the user before writing.
        ``'deny'``   — must not write.
    """
    base = Path(github_dir or _GITHUB_DIR).resolve()
    target = Path(path)
    if not target.is_absolute():
        target = (base / target).resolve()
    else:
        target = target.resolve()

    try:
        target.relative_to(base)
    except ValueError:
        return "deny"

    norm = target.as_posix().lower()
    filename = target.name.lower()
    _, ext = os.path.splitext(filename)

    # Deny writes to .env* files
    if _ENV_PATTERN.search(filename):
        return "deny"

    # Deny writes to key/cert files
    if ext.lower() in _SENSITIVE_EXTENSIONS:
        return "deny"

    # Ask for protected directories
    for protected_dir in _PROTECTED_DIRS:
        dir_segment = f"/{protected_dir}/"
        if dir_segment in norm + "/":
            return "ask"

    # Ask for protected individual files
    for protected_file in _PROTECTED_FILES:
        if filename == protected_file.lower():
            return "ask"

    return "allow"
