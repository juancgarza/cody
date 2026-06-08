import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorLocateTextTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_locate_text",
  description:
    "Resolve text in the current buffer or workspace into concrete file/range candidates before editing or navigation.",
  parameters: objectSchema(
    {
      query: {
        type: "string",
        description: "Literal text to locate.",
      },
      scope: {
        type: "string",
        enum: ["current_buffer", "workspace"],
        description: "Search current buffer by default; use workspace for project-wide references.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of candidate matches to return.",
      },
    },
    ["query"],
  ),
};
