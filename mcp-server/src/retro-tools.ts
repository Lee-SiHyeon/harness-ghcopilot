import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadStateLib } from "./utils.js";

export function registerRetroTools(server: McpServer): void {
  const retro = loadStateLib("retro");

  server.registerTool(
    "retro_append",
    { description: "Append a retrospective entry to retro.jsonl", inputSchema: z.object({
      entry: z.record(z.string(), z.unknown()).describe("Retrospective entry object"),
    }) },
    async ({ entry }) => {
      const result = retro.appendRetro(entry);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "retro_get_recent",
    { description: "Get recent retrospective entries from retro.jsonl", inputSchema: z.object({
      limit: z.number().optional().describe("Number of recent entries to return (default: 5)"),
    }) },
    async ({ limit }) => {
      const entries = retro.getRecentRetro(limit);
      return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
    }
  );

  server.registerTool(
    "retro_get_patterns",
    { description: "Get retrospective patterns from retro-patterns.json", inputSchema: z.object({}) },
    async () => {
      const patterns = retro.getPatterns();
      return { content: [{ type: "text" as const, text: JSON.stringify(patterns, null, 2) }] };
    }
  );
}
