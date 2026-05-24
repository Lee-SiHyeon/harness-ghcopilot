"""Investigator agent node."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("investigator.agent.md", "Investigator")


def investigator_node(state: HarnessState) -> HarnessState:
    """Investigate bugs and root-cause issues."""
    return _node.invoke(state)
