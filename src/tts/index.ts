import type { CodyFeedbackEvent } from "../types.js";
import { ElevenLabsSynthesizer } from "./elevenlabs.js";
import { AfplayPlayer } from "./player.js";
import { loadTtsConfig, type AudioPlayer, type SpeechSynthesizer, type TtsConfig, type TtsController } from "./types.js";

export { loadTtsConfig } from "./types.js";
export type { AudioPlayer, SpeechSynthesizer, TtsConfig, TtsController } from "./types.js";

type SpeechDecision = {
  cancel: boolean;
  text: string | null;
};

const ACTION_PHRASES: Record<string, string> = {
  editor_replace_range: "Editing range.",
  editor_replace_line: "Editing line.",
  editor_insert_at_cursor: "Inserting text.",
  editor_go_to_line: "Going to line.",
  editor_go_to_file: "Opening file.",
  lsp_rename: "Renaming.",
  lsp_code_action: "Applying code action.",
  lsp_references: "Finding references.",
  lsp_definition: "Going to definition.",
  cody_stop_voice_session: "Stopping voice session.",
  editor_run_command: "Running command.",
  editor_command: "Running editor command.",
};

// Reads and locators are internal lookups, not high-signal edits, so we stay
// quiet about them even when action speech is enabled.
const SILENT_ACTIONS = new Set([
  "editor_get_context",
  "editor_get_buffer_slice",
  "editor_locate_cursor_symbol",
  "editor_locate_current_function",
  "editor_locate_text",
  "editor_locate_file",
  "editor_locate_diagnostic",
]);

const REASON_MAX_CHARS = 80;
const CACHEABLE_TEXT_MAX_CHARS = 120;
const AUDIO_CACHE_MAX_ITEMS = 40;

function humanizeAction(name: string): string {
  const cleaned = name
    .replace(/^(editor|lsp|picker|cody|ai)_/, "")
    .replace(/_/g, " ")
    .trim();
  if (!cleaned) {
    return "Running a command.";
  }
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}.`;
}

function actionPhrase(name: string | undefined): string | null {
  if (!name || SILENT_ACTIONS.has(name)) {
    return null;
  }
  return ACTION_PHRASES[name] ?? humanizeAction(name);
}

function shortReason(message: string | undefined): string {
  const cleaned = (message ?? "")
    .replace(/^failed:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.length > REASON_MAX_CHARS ? `${cleaned.slice(0, REASON_MAX_CHARS - 1)}…` : cleaned;
}

function failureText(reason: string): string {
  return reason ? `Failed: ${reason}.` : "Failed.";
}

/**
 * Pure mapping from a feedback event to a speech decision. Each spoken concept
 * has a single source so we never double-announce:
 *   - listening / thinking -> phase events (speakPhases)
 *   - tool announcements    -> action events (speakActions)
 *   - done / failed         -> result events (speakResults)
 *   - prose                 -> message events (speakMessages)
 * `failed` and `stopped` also cancel whatever is currently playing.
 */
export function decideSpeech(event: CodyFeedbackEvent, config: TtsConfig): SpeechDecision {
  switch (event.kind) {
    case "intent":
      // A fresh turn started; drop any stale speech, say nothing.
      return { cancel: true, text: null };
    case "transcript":
      // Live transcription deltas are never spoken.
      return { cancel: false, text: null };
    case "phase": {
      if (event.phase === "stopped") {
        return { cancel: true, text: null };
      }
      if (event.phase === "failed") {
        return { cancel: true, text: config.speakResults ? failureText(shortReason(event.detail)) : null };
      }
      if (!config.speakPhases) {
        return { cancel: false, text: null };
      }
      if (event.phase === "listening") {
        return { cancel: false, text: "Listening." };
      }
      if (event.phase === "thinking") {
        return { cancel: false, text: "Thinking." };
      }
      return { cancel: false, text: null };
    }
    case "action":
      return { cancel: false, text: config.speakActions ? actionPhrase(event.name) : null };
    case "result": {
      if (event.ok === false) {
        return { cancel: true, text: config.speakResults ? failureText(shortReason(event.message)) : null };
      }
      return { cancel: false, text: config.speakResults ? "Done." : null };
    }
    case "message": {
      // `append` marks a streamed delta; only speak complete messages.
      if (event.append) {
        return { cancel: false, text: null };
      }
      const message = (event.message ?? "").trim();
      if (!config.speakMessages || !message || message.length > config.messageMaxChars) {
        return { cancel: false, text: null };
      }
      return { cancel: false, text: message };
    }
    default:
      return { cancel: false, text: null };
  }
}

/**
 * Drives spoken feedback. Speaks a curated subset of feedback events, plays
 * them one at a time, and cancels instantly on a new turn, stop, or failure.
 */
export class CodyTtsController implements TtsController {
  private queue: string[] = [];
  private draining = false;
  private generation = 0;
  private activeRequest: AbortController | undefined;
  private lastSpoken: string | undefined;
  private readonly audioCache = new Map<string, Buffer>();

  constructor(
    private readonly config: TtsConfig,
    private readonly synthesizer: SpeechSynthesizer,
    private readonly player: AudioPlayer,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  speak(text: string): void {
    if (!this.config.enabled) {
      return;
    }
    const trimmed = text.trim();
    if (trimmed) {
      this.enqueue(trimmed);
    }
  }

  handleFeedback(event: CodyFeedbackEvent): void {
    if (!this.config.enabled) {
      return;
    }

    const decision = decideSpeech(event, this.config);
    if (decision.cancel) {
      this.cancel();
    }
    if (decision.text) {
      this.enqueue(decision.text);
    }
  }

  cancel(): void {
    this.generation += 1;
    this.queue = [];
    this.lastSpoken = undefined;
    this.activeRequest?.abort();
    this.activeRequest = undefined;
    this.player.stop();
  }

  shutdown(): void {
    this.cancel();
  }

  private enqueue(text: string): void {
    // Collapse immediate repeats (e.g. a result and a phase that both resolve
    // to the same phrase) so we never say the same thing twice in a row.
    if (text === this.lastSpoken && this.queue.length === 0) {
      return;
    }
    if (this.queue[this.queue.length - 1] === text) {
      return;
    }
    this.queue.push(text);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    const generation = this.generation;

    try {
      while (this.queue.length > 0 && generation === this.generation) {
        const text = this.queue.shift() as string;
        let request: AbortController | undefined;

        let audio = this.audioCache.get(text);
        if (!audio) {
          request = new AbortController();
          this.activeRequest = request;

          try {
            audio = await this.synthesizer.synthesize(text, request.signal);
            this.rememberAudio(text, audio);
          } catch (error) {
            if (request.signal.aborted || generation !== this.generation) {
              break;
            }
            this.onError(`TTS synthesis failed: ${describeError(error)}`);
            continue;
          }
        }

        if (generation !== this.generation || request?.signal.aborted) {
          break;
        }

        this.lastSpoken = text;
        try {
          await this.player.play(audio);
        } catch (error) {
          if (generation !== this.generation) {
            break;
          }
          this.onError(`TTS playback failed: ${describeError(error)}`);
        }
      }
    } finally {
      this.draining = false;
      if (this.activeRequest && generation === this.generation) {
        this.activeRequest = undefined;
      }
      // A cancel that landed mid-drain may have enqueued fresh speech under the
      // new generation; pick it up now that the old loop has unwound.
      if (this.queue.length > 0 && generation !== this.generation) {
        void this.drain();
      }
    }
  }

  private rememberAudio(text: string, audio: Buffer): void {
    if (text.length > CACHEABLE_TEXT_MAX_CHARS) {
      return;
    }
    if (this.audioCache.has(text)) {
      this.audioCache.delete(text);
    }
    this.audioCache.set(text, audio);

    while (this.audioCache.size > AUDIO_CACHE_MAX_ITEMS) {
      const oldest = this.audioCache.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.audioCache.delete(oldest);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a TTS controller from the environment, or returns undefined when TTS
 * is disabled or misconfigured (so the bridge runs unchanged by default).
 */
export function createTtsControllerFromEnv(
  onError: (message: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
): TtsController | undefined {
  const config = loadTtsConfig(env);
  if (!config.enabled) {
    return undefined;
  }

  if (!config.apiKey) {
    onError("CODY_TTS_ENABLED is set but ELEVENLABS_API_KEY is missing; spoken feedback is off.");
    return undefined;
  }
  if (!config.voiceId) {
    onError("CODY_TTS_ENABLED is set but ELEVENLABS_VOICE_ID is missing; spoken feedback is off.");
    return undefined;
  }

  const synthesizer = new ElevenLabsSynthesizer({
    apiKey: config.apiKey,
    voiceId: config.voiceId,
    modelId: config.modelId,
    outputFormat: config.outputFormat,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const player = new AfplayPlayer();
  return new CodyTtsController(config, synthesizer, player, onError);
}
