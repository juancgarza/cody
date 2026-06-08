export type RealtimeToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const SCHEMA_BY_ACTION: Record<string, Record<string, unknown>> = {
  rename: objectSchema(
    {
      new_name: {
        type: "string",
        description: "New name for the symbol under the cursor.",
      },
    },
    ["new_name"],
  ),
  code_action: objectSchema({}),
  references: objectSchema({}),
  definition: objectSchema({}),
  document_symbols: objectSchema({}),
  search: objectSchema({
    mode: {
      type: "string",
      enum: ["files", "grep", "symbols"],
      description:
        "Search mode. Use files for file/path search, grep for text search across the workspace, symbols for document/workspace symbols.",
    },
    query: {
      type: "string",
      description: "Optional initial query for the picker.",
    },
  }),
  ai_edit: objectSchema(
    {
      instruction: {
        type: "string",
        description: "Instruction to forward to the AI/edit plugin.",
      },
    },
    ["instruction"],
  ),
};
