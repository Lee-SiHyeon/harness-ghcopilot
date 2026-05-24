"""LangGraph pipeline graph builder.

LangGraph is an optional dependency.  Call ``build_pipeline_graph()`` only
when the package is installed; otherwise an ``ImportError`` is raised with a
clear installation hint.
"""

from __future__ import annotations

import re
from typing import Any

from graph.state import HarnessContext, HarnessState
from graph.supervisor import (
    should_retry_reviewer,
    should_retry_tester,
    supervisor_node,
)
from nodes.maestro_node import maestro_node
from nodes.planner_node import planner_node
from nodes.implementer_node import implementer_node
from nodes.tester_node import tester_node
from nodes.reviewer_node import reviewer_node
from nodes.critic_node import critic_node
from nodes.documenter_node import documenter_node
from nodes.investigator_node import investigator_node
from nodes.scout_node import scout_node
from nodes.release_node import release_node
from nodes.context7_node import context7_node

_NODE_MAP: dict[str, Any] = {
    "Maestro": maestro_node,
    "Planner": planner_node,
    "Implementer": implementer_node,
    "Tester": tester_node,
    "Reviewer": reviewer_node,
    "Critic": critic_node,
    "Documenter": documenter_node,
    "Investigator": investigator_node,
    "Scout": scout_node,
    "Release": release_node,
    "Context7 Docs Agent": context7_node,
}


def build_pipeline_graph(
    max_tester_retries: int = 3,
    max_reviewer_retries: int = 3,
) -> Any:
    """Build and compile a LangGraph ``StateGraph`` for the harness.

    Raises ``ImportError`` when ``langgraph`` is not installed.
    """
    try:
        from langgraph.graph import END, START, StateGraph
    except ImportError as exc:
        raise ImportError(
            "langgraph is not installed.  "
            "Install it with: pip install 'langgraph>=0.3'"
        ) from exc

    graph: StateGraph = StateGraph(
        HarnessState,
        context_schema=HarnessContext,
    )

    # Register all nodes
    graph.add_node("supervisor", supervisor_node)
    for name, fn in _NODE_MAP.items():
        node_id = _label_to_id(name)
        graph.add_node(node_id, fn)

    # START → supervisor
    graph.add_edge(START, "supervisor")
    # supervisor → maestro (entry point for all pipelines)
    graph.add_edge("supervisor", "maestro")
    # maestro → first agent node, routed by pipeline_id
    def _maestro_route(state: HarnessState) -> str:
        pid = (state.get("pipeline_id") or "").lower()
        if "investigator" in pid:
            return "investigator"
        if "context7" in pid or "docs" in pid:
            return "context7_docs_agent"
        if "scout" in pid:
            return "scout"
        return "planner"

    graph.add_conditional_edges(
        "maestro",
        _maestro_route,
        ["planner", "investigator", "context7_docs_agent", "scout"],
    )

    # implementer → tester (conditional loop)
    graph.add_edge("planner", "implementer")
    graph.add_edge("investigator", "implementer")

    def _tester_cond(state: HarnessState) -> str:
        return should_retry_tester(state, max_retries=max_tester_retries)

    graph.add_edge("implementer", "tester")
    graph.add_conditional_edges("tester", _tester_cond, ["tester", "reviewer"])

    def _reviewer_cond(state: HarnessState) -> str:
        return should_retry_reviewer(state, max_retries=max_reviewer_retries)

    graph.add_conditional_edges("reviewer", _reviewer_cond, ["reviewer", "critic"])

    # documenter path
    graph.add_edge("context7_docs_agent", "documenter")
    graph.add_edge("documenter", "critic")
    graph.add_edge("scout", "critic")

    # critic → release → END
    graph.add_edge("critic", "release")
    graph.add_edge("release", END)

    return graph.compile()


def _label_to_id(label: str) -> str:
    """Convert a pipeline step label to a snake_case node id."""
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
