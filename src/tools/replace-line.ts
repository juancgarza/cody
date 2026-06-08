import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorReplaceLineTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_replace_line",
  description:
    "Replace one line in the current buffer. If the user says 'this line', omit line and replace the cursor line.",
  parameters: objectSchema(
    {
      line: {
        type: "integer",
        minimum: 1,
        description: "Optional 1-indexed line number. If absent, Neovim replaces the cursor line.",
      },
      text: {
        type: "string",
        description: "Replacement text. May contain newlines when expanding one line into several lines.",
      },
    },
    ["text"],
  ),
};
