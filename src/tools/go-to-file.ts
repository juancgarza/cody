import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorGoToFileTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_go_to_file",
  description: "Open a file in the active Neovim window. Use relative paths when possible.",
  parameters: objectSchema(
    {
      path: {
        type: "string",
        description: "Absolute path, path relative to the Neovim cwd, or filename discoverable from the cwd.",
      },
    },
    ["path"],
  ),
};
