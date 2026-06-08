import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BridgeCapability } from "../types.js";
import {
  SCHEMA_BY_ACTION,
  STATIC_NATIVE_TOOLS,
  capabilitySignature,
  generateTools,
  objectSchema,
  summarizeForPrompt,
} from "./index.js";

const baseCapability: BridgeCapability = {
  id: "picker_telescope",
  source: "picker",
  provider: "telescope.nvim",
  action: "search",
  description: "Fuzzy find files",
  available: true,
  status: "available",
  invoke: { kind: "lua", module: "telescope.builtin", fn: "find_files" },
};

function capability(overrides: Partial<BridgeCapability>): BridgeCapability {
  return {
    ...baseCapability,
    ...overrides,
  };
}

describe("generateTools", () => {
  it("includes static native tools and only available non-native capabilities", () => {
    const tools = generateTools([
      capability({ id: "native_go_to_line", source: "native", provider: "neovim" }),
      capability({ id: "lsp_rename", source: "lsp", action: "rename", provider: "lsp:lua_ls" }),
      capability({
        id: "picker_fzf_lua",
        provider: "fzf-lua",
        available: false,
        status: "installed_not_loaded",
      }),
      capability({
        id: "ai_avante",
        source: "ai_edit",
        provider: "avante.nvim",
        action: "ai_edit",
        available: false,
        status: "missing",
      }),
    ]);

    assert.equal(tools.length, STATIC_NATIVE_TOOLS.length + 1);
    assert.ok(tools.some((tool) => tool.name === "editor_get_context"));
    assert.ok(tools.some((tool) => tool.name === "lsp_rename"));
    assert.ok(!tools.some((tool) => tool.name === "picker_fzf_lua"));
    assert.ok(!tools.some((tool) => tool.name === "ai_avante"));
  });

  it("offers editor_run_command only when shellEnabled is set", () => {
    assert.ok(!generateTools([]).some((tool) => tool.name === "editor_run_command"));
    assert.ok(!generateTools([], { shellEnabled: false }).some((tool) => tool.name === "editor_run_command"));

    const enabled = generateTools([], { shellEnabled: true });
    assert.ok(enabled.some((tool) => tool.name === "editor_run_command"));
    assert.equal(enabled.length, STATIC_NATIVE_TOOLS.length + 1);
  });

  it("offers editor_command only when commandsEnabled is set", () => {
    assert.ok(!generateTools([]).some((tool) => tool.name === "editor_command"));

    const enabled = generateTools([], { commandsEnabled: true });
    assert.ok(enabled.some((tool) => tool.name === "editor_command"));
    assert.equal(enabled.length, STATIC_NATIVE_TOOLS.length + 1);

    const both = generateTools([], { shellEnabled: true, commandsEnabled: true });
    assert.equal(both.length, STATIC_NATIVE_TOOLS.length + 2);
  });

  it("exposes native locator tools", () => {
    const names = new Set(STATIC_NATIVE_TOOLS.map((tool) => tool.name));

    assert.ok(names.has("editor_locate_cursor_symbol"));
    assert.ok(names.has("editor_locate_current_function"));
    assert.ok(names.has("editor_locate_text"));
    assert.ok(names.has("editor_locate_file"));
    assert.ok(names.has("editor_locate_diagnostic"));
  });

  it("uses schemas by action and falls back to an empty object schema", () => {
    const tools = generateTools([
      capability({ id: "lsp_rename", source: "lsp", action: "rename", provider: "lsp:lua_ls" }),
      capability({ id: "unknown_action", action: "unknown" }),
    ]);

    const rename = tools.find((tool) => tool.name === "lsp_rename");
    const unknown = tools.find((tool) => tool.name === "unknown_action");

    assert.deepEqual(rename?.parameters, {
      type: "object",
      properties: {
        new_name: {
          type: "string",
          description: "New name for the symbol under the cursor.",
        },
      },
      required: ["new_name"],
      additionalProperties: false,
    });
    assert.deepEqual(unknown?.parameters, objectSchema({}));
  });

  it("honors a capability tool_schema override", () => {
    const override = objectSchema({ value: { type: "number" } }, ["value"]);
    const tools = generateTools([capability({ tool_schema: override })]);

    assert.deepEqual(tools.find((tool) => tool.name === "picker_telescope")?.parameters, override);
  });

  it("exposes picker search mode in the search schema", () => {
    assert.deepEqual(SCHEMA_BY_ACTION.search.properties, {
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
    });
  });
});

describe("capabilitySignature", () => {
  it("is stable under reorder and changes when available capability ids change", () => {
    const a = capability({ id: "a" });
    const b = capability({ id: "b" });
    const unavailable = capability({ id: "c", available: false, status: "missing" });

    assert.equal(capabilitySignature([b, unavailable, a]), "a,b");
    assert.equal(capabilitySignature([a, b]), "a,b");
    assert.equal(capabilitySignature([a]), "a");
  });
});

describe("summarizeForPrompt", () => {
  it("summarizes available and unavailable capabilities without exposing missing tools as callable", () => {
    const summary = summarizeForPrompt([
      capability({ id: "lsp_definition", source: "lsp", action: "definition", provider: "lsp:lua_ls" }),
      capability({
        id: "picker_fzf_lua",
        provider: "fzf-lua",
        available: false,
        status: "missing",
        install_repo: "ibhagwan/fzf-lua",
      }),
      capability({
        id: "ai_avante",
        source: "ai_edit",
        provider: "avante.nvim",
        action: "ai_edit",
        available: false,
        status: "installed_not_loaded",
      }),
    ]);

    assert.match(summary, /- lsp_definition: .* \(lsp:lua_ls\)/);
    assert.match(summary, /fzf-lua: missing - suggest ":CodyInstall fzf-lua"/);
    assert.match(summary, /avante.nvim: installed, not loaded - suggest loading it/);
    assert.doesNotMatch(summary, /- picker_fzf_lua:/);
    assert.doesNotMatch(summary, /- ai_avante:/);
  });
});
