# Cody

Neovim-first voice control for developers who want hands-free, low-latency command of their editor without leaving it.

Cody deliberately stays inside the editor: no screen overlay, no mouse pointer, no general desktop assistant. It lives inside Neovim and turns short voice or text commands into editor actions.

Examples:

```vim
:CodyDo go to line 48
:CodyDo go to file src/server.ts
:CodyDo edit this line to return early when request.user is missing
```

Cody should not rebuild editor primitives. It should route voice intent into the editor command surface developers already use, and install missing command providers only when that is explicitly supported by the user's setup.

## Architecture

```text
Neovim Lua plugin          Node Realtime bridge          OpenAI Realtime
----------------          --------------------          ---------------
:CodyDo / voice cmds  ->   JSONL over stdio        ->    WebSocket session
editor command adapter <-   function-call router    <-    gpt-realtime-2
buffer/cursor context  ->   prompt + tool schemas   ->    text/audio input
```

Rather than capturing the screen and pointing at UI elements, Cody sends editor state:

- current file, filetype, cursor line/column
- current line and nearby buffer lines
- available editor commands from native Neovim, LSP, and installed plugins

## Command Adapter

The important layer is not "go to line" itself. Neovim already has that. The useful layer is:

1. detect what the editor can already do
2. expose those capabilities to GPT Realtime as callable tools
3. install a missing provider when the user's plugin manager supports it
4. route the spoken command to the best existing command

Initial command providers:

- Native Neovim: line jumps, file edits, buffers, windows, quickfix
- LSP: rename, code actions, references, definitions
- Pickers: Telescope, fzf-lua, Snacks picker, mini.pick
- AI/code edit plugins: CodeCompanion, Avante, Copilot Chat, or a Cody-owned Realtime edit fallback

This means there is no separate Phase 1 for proving basic editor commands. We start at the adapter.

## Setup

Requirements:

- Neovim 0.10+
- Node.js 20+
- `OPENAI_API_KEY` for intelligent commands
- `sox` for voice input: `brew install sox`

Install dependencies and build the local bridge:

```bash
npm install
npm run build
```

Install with your plugin manager. The Node bridge must be built, so use a build
hook. With **lazy.nvim**:

```lua
{
  "juancgarza/cody",
  build = "npm install && npm run build", -- compiles the Node bridge (dist/)
  opts = {
    -- enable_shell = true,    -- on by default once setup() runs
    -- enable_commands = true, -- on by default once setup() runs
    -- tts_enabled = true, tts_voice_id = "<elevenlabs-voice-id>",
  },
  -- lazy.nvim calls require("cody").setup(opts) automatically.
}
```

Then export `OPENAI_API_KEY` (and `ELEVENLABS_API_KEY` for TTS) in the shell you
launch Neovim from, and run `:CodyStart`.

Without a plugin manager, or during development:

```vim
set runtimepath^=/path/to/cody
runtime plugin/cody.lua
lua require("cody").setup()
```

If you pass the runtimepath before Neovim starts, the `plugin/` file is sourced
automatically:

```bash
nvim --cmd 'set runtimepath^=/path/to/cody'
```

For `nvim -u NONE`, plugin loading is disabled; use the explicit `runtime
plugin/cody.lua` form above.

Optional quick-command routing:

```lua
require("cody").setup({
  quick_commands = "fallback", -- "fallback" | "always" | "off"

  -- Shell command tool (lets Cody run allowlisted terminal commands via
  -- vim.system). ON by default once setup() runs; set false to disable.
  enable_shell = true,
  shell_skip_confirm = true,        -- default true (no prompt); set false to confirm each command
  -- shell_allowlist = nil,         -- list of allowed executables; nil = built-in default set
  -- shell_timeout_ms = 15000,      -- per-command timeout (clamped 1000..120000)
  -- shell_output_max_bytes = 8000, -- cap stdout+stderr returned to the model

  -- Ex-command tool (lets Cody run :CodyTranscript, :split, and change settings
  -- via :CodySet). ON by default once setup() runs; set false to disable.
  enable_commands = true,
  -- commands_confirm = false,      -- ask before each command (default off; allowlist is the guard)
  -- commands_allowlist = nil,      -- list of allowed command names; nil = built-in default set

  show_assistant_messages = true,
  feedback_panel = true,
  feedback_auto_open = true,
  feedback_height = 16,
  feedback_width = 96,
  feedback_recent_lines = 4,
  feedback_conversation_items = 12,
  context_max_lines = 2000,
  context_max_bytes = 240000,

  -- Optional spoken feedback (ElevenLabs). Off unless tts_enabled = true.
  tts_enabled = false,
  tts_provider = "elevenlabs",
  tts_voice_id = nil,          -- falls back to $ELEVENLABS_VOICE_ID
  tts_model_id = nil,          -- falls back to $ELEVENLABS_MODEL_ID, then eleven_flash_v2_5
  tts_speak_phases = false,    -- opt-in "Listening." / "Thinking."
  tts_speak_actions = true,    -- "Editing range." / "Renaming."
  tts_speak_results = true,    -- "Done." / "Failed: <reason>."
  tts_speak_messages = true,   -- short final assistant replies
  tts_message_max_chars = 160, -- skip spoken messages longer than this
  tts_request_timeout_ms = nil, -- falls back to $CODY_TTS_REQUEST_TIMEOUT_MS, then 10000
})
```

`fallback` is the default: typed `:CodyDo` commands go through GPT Realtime when
`OPENAI_API_KEY` is set, and simple local regex commands are used only when the
key is absent.
Assistant messages are shown by default and truncated to fit the command line;
set `show_assistant_messages = false` to suppress prose during voice sessions.
Cody sends the active buffer with line numbers and a cursor marker when it fits
the context limits above; larger buffers are cursor-centered and marked as
truncated with omitted-line counts.
The feedback panel is enabled by default and auto-opens on Cody activity. It
shows the current phase, intent, transcript, selected tool/action, result,
assistant message text, and a short recent event stream.

Then start it:

```vim
:CodyStart
```

## Spoken Feedback (TTS)

Cody can optionally speak short, high-signal confirmations using
[ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
It is off unless you opt in, and it is deliberately terse: it never reads back
your command, streamed transcript, or streamed assistant text.

What gets spoken, by category (each toggleable):

- `tts_speak_phases`: `Listening.`, `Thinking.` (off by default)
- `tts_speak_actions`: the selected tool, e.g. `Editing range.`, `Renaming.`
  (read-only locator/context tools stay silent)
- `tts_speak_results`: `Done.` on success, `Failed: <reason>.` on failure
- `tts_speak_messages`: a short final assistant reply, only when it fits
  `tts_message_max_chars`

Speech is cancelled immediately on a new turn, `:CodyVoiceStop`, an
interruption, or a failure, so stale audio never trails the current action.

Enable it and provide a voice:

```lua
require("cody").setup({
  tts_enabled = true,
  tts_voice_id = "<elevenlabs-voice-id>",
  -- tts_model_id = "eleven_flash_v2_5", -- optional; this is the default
  -- tts_request_timeout_ms = 10000,     -- optional; default is 10s
})
```

```bash
export ELEVENLABS_API_KEY="..."
# Optional, can be set here instead of in setup():
export ELEVENLABS_VOICE_ID="<elevenlabs-voice-id>"
export ELEVENLABS_MODEL_ID="eleven_flash_v2_5"
export CODY_TTS_REQUEST_TIMEOUT_MS="10000"
```

The API key is read from the shell environment in Node and is never passed from
Lua. The voice and model fall back to `ELEVENLABS_VOICE_ID` /
`ELEVENLABS_MODEL_ID` when set; otherwise Cody uses `eleven_flash_v2_5`, the
ElevenLabs low-latency model for real-time use. Cody also defaults to the
smaller `mp3_22050_32` output format to reduce response payload size. Override
that with `ELEVENLABS_OUTPUT_FORMAT` if you prefer higher-bitrate audio.

Playback uses macOS `afplay` on a temporary `mp3` file. On other platforms, set
`CODY_TTS_PLAYER_COMMAND` to an audio player that accepts a file path argument
(for example `mpg123` or `ffplay`). If `ELEVENLABS_API_KEY` or the voice id is
missing while `tts_enabled` is true, Cody reports it once and continues without
spoken feedback.

Useful live checks:

```bash
npm run tts:voices
npm run tts:smoke -- "Cody spoken feedback is working. Done." "<elevenlabs-voice-id>"
```

Inside Neovim, these check the same bridge process used by `:CodyVoiceSession`:

```vim
:CodyTtsStatus
:CodyTtsSmoke Cody spoken feedback is working. Done.
```

If the shell smoke test works but `:CodyTtsStatus` says TTS is disabled or the
API key is missing, restart Neovim from the shell that exports the variables, or
run `:CodyStop` then `:CodyStart` after changing `require("cody").setup(...)`.
An ElevenLabs `402` response means the request reached ElevenLabs but failed due
to billing, quota, or plan/voice access.

## Shell Commands

Cody can run terminal commands from inside Neovim via `vim.system`, exposed to
GPT as the `editor_run_command` tool. It is **on by default once `setup()` runs**
(set `enable_shell = false` to disable; a bare plugin load with no `setup()` stays
off). It is gated several ways:

- the bridge only advertises the tool when `enable_shell` is on (which sets
  `CODY_ENABLE_SHELL=1` for the Node bridge);
- the Lua handler refuses when `enable_shell = false`, even if the tool is
  somehow advertised (the bridge env is captured at start, so the two layers can
  briefly disagree until a restart);
- every command is checked against an allowlist of executables. The per-command
  `vim.fn.confirm` prompt is **off by default** (`shell_skip_confirm = true`);
  set `shell_skip_confirm = false` to be asked before every command.

Commands run **without a shell** (argv only), so pipes, globs, redirection, and
`; & |` are rejected — pass an argv array like `["git", "status", "--short"]` for
anything with spaces in arguments. Output (stdout+stderr) is capped before being
sent to the model, and execution is asynchronous, so a slow command never freezes
the editor; it is killed at `shell_timeout_ms`.

The allowlist binds the executable name only. Some allowed tools are general
interpreters or build drivers (`node -e`, `python -c`, `make`, `npm run`,
`cargo`) that can run arbitrary code, so treat the allowlist as a convenience
filter, not a sandbox — the per-command confirmation is the real authorization
boundary. Set `shell_skip_confirm = true` only when you trust the session.

```lua
require("cody").setup({
  enable_shell = true,
  -- shell_skip_confirm = true,                            -- skip the per-command prompt (use with care)
  -- shell_allowlist = { "npm", "git", "make", "cargo" },  -- replaces the built-in default set
})
```

Then ask, for example, `:CodyDo run the tests` or say "git status". Changing
`enable_shell` requires restarting the bridge (`:CodyStop` then `:CodyStart`).

## Editor Commands

Cody can also run **Ex commands** (the kind you type after `:`) as the
`editor_command` tool — so voice/text like "open the transcript" or "split the
window" maps to `:CodyTranscript` / `:split`. Like the shell tool it is **on by
default once `setup()` runs** (set `enable_commands = false` to disable), and only
**allowlisted** command names run; `:!`, `:lua`, the `!` variant, and `|` chaining
are rejected.

```lua
require("cody").setup({
  enable_commands = true,
  -- commands_confirm = true,                      -- ask before each command (default off; allowlist is the guard)
  -- commands_allowlist = { "CodyTranscript", "split", "MyCmd" }, -- replaces the built-in set
})
```

The default allowlist covers safe Cody/display/navigation commands plus the
built-in **netrw file explorer** (`CodyTranscript`, `CodyFeedbackOpen`,
`CodyCapabilities`, `split`, `vsplit`, `only`, `close`, `wincmd`, `nohlsearch`,
`redraw`, `Explore`, `Lexplore`, `Sexplore`, `Vexplore`, …). File-*writing*/buffer-loading
commands (`write`, `update`, `edit`, `tabnew`, …) are intentionally **excluded** —
with a path argument they write or load arbitrary files — so add them via
`commands_allowlist` only if you want that (ideally with `commands_confirm = true`).
Then say things like "open the transcript", "open the file tree", or
`:CodyDo show the feedback panel`.

To change a setting by voice, Cody runs `:CodySet <key> <value>` (also usable
directly):

```vim
:CodySet feedback_height 30
:CodySet show_assistant_messages false
```

`:CodySet` only changes **live-applicable display keys** (`feedback_height`,
`feedback_width`, `feedback_recent_lines`, `feedback_conversation_items`,
`context_max_lines`, `context_max_bytes`, `show_assistant_messages`) which take
effect immediately. Env-derived flags (`enable_shell`, `enable_commands`,
`tts_*`) and the confirm-guard toggles (`commands_confirm`, `shell_skip_confirm`)
are **not** runtime-settable — set them in `setup()` (and restart the bridge for
the env-derived ones).

## Commands

```vim
:CodyStart
:CodyStop
:CodyDo go to line 48
:CodyDo go to file lua/cody/init.lua
:CodyDo edit this line to handle nil paths
:CodyCapabilities
:CodyCapabilities json
:CodyFeedback
:CodyFeedbackOpen
:CodyFeedbackClose
:CodyFeedbackClear
:CodyTranscript
:CodySet feedback_height 30
:CodyInstall
:CodyInstall telescope.nvim
:CodyInstall json
:CodyStartTsLsp
:CodyVoiceStart
:CodyVoiceSession
:CodyVoicePress
:CodyVoiceRelease
:CodyVoiceStop
:CodyTtsStatus
:CodyTtsSmoke
```

`:CodyInstall` explains missing installable providers and renders lazy.nvim
specs when lazy.nvim is detected. `:CodyInstall <provider>` asks for explicit
confirmation, then copies the suggested spec to a register; it does not edit
plugin configuration or install anything silently.

For local TypeScript/JavaScript testing without your own LSP config, Cody includes
an explicit helper that starts Neovim's built-in LSP client against the repo-local
`typescript-language-server`:

```vim
:e src/realtime-session.ts
:CodyStartTsLsp
:CodyCapabilities
```

`CodyStartTsLsp` is opt-in and only attaches to the current JS/TS buffer. Use
`:CodyStartTsLsp!` to force it for an unusual filetype.

Feedback panel controls:

```vim
:CodyFeedback       " toggle
:CodyFeedbackOpen
:CodyFeedbackClose
:CodyFeedbackClear
:CodyTranscript     " full conversation in a scrollable window (q to close)
```

The feedback panel is a compact, non-focusable HUD: it shows only the most recent
lines that fit `feedback_height` and redraws on every event, so you cannot scroll
it. To read or scroll a long (or streamed) assistant message, open
`:CodyTranscript` — a focusable, wrapping window with the full conversation
(`q` to close, normal motions / `<C-d>`/`<C-u>` to scroll). To make the inline
panel itself taller, raise `feedback_height` (and optionally lower
`feedback_recent_lines` to give the conversation more room):

```lua
require("cody").setup({
  feedback_height = 30,      -- default 16; capped to the editor height
  feedback_recent_lines = 2, -- default 4; fewer event lines = more message room
})
```

Suggested push-to-talk mapping:

```lua
vim.keymap.set("n", "<leader>vs", "<cmd>CodyVoiceStart<cr>")
vim.keymap.set("n", "<leader>vl", "<cmd>CodyVoiceSession<cr>")
vim.keymap.set("n", "<leader>vp", "<cmd>CodyVoicePress<cr>")
vim.keymap.set("n", "<leader>vr", "<cmd>CodyVoiceRelease<cr>")
vim.keymap.set("n", "<leader>ve", "<cmd>CodyVoiceStop<cr>") -- cancel/stop fallback
vim.keymap.set("n", "<leader>cd", ":CodyDo ")
```

Voice uses Realtime server-side VAD. Normal flow is `:CodyVoiceStart`, speak a
short command, then stop speaking; Cody stops recording and submits the turn when
the server reports speech has ended. For explicit turn boundaries, bind
`:CodyVoicePress` to key down and `:CodyVoiceRelease` to key up where your
keymap layer supports that shape. `:CodyVoiceStop` cancels the current recorder,
model response, and queued tool results.

For a persistent microphone session:

```vim
:CodyVoiceSession
" speak commands one at a time
" say: stop listening
```

`CodyVoiceSession` keeps the recorder open across VAD turns. When you say "stop
listening", the model should call Cody's `cody_stop_voice_session` tool and the
bridge stops the recorder.

General search uses whichever picker Cody detects as available. For example, if
Telescope is loaded:

```vim
:CodyDo find auth service
:CodyDo search for auth token in the workspace
```

The generated picker tool receives `mode = "files"` for file/path search and
`mode = "grep"` for workspace text search.

## Environment

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_REALTIME_MODEL="gpt-realtime-2"
export CODY_AUDIO_DEVICE="" # optional sox device override
export CODY_ENABLE_SHELL="1" # shell tool; normally set via enable_shell in setup() (default on)
export CODY_ENABLE_COMMANDS="1" # Ex-command tool; normally set via enable_commands in setup() (default on)

# Optional spoken feedback (see "Spoken Feedback (TTS)")
export ELEVENLABS_API_KEY="..."
export ELEVENLABS_VOICE_ID="<elevenlabs-voice-id>"
export ELEVENLABS_MODEL_ID="eleven_flash_v2_5" # optional
export ELEVENLABS_OUTPUT_FORMAT="mp3_22050_32" # optional
export CODY_TTS_REQUEST_TIMEOUT_MS="10000"     # optional
export CODY_TTS_PLAYER_COMMAND="afplay"        # optional, non-macOS players
```

`gpt-realtime-2` is the default because the current OpenAI Realtime docs use it in the WebSocket and session examples.

## Evals

Local deterministic checks:

```bash
npm run typecheck
npm test
lua test/adapter_spec.lua
nvim -l test/tts_env_spec.lua
nvim -l test/shell_handler_spec.lua
nvim -l test/command_handler_spec.lua
```

`npm test` covers the TypeScript bridge, including the TTS feedback-to-speech
mapping and cancellation. `test/tts_env_spec.lua` runs under Neovim's LuaJIT
(not the system `lua`) and checks the bridge environment built from the TTS
config.

Live router evals use the actual Realtime model with fake editor
context/capabilities and check the first selected tool:

```bash
export OPENAI_API_KEY="sk-..."
npm run eval:router
```

If `OPENAI_API_KEY` is not set, `eval:router` skips without failing.
Search evals use fixture files under `test/fixtures/search`.

## Product Direction

Cody is deliberately narrow:

- It should feel like a modal editor command layer, not a chat sidebar.
- Voice commands should be short and imperative.
- Navigation should reuse native editor commands or the user's preferred picker.
- The model should use tools, not narrate pretend actions.
- Write tools are limited to the active editor buffers.

## Phases

1. **Command adapter**: detect native/LSP/plugin commands and expose them as Realtime tools.
2. **Provider installer**: install missing command providers through `lazy.nvim` or another detected package manager.
3. **Realtime text loop**: typed commands call the adapter through GPT Realtime.
4. **Push-to-talk voice**: voice commands flow through the same adapter.
5. **Smarter edits**: add Tree-sitter context and stricter write guardrails.

Useful later steps:

- Add a native push-to-talk key listener for press/release instead of two Vim commands.
- Add a panel focus/scrollback mode and a copy/export command.

Done:

- Optional ElevenLabs spoken feedback driven by the feedback event stream (see
  "Spoken Feedback (TTS)").
- Tree-sitter context for function/class-aware edits.
- A small eval suite for command parsing and tool selection.
