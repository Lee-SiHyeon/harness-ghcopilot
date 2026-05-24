import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadStateLib } from "./utils.js";

export function registerPipelineTools(server: McpServer): void {
  const pipeline = loadStateLib("pipeline");

  server.registerTool(
    "pipeline_record_start",
    { description: "Record a subagent start event into last-subagent-start.json", inputSchema: z.object({
      agentName: z.string().describe("Name of the agent starting"),
      sessionId: z.string().optional().describe("Session ID for correlation"),
    }) },
    async ({ agentName, sessionId }) => {
      const entry = pipeline.recordStart(agentName, sessionId);
      return { content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }] };
    }
  );

  server.registerTool(
    "pipeline_record_stop",
    { description: "Record a subagent stop event, calculate duration, and append to subagent-flow.jsonl", inputSchema: z.object({
      agentName: z.string().describe("Name of the agent stopping"),
      sessionId: z.string().optional().describe("Session ID to match the start event"),
    }) },
    async ({ agentName, sessionId }) => {
      const entry = pipeline.recordStop(agentName, sessionId);
      if (!entry) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No matching start entry found" }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }] };
    }
  );

  server.registerTool(
    "pipeline_query",
    { description: "Query recent entries from subagent-flow.jsonl", inputSchema: z.object({
      agentName: z.string().optional().describe("Filter by agent name"),
      limit: z.number().optional().describe("Max number of entries to return (default: 20)"),
    }) },
    async ({ agentName, limit }) => {
      const entries = pipeline.queryFlow({ agentName, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
    }
  );
}
