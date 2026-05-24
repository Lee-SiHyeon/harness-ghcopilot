import { z } from "zod";
import { loadStateLib } from "./utils.js";
export function registerTestGateTools(server) {
    const testgate = loadStateLib("testgate");
    server.registerTool("testgate_get", { description: "Get the current test gate state from test-gate-state.json", inputSchema: z.object({}) }, async () => {
        const data = testgate.getGateState();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool("testgate_set", { description: "Partially update test-gate-state.json", inputSchema: z.object({
            partial: z.record(z.string(), z.unknown()).describe("Fields to update in the gate state"),
        }) }, async ({ partial }) => {
        const data = testgate.setGateState(partial);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool("testgate_record_evidence", { description: "Write test evidence to test-evidence.json", inputSchema: z.object({
            evidence: z.object({
                suite: z.string().optional(),
                total: z.number().optional(),
                pass: z.number().optional(),
                fail: z.number().optional(),
                failures: z.array(z.unknown()).optional(),
                status: z.enum(["PASS", "FAIL"]),
            }).passthrough().describe("Test evidence object"),
        }) }, async ({ evidence }) => {
        const data = testgate.recordEvidence(evidence);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool("testgate_is_valid", { description: "Check if the current test evidence is valid (status=PASS and ts >= requiredSince)", inputSchema: z.object({}) }, async () => {
        const valid = testgate.isEvidenceValid();
        const evidence = testgate.getEvidence();
        const gate = testgate.getGateState();
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({ valid, evidence, gate }, null, 2),
                }],
        };
    });
}
