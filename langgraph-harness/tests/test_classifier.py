"""Tests for graph/supervisor.py classifier and routing functions."""

from __future__ import annotations

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from graph.supervisor import (
    classify_pipeline,
    should_retry_tester,
    should_retry_reviewer,
    supervisor_node,
    _load_pipelines,
)


class TestLoadPipelines(unittest.TestCase):
    """Tests for _load_pipelines fallback."""

    def test_loads_real_file(self) -> None:
        data = _load_pipelines()
        self.assertIn("pipelines", data)
        self.assertIsInstance(data["pipelines"], list)

    def test_fallback_on_missing_file(self) -> None:
        data = _load_pipelines("/nonexistent/path/pipelines.json")
        self.assertIn("pipelines", data)
        self.assertIn("_load_error", data)


class TestClassifyPipeline(unittest.TestCase):
    """Tests for keyword-based pipeline classification."""

    def test_keyword_match_bug(self) -> None:
        pipeline_id, steps = classify_pipeline("오류가 발생했어요")
        self.assertEqual(pipeline_id, "B")
        self.assertIn("Implementer", steps)

    def test_keyword_match_new_feature(self) -> None:
        pipeline_id, steps = classify_pipeline("새 기능 만들어 줘")
        self.assertEqual(pipeline_id, "A")

    def test_keyword_match_docs(self) -> None:
        pipeline_id, steps = classify_pipeline("문서화 해줘")
        self.assertEqual(pipeline_id, "D")

    def test_default_pipeline_fallback(self) -> None:
        pipeline_id, steps = classify_pipeline("completely unrecognised request xyz")
        self.assertIsInstance(pipeline_id, str)
        self.assertIsInstance(steps, list)

    def test_custom_pipelines_data(self) -> None:
        custom = {
            "pipelines": [
                {"id": "X", "keywords": ["테스트키워드"], "steps": ["Planner"]}
            ],
            "defaultPipeline": "X",
        }
        pid, steps = classify_pipeline("테스트키워드 작업", custom)
        self.assertEqual(pid, "X")
        self.assertEqual(steps, ["Planner"])


class TestShouldRetryTester(unittest.TestCase):
    """Tests for tester conditional edge logic."""

    def test_passed_goes_to_reviewer(self) -> None:
        state = {"tester_passed": True, "tester_retries": 0}
        self.assertEqual(should_retry_tester(state), "reviewer")

    def test_failed_under_limit_retries(self) -> None:
        state = {"tester_passed": False, "tester_retries": 1}
        self.assertEqual(should_retry_tester(state, max_retries=3), "tester")

    def test_failed_at_limit_goes_to_reviewer(self) -> None:
        state = {"tester_passed": False, "tester_retries": 3}
        self.assertEqual(should_retry_tester(state, max_retries=3), "reviewer")


class TestShouldRetryReviewer(unittest.TestCase):
    """Tests for reviewer conditional edge logic."""

    def test_passed_goes_to_critic(self) -> None:
        state = {"reviewer_passed": True, "reviewer_retries": 0}
        self.assertEqual(should_retry_reviewer(state), "critic")

    def test_failed_under_limit_retries(self) -> None:
        state = {"reviewer_passed": False, "reviewer_retries": 0}
        self.assertEqual(should_retry_reviewer(state, max_retries=3), "reviewer")

    def test_failed_at_limit_goes_to_critic(self) -> None:
        state = {"reviewer_passed": False, "reviewer_retries": 3}
        self.assertEqual(should_retry_reviewer(state, max_retries=3), "critic")


class TestSupervisorNode(unittest.TestCase):
    """Tests for the supervisor_node function."""

    def test_sets_pipeline_fields(self) -> None:
        state = {"task": "오류 고쳐줘"}
        result = supervisor_node(state)
        self.assertIn("pipeline_id", result)
        self.assertIn("pipeline_steps", result)
        self.assertIn("current_step", result)

    def test_preserves_existing_fields(self) -> None:
        state = {"task": "만들어줘", "metadata": {"key": "val"}}
        result = supervisor_node(state)
        self.assertEqual(result["metadata"], {"key": "val"})

    def test_initialises_retry_counters(self) -> None:
        state = {"task": "뭔가 해줘"}
        result = supervisor_node(state)
        self.assertEqual(result.get("tester_retries"), 0)
        self.assertEqual(result.get("reviewer_retries"), 0)

    def test_populates_max_retries_from_pipelines_json(self) -> None:
        """Supervisor must seed max retries from pipelines.json (the SSOT)."""
        state = {"task": "뭐 해줘"}
        result = supervisor_node(state)
        self.assertIsInstance(result.get("tester_max_retries"), int)
        self.assertIsInstance(result.get("reviewer_max_retries"), int)
        self.assertGreaterEqual(result["tester_max_retries"], 1)
        self.assertGreaterEqual(result["reviewer_max_retries"], 1)

    def test_honours_pinned_pipeline_id(self) -> None:
        """When state already pins a pipeline_id, supervisor must not reclassify."""
        # "만들어" would normally classify as A; pin to B and verify it sticks.
        state = {"task": "만들어 주세요", "pipeline_id": "B"}
        result = supervisor_node(state)
        self.assertEqual(result["pipeline_id"], "B")
        self.assertIn("Investigator", result["pipeline_steps"])


class TestShouldRetryStateFallback(unittest.TestCase):
    """should_retry_* must fall back to state['*_max_retries'] when arg is None."""

    def test_tester_uses_state_max_retries_when_arg_none(self) -> None:
        state = {
            "tester_passed": False,
            "tester_retries": 4,
            "tester_max_retries": 5,
        }
        # retries (4) < max (5) → loop back to tester
        self.assertEqual(should_retry_tester(state), "tester")

    def test_tester_state_limit_hit_returns_reviewer(self) -> None:
        state = {
            "tester_passed": False,
            "tester_retries": 5,
            "tester_max_retries": 5,
        }
        self.assertEqual(should_retry_tester(state), "reviewer")

    def test_reviewer_uses_state_max_retries_when_arg_none(self) -> None:
        state = {
            "reviewer_passed": False,
            "reviewer_retries": 1,
            "reviewer_max_retries": 2,
        }
        self.assertEqual(should_retry_reviewer(state), "reviewer")


if __name__ == "__main__":
    unittest.main()
