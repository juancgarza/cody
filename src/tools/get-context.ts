import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorGetContextTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_get_context",
  description:
    "Read the current Neovim editor context, including current file, cursor, current line, full active-buffer snapshot, filetype, selection, diagnostics, LSP clients, and nearby lines.",
  parameters: objectSchema({}),
};
