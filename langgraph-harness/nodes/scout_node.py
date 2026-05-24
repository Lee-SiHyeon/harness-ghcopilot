"""Scout agent node — self-improvement and trend research."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("scout.agent.md", "Scout")


def scout_node(state: HarnessState) -> HarnessState:
    """Research trends and collect self-improvement signals."""
    return _node.invoke(state)
