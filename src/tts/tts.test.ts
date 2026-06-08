import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodyTtsController, decideSpeech, loadTtsConfig } from "./index.js";
import type { AudioPlayer, SpeechSynthesizer, TtsConfig } from "./types.js";

function config(overrides: Partial<TtsConfig> = {}): TtsConfig {
  return {
    enabled: true,
    provider: "elevenlabs",
    requestTimeoutMs: 10_000,
    speakPhases: true,
    speakActions: true,
    speakResults: true,
    speakMessages: true,
    messageMaxChars: 160,
    ...overrides,
  };
}

class FakeSynthesizer implements SpeechSynthesizer {
  calls: string[] = [];

  async synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) {
      throw new Error("aborted");
    }
    this.calls.push(text);
    return Buffer.from(text);
  }
}

class FakePlayer implements AudioPlayer {
  played: string[] = [];
  stops = 0;
  blocking = false;
  private pending: Array<() => void> = [];

  async play(audio: Buffer): Promise<void> {
    this.played.push(audio.toString());
    if (this.blocking) {
      await new Promise<void>((resolve) => this.pending.push(resolve));
    }
  }

  stop(): void {
    this.stops += 1;
    this.release();
  }

  release(): void {
    const pending = this.pending;
    this.pending = [];
    for (const resolve of pending) {
      resolve();
    }
  }
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("decideSpeech mapping", () => {
  it("defaults to low-latency conversational settings from env", () => {
    const cfg = loadTtsConfig({});

    assert.equal(cfg.modelId, "eleven_flash_v2_5");
    assert.equal(cfg.outputFormat, "mp3_22050_32");
    assert.equal(cfg.speakPhases, false);
    assert.equal(cfg.speakActions, true);
    assert.equal(cfg.speakResults, true);
    assert.equal(cfg.speakMessages, true);
  });

  it("speaks high-signal phases, actions, results, and short messages", () => {
    const cfg = config();
    assert.equal(decideSpeech({ kind: "phase", phase: "listening" }, cfg).text, "Listening.");
    assert.equal(decideSpeech({ kind: "phase", phase: "thinking" }, cfg).text, "Thinking.");
    assert.equal(decideSpeech({ kind: "action", name: "editor_replace_range" }, cfg).text, "Editing range.");
    assert.equal(decideSpeech({ kind: "action", name: "lsp_rename" }, cfg).text, "Renaming.");
    assert.equal(decideSpeech({ kind: "result", ok: true }, cfg).text, "Done.");
    assert.equal(decideSpeech({ kind: "message", message: "Renamed foo to bar." }, cfg).text, "Renamed foo to bar.");
  });

  it("humanizes unmapped tools and stays silent on reads/locators", () => {
    const cfg = config();
    assert.equal(decideSpeech({ kind: "action", name: "lsp_code_action" }, cfg).text, "Applying code action.");
    assert.equal(decideSpeech({ kind: "action", name: "picker_open" }, cfg).text, "Open.");
    assert.equal(decideSpeech({ kind: "action", name: "editor_get_context" }, cfg).text, null);
    assert.equal(decideSpeech({ kind: "action", name: "editor_locate_text" }, cfg).text, null);
  });

  it("announces failures and requests cancellation", () => {
    const cfg = config();
    const result = decideSpeech({ kind: "result", ok: false, message: "failed: line out of range" }, cfg);
    assert.equal(result.cancel, true);
    assert.equal(result.text, "Failed: line out of range.");

    const phase = decideSpeech({ kind: "phase", phase: "failed", detail: "not connected" }, cfg);
    assert.equal(phase.cancel, true);
    assert.equal(phase.text, "Failed: not connected.");
  });

  it("cancels without speaking on a new turn and on stop", () => {
    const cfg = config();
    assert.deepEqual(decideSpeech({ kind: "intent", message: "go to line 4" }, cfg), { cancel: true, text: null });
    assert.deepEqual(decideSpeech({ kind: "phase", phase: "stopped" }, cfg), { cancel: true, text: null });
  });

  it("ignores transcript deltas, streamed message deltas, and the done phase", () => {
    const cfg = config();
    assert.equal(decideSpeech({ kind: "transcript", message: "go to" }, cfg).text, null);
    assert.equal(decideSpeech({ kind: "message", message: "partial", append: true }, cfg).text, null);
    // `done` is covered by the result event, so the phase itself is silent.
    assert.equal(decideSpeech({ kind: "phase", phase: "done" }, cfg).text, null);
    assert.equal(decideSpeech({ kind: "phase", phase: "executing", detail: "lsp_rename" }, cfg).text, null);
  });

  it("respects per-category toggles and the message length limit", () => {
    assert.equal(decideSpeech({ kind: "phase", phase: "thinking" }, config({ speakPhases: false })).text, null);
    assert.equal(decideSpeech({ kind: "action", name: "lsp_rename" }, config({ speakActions: false })).text, null);
    assert.equal(decideSpeech({ kind: "result", ok: true }, config({ speakResults: false })).text, null);
    assert.equal(decideSpeech({ kind: "message", message: "hi" }, config({ speakMessages: false })).text, null);

    const longMessage = "x".repeat(200);
    assert.equal(decideSpeech({ kind: "message", message: longMessage }, config({ messageMaxChars: 160 })).text, null);
  });
});

describe("CodyTtsController playback", () => {
  it("does nothing when disabled", async () => {
    const synth = new FakeSynthesizer();
    const player = new FakePlayer();
    const controller = new CodyTtsController(config({ enabled: false }), synth, player);

    controller.handleFeedback({ kind: "result", ok: true });
    await tick();

    assert.equal(synth.calls.length, 0);
    assert.equal(player.played.length, 0);
  });

  it("synthesizes and plays high-signal events in order", async () => {
    const synth = new FakeSynthesizer();
    const player = new FakePlayer();
    const controller = new CodyTtsController(config(), synth, player);

    controller.handleFeedback({ kind: "phase", phase: "thinking" });
    controller.handleFeedback({ kind: "action", name: "lsp_rename" });
    await tick();

    assert.deepEqual(synth.calls, ["Thinking.", "Renaming."]);
    assert.deepEqual(player.played, ["Thinking.", "Renaming."]);
  });

  it("ignores transcripts and streamed deltas", async () => {
    const synth = new FakeSynthesizer();
    const player = new FakePlayer();
    const controller = new CodyTtsController(config(), synth, player);

    controller.handleFeedback({ kind: "transcript", message: "go to line four" });
    controller.handleFeedback({ kind: "message", message: "stream", append: true });
    await tick();

    assert.equal(synth.calls.length, 0);
    assert.equal(player.played.length, 0);
  });

  it("cancels active playback and drops queued speech on a new turn", async () => {
    const synth = new FakeSynthesizer();
    const player = new FakePlayer();
    player.blocking = true;
    const controller = new CodyTtsController(config(), synth, player);

    controller.handleFeedback({ kind: "phase", phase: "thinking" });
    controller.handleFeedback({ kind: "action", name: "lsp_rename" });
    await tick();

    // First clip is playing (blocked); the queued one has not been synthesized.
    assert.deepEqual(player.played, ["Thinking."]);
    assert.deepEqual(synth.calls, ["Thinking."]);
    assert.equal(player.stops, 0);

    controller.handleFeedback({ kind: "intent", message: "next command" });
    assert.equal(player.stops, 1);
    await tick();

    // Queued "Renaming." was dropped by the cancel.
    assert.deepEqual(player.played, ["Thinking."]);
    assert.deepEqual(synth.calls, ["Thinking."]);
  });

  it("stops playback on an explicit stop phase", async () => {
    const synth = new FakeSynthesizer();
    const player = new FakePlayer();
    player.blocking = true;
    const controller = new CodyTtsController(config(), synth, player);

    controller.handleFeedback({ kind: "result", ok: true });
    await tick();
    assert.deepEqual(player.played, ["Done."]);

    controller.handleFeedback({ kind: "phase", phase: "stopped" });
    assert.equal(player.stops, 1);
    await tick();
    assert.deepEqual(player.played, ["Done."]);
  });

  it("replays cached short clips without another synthesis request", async () => {
    const synth = new FakeSynthesizer();
    const player = new FakePlayer();
    const controller = new CodyTtsController(config(), synth, player);

    controller.handleFeedback({ kind: "result", ok: true });
    await tick();
    controller.handleFeedback({ kind: "action", name: "lsp_rename" });
    await tick();
    controller.handleFeedback({ kind: "result", ok: true });
    await tick();

    assert.deepEqual(player.played, ["Done.", "Renaming.", "Done."]);
    assert.deepEqual(synth.calls, ["Done.", "Renaming."]);
  });
});
