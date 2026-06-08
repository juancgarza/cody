import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorGetBufferSliceTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_get_buffer_slice",
  description:
    "Read a 1-indexed inclusive line range from the current buffer before planning a targeted code edit.",
  parameters: objectSchema(
    {
      start_line: {
        type: "integer",
        minimum: 1,
      },
      end_line: {
        type: "integer",
        minimum: 1,
      },
    },
    ["start_line", "end_line"],
  ),
};
