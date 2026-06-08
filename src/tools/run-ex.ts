import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

/**
 * Opt-in Ex-command tool. Like run-command.ts it lives in its own module and is
 * only appended by generateTools when command execution is enabled. Only
 * allowlisted commands run; shell escapes, :lua, chaining, and the ! variant are
 * rejected on the Lua side.
 */
export const editorCommandTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_command",
  description:
    "Run a Neovim Ex/editor command (what you type after ':') such as CodyTranscript, " +
    "CodyFeedbackOpen, split, or nohlsearch. Only allowlisted commands run — shell escapes (:!), " +
    ":lua, command chaining with |, and the ! variant are rejected. To change a Cody setting, run " +
    "'CodySet <key> <value>' (for example 'CodySet feedback_height 30'). Give the command WITHOUT " +
    "the leading colon. Use the editor_* navigation/edit tools for moving the cursor or editing " +
    "code, not this.",
  parameters: objectSchema(
    {
      command: {
        type: "string",
        description:
          "The Ex command to run, without the leading ':'. Examples: \"CodyTranscript\", " +
          "\"CodyFeedbackOpen\", \"split\", \"nohlsearch\", \"CodySet feedback_height 30\".",
      },
    },
    ["command"],
  ),
};
