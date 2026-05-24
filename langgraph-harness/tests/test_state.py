"""Tests for graph/state.py TypedDict schemas."""

from __future__ import annotations

import sys
import os
import unittest

# Ensure the harness root is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from graph.state import HarnessState, HarnessContext


class TestHarnessState(unittest.TestCase):
    """HarnessState TypedDict usage tests."""

    def test_empty_state_is_valid(self) -> None:
        """An empty dict satisfies total=False HarnessState."""
        state: HarnessState = {}
        self.assertEqual(state, {})

    def test_state_stores_task(self) -> None:
        state: HarnessState = {"task": "구현해줘", "pipeline_id": "A"}
        self.assertEqual(state["task"], "구현해줘")
        self.assertEqual(state["pipeline_id"], "A")

    def test_state_tester_fields(self) -> None:
        state: HarnessState = {
            "tester_retries": 2,
            "tester_passed": False,
        }
        self.assertFalse(state["tester_passed"])
        self.assertEqual(state["tester_retries"], 2)

    def test_state_release_done(self) -> None:
        state: HarnessState = {"release_done": True}
        self.assertTrue(state["release_done"])

    def test_state_retro_draft(self) -> None:
        state: HarnessState = {"retro_draft": "### Critic\nLooks good"}
        self.assertIn("Critic", state["retro_draft"])


class TestHarnessContext(unittest.TestCase):
    """HarnessContext TypedDict usage tests."""

    def test_empty_context_is_valid(self) -> None:
        ctx: HarnessContext = {}
        self.assertEqual(ctx, {})

    def test_context_stores_paths(self) -> None:
        ctx: HarnessContext = {
            "pipelines_path": "/tmp/pipelines.json",
            "max_tester_retries": 3,
            "dry_run": True,
        }
        self.assertEqual(ctx["max_tester_retries"], 3)
        self.assertTrue(ctx["dry_run"])


if __name__ == "__main__":
    unittest.main()
