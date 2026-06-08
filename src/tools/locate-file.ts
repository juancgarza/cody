import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorLocateFileTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_locate_file",
  description:
    "Resolve a fuzzy file name or path from the current workspace into ranked file candidates before navigation.",
  parameters: objectSchema(
    {
      query: {
        type: "string",
        description: "Fuzzy file name, path fragment, or spoken file description.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of candidate files to return.",
      },
    },
    ["query"],
  ),
};
