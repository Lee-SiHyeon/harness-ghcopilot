"""MCP client wrapper with optional langchain-mcp-adapters dependency."""

from __future__ import annotations

import logging
import warnings
from typing import Any

logger = logging.getLogger(__name__)


def _make_stdio_config(
    command: str,
    args: list[str],
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build a MultiServerMCPClient stdio server config entry."""
    cfg: dict[str, Any] = {"command": command, "args": args, "transport": "stdio"}
    if env is not None:
        cfg["env"] = env
    return cfg


async def get_tools(
    server_configs: dict[str, dict[str, Any]] | None = None,
) -> list[Any]:
    """Return LangChain-compatible tools from configured MCP servers.

    Returns an empty list when ``langchain-mcp-adapters`` is not installed or
    no servers are configured, emitting a ``UserWarning`` in that case.
    """
    if not server_configs:
        return []

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        warnings.warn(
            "langchain-mcp-adapters is not installed; MCP tools unavailable. "
            "Install with: pip install 'langchain-mcp-adapters>=0.1'",
            UserWarning,
            stacklevel=2,
        )
        return []

    try:
        client = MultiServerMCPClient(server_configs)
        # get_tools may be sync or async depending on library version
        result = client.get_tools()
        if hasattr(result, "__await__"):
            tools = await result
        else:
            tools = result
        return tools  # type: ignore[return-value]
    except Exception:
        logger.exception("MCP tool retrieval failed")
        return []
