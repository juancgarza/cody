import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { RealtimeEditorSession } from "./realtime-session.js";
import type { TtsController } from "./tts/index.js";
import type { BridgeOutboundMessage, CodyFeedbackEvent, EditorContext } from "./types.js";

const baseContext: EditorContext = {
  cwd: process.cwd(),
  file: `${process.cwd()}/src/realtime-session.ts`,
  relative_file: "src/realtime-session.ts",
  filetype: "typescript",
  cursor: {
    line: 2,
    column: 7,
  },
  line_count: 3,
  current_line: "const name = value;",
  current_line_with_cursor: "const <CURSOR>name = value;",
  cursor_word: "name",
  cursor_char: "n",
  line_before_cursor: "const ",
  line_after_cursor: "name = value;",
  surrounding: {
    start_line: 1,
    end_line: 3,
    lines: ["function test() {", "  const name = value;", "}"],
  },
  diagnostics: {
    near_cursor: [],
    current_file: [],
  },
  lsp_clients: [],
  cody_capabilities: {
    available: [],
    unavailable: [],
  },
  current_buffer: {
    bufnr: 1,
    name: `${process.cwd()}/src/realtime-session.ts`,
    relative_name: "src/realtime-session.ts",
    line_count: 3,
    start_line: 1,
    end_line: 3,
    truncated: false,
    omitted_lines: 0,
    max_lines: 2000,
    max_bytes: 240000,
    lines: [
      { line: 1, text: "function test() {" },
      { line: 2, text: "  const name = value;", cursor: true, text_with_cursor: "  const <CURSOR>name = value;" },
      { line: 3, text: "}" },
    ],
  },
  window: {
    winid: 1000,
    tabpage: 1,
    mode: "n",
  },
};

class FakeRecorder {
  starts = 0;
  stops = 0;
  options:
    | {
        onAudio: (chunk: Buffer) => void;
        onError: (message: string) => void;
      }
    | undefined;

  start(options: { onAudio: (chunk: Buffer) => void; onError: (message: string) => void }): void {
    this.starts += 1;
    this.options = options;
  }

  stop(): void {
    this.stops += 1;
  }

  pushAudio(bytes: number): void {
    this.options?.onAudio(Buffer.alloc(bytes));
  }
}

class FakeTts implements TtsController {
  feedback: CodyFeedbackEvent[] = [];
  spoken: string[] = [];
  cancels = 0;
  shutdowns = 0;

  speak(text: string): void {
    this.spoken.push(text);
  }

  handleFeedback(event: CodyFeedbackEvent): void {
    this.feedback.push(event);
  }

  cancel(): void {
    this.cancels += 1;
  }

  shutdown(): void {
    this.shutdowns += 1;
  }
}

class FakeSocket {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  once(event: string, listener: (...args: unknown[]) => void): void {
    const wrapped = (...args: unknown[]) => {
      listener(...args);
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((item) => item !== wrapped),
      );
    };
    this.on(event, wrapped);
  }

  emitServer(event: Record<string, unknown>): void {
    this.emit("message", JSON.stringify(event));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function statuses(messages: BridgeOutboundMessage[]): string[] {
  return messages
    .filter((message): message is Extract<BridgeOutboundMessage, { type: "status" }> => message.type === "status")
    .map((message) => message.message);
}

function feedback(messages: BridgeOutboundMessage[]): Array<Extract<BridgeOutboundMessage, { type: "feedback" }>["event"]> {
  return messages
    .filter((message): message is Extract<BridgeOutboundMessage, { type: "feedback" }> => message.type === "feedback")
    .map((message) => message.event);
}

describe("RealtimeEditorSession voice state machine", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousQuickCommands = process.env.CODY_QUICK_COMMANDS;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.CODY_QUICK_COMMANDS = "off";
  });

  afterEach(() => {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }

    if (previousQuickCommands === undefined) {
      delete process.env.CODY_QUICK_COMMANDS;
    } else {
      process.env.CODY_QUICK_COMMANDS = previousQuickCommands;
    }
  });

  it("returns a persistent voice session to listening after a response", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder,
      createSocket: () => socket,
    });

    await session.handleEditorMessage({
      type: "voice_session_start",
      id: "voice-1",
      context: baseContext,
      capabilities: [],
    });

    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "input_audio_buffer.speech_stopped" });
    socket.emitServer({ type: "response.created" });
    socket.emitServer({
      type: "response.done",
      response: {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Done." }],
          },
        ],
      },
    });

    assert.equal(recorder.starts, 1);
    assert.equal(statuses(messages).at(-1), "listening");
    assert.ok(statuses(messages).includes("finalizing"));
    assert.ok(messages.some((message) => message.type === "assistant_message" && message.message === "Done."));
  });

  it("makes an empty push-to-talk release a clean no-op", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder,
      createSocket: () => socket,
    });

    await session.handleEditorMessage({
      type: "voice_press",
      id: "press-1",
      context: baseContext,
      capabilities: [],
    });
    await session.handleEditorMessage({
      type: "voice_release",
      id: "release-1",
      context: baseContext,
      capabilities: [],
    });

    assert.equal(recorder.starts, 1);
    assert.equal(recorder.stops, 1);
    assert.equal(statuses(messages).at(-1), "done");
    assert.ok(!socket.sent.some((event) => event.type === "input_audio_buffer.commit"));
  });

  it("cancels an active response when a new push-to-talk turn starts", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder,
      createSocket: () => socket,
    });

    await session.handleEditorMessage({
      type: "text_command",
      id: "text-1",
      text: "explain this",
      context: baseContext,
      capabilities: [],
    });
    await session.handleEditorMessage({
      type: "voice_press",
      id: "press-1",
      context: baseContext,
      capabilities: [],
    });

    assert.ok(socket.sent.some((event) => event.type === "response.cancel"));
    assert.equal(recorder.starts, 1);
    assert.equal(statuses(messages).at(-1), "listening");
  });

  it("submits full current-buffer context with cursor line marker", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder,
      createSocket: () => socket,
    });

    await session.handleEditorMessage({
      type: "text_command",
      id: "text-1",
      text: "what is here?",
      context: baseContext,
      capabilities: [],
    });

    const userEvent = socket.sent.find((event) => event.type === "conversation.item.create");
    assert.ok(userEvent);
    const item = userEvent.item as { content?: Array<{ text?: string }> };
    const text = item.content?.[0]?.text ?? "";

    assert.match(text, /Current buffer snapshot:/);
    assert.match(text, /Lines: 1-3 of 3/);
    assert.match(text, /=> 2:   const <CURSOR>name = value;/);
    assert.match(text, /Window JSON:/);
  });

  it("emits feedback for transcript, selected action, and result", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder,
      createSocket: () => socket,
    });

    await session.handleEditorMessage({
      type: "voice_press",
      id: "press-1",
      context: baseContext,
      capabilities: [],
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "go to line four",
    });
    socket.emitServer({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            name: "editor_go_to_line",
            call_id: "call-1",
            arguments: "{\"line\":4}",
          },
        ],
      },
    });

    const toolCall = messages.find(
      (message): message is Extract<BridgeOutboundMessage, { type: "tool_call" }> =>
        message.type === "tool_call",
    );
    assert.ok(toolCall);

    await session.handleEditorMessage({
      type: "tool_result",
      request_id: toolCall.request_id,
      ok: true,
      output: { ok: true, line: 4 },
    });

    const events = feedback(messages);
    assert.ok(events.some((event) => event.kind === "transcript" && event.message === "go to line four"));
    assert.ok(events.some((event) => event.kind === "action" && event.name === "editor_go_to_line"));
    assert.ok(events.some((event) => event.kind === "result" && event.name === "editor_go_to_line" && event.ok));
  });

  it("surfaces assistant messages from plain text content and text deltas", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder,
      createSocket: () => socket,
    });

    await session.handleEditorMessage({
      type: "text_command",
      id: "text-1",
      text: "why is this async?",
      context: baseContext,
      capabilities: [],
    });
    socket.emitServer({
      type: "response.text.delta",
      delta: "Because ",
    });
    socket.emitServer({
      type: "response.done",
      response: {
        output: [
          {
            type: "message",
            content: [{ type: "text", text: "Because it awaits I/O." }],
          },
        ],
      },
    });

    assert.ok(messages.some((message) => message.type === "assistant_delta" && message.delta === "Because "));
    assert.ok(
      messages.some(
        (message) => message.type === "assistant_message" && message.message === "Because it awaits I/O.",
      ),
    );
    assert.ok(
      feedback(messages).some(
        (event) => event.kind === "message" && event.message === "Because it awaits I/O.",
      ),
    );
  });

  it("ignores stale tool results after stop", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder,
      createSocket: () => socket,
    });

    await session.handleEditorMessage({
      type: "text_command",
      id: "text-1",
      text: "go to line 4",
      context: baseContext,
      capabilities: [],
    });
    socket.emitServer({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            name: "editor_go_to_line",
            call_id: "call-1",
            arguments: "{\"line\":4}",
          },
        ],
      },
    });

    const toolCall = messages.find(
      (message): message is Extract<BridgeOutboundMessage, { type: "tool_call" }> =>
        message.type === "tool_call",
    );
    assert.ok(toolCall);

    await session.handleEditorMessage({
      type: "voice_stop",
      id: "stop-1",
      context: baseContext,
      capabilities: [],
    });
    const sentBeforeStaleResult = socket.sent.length;
    await session.handleEditorMessage({
      type: "tool_result",
      request_id: toolCall.request_id,
      ok: true,
      output: { ok: true },
    });

    assert.equal(socket.sent.length, sentBeforeStaleResult);
    assert.equal(statuses(messages).at(-1), "stopped");
  });

  it("feeds feedback to the TTS controller and cancels it on stop and shutdown", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const tts = new FakeTts();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder,
      createSocket: () => socket,
      tts,
    });

    await session.handleEditorMessage({
      type: "text_command",
      id: "text-1",
      text: "go to line 4",
      context: baseContext,
      capabilities: [],
    });

    assert.ok(tts.feedback.some((event) => event.kind === "intent"));

    const cancelsBeforeStop = tts.cancels;
    await session.handleEditorMessage({
      type: "voice_stop",
      id: "stop-1",
      context: baseContext,
      capabilities: [],
    });
    assert.ok(tts.cancels > cancelsBeforeStop, "voice_stop should cancel active speech");

    session.shutdown();
    assert.equal(tts.shutdowns, 1);
  });

  it("can smoke-test TTS through the bridge controller", async () => {
    const messages: BridgeOutboundMessage[] = [];
    const tts = new FakeTts();
    const session = new RealtimeEditorSession((message) => messages.push(message), {
      recorder: new FakeRecorder(),
      createSocket: () => new FakeSocket(),
      tts,
    });

    await session.handleEditorMessage({
      type: "tts_smoke",
      id: "tts-1",
      text: "Testing in-editor speech.",
    });

    assert.deepEqual(tts.spoken, ["Testing in-editor speech."]);
    assert.equal(statuses(messages).at(-1), "TTS smoke queued: Testing in-editor speech.");
  });
});
