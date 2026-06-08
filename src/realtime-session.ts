import WebSocket from "ws";
import { SoxRecorder } from "./audio/sox-recorder.js";
import { capabilitySignature, generateTools } from "./tools/index.js";
import { composeInstructions } from "./prompt.js";
import { parseQuickCommand } from "./quick-commands.js";
import { createTtsControllerFromEnv, loadTtsConfig, type TtsController } from "./tts/index.js";
import type {
  BridgeCapability,
  BridgeOutboundMessage,
  CodyFeedbackEvent,
  EditorContext,
  EditorInboundMessage,
  EditorToolName,
  PendingToolRequest,
} from "./types.js";

type RealtimeOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{
    type?: string;
    text?: string;
    transcript?: string;
  }>;
};

type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  error?: {
    message?: string;
  };
  response?: {
    output?: RealtimeOutputItem[];
  };
};

const DEFAULT_MODEL = "gpt-realtime-2";
const MIN_VOICE_AUDIO_BYTES = 2400;
const TURN_MEMORY_LIMIT = 10;
type QuickCommandMode = "fallback" | "always" | "off";
type VoiceSessionState =
  | "idle"
  | "listening"
  | "finalizing"
  | "planning"
  | "executing"
  | "responding"
  | "stopping"
  | "failed";
type VoiceMode = "one_shot" | "persistent" | "push_to_talk";

type RecorderLike = {
  start(options: {
    onAudio: (chunk: Buffer) => void;
    onError: (message: string) => void;
  }): void;
  stop(): void;
};

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
};

type RealtimeSessionDeps = {
  recorder?: RecorderLike;
  createSocket?: (url: string, options: { headers: Record<string, string> }) => SocketLike;
  tts?: TtsController;
};

type TurnMemory = {
  intent: string;
  action: string;
  result: string;
};

function quickCommandMode(): QuickCommandMode {
  const mode = process.env.CODY_QUICK_COMMANDS;
  return mode === "always" || mode === "off" || mode === "fallback" ? mode : "fallback";
}

function readShellEnabled(): boolean {
  const value = (process.env.CODY_ENABLE_SHELL ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readCommandsEnabled(): boolean {
  const value = (process.env.CODY_ENABLE_COMMANDS ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export class RealtimeEditorSession {
  private websocket: SocketLike | undefined;
  private latestContext: EditorContext | undefined;
  private latestCapabilities: BridgeCapability[] = [];
  private currentToolSignature: string | undefined;
  private pendingToolRequests = new Map<string, PendingToolRequest>();
  private readonly recorder: RecorderLike;
  private readonly createSocket: (url: string, options: { headers: Record<string, string> }) => SocketLike;
  private hasWarnedMissingApiKey = false;
  private hasActiveResponse = false;
  private state: VoiceSessionState = "idle";
  private voiceMode: VoiceMode | undefined;
  private speechDetected = false;
  private voiceAudioBytes = 0;
  private currentTurnId = 0;
  private activeIntent: string | undefined;
  private turnMemory: TurnMemory[] = [];
  private readonly tts: TtsController | undefined;
  private readonly shellEnabled = readShellEnabled();
  private readonly commandsEnabled = readCommandsEnabled();

  constructor(
    private readonly sendToEditor: (message: BridgeOutboundMessage) => void,
    deps: RealtimeSessionDeps = {},
  ) {
    this.recorder = deps.recorder ?? new SoxRecorder();
    this.createSocket = deps.createSocket ?? ((url, options) => new WebSocket(url, options));
    this.tts =
      deps.tts ??
      createTtsControllerFromEnv((message) => this.sendToEditor({ type: "status", message }));
  }

  async handleEditorMessage(message: EditorInboundMessage): Promise<void> {
    if ("context" in message) {
      this.latestContext = message.context;
    }
    if ("capabilities" in message && message.capabilities) {
      this.updateCapabilities(message.capabilities);
    }

    switch (message.type) {
      case "editor_context":
        if (this.state === "listening") {
          this.updateVoiceInstructions();
        }
        return;
      case "capabilities":
        return;
      case "text_command":
        await this.handleTextCommand(message.text, message.context);
        return;
      case "voice_start":
        await this.handleVoiceStart("one_shot");
        return;
      case "voice_session_start":
        await this.handleVoiceStart("persistent");
        return;
      case "voice_press":
        await this.handleVoiceStart("push_to_talk");
        return;
      case "voice_release":
        this.handleVoiceRelease();
        return;
      case "voice_stop":
        this.handleVoiceStop();
        return;
      case "tts_status":
        this.sendLiteralStatus(this.describeTtsStatus());
        return;
      case "tts_smoke":
        this.handleTtsSmoke(message.text);
        return;
      case "tool_result":
        this.handleToolResult(message.request_id, message.ok, message.output);
        return;
      case "shutdown":
        this.shutdown();
        return;
    }
  }

  private async handleTextCommand(text: string, context: EditorContext): Promise<void> {
    this.interruptForNewTurn();

    const mode = quickCommandMode();
    const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
    const shouldTryQuickCommand = mode === "always" || (mode === "fallback" && !hasApiKey);
    const quickCommand = shouldTryQuickCommand ? parseQuickCommand(text, context) : undefined;

    if (quickCommand) {
      this.beginTurn(text);
      this.sendFeedback({
        kind: "intent",
        message: text,
      });
      this.sendLocalToolCall(quickCommand.name, quickCommand.arguments, text);
      return;
    }

    const connected = await this.ensureConnected();
    if (!connected) {
      return;
    }

    this.beginTurn(text);
    this.sendFeedback({
      kind: "intent",
      message: text,
    });
    this.syncTools();
    this.transition("planning");

    this.sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: this.buildUserText(text, context),
          },
        ],
      },
    });

    this.createResponse({
      output_modalities: ["text"],
    });
  }

  private async handleVoiceStart(mode: VoiceMode): Promise<void> {
    if (this.state === "listening") {
      this.stopVoiceRecorder();
    }
    this.interruptForNewTurn();

    const connected = await this.ensureConnected();
    if (!connected) {
      return;
    }

    this.beginTurn(mode === "persistent" ? "persistent voice" : "voice");
    this.sendFeedback({
      kind: "intent",
      message: mode === "persistent" ? "persistent voice session" : "voice command",
    });
    this.voiceMode = mode;
    this.speechDetected = false;
    this.voiceAudioBytes = 0;
    this.sendRealtimeEvent({ type: "input_audio_buffer.clear" });
    this.updateVoiceInstructions();

    this.recorder.start({
      onAudio: (chunk) => {
        this.voiceAudioBytes += chunk.byteLength;
        this.sendRealtimeEvent({
          type: "input_audio_buffer.append",
          audio: chunk.toString("base64"),
        });
      },
      onError: (message) => {
        this.transition("failed", message);
      },
    });
    this.transition("listening");
  }

  private handleVoiceStop(): void {
    this.stopActiveTurn(true);
  }

  private handleTtsSmoke(text: string | undefined): void {
    if (!this.tts) {
      this.sendLiteralStatus(this.describeTtsStatus());
      return;
    }

    const phrase = text?.trim() || "Cody spoken feedback is working. Done.";
    this.tts.speak(phrase);
    this.sendLiteralStatus(`TTS smoke queued: ${phrase}`);
  }

  private handleVoiceRelease(): void {
    if (this.voiceMode !== "push_to_talk" && this.voiceMode !== "one_shot") {
      this.sendLiteralStatus("stopped");
      return;
    }

    this.stopVoiceRecorder();

    if (this.voiceAudioBytes < MIN_VOICE_AUDIO_BYTES && !this.speechDetected) {
      this.sendRealtimeEvent({ type: "input_audio_buffer.clear" });
      this.finishTurn();
      return;
    }

    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      this.transition("failed", "not connected");
      return;
    }

    this.transition("finalizing");
    this.sendRealtimeEvent({ type: "input_audio_buffer.commit" });
    this.createResponse({
      output_modalities: ["text"],
      instructions: this.voiceContextInstructions(),
    });
  }

  private updateCapabilities(capabilities: BridgeCapability[]): void {
    this.latestCapabilities = capabilities;
    if (this.state === "listening") {
      this.updateVoiceInstructions();
      return;
    }

    this.syncTools();
  }

  private handleToolResult(requestId: string, ok: boolean, output: unknown): void {
    const pending = this.pendingToolRequests.get(requestId);
    this.pendingToolRequests.delete(requestId);

    if (!pending) {
      return;
    }
    if (pending.turnId !== undefined && pending.turnId !== this.currentTurnId) {
      return;
    }

    this.recordTurnMemory({
      intent: pending.intent || this.activeIntent || "(unknown)",
      action: pending.name,
      result: ok ? this.summarizeResult(output) : `failed: ${this.summarizeResult(output)}`,
    });
    this.sendFeedback({
      kind: "result",
      name: pending.name,
      ok,
      message: ok ? this.summarizeResult(output) : `failed: ${this.summarizeResult(output)}`,
    });

    if (pending.origin === "local") {
      if (ok) {
        this.finishTurn();
      } else {
        this.transition("failed", this.summarizeResult(output));
      }
      return;
    }

    if (!pending.callId) {
      return;
    }

    this.sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: pending.callId,
        output: JSON.stringify({
          ok,
          result: output,
        }),
      },
    });

    this.transition("planning");
    this.createResponse({
      output_modalities: ["text"],
    });
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.websocket?.readyState === WebSocket.OPEN) {
      return true;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      if (!this.hasWarnedMissingApiKey) {
        const quickNote = quickCommandMode() === "off" ? "" : " Quick local commands still work.";
        this.sendToEditor({
          type: "error",
          message: `OPENAI_API_KEY is not set.${quickNote}`,
        });
        this.hasWarnedMissingApiKey = true;
      }
      return false;
    }

    const model = process.env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL;
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    this.websocket = this.createSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.OPENAI_SAFETY_IDENTIFIER
          ? { "OpenAI-Safety-Identifier": process.env.OPENAI_SAFETY_IDENTIFIER }
          : {}),
      },
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.websocket) {
        reject(new Error("websocket was not created"));
        return;
      }

      if (this.websocket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.websocket.once("open", () => resolve());
      this.websocket.once("error", (error) => reject(error));
    }).catch((error: unknown) => {
      this.sendToEditor({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });

    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.websocket.on("message", (data) => {
      this.handleRealtimeMessage(String(data));
    });

    this.websocket.on("close", () => {
      this.sendToEditor({
        type: "status",
        message: "Realtime session closed",
      });
    });

    this.websocket.on("error", (error) => {
      this.sendToEditor({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });

    this.configureSession(model);
    this.sendToEditor({
      type: "status",
      message: `Realtime connected (${model})`,
    });

    return true;
  }

  private configureSession(model: string): void {
    this.currentToolSignature = capabilitySignature(this.latestCapabilities);
    this.sendRealtimeEvent({
      type: "session.update",
      session: {
        type: "realtime",
        model,
        instructions: composeInstructions(this.latestCapabilities),
        output_modalities: ["text"],
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 650,
              create_response: true,
              interrupt_response: true,
            },
          },
        },
        tools: generateTools(this.latestCapabilities, { shellEnabled: this.shellEnabled, commandsEnabled: this.commandsEnabled }),
        tool_choice: "auto",
      },
    });
  }

  private syncTools(): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const signature = capabilitySignature(this.latestCapabilities);
    if (signature === this.currentToolSignature) {
      return;
    }

    this.currentToolSignature = signature;
    this.sendRealtimeEvent({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: composeInstructions(this.latestCapabilities),
        tools: generateTools(this.latestCapabilities, { shellEnabled: this.shellEnabled, commandsEnabled: this.commandsEnabled }),
        tool_choice: "auto",
      },
    });
  }

  private handleRealtimeMessage(rawMessage: string): void {
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(rawMessage) as RealtimeServerEvent;
    } catch {
      this.sendToEditor({
        type: "error",
        message: `Invalid Realtime event: ${rawMessage}`,
      });
      return;
    }

    if (event.type === "error") {
      const message = event.error?.message || "Unknown Realtime error";
      if (/cancellation failed/i.test(message) && /no active response/i.test(message)) {
        this.hasActiveResponse = false;
        return;
      }

      this.sendToEditor({
        type: "error",
        message,
      });
      this.transition("failed", message);
      return;
    }

    if (this.isAssistantTextDeltaEvent(event) && event.delta) {
      this.sendToEditor({
        type: "assistant_delta",
        delta: event.delta,
      });
      return;
    }

    if (this.isTranscriptEvent(event)) {
      const transcript = event.delta || event.transcript || event.text;
      if (transcript) {
        this.sendFeedback({
          kind: "transcript",
          message: transcript,
          final: this.isFinalTranscriptEvent(event),
        });
      }
      return;
    }

    if (event.type === "response.created") {
      this.hasActiveResponse = true;
      this.transition("planning");
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      this.speechDetected = true;
      this.sendFeedback({
        kind: "phase",
        phase: "listening",
        detail: "heard speech",
      });
      this.transition("listening");
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      this.speechDetected = true;
      if (this.voiceMode !== "persistent") {
        this.stopVoiceRecorder();
      }
      this.transition("finalizing");
      return;
    }

    if (event.type === "response.done") {
      this.hasActiveResponse = false;
      this.handleResponseDone(event);
    }
  }

  private handleResponseDone(event: RealtimeServerEvent): void {
    const output = event.response?.output || [];
    const textParts: string[] = [];
    let toolCallCount = 0;

    for (const item of output) {
      if (item.type === "function_call") {
        this.sendRealtimeToolCall(item);
        toolCallCount += 1;
      }

      for (const content of item.content || []) {
        if ((content.type === "output_text" || content.type === "text") && content.text) {
          textParts.push(content.text);
        }
        if (content.transcript) {
          textParts.push(content.transcript);
        }
      }
    }

    const message = textParts.join("").trim();
    if (message) {
      this.transition("responding");
      this.sendFeedback({
        kind: "message",
        message,
      });
      this.sendToEditor({
        type: "assistant_message",
        message,
      });
    }

    if (toolCallCount === 0) {
      if (message) {
        this.recordTurnMemory({
          intent: this.activeIntent || "(unknown)",
          action: "respond",
          result: this.summarizeResult(message),
        });
      }
      this.finishTurn();
    }
  }

  private sendRealtimeToolCall(item: RealtimeOutputItem): void {
    if (!item.name || !item.call_id) {
      return;
    }

    const requestId = `rt-${item.call_id}`;
    const parsedArguments = this.parseToolArguments(item.arguments);

    this.pendingToolRequests.set(requestId, {
      origin: "realtime",
      callId: item.call_id,
      name: item.name,
      turnId: this.currentTurnId,
      intent: this.activeIntent,
    });

    this.transition("executing", item.name);
    this.sendFeedback({
      kind: "action",
      name: item.name,
      arguments: parsedArguments,
    });
    this.sendToEditor({
      type: "tool_call",
      request_id: requestId,
      name: item.name,
      arguments: parsedArguments,
    });
  }

  private sendLocalToolCall(name: EditorToolName, toolArguments: Record<string, unknown>, intent?: string): void {
    const requestId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.pendingToolRequests.set(requestId, {
      origin: "local",
      name,
      turnId: this.currentTurnId,
      intent,
    });

    this.transition("executing", name);
    this.sendFeedback({
      kind: "action",
      name,
      arguments: toolArguments,
    });
    this.sendToEditor({
      type: "tool_call",
      request_id: requestId,
      name,
      arguments: toolArguments,
    });
  }

  private sendRealtimeEvent(event: Record<string, unknown>): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.websocket.send(JSON.stringify(event));
  }

  private updateVoiceInstructions(): void {
    this.currentToolSignature = capabilitySignature(this.latestCapabilities);
    this.sendRealtimeEvent({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: `${composeInstructions(this.latestCapabilities)}\n\n${this.voiceContextInstructions()}`,
        tools: generateTools(this.latestCapabilities, { shellEnabled: this.shellEnabled, commandsEnabled: this.commandsEnabled }),
        tool_choice: "auto",
      },
    });
  }

  private voiceContextInstructions(): string {
    return this.latestContext
      ? `Use this current editor context for the spoken command:\n${this.formatEditorContext(this.latestContext)}`
      : "Use the current editor context already provided by tools if needed.";
  }

  private stopVoiceRecorder(): void {
    this.recorder.stop();
  }

  private createResponse(response: Record<string, unknown>): void {
    this.hasActiveResponse = true;
    this.sendRealtimeEvent({
      type: "response.create",
      response,
    });
  }

  private cancelActiveResponse(): void {
    if (!this.hasActiveResponse) {
      return;
    }

    this.hasActiveResponse = false;
    this.sendRealtimeEvent({ type: "response.cancel" });
  }

  private beginTurn(intent: string): number {
    this.currentTurnId += 1;
    this.activeIntent = intent;
    return this.currentTurnId;
  }

  private interruptForNewTurn(): void {
    if (this.state === "idle" && !this.hasActiveResponse && this.pendingToolRequests.size === 0) {
      return;
    }

    this.stopActiveTurn(false);
  }

  private stopActiveTurn(emitStatus: boolean): void {
    this.state = "stopping";
    this.currentTurnId += 1;
    this.pendingToolRequests.clear();
    this.tts?.cancel();
    this.stopVoiceRecorder();
    this.cancelActiveResponse();
    this.sendRealtimeEvent({ type: "input_audio_buffer.clear" });
    this.voiceMode = undefined;
    this.speechDetected = false;
    this.voiceAudioBytes = 0;
    this.activeIntent = undefined;
    this.state = "idle";

    if (emitStatus) {
      this.sendFeedback({
        kind: "phase",
        phase: "stopped",
      });
      this.sendLiteralStatus("stopped");
    }
  }

  private finishTurn(): void {
    this.hasActiveResponse = false;
    this.speechDetected = false;
    this.voiceAudioBytes = 0;
    this.activeIntent = undefined;
    this.sendFeedback({
      kind: "phase",
      phase: "done",
    });
    this.sendLiteralStatus("done");

    if (this.voiceMode === "persistent") {
      this.transition("listening");
      return;
    }

    this.voiceMode = undefined;
    this.state = "idle";
  }

  private transition(nextState: VoiceSessionState, detail?: string): void {
    this.state = nextState;
    this.sendStateStatus(nextState, detail);
  }

  private sendStateStatus(nextState: VoiceSessionState, detail?: string): void {
    this.sendFeedback({
      kind: "phase",
      phase: this.feedbackPhaseName(nextState),
      detail,
    });

    switch (nextState) {
      case "idle":
        return;
      case "listening":
        this.sendLiteralStatus("listening");
        return;
      case "finalizing":
        this.sendLiteralStatus("finalizing");
        return;
      case "planning":
        this.sendLiteralStatus("thinking");
        return;
      case "executing":
        this.sendLiteralStatus(detail ? `executing ${detail}` : "executing");
        return;
      case "responding":
        this.sendLiteralStatus("responding");
        return;
      case "stopping":
        this.sendLiteralStatus("stopped");
        return;
      case "failed":
        this.sendLiteralStatus(`failed: ${detail || "unknown error"}`);
        return;
    }
  }

  private sendLiteralStatus(message: string): void {
    this.sendToEditor({
      type: "status",
      message,
    });
  }

  private describeTtsStatus(): string {
    const config = loadTtsConfig();
    if (!config.enabled) {
      return "TTS disabled. Set tts_enabled = true in require('cody').setup(...) and restart the bridge.";
    }
    if (!config.apiKey) {
      return "TTS enabled, but ELEVENLABS_API_KEY is missing from the Neovim bridge environment.";
    }
    if (!config.voiceId) {
      return "TTS enabled, but ELEVENLABS_VOICE_ID is missing. Set tts_voice_id in setup() or export ELEVENLABS_VOICE_ID.";
    }
    if (!this.tts) {
      return "TTS env looks configured, but the controller was not initialized. Restart the Cody bridge.";
    }

    return [
      `TTS enabled: ElevenLabs voice ${config.voiceId}`,
      `model ${config.modelId}`,
      `format ${config.outputFormat}`,
      `timeout ${config.requestTimeoutMs}ms`,
    ].join(", ");
  }

  private sendFeedback(event: CodyFeedbackEvent): void {
    this.sendToEditor({
      type: "feedback",
      event,
    });
    this.tts?.handleFeedback(event);
  }

  private feedbackPhaseName(state: VoiceSessionState): string {
    if (state === "planning") {
      return "thinking";
    }
    return state;
  }

  private isTranscriptEvent(event: RealtimeServerEvent): boolean {
    const type = event.type || "";
    return /transcri(pt|ption)/i.test(type) && Boolean(event.delta || event.transcript || event.text);
  }

  private isFinalTranscriptEvent(event: RealtimeServerEvent): boolean {
    return /(completed|complete|done|final)/i.test(event.type || "");
  }

  private isAssistantTextDeltaEvent(event: RealtimeServerEvent): boolean {
    return event.type === "response.output_text.delta" || event.type === "response.text.delta";
  }

  private recordTurnMemory(memory: TurnMemory): void {
    this.turnMemory.push({
      intent: this.summarizeResult(memory.intent),
      action: memory.action,
      result: this.summarizeResult(memory.result),
    });

    if (this.turnMemory.length > TURN_MEMORY_LIMIT) {
      this.turnMemory = this.turnMemory.slice(-TURN_MEMORY_LIMIT);
    }
  }

  private summarizeResult(output: unknown): string {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    if (!text) {
      return "(empty)";
    }
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  }

  private parseToolArguments(argumentsJson: string | undefined): Record<string, unknown> {
    if (!argumentsJson) {
      return {};
    }

    try {
      const parsed = JSON.parse(argumentsJson) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private buildUserText(text: string, context: EditorContext): string {
    return `User command: ${text}

Current editor context:
${this.formatEditorContext(context)}`;
  }

  private formatCurrentBuffer(context: EditorContext): string {
    const buffer = context.current_buffer;
    if (!buffer) {
      return "(not provided)";
    }

    const lines = buffer.lines
      .map((line) => {
        const marker = line.cursor ? "=>" : "  ";
        const text = line.text_with_cursor ?? line.text;
        return `${marker} ${line.line}: ${text}`;
      })
      .join("\n");

    const truncation = buffer.truncated
      ? `truncated: true, omitted_lines: ${buffer.omitted_lines}, limits: ${buffer.max_lines} lines / ${buffer.max_bytes} bytes`
      : "truncated: false";

    return `Buffer: ${buffer.relative_name || buffer.name || "[No Name]"}
Lines: ${buffer.start_line}-${buffer.end_line} of ${buffer.line_count}
${truncation}
Numbered buffer text:
${lines}`;
  }

  private formatEditorContext(context: EditorContext): string {
    const diagnostics = context.diagnostics ?? { near_cursor: [], current_file: [] };
    const toolNames = generateTools(this.latestCapabilities, { shellEnabled: this.shellEnabled, commandsEnabled: this.commandsEnabled }).map(
      (tool) => tool.name,
    );
    const capabilities = context.cody_capabilities ?? { available: [], unavailable: [] };
    const memory = this.turnMemory.slice(-TURN_MEMORY_LIMIT);

    return `File: ${context.relative_file || context.file || "[No Name]"}
Filetype: ${context.filetype || "unknown"}
Cursor: line ${context.cursor.line}, column ${context.cursor.column}
Cursor word: ${context.cursor_word || "(none)"}
Cursor character: ${context.cursor_char || "(none)"}
Window JSON:
${JSON.stringify(context.window ?? null, null, 2)}
Current line:
${context.current_line}
Current line with cursor marker:
${context.current_line_with_cursor}
Before cursor:
${context.line_before_cursor}
After cursor:
${context.line_after_cursor}
Selection JSON:
${JSON.stringify(context.selection ?? null, null, 2)}
Attached LSP clients JSON:
${JSON.stringify(context.lsp_clients ?? [], null, 2)}
Diagnostics near cursor JSON:
${JSON.stringify(diagnostics.near_cursor, null, 2)}
Current file diagnostics JSON:
${JSON.stringify(diagnostics.current_file, null, 2)}
Available Cody tools JSON:
${JSON.stringify(toolNames, null, 2)}
Cody capability snapshot JSON:
${JSON.stringify(capabilities, null, 2)}
Current buffer snapshot:
${this.formatCurrentBuffer(context)}
Nearby lines JSON:
${JSON.stringify(context.surrounding, null, 2)}
Recent Cody turn memory JSON:
${JSON.stringify(memory, null, 2)}`;
  }

  shutdown(): void {
    this.stopActiveTurn(false);
    this.tts?.shutdown();
    this.websocket?.close();
    this.websocket = undefined;
    this.hasActiveResponse = false;
  }
}
