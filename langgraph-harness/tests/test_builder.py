"""Tests for graph/builder.py — LangGraph optional import handling."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_LANGGRAPH_INSTALLED = importlib.util.find_spec("langgraph") is not None


class TestBuilderImportError(unittest.TestCase):
    """Verify builder raises ImportError when langgraph is absent."""

    @unittest.skipIf(_LANGGRAPH_INSTALLED, "langgraph is installed - absence test not applicable")
    def test_raises_import_error_when_langgraph_missing(self) -> None:
        """When langgraph is not installed, build_pipeline_graph must raise."""
        # Temporarily hide langgraph from sys.modules to simulate absence
        had_langgraph = "langgraph" in sys.modules
        original = sys.modules.pop("langgraph", None)
        original_graph = sys.modules.pop("langgraph.graph", None)

        try:
            # Re-import builder with langgraph hidden
            if "graph.builder" in sys.modules:
                del sys.modules["graph.builder"]

            try:
                from graph.builder import build_pipeline_graph

                with self.assertRaises(ImportError) as ctx:
                    build_pipeline_graph()
                self.assertIn("langgraph", str(ctx.exception).lower())
            except ImportError:
                # ImportError at import time is also acceptable
                pass
        finally:
            if original is not None:
                sys.modules["langgraph"] = original
            if original_graph is not None:
                sys.modules["langgraph.graph"] = original_graph

    def test_builder_module_is_importable(self) -> None:
        """graph.builder must be importable even without langgraph installed."""
        try:
            import graph.builder  # noqa: F401
        except ImportError as exc:
            self.fail(f"graph.builder import failed unexpectedly: {exc}")


class TestBuilderWithLangGraph(unittest.TestCase):
    """Smoke-test graph compilation when langgraph is installed."""

    @unittest.skipUnless(
        _LANGGRAPH_INSTALLED,
        "langgraph not installed",
    )
    def test_build_pipeline_graph_returns_compiled(self) -> None:
        from graph.builder import build_pipeline_graph

        compiled = build_pipeline_graph()
        self.assertIsNotNone(compiled)

    @unittest.skipUnless(_LANGGRAPH_INSTALLED, "langgraph not installed")
    def test_each_pipeline_in_json_compiles(self) -> None:
        """Every pipeline id declared in pipelines.json must compile cleanly."""
        from graph.builder import build_pipeline_graph
        from graph.supervisor import _load_pipelines

        data = _load_pipelines()
        ids = [p["id"] for p in data["pipelines"]]
        self.assertGreater(len(ids), 0)
        for pid in ids:
            with self.subTest(pipeline_id=pid):
                compiled = build_pipeline_graph(pid, enable_logging=False)
                self.assertIsNotNone(compiled)


class TestBuilderHelpers(unittest.TestCase):
    """Pure-function tests for helpers that do not require langgraph."""

    def test_label_to_id_basic(self) -> None:
        from graph.builder import _label_to_id

        self.assertEqual(_label_to_id("Planner"), "planner")
        self.assertEqual(_label_to_id("Context7 Docs Agent"), "context7_docs_agent")
        self.assertEqual(_label_to_id("Investigator"), "investigator")

    def test_find_pipeline_returns_matching_entry(self) -> None:
        from graph.builder import _find_pipeline

        data = {
            "pipelines": [
                {"id": "A", "steps": ["Planner"]},
                {"id": "B", "steps": ["Investigator"]},
            ]
        }
        self.assertEqual(_find_pipeline(data, "B")["steps"], ["Investigator"])
        self.assertIsNone(_find_pipeline(data, "Z"))

    def test_loopback_prefers_implementer(self) -> None:
        from graph.builder import _loopback_target

        # ...Planner → Implementer → Tester... ; Tester is at idx 2 (between Implementer and next)
        steps = ["Planner", "Implementer", "Tester", "Reviewer"]
        # current_idx points at the pair (steps[idx], steps[idx+1]); for the
        # transition out of Tester (idx=2) we should loop back to Implementer.
        self.assertEqual(_loopback_target(steps, 2), "implementer")

    def test_loopback_falls_back_when_no_implementer(self) -> None:
        from graph.builder import _loopback_target

        steps = ["Scout", "Tester", "Critic"]
        # No Implementer: loop back to the immediately preceding step (Tester
        # itself — pathological pipeline, but the function must not crash).
        self.assertEqual(_loopback_target(steps, 1), "tester")

    def test_build_raises_on_unknown_pipeline_id(self) -> None:
        if not _LANGGRAPH_INSTALLED:
            self.skipTest("langgraph not installed")
        from graph.builder import build_pipeline_graph

        with self.assertRaises(ValueError):
            build_pipeline_graph("ZZZ", enable_logging=False)

    def test_build_raises_on_unknown_agent_label(self) -> None:
        if not _LANGGRAPH_INSTALLED:
            self.skipTest("langgraph not installed")
        from graph.builder import build_pipeline_graph

        custom = {
            "pipelines": [{"id": "X", "steps": ["Planner", "NotARealAgent"]}],
            "defaultPipeline": "X",
        }
        with self.assertRaises(ValueError):
            build_pipeline_graph(
                "X", pipelines_data=custom, enable_logging=False
            )


class TestWrapWithLogger(unittest.TestCase):
    """Verify _wrap_with_logger emits a record per node invocation."""

    def test_wrapper_appends_to_jsonl(self) -> None:
        from graph.builder import _wrap_with_logger

        with tempfile.TemporaryDirectory() as tmp:
            log_path = os.path.join(tmp, "pipeline.jsonl")

            # Patch the default log path used by callbacks.pipeline_logger via
            # an explicit log_path in the wrapper helper.  We can't easily inject
            # log_path through the wrapper, so we monkeypatch the module default.
            import callbacks.pipeline_logger as pl

            original_default = pl._DEFAULT_LOG_PATH
            pl._DEFAULT_LOG_PATH = log_path
            try:
                def fake_node(state):
                    return {**state, "agent_output": "hello"}

                wrapped = _wrap_with_logger(fake_node, "Planner", "A")
                result = wrapped({"task": "x", "pipeline_id": "A"})

                self.assertEqual(result["agent_output"], "hello")
                with open(log_path, encoding="utf-8") as fh:
                    lines = fh.read().strip().splitlines()
                self.assertEqual(len(lines), 1)
                record = json.loads(lines[0])
                self.assertEqual(record["pipeline_id"], "A")
                self.assertEqual(record["step"], "Planner")
                self.assertEqual(record["output"], "hello")
            finally:
                pl._DEFAULT_LOG_PATH = original_default

    def test_wrapper_swallows_logger_errors(self) -> None:
        from graph.builder import _wrap_with_logger
        import callbacks.pipeline_logger as pl

        original = pl.log_step

        def boom(*_a, **_kw):
            raise RuntimeError("disk full")

        pl.log_step = boom
        try:
            wrapped = _wrap_with_logger(
                lambda s: {**s, "agent_output": "ok"}, "Planner", "A"
            )
            # Must not raise even though log_step blows up
            result = wrapped({"task": "x"})
            self.assertEqual(result["agent_output"], "ok")
        finally:
            pl.log_step = original


class TestSeedPipelineId(unittest.TestCase):
    """Verify the supervisor seeder pins the build-time pipeline id."""

    def test_seed_uses_build_time_id_when_state_blank(self) -> None:
        from graph.builder import _seed_pipeline_id

        seeded = _seed_pipeline_id("B")
        result = seeded({"task": "만들어 줘"})  # would classify as 'A' normally
        self.assertEqual(result["pipeline_id"], "B")

    def test_seed_preserves_existing_pinned_id(self) -> None:
        from graph.builder import _seed_pipeline_id

        seeded = _seed_pipeline_id("A")
        result = seeded({"task": "x", "pipeline_id": "G"})
        self.assertEqual(result["pipeline_id"], "G")


if __name__ == "__main__":
    unittest.main()
