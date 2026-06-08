import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export type SoxRecorderOptions = {
  device?: string;
  onAudio: (chunk: Buffer) => void;
  onError: (message: string) => void;
};

function recorderStartError(command: string, error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return `Could not find '${command}'. Install SoX with 'brew install sox', or set CODY_SOX_COMMAND to a recorder binary.`;
  }

  return `Could not start sox recorder: ${error.message}`;
}

export class SoxRecorder {
  private process: ChildProcessByStdio<null, Readable, Readable> | undefined;

  start(options: SoxRecorderOptions): void {
    if (this.process) {
      return;
    }

    const command = process.env.CODY_SOX_COMMAND || "sox";
    const inputDevice = options.device || process.env.CODY_AUDIO_DEVICE || "-d";
    const args = [
      inputDevice,
      "-q",
      "-r",
      "24000",
      "-c",
      "1",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
    ];

    const recorder = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = recorder;

    recorder.stdout.on("data", (chunk: Buffer) => {
      options.onAudio(chunk);
    });

    recorder.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) {
        options.onError(message);
      }
    });

    recorder.on("error", (error: NodeJS.ErrnoException) => {
      options.onError(recorderStartError(command, error));
      this.process = undefined;
    });

    recorder.on("exit", () => {
      this.process = undefined;
    });
  }

  stop(): void {
    if (!this.process) {
      return;
    }

    this.process.kill("SIGINT");
    this.process = undefined;
  }
}
