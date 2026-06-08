import { listElevenLabsVoices } from "./elevenlabs.js";

// Lists voices available to the current ElevenLabs API key.
//
//   ELEVENLABS_API_KEY=... npm run tts:voices
//   ELEVENLABS_API_KEY=... npm run tts:voices -- george
async function main(): Promise<void> {
  const [search] = process.argv.slice(2);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const requestTimeoutMs = envNumber(process.env.CODY_TTS_REQUEST_TIMEOUT_MS, 10_000);

  if (!apiKey) {
    console.error("Set ELEVENLABS_API_KEY in this shell first.");
    process.exit(1);
  }

  const voices = await listElevenLabsVoices({ apiKey, requestTimeoutMs });
  const normalizedSearch = search?.trim().toLowerCase();
  const filtered = normalizedSearch
    ? voices.filter((voice) => {
        const haystack = [voice.voice_id, voice.name, voice.category, voice.description]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedSearch);
      })
    : voices;

  if (filtered.length === 0) {
    console.log(normalizedSearch ? `No voices matched "${search}".` : "No voices returned by ElevenLabs.");
    return;
  }

  for (const voice of filtered) {
    const suffix = [voice.name, voice.category].filter(Boolean).join(" - ");
    console.log(suffix ? `${voice.voice_id}\t${suffix}` : voice.voice_id);
  }
}

function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
