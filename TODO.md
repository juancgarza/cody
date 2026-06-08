# TODO

## Milestone 1: Command Capability Model

- [x] Define a capability schema for editor actions.
- [x] Detect native Neovim capabilities.
- [x] Detect active LSP capabilities.
- [x] Detect common picker plugins:
  - [x] `telescope.nvim`
  - [x] `fzf-lua`
  - [x] `snacks.nvim` picker
  - [x] `mini.pick`
- [x] Detect AI/edit plugins:
  - [x] `codecompanion.nvim`
  - [x] `avante.nvim`
  - [x] Copilot Chat
- [x] Add `:CodyCapabilities`.
- [x] Report missing providers without installing them.

Acceptance:

- Cody can report available editor capabilities without calling GPT.
- Missing providers are visible.
- No install logic yet.
- No voice input yet.

## Milestone 2: Provider Install Planning

- [x] Detect `lazy.nvim`.
- [x] Represent installable providers as plugin specs.
- [x] Add install suggestions for missing providers.
- [x] Require explicit user confirmation before installation.

Acceptance:

- Cody can explain what is missing and how it would install it.
- Cody does not silently modify plugin configuration.

## Milestone 3: Realtime Text Router

- [x] Expose detected capabilities to the Node Realtime bridge.
- [x] Generate Realtime tool definitions from capabilities.
- [x] Route `:CodyDo ...` through GPT Realtime.
- [x] Execute selected editor commands through the command adapter.
- [x] Keep temporary direct handlers only as fallback scaffolding.

Acceptance:

- Typed commands use detected native/LSP/plugin capabilities.
- GPT is not offered tools for unavailable providers.
- Tool success or failure is reported clearly in Neovim.

## Milestone 4: Push-To-Talk Voice

- [x] Add voice input.
- [x] Send spoken commands through the same router as typed commands.
- [x] Keep voice confirmations terse.
- [x] Refactor voice into an explicit voice state machine.
- [x] Support deterministic interruption/cancel behavior.
- [x] Add press/release push-to-talk functions.

Acceptance:

- Spoken and typed commands behave consistently.
- Voice does not introduce a second command path.

## Milestone 5: Smarter Code Edits

- [x] Add a small routing eval suite.
- [x] Add submit-time diagnostics and selected-range context.
- [x] Add editor locator tools for cursor symbol, text, files, diagnostics, and current scope.
- [x] Add Tree-sitter context for current function/class scope.
- [ ] Prefer existing AI/edit plugins when available.
- [ ] Add strict guardrails for destructive edits.
- [x] Require exact ranges for risky write operations.

Acceptance:

- Code edits use richer context.
- Destructive edits are constrained.
- Routing behavior is testable.

## Milestone 6: Spoken Feedback

- [x] Add an optional, opt-in ElevenLabs TTS controller in the Node bridge.
- [x] Drive speech from the existing feedback event stream (high-signal only).
- [x] Do not speak intents, transcript deltas, or streamed assistant deltas.
- [x] Cancel speech on new turn, stop, interruption, or failure.
- [x] Play locally via `afplay` (override with `CODY_TTS_PLAYER_COMMAND`).
- [x] Expose Lua config (`tts_*`) and pass it to the bridge env.
- [x] Add TypeScript controller tests and a headless Lua env test.

Acceptance:

- Spoken feedback is off unless `tts_enabled = true`.
- The bridge runs unchanged when TTS is disabled or misconfigured.
- Speech is terse and never trails the current action.

## Not Yet

- [ ] Add a finalizing timeout / best-transcript fallback for voice turns.
- [ ] Add a `:CodyVoiceStatus` diagnostic command.
- [ ] Add speech-first prompt rules for spoken file explanations and no-tool answers.
- [ ] Add a conversation TTS preset for assistant-message-heavy sessions.
- [ ] Consider streaming TTS playback if temp-file `afplay` latency remains noticeable.
- [ ] Do not build a desktop overlay.
- [ ] Do not add mouse/screen-control features.
- [ ] Do not auto-install plugins silently.
- [ ] Do not build a separate editor command system when Neovim/LSP/plugins already provide one.
