import { ElevenLabsSynthesizer } from "./elevenlabs.js";
import { AfplayPlayer } from "./player.js";
import { DEFAULT_ELEVENLABS_MODEL_ID, DEFAULT_ELEVENLABS_OUTPUT_FORMAT } from "./types.js";

// Manual smoke test for spoken feedback. Hits the real ElevenLabs API and plays
// the result locally, isolating the synthesizer + player from the editor path.
//
//   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... npm run tts:smoke
//   npm run tts:smoke -- "Going to line. Done." <voice-id>
//   npm run tts:smoke -- <voice-id>
async function main(): Promise<void> {
  const { text, voiceArg } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = voiceArg ?? process.env.ELEVENLABS_VOICE_ID;
  const modelId = envText(process.env.ELEVENLABS_MODEL_ID) ?? DEFAULT_ELEVENLABS_MODEL_ID;
  const outputFormat = envText(process.env.ELEVENLABS_OUTPUT_FORMAT) ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
  const requestTimeoutMs = envNumber(process.env.CODY_TTS_REQUEST_TIMEOUT_MS, 10_000);

  if (!apiKey) {
    console.error("Set ELEVENLABS_API_KEY in this shell first.");
    process.exit(1);
  }
  if (!voiceId) {
    console.error("Pass a voice id as the 2nd argument or set ELEVENLABS_VOICE_ID.");
    process.exit(1);
  }

  const synthesizer = new ElevenLabsSynthesizer({ apiKey, voiceId, modelId, outputFormat, requestTimeoutMs });
  console.log(
    `Synthesizing "${text}" (voice ${voiceId}, model ${modelId}, format ${outputFormat}, timeout ${requestTimeoutMs}ms)...`,
  );

  const audio = await synthesizer.synthesize(text, new AbortController().signal);
  console.log(`Received ${audio.length} bytes; playing…`);

  await new AfplayPlayer().play(audio);
  console.log("Played.");
}

function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseArgs(args: string[]): { text: string; voiceArg?: string } {
  const defaultText = "Cody spoken feedback is working. Done.";
  const [first, second] = args;
  if (first && !second && looksLikeVoiceId(first)) {
    return { text: defaultText, voiceArg: first };
  }
  return { text: first ?? defaultText, voiceArg: second };
}

function looksLikeVoiceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{18,}$/.test(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
