import type { BridgeCapability } from "../types.js";
import { STATIC_NATIVE_TOOLS } from "./native.js";
import { editorRunCommandTool } from "./run-command.js";
import { editorCommandTool } from "./run-ex.js";
import { objectSchema, SCHEMA_BY_ACTION, type RealtimeToolDefinition } from "./schema.js";

export type GenerateToolsOptions = {
  /** When true, the opt-in editor_run_command shell tool is offered to GPT. */
  shellEnabled?: boolean;
  /** When true, the opt-in editor_command Ex-command tool is offered to GPT. */
  commandsEnabled?: boolean;
};

export function dedupeByName(tools: RealtimeToolDefinition[]): RealtimeToolDefinition[] {
  const seen = new Set<string>();
  const deduped: RealtimeToolDefinition[] = [];

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    deduped.push(tool);
  }

  return deduped;
}

export function generateTools(
  capabilities: BridgeCapability[],
  options: GenerateToolsOptions = {},
): RealtimeToolDefinition[] {
  const dynamicTools = capabilities
    .filter((capability) => capability.source !== "native" && capability.available)
    .map((capability): RealtimeToolDefinition => ({
      type: "function",
      name: capability.id,
      description: capability.description,
      parameters: capability.tool_schema ?? SCHEMA_BY_ACTION[capability.action] ?? objectSchema({}),
    }));

  const tools = [...STATIC_NATIVE_TOOLS, ...dedupeByName(dynamicTools)];
  if (options.shellEnabled) {
    tools.push(editorRunCommandTool);
  }
  if (options.commandsEnabled) {
    tools.push(editorCommandTool);
  }
  return tools;
}

export function capabilitySignature(capabilities: BridgeCapability[]): string {
  return capabilities
    .filter((capability) => capability.source !== "native" && capability.available)
    .map((capability) => capability.id)
    .sort()
    .join(",");
}

export function summarizeForPrompt(capabilities: BridgeCapability[]): string {
  const available = capabilities.filter((capability) => capability.source !== "native" && capability.available);
  const unavailable = capabilities.filter((capability) => capability.source !== "native" && !capability.available);
  const lines: string[] = ["# Available capabilities"];

  if (available.length === 0) {
    lines.push("- No dynamic provider tools are currently available.");
  } else {
    for (const capability of available) {
      lines.push(`- ${capability.id}: ${capability.description} (${capability.provider})`);
    }
  }

  lines.push("(native line/file/edit tools are always available)", "", "# Unavailable capabilities");

  if (unavailable.length === 0) {
    lines.push("- None.");
  } else {
    for (const capability of unavailable) {
      const status =
        capability.status === "installed_not_loaded" ? "installed, not loaded" : capability.status;
      const installHint = capability.install_repo
        ? `suggest ":CodyInstall ${capability.provider}"`
        : "do not call a tool for it";
      const loadHint =
        capability.status === "installed_not_loaded"
          ? `suggest loading it or ":CodyInstall ${capability.provider}"`
          : installHint;
      lines.push(`- ${capability.provider}: ${status} - ${loadHint}`);
    }
  }

  return lines.join("\n");
}
