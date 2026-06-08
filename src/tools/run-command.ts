import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

/**
 * Opt-in shell tool. Kept in its own module (NOT in STATIC_NATIVE_TOOLS) so it
 * is only appended by generateTools when shell execution is enabled, leaving the
 * default tool roster — and the tests that count it — unchanged.
 */
export const editorRunCommandTool: RealtimeToolDefinition = {
  type: "function",
  name: "editor_run_command",
  description:
    "Run a terminal command from inside Neovim and return its stdout, stderr, and exit code. " +
    "Use it for build/test/VCS tasks like running tests, checking git status, or building. " +
    "Do NOT use it for editor navigation or code edits — use the editor_* tools for those. " +
    "Prefer the array form for the command (program first, one token per argument) so no shell " +
    "parsing happens; pass a single string only for simple commands with no spaces in arguments. " +
    "Commands run without a shell, so pipes, globs, redirection, and ; & | are not supported. " +
    "Read result.code (0 means success) and result.output, not the outer ok flag, which only " +
    "reports whether the tool itself ran.",
  parameters: objectSchema(
    {
      command: {
        description:
          "The command to run. Either an argv array like [\"git\", \"status\", \"--short\"] " +
          "(element 0 is the executable; required for any argument containing spaces) or a single " +
          "string like \"npm test\" with no shell metacharacters.",
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1 },
        ],
      },
      cwd: {
        type: "string",
        description:
          "Optional working directory. Defaults to Neovim's current working directory; pass an " +
          "explicit path when the command should run relative to a specific file or project.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        description:
          "Optional timeout in milliseconds; the command is killed if it exceeds this. Clamped to " +
          "1000–120000, default 15000. Keep it small for interactive use.",
      },
    },
    ["command"],
  ),
};
