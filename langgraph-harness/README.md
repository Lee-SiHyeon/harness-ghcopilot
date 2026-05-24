# LangGraph Harness

LangGraph-based multi-agent harness for `.github` pipelines.

## Structure

```
langgraph-harness/
  graph/         # StateGraph, state schema, supervisor, builder
  nodes/         # 11 agent nodes + base
  tools/         # MCP client, safety/file/model guards
  callbacks/     # Pipeline logger, retro collector
  prompts/       # Prompt loader
  tests/         # unittest-based tests
```

## Run tests (no pytest required)

```powershell
cd c:\Users\dlxog\projects\.github\langgraph-harness
python -m unittest discover -s tests -v
```

## Optional dependencies

- `langgraph>=0.3,<1.0` — required for `build_pipeline_graph()` (`context_schema` API)
- `langchain-core>=0.3,<1.0` — required for prompt loading
- `langchain-mcp-adapters>=0.1,<1.0` — required for MCP tool retrieval
- `pyyaml>=6.0` — preferred for frontmatter parsing (regex fallback available)
