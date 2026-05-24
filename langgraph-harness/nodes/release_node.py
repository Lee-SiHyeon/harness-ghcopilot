"""Release agent node — marks pipeline as complete."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("release.agent.md", "Release")


def release_node(state: HarnessState) -> HarnessState:
    """Finalize the pipeline run and set release_done=True."""
    output = _node._runner.run(_node._prompt, context=state.get("task", ""))
    return {
        **state,
        "agent_output": output,
        "current_step": "Release",
        "release_done": True,
    }
