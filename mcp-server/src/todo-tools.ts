import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadStateLib } from "./utils.js";

export function registerTodoTools(server: McpServer): void {
  const todo = loadStateLib("todo");

  server.registerTool(
    "todo_get",
    { description: "Get all todos from current-todos.json", inputSchema: z.object({}) },
    async () => {
      const data = todo.getTodos();
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "todo_create",
    { description: "Create a new todo item", inputSchema: z.object({
      title: z.string().describe("Title of the new todo"),
      status: z.enum(["not-started", "in-progress", "completed"]).optional()
        .describe("Initial status (default: not-started)"),
    }) },
    async ({ title, status }) => {
      const data = todo.createTodo(title, status);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "todo_update",
    { description: "Update the status of a single todo by id", inputSchema: z.object({
      id: z.number().describe("Todo id to update"),
      status: z.enum(["not-started", "in-progress", "completed"]).describe("New status"),
    }) },
    async ({ id, status }) => {
      const data = todo.updateTodo(id, status);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "todo_bulk_update",
    { description: "Update multiple todos at once. Each item must have id; status and title are optional.", inputSchema: z.object({
      todos: z.array(
        z.object({
          id: z.number(),
          status: z.enum(["not-started", "in-progress", "completed"]).optional(),
          title: z.string().optional(),
        })
      ).describe("Array of todo updates"),
    }) },
    async ({ todos }) => {
      const data = todo.bulkUpdate(todos);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "todo_clear",
    { description: "Clear all todos (reset to empty list)", inputSchema: z.object({}) },
    async () => {
      const data = todo.clearTodos();
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
