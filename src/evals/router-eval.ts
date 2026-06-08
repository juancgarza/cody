import { setTimeout as delay } from "node:timers/promises";
import { RealtimeEditorSession } from "../realtime-session.js";
import type { BridgeCapability, BridgeOutboundMessage, EditorContext } from "../types.js";

type EvalCase = {
  name: string;
  text: string;
  expectedTool?: string;
  expectedNoTool?: boolean;
  expectedArguments?: Record<string, unknown>;
  capabilities?: BridgeCapability[];
  context?: Partial<EditorContext>;
};

type EvalResult = {
  name: string;
  ok: boolean;
  expectedTool?: string;
  expectedNoTool?: boolean;
  actualTool?: string;
  actualArguments?: Record<string, unknown>;
  messages: BridgeOutboundMessage[];
  error?: string;
};

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.CODY_EVAL_TIMEOUT_MS || "20000", 10);

const baseContext: EditorContext = {
  cwd: process.cwd(),
  file: `${process.cwd()}/src/realtime-session.ts`,
  relative_file: "src/realtime-session.ts",
  filetype: "typescript",
  cursor: {
    line: 42,
    column: 17,
  },
  line_count: 520,
  current_line: "const currentName = previousName;",
  current_line_with_cursor: "const currentName = <CURSOR>previousName;",
  cursor_word: "previousName",
  cursor_char: "p",
  line_before_cursor: "const currentName = ",
  line_after_cursor: "previousName;",
  surrounding: {
    start_line: 40,
    end_line: 44,
    lines: [
      "function renameTarget() {",
      "  const previousName = getPreviousName();",
      "  const currentName = previousName;",
      "  return currentName;",
      "}",
    ],
  },
  selection: null,
  diagnostics: {
    near_cursor: [
      {
        file: `${process.cwd()}/src/realtime-session.ts`,
        line: 42,
        column: 17,
        severity: "error",
        source: "typescript",
        code: 2322,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
    current_file: [
      {
        file: `${process.cwd()}/src/realtime-session.ts`,
        line: 42,
        column: 17,
        severity: "error",
        source: "typescript",
        code: 2322,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  },
  lsp_clients: [
    {
      id: 1,
      name: "cody-ts-lsp",
      capabilities: ["rename", "code_action", "references", "definition", "document_symbols"],
    },
  ],
  cody_capabilities: {
    available: ["lsp_rename", "lsp_code_action", "lsp_references", "lsp_definition", "picker_telescope"],
    unavailable: [],
  },
  current_buffer: {
    bufnr: 1,
    name: `${process.cwd()}/src/realtime-session.ts`,
    relative_name: "src/realtime-session.ts",
    line_count: 520,
    start_line: 40,
    end_line: 44,
    truncated: true,
    omitted_lines: 515,
    max_lines: 2000,
    max_bytes: 240000,
    lines: [
      { line: 40, text: "function renameTarget() {" },
      { line: 41, text: "  const previousName = getPreviousName();" },
      {
        line: 42,
        text: "  const currentName = previousName;",
        cursor: true,
        text_with_cursor: "  const currentName = <CURSOR>previousName;",
      },
      { line: 43, text: "  return currentName;" },
      { line: 44, text: "}" },
    ],
  },
  window: {
    winid: 1000,
    tabpage: 1,
    mode: "n",
  },
};

const lspCapabilities: BridgeCapability[] = [
  {
    id: "lsp_rename",
    source: "lsp",
    provider: "lsp:cody-ts-lsp",
    action: "rename",
    description: "Rename the symbol under the cursor via LSP",
    available: true,
    status: "available",
    invoke: { kind: "lsp", method: "textDocument/rename" },
  },
  {
    id: "lsp_references",
    source: "lsp",
    provider: "lsp:cody-ts-lsp",
    action: "references",
    description: "Find references for the symbol under the cursor via LSP",
    available: true,
    status: "available",
    invoke: { kind: "lsp", method: "textDocument/references" },
  },
  {
    id: "lsp_definition",
    source: "lsp",
    provider: "lsp:cody-ts-lsp",
    action: "definition",
    description: "Go to the definition of the symbol under the cursor via LSP",
    available: true,
    status: "available",
    invoke: { kind: "lsp", method: "textDocument/definition" },
  },
  {
    id: "lsp_code_action",
    source: "lsp",
    provider: "lsp:cody-ts-lsp",
    action: "code_action",
    description: "Open LSP code actions and quick fixes at the cursor",
    available: true,
    status: "available",
    invoke: { kind: "lsp", method: "textDocument/codeAction" },
  },
];

const pickerCapabilities: BridgeCapability[] = [
  {
    id: "picker_telescope",
    source: "picker",
    provider: "telescope.nvim",
    action: "search",
    description: "Fuzzy find files, grep, and LSP results (Telescope)",
    available: true,
    status: "available",
    invoke: { kind: "lua", module: "telescope.builtin", fn: "find_files" },
  },
];

const evalCases: EvalCase[] = [
  {
    name: "go to line",
    text: "go to line one",
    expectedTool: "editor_go_to_line",
    expectedArguments: { line: 1 },
  },
  {
    name: "insert comment",
    text: "insert a comment at the cursor",
    expectedTool: "editor_insert_at_cursor",
    expectedArguments: { text: "// TODO" },
  },
  {
    name: "rename cursor symbol",
    text: "rename this symbol to foo",
    expectedTool: "lsp_rename",
    expectedArguments: { new_name: "foo" },
  },
  {
    name: "references",
    text: "show references for this symbol",
    expectedTool: "lsp_references",
  },
  {
    name: "definition",
    text: "go to definition",
    expectedTool: "lsp_definition",
  },
  {
    name: "code actions",
    text: "show code actions",
    expectedTool: "lsp_code_action",
  },
  {
    name: "diagnostic fix",
    text: "fix this error",
    expectedTool: "lsp_code_action",
  },
  {
    name: "locate current function",
    text: "locate this function",
    expectedTool: "editor_locate_current_function",
  },
  {
    name: "file search",
    text: "find auth service",
    expectedTool: "picker_telescope",
    expectedArguments: { mode: "files" },
    context: {
      cwd: `${process.cwd()}/test/fixtures/search`,
      file: `${process.cwd()}/test/fixtures/search/src/auth-service.ts`,
      relative_file: "src/auth-service.ts",
    },
  },
  {
    name: "workspace grep",
    text: "search for auth token in the workspace",
    expectedTool: "picker_telescope",
    expectedArguments: { mode: "grep" },
    context: {
      cwd: `${process.cwd()}/test/fixtures/search`,
      file: `${process.cwd()}/test/fixtures/search/src/auth-service.ts`,
      relative_file: "src/auth-service.ts",
    },
  },
  {
    name: "stop listening",
    text: "stop listening",
    expectedTool: "cody_stop_voice_session",
  },
  {
    name: "no-action question",
    text: "why is this function async?",
    expectedNoTool: true,
  },
  {
    name: "rename unavailable explains setup",
    text: "rename this symbol to foo",
    expectedNoTool: true,
    capabilities: pickerCapabilities,
    context: {
      cody_capabilities: {
        available: ["picker_telescope"],
        unavailable: ["lsp_rename"],
      },
      lsp_clients: [],
    },
  },
];

function context(overrides: Partial<EditorContext> = {}): EditorContext {
  return {
    ...baseContext,
    ...overrides,
    cursor: {
      ...baseContext.cursor,
      ...overrides.cursor,
    },
    surrounding: {
      ...baseContext.surrounding,
      ...overrides.surrounding,
    },
  };
}

async function waitForTerminalMessage(
  messages: BridgeOutboundMessage[],
  startIndex: number,
  timeoutMs: number,
): Promise<BridgeOutboundMessage | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const message = messages.slice(startIndex).find((item) => {
      if (item.type === "tool_call" || item.type === "error" || item.type === "assistant_message") {
        return true;
      }
      return false;
    });

    if (message) {
      return message;
    }

    await delay(50);
  }

  return undefined;
}

function argumentsMatch(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  if (!actual) {
    return false;
  }

  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      return false;
    }
  }

  return true;
}

async function runCase(testCase: EvalCase): Promise<EvalResult> {
  const messages: BridgeOutboundMessage[] = [];
  const session = new RealtimeEditorSession((message) => {
    messages.push(message);
  });
  const caseContext = context(testCase.context);
  const capabilities = testCase.capabilities ?? [...lspCapabilities, ...pickerCapabilities];

  try {
    await session.handleEditorMessage({
      type: "editor_context",
      context: caseContext,
    });
    await session.handleEditorMessage({
      type: "capabilities",
      capabilities,
    });

    const startIndex = messages.length;
    await session.handleEditorMessage({
      type: "text_command",
      id: `eval-${testCase.name}`,
      text: testCase.text,
      context: caseContext,
      capabilities,
    });

    const terminal = await waitForTerminalMessage(messages, startIndex, DEFAULT_TIMEOUT_MS);
    if (!terminal) {
      return {
        name: testCase.name,
        ok: false,
        expectedTool: testCase.expectedTool,
        expectedNoTool: testCase.expectedNoTool,
        messages,
        error: `timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      };
    }

    if (testCase.expectedNoTool) {
      const ok = terminal.type === "assistant_message";
      return {
        name: testCase.name,
        ok,
        expectedNoTool: true,
        actualTool: terminal.type === "tool_call" ? terminal.name : undefined,
        actualArguments: terminal.type === "tool_call" ? terminal.arguments : undefined,
        messages,
        error: ok ? undefined : "expected assistant response without a tool call",
      };
    }

    if (terminal.type !== "tool_call") {
      return {
        name: testCase.name,
        ok: false,
        expectedTool: testCase.expectedTool,
        messages,
        error: `${terminal.type}: ${"message" in terminal ? terminal.message : ""}`,
      };
    }

    const ok =
      terminal.name === testCase.expectedTool &&
      argumentsMatch(terminal.arguments, testCase.expectedArguments);

    return {
      name: testCase.name,
      ok,
      expectedTool: testCase.expectedTool,
      actualTool: terminal.name,
      actualArguments: terminal.arguments,
      messages,
      error: ok ? undefined : "tool or arguments mismatch",
    };
  } finally {
    session.shutdown();
  }
}

function printResult(result: EvalResult): void {
  const mark = result.ok ? "PASS" : "FAIL";
  const expected = result.expectedNoTool ? "no tool" : result.expectedTool;
  const actual = result.actualTool
    ? `${result.actualTool} ${JSON.stringify(result.actualArguments ?? {})}`
    : result.error || "no result";
  console.log(`${mark} ${result.name}: expected ${expected}, got ${actual}`);
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.log("SKIP router evals: OPENAI_API_KEY is not set.");
    return;
  }

  process.env.CODY_QUICK_COMMANDS = "off";

  const results: EvalResult[] = [];
  for (const testCase of evalCases) {
    const result = await runCase(testCase);
    results.push(result);
    printResult(result);
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failures.length}/${results.length} passed`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
