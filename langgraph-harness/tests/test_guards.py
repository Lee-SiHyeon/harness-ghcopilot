"""Tests for tools/safety_guard.py and tools/file_guard.py."""

from __future__ import annotations

import sys
import os
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.safety_guard import check_command, is_safe
from tools.file_guard import check_file
from nodes.tester_node import _PASS_RE, _FAIL_RE


class TestSafetyGuard(unittest.TestCase):
    """Tests for destructive command detection."""

    def test_rm_rf_is_denied(self) -> None:
        self.assertEqual(check_command("rm -rf /tmp/test"), "deny")

    def test_rm_fr_is_denied(self) -> None:
        self.assertEqual(check_command("rm -fr /some/dir"), "deny")

    def test_drop_table_is_denied(self) -> None:
        self.assertEqual(check_command("DROP TABLE users;"), "deny")

    def test_drop_database_is_denied(self) -> None:
        self.assertEqual(check_command("drop database mydb"), "deny")

    def test_git_push_force_is_denied(self) -> None:
        self.assertEqual(check_command("git push --force"), "deny")

    def test_git_push_f_is_denied(self) -> None:
        self.assertEqual(check_command("git push -f origin main"), "deny")

    def test_git_reset_hard_is_denied(self) -> None:
        self.assertEqual(check_command("git reset --hard HEAD~1"), "deny")

    def test_force_with_lease_is_allowed(self) -> None:
        """--force-with-lease must be explicitly allowed."""
        self.assertEqual(check_command("git push --force-with-lease"), "allow")

    def test_normal_git_push_is_allowed(self) -> None:
        self.assertEqual(check_command("git push origin main"), "allow")

    def test_safe_rm_no_flags_is_allowed(self) -> None:
        self.assertEqual(check_command("rm somefile.txt"), "allow")

    def test_is_safe_true(self) -> None:
        self.assertTrue(is_safe("echo hello"))

    def test_is_safe_false(self) -> None:
        self.assertFalse(is_safe("rm -rf /"))


class TestFileGuard(unittest.TestCase):
    """Tests for file path protection decisions."""

    def _github_dir(self) -> str:
        return os.path.normpath(
            os.path.join(os.path.dirname(__file__), "..", "..")
        )

    def test_env_file_is_denied(self) -> None:
        path = os.path.join(self._github_dir(), ".env")
        self.assertEqual(check_file(path, self._github_dir()), "deny")

    def test_env_local_is_denied(self) -> None:
        path = os.path.join(self._github_dir(), ".env.local")
        self.assertEqual(check_file(path, self._github_dir()), "deny")

    def test_pem_key_is_denied(self) -> None:
        path = os.path.join(self._github_dir(), "server.pem")
        self.assertEqual(check_file(path, self._github_dir()), "deny")

    def test_hooks_dir_asks(self) -> None:
        path = os.path.join(self._github_dir(), "hooks", "pre-commit")
        self.assertEqual(check_file(path, self._github_dir()), "ask")

    def test_maestro_agent_md_asks(self) -> None:
        path = os.path.join(self._github_dir(), "agents", "maestro.agent.md")
        self.assertEqual(check_file(path, self._github_dir()), "ask")

    def test_regular_file_is_allowed(self) -> None:
        path = os.path.join(self._github_dir(), "logs", "pipeline.jsonl")
        self.assertEqual(check_file(path, self._github_dir()), "allow")

    def test_windows_path_normalisation(self) -> None:
        """Windows backslash paths must be handled correctly."""
        github = self._github_dir()
        # Construct path with backslashes
        path = github + "\\agents\\maestro.agent.md"
        result = check_file(path, github)
        self.assertEqual(result, "ask")

    def test_relative_path_traversal_is_denied(self) -> None:
        """Relative ../outside.txt escape must be denied."""
        result = check_file("../outside.txt", self._github_dir())
        self.assertEqual(result, "deny")

    def test_absolute_external_path_is_denied(self) -> None:
        """Absolute path outside workspace must be denied."""
        with tempfile.TemporaryDirectory() as outside:
            result = check_file(os.path.join(outside, "evil.txt"), self._github_dir())
            self.assertEqual(result, "deny")


class TestTesterPassFailRegex(unittest.TestCase):
    """Tests for word-boundary PASS/FAIL detection in tester_node."""

    def test_pass_matches_pass(self) -> None:
        self.assertIsNotNone(_PASS_RE.search("All tests PASS"))

    def test_pass_does_not_match_bypass(self) -> None:
        self.assertIsNone(_PASS_RE.search("BYPASS the check"))

    def test_pass_does_not_match_surpass(self) -> None:
        self.assertIsNone(_PASS_RE.search("SURPASS expectations"))

    def test_fail_matches_fail(self) -> None:
        self.assertIsNotNone(_FAIL_RE.search("Test FAIL detected"))

    def test_fail_does_not_match_failure_word(self) -> None:
        """\"FAILURE\" contains FAIL but \\bFAIL\\b should not match mid-word."""
        self.assertIsNone(_FAIL_RE.search("FAILURE mode"))


if __name__ == "__main__":
    unittest.main()
