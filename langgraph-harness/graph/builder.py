"""LangGraph pipeline graph builder.

The builder consumes ``.github/meta/pipelines.json`` as the single source of
truth.  A new pipeline can be added (or an existing one re-shaped) by editing
the JSON only — no Python changes required.

LangGraph is an optional dependency.  Call ``build_pipeline_graph()`` only
when the package is installed; otherwise an ``ImportError`` is raised with a
clear installation hint.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from graph.state import HarnessContext, HarnessState
from graph.supervisor import (
    _load_pipelines,
    should_retry_reviewer,
    should_retry_tester,
    supervisor_node,
)
from nodes.context7_node import context7_node
from nodes.critic_node import critic_node
from nodes.documenter_node import documenter_node
from nodes.implementer_node import implementer_node
from nodes.investigator_node import investigator_node
from nodes.planner_node import planner_node
from nodes.release_node import release_node
from nodes.reviewer_node import reviewer_node
from nodes.scout_node import scout_node
from nodes.tester_node import tester_node

_NODE_MAP: dict[str, Callable[[HarnessState], HarnessState]] = {
    "Planner": planner_node,
    "Implementer": implementer_node,
    "Tester": tester_node,
    "Reviewer": reviewer_node,
    "Critic": critic_node,
    "Documenter": documenter_node,
    "Investigator": investigator_node,
    "Scout": scout_node,
    "Release": release_node,
    "Context7 Docs Agent": context7_node,
}


def build_pipeline_graph(
    pipeline_id: str = "A",
    *,
    pipelines_data: dict[str, Any] | None = None,
    enable_logging: bool = True,
) -> Any:
    """Build and compile a LangGraph ``StateGraph`` for a single pipeline.

    Args:
        pipeline_id: The pipeline id from ``pipelines.json`` (``"A"`` .. ``"J"``).
        pipelines_data: Pre-loaded pipelines JSON; loads from disk when ``None``.
        enable_logging: Wrap each node so step events append to
            ``logs/pipeline.jsonl`` (best-effort, never fails the graph).

    Raises:
        ImportError: when ``langgraph`` is not installed.
        ValueError: when ``pipeline_id`` does not exist in pipelines.json
            or references an unknown agent label.
    """
    try:
        from langgraph.graph import END, START, StateGraph
    except ImportError as exc:
        raise ImportError(
            "langgraph is not installed.  "
            "Install it with: pip install 'langgraph>=0.3'"
        ) from exc

    data = pipelines_data or _load_pipelines()
    pipeline = _find_pipeline(data, pipeline_id)
    if pipeline is None:
        raise ValueError(
            f"pipeline_id {pipeline_id!r} not found in pipelines.json"
        )

    steps: list[str] = pipeline.get("steps", [])
    if not steps:
        raise ValueError(f"pipeline {pipeline_id!r} has no steps defined")

    for step in steps:
        if step not in _NODE_MAP:
            raise ValueError(
                f"pipeline {pipeline_id!r} references unknown agent {step!r}; "
                f"register it in graph.builder._NODE_MAP"
            )

    graph: StateGraph = StateGraph(HarnessState, context_schema=HarnessContext)

    graph.add_node("supervisor", _seed_pipeline_id(pipeline_id))

    seen_ids: set[str] = set()
    for step in steps:
        node_id = _label_to_id(step)
        if node_id in seen_ids:
            # Pipelines may legally repeat a step (e.g. Implementer reused),
            # but the graph itself can register each node id only once.
            continue
        node_fn = _NODE_MAP[step]
        if enable_logging:
            node_fn = _wrap_with_logger(node_fn, step, pipeline_id)
        graph.add_node(node_id, node_fn)
        seen_ids.add(node_id)

    first_id = _label_to_id(steps[0])
    graph.add_edge(START, "supervisor")
    graph.add_edge("supervisor", first_id)

    for idx, (prev, curr) in enumerate(zip(steps, steps[1:])):
        prev_id = _label_to_id(prev)
        curr_id = _label_to_id(curr)

        if prev == "Tester":
            loopback = _loopback_target(steps, idx)
            _add_tester_branch(graph, prev_id, loopback, curr_id)
        elif prev == "Reviewer":
            loopback = _loopback_target(steps, idx)
            _add_reviewer_branch(graph, prev_id, loopback, curr_id)
        else:
            graph.add_edge(prev_id, curr_id)

    graph.add_edge(_label_to_id(steps[-1]), END)

    return graph.compile()


def _find_pipeline(data: dict[str, Any], pipeline_id: str) -> dict[str, Any] | None:
    for p in data.get("pipelines", []):
        if p.get("id") == pipeline_id:
            return p
    return None


def _label_to_id(label: str) -> str:
    """Convert a pipeline step label to a snake_case node id."""
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")


def _loopback_target(steps: list[str], current_idx: int) -> str:
    """Return the node id to loop back to on a Tester/Reviewer failure.

    Prefers ``Implementer`` if present earlier in the pipeline; otherwise
    falls back to the immediately preceding step.
    """
    earlier = steps[: current_idx + 1]
    if "Implementer" in earlier:
        return _label_to_id("Implementer")
    return _label_to_id(steps[current_idx])


def _add_tester_branch(
    graph: Any,
    tester_id: str,
    loopback_id: str,
    next_id: str,
) -> None:
    def _cond(state: HarnessState) -> str:
        decision = should_retry_tester(state)
        # supervisor.should_retry_tester returns the symbolic names
        # "tester" / "reviewer".  Map those to the actual node ids in this
        # pipeline (the loopback target and the literal next step).
        return loopback_id if decision == "tester" else next_id

    graph.add_conditional_edges(tester_id, _cond, [loopback_id, next_id])


def _add_reviewer_branch(
    graph: Any,
    reviewer_id: str,
    loopback_id: str,
    next_id: str,
) -> None:
    def _cond(state: HarnessState) -> str:
        decision = should_retry_reviewer(state)
        return loopback_id if decision == "reviewer" else next_id

    graph.add_conditional_edges(reviewer_id, _cond, [loopback_id, next_id])


def _seed_pipeline_id(pipeline_id: str) -> Callable[[HarnessState], HarnessState]:
    """Return a supervisor wrapper that pins ``pipeline_id`` before classification.

    Pinning at build time guarantees the runtime graph routing matches the
    pipeline the user asked the builder to compile, regardless of what the
    keyword classifier would have chosen from the task text.
    """

    def _seeded(state: HarnessState) -> HarnessState:
        seeded = {**state, "pipeline_id": state.get("pipeline_id") or pipeline_id}
        return supervisor_node(seeded)

    return _seeded


def _wrap_with_logger(
    fn: Callable[[HarnessState], HarnessState],
    step_name: str,
    pipeline_id: str,
) -> Callable[[HarnessState], HarnessState]:
    """Wrap a node so each invocation appends an event to pipeline.jsonl.

    Logging is best-effort: any exception is swallowed so the graph keeps
    running even if the log file is unwritable.
    """
    from callbacks.pipeline_logger import log_step

    def _wrapped(state: HarnessState) -> HarnessState:
        result = fn(state)
        try:
            log_step(
                pipeline_id=result.get("pipeline_id", pipeline_id),
                step_name=step_name,
                output=str(result.get("agent_output", "")),
                extra={
                    "tester_retries": result.get("tester_retries", 0),
                    "reviewer_retries": result.get("reviewer_retries", 0),
                },
            )
        except Exception:  # pragma: no cover - logging never breaks the graph
            pass
        return result

    return _wrapped
