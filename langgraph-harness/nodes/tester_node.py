"""Tester agent node — runs tests and detects PASS/FAIL."""

from __future__ import annotations

import re

from nodes.base import make_node, NoopRunner
from graph.state import HarnessState

_node = make_node("tester.agent.md", "Tester")

_PASS_RE: re.Pattern[str] = re.compile(r"\bPASS\b")
_FAIL_RE: re.Pattern[str] = re.compile(r"\bFAIL\b")


def tester_node(state: HarnessState) -> HarnessState:
    """Run tests and update tester_passed / tester_retries."""
    output = _node._runner.run(_node._prompt, context=state.get("task", ""))
    passed = bool(_PASS_RE.search(output)) and not bool(_FAIL_RE.search(output))
    retries = state.get("tester_retries", 0)
    if not passed:
        retries += 1
    return {
        **state,
        "agent_output": output,
        "current_step": "Tester",
        "tester_passed": passed,
        "tester_retries": retries,
    }
