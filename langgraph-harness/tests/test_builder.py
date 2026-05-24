"""Tests for graph/builder.py — LangGraph optional import handling."""

from __future__ import annotations

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestBuilderImportError(unittest.TestCase):
    """Verify builder raises ImportError when langgraph is absent."""

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
        __import__("importlib.util", fromlist=["find_spec"]).find_spec("langgraph")
        is not None,
        "langgraph not installed",
    )
    def test_build_pipeline_graph_returns_compiled(self) -> None:
        from graph.builder import build_pipeline_graph

        compiled = build_pipeline_graph()
        self.assertIsNotNone(compiled)


if __name__ == "__main__":
    unittest.main()
