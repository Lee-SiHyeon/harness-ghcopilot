"""Implementer agent node."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("implementer.agent.md", "Implementer")


def implementer_node(state: HarnessState) -> HarnessState:
    """Execute the implementation plan produced by the Planner."""
    return _node.invoke(state)
