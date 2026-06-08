import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorReplaceRangeTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_replace_range",
  description:
    "Replace a precise 1-indexed line/column range in the current buffer. Columns are 1-indexed and end_column is exclusive.",
  parameters: objectSchema(
    {
      start_line: {
        type: "integer",
        minimum: 1,
      },
      start_column: {
        type: "integer",
        minimum: 1,
      },
      end_line: {
        type: "integer",
        minimum: 1,
      },
      end_column: {
        type: "integer",
        minimum: 1,
      },
      text: {
        type: "string",
      },
    },
    ["start_line", "start_column", "end_line", "end_column", "text"],
  ),
};
