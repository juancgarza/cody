import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorInsertAtCursorTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_insert_at_cursor",
  description: "Insert text at the current Neovim cursor position.",
  parameters: objectSchema(
    {
      text: {
        type: "string",
      },
    },
    ["text"],
  ),
};
