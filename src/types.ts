export type EditorCursor = {
  line: number;
  column: number;
};

export type EditorRange = {
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
};

export type EditorSelection = {
  mode: string;
  range: EditorRange;
  text: string;
  line_count: number;
};

export type EditorDiagnostic = {
  file: string;
  line: number;
  column: number;
  end_line?: number;
  end_column?: number;
  severity?: number | string;
  source?: string;
  code?: string | number;
  message: string;
};

export type EditorLspClient = {
  id?: number;
  name: string;
  capabilities: string[];
};

export type EditorCapabilitySnapshot = {
  available: string[];
  unavailable: string[];
};

export type EditorBufferLine = {
  line: number;
  text: string;
  cursor?: boolean;
  text_with_cursor?: string;
};

export type EditorBufferSnapshot = {
  bufnr?: number;
  name: string;
  relative_name: string;
  line_count: number;
  start_line: number;
  end_line: number;
  truncated: boolean;
  omitted_lines: number;
  max_lines: number;
  max_bytes: number;
  lines: EditorBufferLine[];
};

export type EditorWindowSnapshot = {
  winid?: number;
  tabpage?: number;
  mode: string;
};

export type EditorContext = {
  cwd: string;
  file: string;
  relative_file: string;
  filetype: string;
  cursor: EditorCursor;
  line_count: number;
  current_line: string;
  current_line_with_cursor: string;
  cursor_word: string;
  cursor_char: string;
  line_before_cursor: string;
  line_after_cursor: string;
  surrounding: {
    start_line: number;
    end_line: number;
    lines: string[];
  };
  selection?: EditorSelection | null;
  diagnostics?: {
    near_cursor: EditorDiagnostic[];
    current_file: EditorDiagnostic[];
  };
  lsp_clients?: EditorLspClient[];
  cody_capabilities?: EditorCapabilitySnapshot;
  current_buffer?: EditorBufferSnapshot;
  window?: EditorWindowSnapshot;
};

export type BridgeCapability = {
  id: string;
  source: "native" | "lsp" | "picker" | "ai_edit";
  provider: string;
  action: string;
  description: string;
  available: boolean;
  status: "available" | "installed_not_loaded" | "missing";
  invoke: Record<string, unknown>;
  install_repo?: string;
  tool_schema?: Record<string, unknown>;
};

export type StaticEditorToolName =
  | "editor_get_context"
  | "editor_go_to_line"
  | "editor_go_to_file"
  | "editor_get_buffer_slice"
  | "editor_replace_line"
  | "editor_replace_range"
  | "editor_insert_at_cursor"
  | "editor_locate_cursor_symbol"
  | "editor_locate_current_function"
  | "editor_locate_text"
  | "editor_locate_file"
  | "editor_locate_diagnostic"
  | "editor_run_command"
  | "editor_command"
  | "cody_stop_voice_session";

export type EditorToolName = string;

export type EditorInboundMessage =
  | {
      type: "editor_context";
      context: EditorContext;
    }
  | {
      type: "capabilities";
      capabilities: BridgeCapability[];
    }
  | {
      type: "text_command";
      id: string;
      text: string;
      context: EditorContext;
      capabilities?: BridgeCapability[];
    }
  | {
      type: "voice_start";
      id: string;
      context: EditorContext;
      capabilities?: BridgeCapability[];
    }
  | {
      type: "voice_session_start";
      id: string;
      context: EditorContext;
      capabilities?: BridgeCapability[];
    }
  | {
      type: "voice_press";
      id: string;
      context: EditorContext;
      capabilities?: BridgeCapability[];
    }
  | {
      type: "voice_release";
      id: string;
      context: EditorContext;
      capabilities?: BridgeCapability[];
    }
  | {
      type: "voice_stop";
      id: string;
      context: EditorContext;
      capabilities?: BridgeCapability[];
    }
  | {
      type: "tts_status";
      id: string;
    }
  | {
      type: "tts_smoke";
      id: string;
      text?: string;
    }
  | {
      type: "tool_result";
      request_id: string;
      ok: boolean;
      output: unknown;
    }
  | {
      type: "shutdown";
    };

export type CodyFeedbackEvent = {
  kind: "phase" | "intent" | "transcript" | "action" | "result" | "message";
  phase?: string;
  message?: string;
  detail?: string;
  name?: EditorToolName;
  arguments?: Record<string, unknown>;
  ok?: boolean;
  final?: boolean;
  append?: boolean;
};

export type BridgeOutboundMessage =
  | {
      type: "status";
      message: string;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "assistant_delta";
      delta: string;
    }
  | {
      type: "assistant_message";
      message: string;
    }
  | {
      type: "feedback";
      event: CodyFeedbackEvent;
    }
  | {
      type: "tool_call";
      request_id: string;
      name: EditorToolName;
      arguments: Record<string, unknown>;
    };

export type PendingToolRequest = {
  origin: "local" | "realtime";
  callId?: string;
  name: string;
  turnId?: number;
  intent?: string;
};
