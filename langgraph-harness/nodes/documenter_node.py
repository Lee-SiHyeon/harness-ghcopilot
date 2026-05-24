"""Documenter agent node."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("documenter.agent.md", "Documenter")


def documenter_node(state: HarnessState) -> HarnessState:
    """Generate or update documentation based on pipeline output."""
    return _node.invoke(state)
