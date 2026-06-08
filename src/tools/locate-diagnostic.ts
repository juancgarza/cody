import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorLocateDiagnosticTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_locate_diagnostic",
  description:
    "Resolve the nearest diagnostic, or a current-file diagnostic matching query text, into a concrete file/range target.",
  parameters: objectSchema({
    query: {
      type: "string",
      description: "Optional text to match against diagnostic message, source, or code.",
    },
  }),
};
