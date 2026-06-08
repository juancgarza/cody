import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorGoToLineTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_go_to_line",
  description: "Move the active Neovim window cursor to a 1-indexed line in the current buffer.",
  parameters: objectSchema(
    {
      line: {
        type: "integer",
        minimum: 1,
        description: "The 1-indexed line number to move to.",
      },
    },
    ["line"],
  ),
};
