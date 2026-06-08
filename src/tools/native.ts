import { editorGetBufferSliceTool } from "./get-buffer-slice.js";
import { editorGetContextTool } from "./get-context.js";
import { editorGoToFileTool } from "./go-to-file.js";
import { editorGoToLineTool } from "./go-to-line.js";
import { editorInsertAtCursorTool } from "./insert-at-cursor.js";
import { editorLocateCurrentFunctionTool } from "./locate-current-function.js";
import { editorLocateCursorSymbolTool } from "./locate-cursor-symbol.js";
import { editorLocateDiagnosticTool } from "./locate-diagnostic.js";
import { editorLocateFileTool } from "./locate-file.js";
import { editorLocateTextTool } from "./locate-text.js";
import { editorReplaceLineTool } from "./replace-line.js";
import { editorReplaceRangeTool } from "./replace-range.js";
import { codyStopVoiceSessionTool } from "./stop-voice-session.js";
import type { RealtimeToolDefinition } from "./schema.js";

export const STATIC_NATIVE_TOOLS: RealtimeToolDefinition[] = [
  editorGetContextTool,
  editorGoToLineTool,
  editorGoToFileTool,
  editorGetBufferSliceTool,
  editorReplaceLineTool,
  editorReplaceRangeTool,
  editorInsertAtCursorTool,
  editorLocateCursorSymbolTool,
  editorLocateCurrentFunctionTool,
  editorLocateTextTool,
  editorLocateFileTool,
  editorLocateDiagnosticTool,
  codyStopVoiceSessionTool,
];

export const EDITOR_TOOLS = STATIC_NATIVE_TOOLS;
