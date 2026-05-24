"""Maestro orchestrator node."""

from __future__ import annotations

from nodes.base import BaseAgentNode
from graph.state import HarnessState

_NODE = BaseAgentNode.__new__(BaseAgentNode)
_NODE._agent_filename = "maestro.agent.md"
_NODE._step_name = "Maestro"
_NODE._runner = __import__("nodes.base", fromlist=["NoopRunner"]).NoopRunner()
_NODE._agents_dir = None
_NODE._prompt = __import__("nodes.base", fromlist=["load_agent_prompt"]).load_agent_prompt(
    "maestro.agent.md"
)


def maestro_node(state: HarnessState) -> HarnessState:
    """Orchestrator entry node: routes to the correct pipeline start."""
    return _NODE.invoke(state)
