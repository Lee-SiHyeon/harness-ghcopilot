"""Base classes and protocols shared by all agent nodes."""

from __future__ import annotations

import os
import re
import warnings
from pathlib import Path
from typing import Protocol, runtime_checkable

from graph.state import HarnessState

_AGENTS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "agents")
)


def load_agent_prompt(agent_filename: str, agents_dir: str | None = None) -> str:
    """Load agent prompt from an ``.agent.md`` file, stripping YAML frontmatter.

    Paths escaping the agents base directory are blocked and return an empty
    string to prevent path traversal.

    Returns an empty string when the file cannot be read.
    """
    base = Path(agents_dir or _AGENTS_DIR).resolve()
    candidate = (base / agent_filename).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        warnings.warn(
            f"Agent path escape blocked: {agent_filename!r}",
            UserWarning,
            stacklevel=2,
        )
        return ""

    try:
        with open(candidate, encoding="utf-8") as fh:
            content = fh.read()
    except OSError:
        return ""

    # Strip YAML frontmatter delimited by ---
    stripped = re.sub(r"^---\n.*?\n---\n?", "", content, flags=re.DOTALL)
    return stripped.strip()


@runtime_checkable
class LLMRunner(Protocol):
    """Minimal protocol for pluggable LLM backends."""

    def run(self, prompt: str, context: str = "") -> str:
        """Run a prompt and return the model response."""
        ...


class NoopRunner:
    """Placeholder LLM runner that returns a fixed stub response."""

    def run(self, prompt: str, context: str = "") -> str:
        """Return a stub response without invoking any LLM."""
        return f"[NoopRunner] prompt_len={len(prompt)}"


class BaseAgentNode:
    """Reusable base for all agent nodes.

    Subclasses override ``_agent_filename`` and ``_step_name``
    and may override ``invoke`` for custom state updates.
    """

    _agent_filename: str = ""
    _step_name: str = ""

    def __init__(
        self,
        runner: LLMRunner | None = None,
        agents_dir: str | None = None,
    ) -> None:
        self._runner: LLMRunner = runner or NoopRunner()
        self._agents_dir = agents_dir
        self._prompt = load_agent_prompt(self._agent_filename, agents_dir)

    def invoke(self, state: HarnessState) -> HarnessState:
        """Execute the node and return the updated state."""
        output = self._runner.run(self._prompt, context=state.get("task", ""))
        return {**state, "agent_output": output, "current_step": self._step_name}


def make_node(
    agent_filename: str,
    step_name: str,
    runner: LLMRunner | None = None,
    agents_dir: str | None = None,
) -> BaseAgentNode:
    """Factory: create a ``BaseAgentNode`` instance without subclassing."""
    node = object.__new__(BaseAgentNode)
    node._agent_filename = agent_filename
    node._step_name = step_name
    node._runner = runner or NoopRunner()
    node._agents_dir = agents_dir
    node._prompt = load_agent_prompt(agent_filename, agents_dir)
    return node
