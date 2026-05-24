"""Critic agent node — updates retro draft."""

from __future__ import annotations

from nodes.base import make_node
from graph.state import HarnessState

_node = make_node("critic.agent.md", "Critic")


def critic_node(state: HarnessState) -> HarnessState:
    """Critique the pipeline output and append to retro_draft."""
    output = _node._runner.run(_node._prompt, context=state.get("agent_output", ""))
    existing = state.get("retro_draft", "")
    updated = f"{existing}\n\n### Critic\n{output}".strip()
    return {
        **state,
        "agent_output": output,
        "current_step": "Critic",
        "retro_draft": updated,
    }
