import {
  DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
  type SpeechSynthesizer,
} from "./types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ElevenLabsOptions = {
  apiKey: string;
  voiceId: string;
  // Optional. Cody's env loader defaults to eleven_flash_v2_5 for low-latency
  // conversational feedback.
  modelId?: string;
  // Optional. Defaults to a small MP3 payload that afplay can play directly on
  // macOS.
  outputFormat?: string;
  requestTimeoutMs?: number;
  baseUrl?: string;
  fetch?: FetchLike;
};

export type ElevenLabsVoice = {
  voice_id: string;
  name?: string;
  category?: string;
  description?: string;
  labels?: Record<string, unknown>;
};

export type ElevenLabsVoiceListOptions = {
  apiKey: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetch?: FetchLike;
};

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Synthesizes speech with the ElevenLabs text-to-speech REST endpoint:
 *   POST /v1/text-to-speech/{voice_id}
 * Auth is the `xi-api-key` header. The request is cancellable via the abort
 * signal so an in-flight clip can be dropped the moment a new turn starts.
 */
export class ElevenLabsSynthesizer implements SpeechSynthesizer {
  private readonly baseUrl: string;
  private readonly outputFormat: string;
  private readonly requestTimeoutMs: number;
  private readonly fetcher: FetchLike;

  constructor(private readonly options: ElevenLabsOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.outputFormat = options.outputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetcher = options.fetch ?? fetch;
  }

  async synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.options.voiceId)}?output_format=${encodeURIComponent(this.outputFormat)}`;

    const body: Record<string, unknown> = { text };
    if (this.options.modelId) {
      body.model_id = this.options.modelId;
    }

    const request = timeoutSignal(signal, this.requestTimeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.options.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });

      if (!response.ok) {
        const detail = await responseDetail(response);
        throw new Error(
          `ElevenLabs request failed (${response.status})${statusHint(response.status)}${detail ? `: ${detail}` : ""}`,
        );
      }

      const audio = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !isAudioContentType(contentType)) {
        const preview = audio.toString("utf8", 0, Math.min(audio.length, 200)).trim();
        throw new Error(
          `ElevenLabs returned '${contentType}' instead of audio${preview ? `: ${preview}` : ""}`,
        );
      }
      if (audio.length === 0) {
        throw new Error("ElevenLabs returned an empty audio response.");
      }
      return audio;
    } catch (error) {
      if (request.timedOut()) {
        throw new Error(`ElevenLabs request timed out after ${this.requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      request.cleanup();
    }
  }
}

export async function listElevenLabsVoices(options: ElevenLabsVoiceListOptions): Promise<ElevenLabsVoice[]> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetcher = options.fetch ?? fetch;
  const voices: ElevenLabsVoice[] = [];
  let nextPageToken: string | undefined;

  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${baseUrl}/v2/voices`);
    url.searchParams.set("page_size", "100");
    url.searchParams.set("include_total_count", "false");
    if (nextPageToken) {
      url.searchParams.set("next_page_token", nextPageToken);
    }

    const request = timeoutSignal(undefined, requestTimeoutMs);
    try {
      const response = await fetcher(url, {
        headers: {
          "xi-api-key": options.apiKey,
          Accept: "application/json",
        },
        signal: request.signal,
      });

      if (!response.ok) {
        const detail = await responseDetail(response);
        throw new Error(
          `ElevenLabs voices request failed (${response.status})${statusHint(response.status)}${detail ? `: ${detail}` : ""}`,
        );
      }

      const data = (await response.json()) as unknown;
      voices.push(...extractVoices(data));

      if (!isRecord(data) || data.has_more !== true || typeof data.next_page_token !== "string") {
        break;
      }
      nextPageToken = data.next_page_token;
    } catch (error) {
      if (request.timedOut()) {
        throw new Error(`ElevenLabs voices request timed out after ${requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      request.cleanup();
    }
  }

  return voices;
}

function timeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  let timeout: NodeJS.Timeout | undefined;

  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
    timedOut: () => didTimeout,
  };
}

function isAudioContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("audio/") || normalized.startsWith("application/octet-stream");
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) {
    return " (check your API key and voice access)";
  }
  if (status === 402) {
    return " (ElevenLabs billing, quota, or plan access issue)";
  }
  if (status === 429) {
    return " (ElevenLabs rate limit)";
  }
  return "";
}

async function responseDetail(response: Response): Promise<string> {
  const raw = (await response.text().catch(() => "")).trim();
  if (!raw) {
    return "";
  }

  const parsed = parseJson(raw);
  if (parsed) {
    const jsonMessage = findJsonMessage(parsed);
    if (jsonMessage) {
      return jsonMessage.slice(0, 300);
    }
  }

  return raw.slice(0, 300);
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function findJsonMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["message", "detail", "error", "status"]) {
    const field = value[key];
    const message = findJsonMessage(field);
    if (message) {
      return message;
    }
  }

  return undefined;
}

function extractVoices(data: unknown): ElevenLabsVoice[] {
  const maybeVoices = Array.isArray(data) ? data : isRecord(data) ? data.voices : undefined;
  if (!Array.isArray(maybeVoices)) {
    throw new Error("ElevenLabs voices response did not include a voices array.");
  }

  return maybeVoices.flatMap((voice) => {
    if (!isRecord(voice) || typeof voice.voice_id !== "string") {
      return [];
    }
    return [
      {
        voice_id: voice.voice_id,
        name: typeof voice.name === "string" ? voice.name : undefined,
        category: typeof voice.category === "string" ? voice.category : undefined,
        description: typeof voice.description === "string" ? voice.description : undefined,
        labels: isRecord(voice.labels) ? voice.labels : undefined,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
