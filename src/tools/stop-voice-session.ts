import { objectSchema, type RealtimeToolDefinition } from "./schema.js";

export const codyStopVoiceSessionTool: RealtimeToolDefinition = {
  type: "function",
  name: "cody_stop_voice_session",
  description:
    "Stop Cody's persistent voice session when the user explicitly says to stop listening, stop voice mode, or end the voice session.",
  parameters: objectSchema({}),
};
