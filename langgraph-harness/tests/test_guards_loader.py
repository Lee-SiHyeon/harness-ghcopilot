"""Tests for tools/guards_loader.py — meta/guards.json SSOT consumption."""

from __future__ import annotations

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.guards_loader import get_destructive_patterns, load_guards


class TestLoadGuards(unittest.TestCase):
    def test_returns_expected_fields(self) -> None:
        g = load_guards()
        self.assertIsInstance(g.get("protectedDirs"), list)
        self.assertIn("hooks", g["protectedDirs"])
        self.assertIn("maestro.agent.md", g["protectedFiles"])
        self.assertIsInstance(g["sensitiveExtensions"], list)
        self.assertIsInstance(g["envFilenamePattern"], str)
        self.assertIn("package-lock.json", g["lockFiles"])
        self.assertTrue(len(g["destructiveCommands"]) > 0)

    def test_load_missing_file_returns_fallback(self) -> None:
        g = load_guards("/nonexistent/guards.json")
        self.assertEqual(g["protectedDirs"], [])
        self.assertEqual(g["destructiveCommands"], [])


class TestGetDestructivePatterns(unittest.TestCase):
    def test_py_includes_windows_patterns(self) -> None:
        patterns = get_destructive_patterns("py")
        labels = [label for _re, label in patterns]
        self.assertTrue(any("Windows" in label for label in labels), labels)

    def test_py_excludes_kubectl(self) -> None:
        patterns = get_destructive_patterns("py")
        labels = [label for _re, label in patterns]
        self.assertFalse(any("kubectl" in label for label in labels), labels)

    def test_compiled_pattern_matches_rm_rf(self) -> None:
        patterns = get_destructive_patterns("py")
        regexes = [r for r, _ in patterns]
        self.assertTrue(any(r.search("rm -rf /tmp/x") for r in regexes))

    def test_force_with_lease_not_matched_by_force_pattern(self) -> None:
        patterns = get_destructive_patterns("py")
        regexes = [r for r, _ in patterns]
        # 모든 패턴 중 어느 것도 force-with-lease를 매칭하면 안 된다
        self.assertFalse(
            any(r.search("git push --force-with-lease") for r in regexes),
            "force-with-lease should not be matched by any pattern",
        )

    def test_returns_python_compiled_regex(self) -> None:
        patterns = get_destructive_patterns("py")
        for r, _label in patterns:
            self.assertIsInstance(r, re.Pattern)


if __name__ == "__main__":
    unittest.main()
