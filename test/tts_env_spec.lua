-- Headless TTS env test. Run from the repo root with:
--   nvim -l test/tts_env_spec.lua
-- It exercises M._build_job_env, the pure helper that builds the bridge
-- environment, without touching the heavier Neovim context collection.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

local cody = require("cody")

local function assert_eq(actual, expected, label)
  if actual ~= expected then
    error(string.format("%s: expected %q, got %q", label, tostring(expected), tostring(actual)))
  end
end

-- Defaults: TTS off, quick commands fallback, no ElevenLabs voice/model so the
-- shell environment is never clobbered.
local default_env = cody._build_job_env({})
assert_eq(default_env.CODY_QUICK_COMMANDS, "fallback", "default CODY_QUICK_COMMANDS")
assert_eq(default_env.CODY_ENABLE_SHELL, "0", "default CODY_ENABLE_SHELL")
assert_eq(default_env.CODY_ENABLE_COMMANDS, "0", "default CODY_ENABLE_COMMANDS")
assert_eq(default_env.CODY_TTS_ENABLED, "0", "default CODY_TTS_ENABLED")
assert_eq(default_env.CODY_TTS_PROVIDER, "elevenlabs", "default CODY_TTS_PROVIDER")
assert_eq(default_env.CODY_TTS_SPEAK_PHASES, "0", "default speak phases")
assert_eq(default_env.CODY_TTS_SPEAK_ACTIONS, "1", "default speak actions")
assert_eq(default_env.CODY_TTS_SPEAK_RESULTS, "1", "default speak results")
assert_eq(default_env.CODY_TTS_SPEAK_MESSAGES, "1", "default speak messages")
assert_eq(default_env.CODY_TTS_MESSAGE_MAX_CHARS, "160", "default message max chars")
assert_eq(default_env.ELEVENLABS_VOICE_ID, nil, "voice id absent by default")
assert_eq(default_env.ELEVENLABS_MODEL_ID, nil, "model id absent by default")
assert_eq(default_env.CODY_TTS_REQUEST_TIMEOUT_MS, nil, "timeout absent by default")

-- Enabled config: booleans map to "1"/"0", quick-command behavior preserved,
-- voice/model forwarded.
local enabled_env = cody._build_job_env({
  quick_commands = "always",
  enable_shell = true,
  enable_commands = true,
  tts_enabled = true,
  tts_speak_phases = false,
  tts_speak_messages = false,
  tts_voice_id = "voice-123",
  tts_model_id = "eleven_flash_v2_5",
  tts_message_max_chars = 200,
  tts_request_timeout_ms = 2500,
})
assert_eq(enabled_env.CODY_QUICK_COMMANDS, "always", "quick commands preserved")
assert_eq(enabled_env.CODY_ENABLE_SHELL, "1", "enabled CODY_ENABLE_SHELL")
assert_eq(enabled_env.CODY_ENABLE_COMMANDS, "1", "enabled CODY_ENABLE_COMMANDS")
assert_eq(enabled_env.CODY_TTS_ENABLED, "1", "enabled CODY_TTS_ENABLED")
assert_eq(enabled_env.CODY_TTS_SPEAK_PHASES, "0", "speak phases off")
assert_eq(enabled_env.CODY_TTS_SPEAK_ACTIONS, "1", "speak actions still on")
assert_eq(enabled_env.CODY_TTS_SPEAK_RESULTS, "1", "speak results still on")
assert_eq(enabled_env.CODY_TTS_SPEAK_MESSAGES, "0", "speak messages off")
assert_eq(enabled_env.ELEVENLABS_VOICE_ID, "voice-123", "voice id forwarded")
assert_eq(enabled_env.ELEVENLABS_MODEL_ID, "eleven_flash_v2_5", "model id forwarded")
assert_eq(enabled_env.CODY_TTS_MESSAGE_MAX_CHARS, "200", "message max chars forwarded")
assert_eq(enabled_env.CODY_TTS_REQUEST_TIMEOUT_MS, "2500", "timeout forwarded")

-- An empty Lua voice id must not override a shell-provided ELEVENLABS_VOICE_ID.
local empty_voice = cody._build_job_env({ tts_enabled = true, tts_voice_id = "" })
assert_eq(empty_voice.ELEVENLABS_VOICE_ID, nil, "empty voice id not forwarded")

print("tts_env_spec: ok")
