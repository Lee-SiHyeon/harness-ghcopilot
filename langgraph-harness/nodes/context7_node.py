"""Context7 Docs Agent node — retrieves library documentation."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("context7.agent.md", "Context7 Docs Agent")


def context7_node(state: HarnessState) -> HarnessState:
    """Retrieve official library documentation via Context7."""
    return _node.invoke(state)
