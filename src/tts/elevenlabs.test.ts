import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsSynthesizer, listElevenLabsVoices, type FetchLike } from "./elevenlabs.js";

describe("ElevenLabsSynthesizer", () => {
  it("posts text to the documented speech endpoint", async () => {
    let seenInput: string | URL | undefined;
    let seenInit: RequestInit | undefined;
    const fetcher: FetchLike = async (input, init) => {
      seenInput = input;
      seenInit = init;
      return new Response(Buffer.from("audio"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };

    const synthesizer = new ElevenLabsSynthesizer({
      apiKey: "key-123",
      voiceId: "voice/id",
      modelId: "eleven_flash_v2_5",
      outputFormat: "mp3_22050_32",
      fetch: fetcher,
    });

    const audio = await synthesizer.synthesize("Done.", new AbortController().signal);

    assert.equal(audio.toString(), "audio");
    assert.equal(
      String(seenInput),
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid?output_format=mp3_22050_32",
    );
    assert.equal(seenInit?.method, "POST");
    assert.deepEqual(seenInit?.headers, {
      "xi-api-key": "key-123",
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    });
    assert.deepEqual(JSON.parse(String(seenInit?.body)), {
      text: "Done.",
      model_id: "eleven_flash_v2_5",
    });
  });

  it("surfaces JSON error details from ElevenLabs", async () => {
    const fetcher: FetchLike = async () =>
      new Response(JSON.stringify({ detail: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    const synthesizer = new ElevenLabsSynthesizer({
      apiKey: "bad-key",
      voiceId: "voice",
      fetch: fetcher,
    });

    await assert.rejects(
      synthesizer.synthesize("Done.", new AbortController().signal),
      /ElevenLabs request failed \(401\) \(check your API key and voice access\): Invalid API key/,
    );
  });

  it("fails fast when the request times out", async () => {
    const fetcher: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const synthesizer = new ElevenLabsSynthesizer({
      apiKey: "key",
      voiceId: "voice",
      requestTimeoutMs: 1,
      fetch: fetcher,
    });

    await assert.rejects(
      synthesizer.synthesize("Done.", new AbortController().signal),
      /ElevenLabs request timed out after 1ms/,
    );
  });
});

describe("listElevenLabsVoices", () => {
  it("reads voices from the current v2 voices response shape", async () => {
    let seenInput: string | URL | undefined;
    const fetcher: FetchLike = async (input) => {
      seenInput = input;
      return Response.json({
        voices: [
          {
            voice_id: "UgBBYS2sOqTuMpoF3BR0",
            name: "Chosen voice",
            category: "cloned",
          },
        ],
        has_more: false,
        next_page_token: null,
      });
    };

    const voices = await listElevenLabsVoices({ apiKey: "key", fetch: fetcher });

    assert.equal(String(seenInput), "https://api.elevenlabs.io/v2/voices?page_size=100&include_total_count=false");
    assert.deepEqual(voices, [
      {
        voice_id: "UgBBYS2sOqTuMpoF3BR0",
        name: "Chosen voice",
        category: "cloned",
        description: undefined,
        labels: undefined,
      },
    ]);
  });
});
