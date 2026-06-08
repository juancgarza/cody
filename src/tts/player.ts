import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AudioPlayer } from "./types.js";

let clipCounter = 0;

/**
 * Plays audio by writing it to a temp file and handing it to a local player
 * (`afplay` on macOS by default; override with CODY_TTS_PLAYER_COMMAND). Keeps a
 * handle to the child process so `stop` can kill it instantly on interruption.
 */
export class AfplayPlayer implements AudioPlayer {
  private process: ChildProcess | undefined;
  private readonly command: string;
  private readonly extension: string;

  constructor(command?: string, extension = "mp3") {
    this.command = command ?? process.env.CODY_TTS_PLAYER_COMMAND ?? "afplay";
    this.extension = extension;
  }

  async play(audio: Buffer): Promise<void> {
    clipCounter += 1;
    const file = path.join(os.tmpdir(), `cody-tts-${process.pid}-${clipCounter}.${this.extension}`);
    await fs.writeFile(file, audio);

    const cleanup = (): void => {
      void fs.rm(file, { force: true }).catch(() => {});
    };

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, [file], { stdio: "ignore" });
      this.process = child;

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (this.process === child) {
          this.process = undefined;
        }
        cleanup();
        if (error.code === "ENOENT") {
          reject(
            new Error(
              `Could not find '${this.command}'. Install it or set CODY_TTS_PLAYER_COMMAND to an audio player.`,
            ),
          );
          return;
        }
        reject(error);
      });

      child.on("exit", () => {
        if (this.process === child) {
          this.process = undefined;
        }
        cleanup();
        resolve();
      });
    });
  }

  stop(): void {
    if (!this.process) {
      return;
    }
    this.process.kill("SIGTERM");
    this.process = undefined;
  }
}
