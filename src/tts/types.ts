import type { CodyFeedbackEvent } from "../types.js";

export type TtsProvider = "elevenlabs";

export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = "mp3_22050_32";

export type TtsConfig = {
  enabled: boolean;
  provider: TtsProvider;
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  requestTimeoutMs: number;
  speakPhases: boolean;
  speakActions: boolean;
  speakResults: boolean;
  speakMessages: boolean;
  messageMaxChars: number;
};

/**
 * Turns a short string into spoken audio bytes. Implementations must honour the
 * abort signal so an in-flight request can be cancelled the moment a new turn
 * begins.
 */
export interface SpeechSynthesizer {
  synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
}

/**
 * Plays a single clip of audio bytes and resolves when playback finishes.
 * `stop` must interrupt any active playback immediately.
 */
export interface AudioPlayer {
  play(audio: Buffer): Promise<void>;
  stop(): void;
}

/**
 * Consumes the structured feedback stream and speaks the high-signal subset.
 * `cancel` stops current speech and clears anything queued; `shutdown` releases
 * resources for good.
 */
export interface TtsController {
  speak(text: string): void;
  handleFeedback(event: CodyFeedbackEvent): void;
  cancel(): void;
  shutdown(): void;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""]);

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return fallback;
}

function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Builds a TTS config from the process environment. The bridge stays silent
 * unless `CODY_TTS_ENABLED` is truthy, matching the opt-in design in the
 * handoff. The ElevenLabs API key is read from the shell environment, never
 * forwarded from Lua.
 */
export function loadTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  return {
    enabled: envFlag(env.CODY_TTS_ENABLED, false),
    provider: "elevenlabs",
    apiKey: envText(env.ELEVENLABS_API_KEY),
    voiceId: envText(env.ELEVENLABS_VOICE_ID),
    modelId: envText(env.ELEVENLABS_MODEL_ID) ?? DEFAULT_ELEVENLABS_MODEL_ID,
    outputFormat: envText(env.ELEVENLABS_OUTPUT_FORMAT) ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
    requestTimeoutMs: envNumber(env.CODY_TTS_REQUEST_TIMEOUT_MS, 10_000),
    speakPhases: envFlag(env.CODY_TTS_SPEAK_PHASES, false),
    speakActions: envFlag(env.CODY_TTS_SPEAK_ACTIONS, true),
    speakResults: envFlag(env.CODY_TTS_SPEAK_RESULTS, true),
    speakMessages: envFlag(env.CODY_TTS_SPEAK_MESSAGES, true),
    messageMaxChars: envNumber(env.CODY_TTS_MESSAGE_MAX_CHARS, 160),
  };
}
