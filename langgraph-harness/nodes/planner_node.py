"""Planner agent node."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("planner.agent.md", "Planner")


def planner_node(state: HarnessState) -> HarnessState:
    """Generate an implementation plan from the task description."""
    return _node.invoke(state)
