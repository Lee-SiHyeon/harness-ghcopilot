"""Tests for tester/reviewer retry gate logic (test-gate simulation)."""

from __future__ import annotations

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from graph.supervisor import should_retry_tester, should_retry_reviewer
from nodes.tester_node import tester_node
from nodes.reviewer_node import reviewer_node


class TestTesterGate(unittest.TestCase):
    """Verify PASS/FAIL detection and retry counter increments."""

    def _make_state(self, **kwargs: object) -> dict:  # type: ignore[type-arg]
        base = {
            "task": "test task",
            "tester_retries": 0,
            "tester_passed": False,
            "reviewer_retries": 0,
            "reviewer_passed": False,
            "release_done": False,
            "retro_draft": "",
        }
        base.update(kwargs)
        return base

    def test_noop_runner_does_not_set_pass(self) -> None:
        """NoopRunner output never contains 'PASS', so tester_passed=False."""
        state = self._make_state()
        result = tester_node(state)
        # NoopRunner returns "[NoopRunner] ..." which has neither PASS nor FAIL
        # so tester_passed should be False and retries incremented
        self.assertFalse(result["tester_passed"])
        self.assertEqual(result["tester_retries"], 1)

    def test_retry_gate_blocks_below_limit(self) -> None:
        state = self._make_state(tester_passed=False, tester_retries=1)
        self.assertEqual(should_retry_tester(state, max_retries=3), "tester")

    def test_retry_gate_passes_at_limit(self) -> None:
        state = self._make_state(tester_passed=False, tester_retries=3)
        self.assertEqual(should_retry_tester(state, max_retries=3), "reviewer")

    def test_retry_gate_passes_when_passed(self) -> None:
        state = self._make_state(tester_passed=True, tester_retries=0)
        self.assertEqual(should_retry_tester(state), "reviewer")


class TestReviewerGate(unittest.TestCase):
    """Verify CRITICAL detection and retry counter increments."""

    def _make_state(self, **kwargs: object) -> dict:  # type: ignore[type-arg]
        base = {
            "task": "review task",
            "reviewer_retries": 0,
            "reviewer_passed": False,
        }
        base.update(kwargs)
        return base

    def test_noop_runner_sets_passed_true(self) -> None:
        """NoopRunner output has no 'CRITICAL', so reviewer_passed=True."""
        state = self._make_state()
        result = reviewer_node(state)
        self.assertTrue(result["reviewer_passed"])
        self.assertEqual(result["reviewer_retries"], 0)

    def test_reviewer_gate_blocks_below_limit(self) -> None:
        state = self._make_state(reviewer_passed=False, reviewer_retries=1)
        self.assertEqual(should_retry_reviewer(state, max_retries=3), "reviewer")

    def test_reviewer_gate_passes_at_limit(self) -> None:
        state = self._make_state(reviewer_passed=False, reviewer_retries=3)
        self.assertEqual(should_retry_reviewer(state, max_retries=3), "critic")

    def test_reviewer_gate_passes_when_passed(self) -> None:
        state = self._make_state(reviewer_passed=True)
        self.assertEqual(should_retry_reviewer(state), "critic")


if __name__ == "__main__":
    unittest.main()
