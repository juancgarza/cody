import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const editorLocateCurrentFunctionTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_locate_current_function",
  description:
    "Resolve the function, method, class, or nearest enclosing code scope around the current cursor.",
  parameters: objectSchema({}),
};
