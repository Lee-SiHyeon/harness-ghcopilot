import { z } from "zod";
import { loadStateLib } from "./utils.js";
export function registerActionItemsTools(server) {
    const actionitems = loadStateLib("actionitems");
    server.registerTool("actionitems_get", { description: "Get the full retrospective-draft.json content", inputSchema: z.object({}) }, async () => {
        const data = actionitems.getDraft();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool("actionitems_append", { description: "Append action items to retrospective-draft.json (deduplicated by message)", inputSchema: z.object({
            items: z.array(z.object({
                message: z.string().describe("Action item message"),
            }).passthrough()).describe("Array of action items to append"),
        }) }, async ({ items }) => {
        const result = actionitems.appendActionItems(items);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });
    server.registerTool("actionitems_consume", { description: "Return current action items and reset the list to empty", inputSchema: z.object({}) }, async () => {
        const items = actionitems.consumeActionItems();
        return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    });
    server.registerTool("actionitems_update_draft", { description: "Partially update retrospective-draft.json fields (ts is auto-updated)", inputSchema: z.object({
            partial: z.record(z.string(), z.unknown()).describe("Fields to update in the draft"),
        }) }, async ({ partial }) => {
        const data = actionitems.updateDraft(partial);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
}
