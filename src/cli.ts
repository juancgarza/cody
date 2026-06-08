#!/usr/bin/env node
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { RealtimeEditorSession } from "./realtime-session.js";
import type { BridgeOutboundMessage, EditorInboundMessage } from "./types.js";

function sendToEditor(message: BridgeOutboundMessage): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(message: string): void {
  sendToEditor({
    type: "error",
    message,
  });
}

const session = new RealtimeEditorSession(sendToEditor);

const lines = readline.createInterface({
  input: stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let message: EditorInboundMessage;
  try {
    message = JSON.parse(line) as EditorInboundMessage;
  } catch {
    sendError(`Invalid editor JSON: ${line}`);
    return;
  }

  session.handleEditorMessage(message).catch((error: unknown) => {
    sendError(error instanceof Error ? error.message : String(error));
  });
});

lines.on("close", () => {
  session.shutdown();
});

process.on("SIGINT", () => {
  session.shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  session.shutdown();
  process.exit(0);
});
