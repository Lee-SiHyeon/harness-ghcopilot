"""Reviewer agent node — checks for critical issues."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("reviewer.agent.md", "Reviewer")

_CRITICAL_KEYWORD = "CRITICAL"


def reviewer_node(state: HarnessState) -> HarnessState:
    """Review implementation and update reviewer_passed / reviewer_retries."""
    output = _node._runner.run(_node._prompt, context=state.get("task", ""))
    has_critical = _CRITICAL_KEYWORD in output.upper()
    passed = not has_critical
    retries = state.get("reviewer_retries", 0)
    if not passed:
        retries += 1
    return {
        **state,
        "agent_output": output,
        "current_step": "Reviewer",
        "reviewer_passed": passed,
        "reviewer_retries": retries,
    }
