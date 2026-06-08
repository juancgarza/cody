import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorLocateCursorSymbolTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_locate_cursor_symbol",
  description:
    "Resolve the symbol or token under the current Neovim cursor into a concrete file/range target.",
  parameters: objectSchema({}),
};
