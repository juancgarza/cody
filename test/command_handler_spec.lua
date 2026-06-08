-- Headless test for the opt-in editor_command Ex-command tool and :CodySet. Run
-- from the repo root with:
--   nvim -l test/command_handler_spec.lua
-- It exercises the pure command normalizer/allowlist, the live config setter, and
-- the handler's disabled guard — without running any real Ex command.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

local cody = require("cody")
cody.setup({}) -- enable_commands defaults to false

local function assert_eq(actual, expected, label)
  if actual ~= expected then
    error(string.format("%s: expected %q, got %q", label, tostring(expected), tostring(actual)))
  end
end

local function assert_true(cond, label)
  if not cond then
    error(label .. ": expected truthy")
  end
end

local function assert_error_contains(fn, needle, label)
  local ok, err = pcall(fn)
  if ok then
    error(label .. ": expected an error, got success")
  end
  if not tostring(err):find(needle, 1, true) then
    error(label .. ": expected error containing " .. needle .. ", got " .. tostring(err))
  end
end

-- normalize: allowlisted Cody command.
local cleaned, name = cody._normalize_ex_command("CodyTranscript")
assert_eq(cleaned, "CodyTranscript", "cleaned command")
assert_eq(name, "CodyTranscript", "command name")

-- normalize: strips a leading colon and surrounding whitespace.
local _, colon_name = cody._normalize_ex_command(":  CodyFeedbackOpen")
assert_eq(colon_name, "CodyFeedbackOpen", "colon/space stripped")

-- normalize: keeps arguments (CodySet ...).
local set_cleaned, set_name = cody._normalize_ex_command("CodySet feedback_height 30")
assert_eq(set_name, "CodySet", "CodySet name")
assert_eq(set_cleaned, "CodySet feedback_height 30", "CodySet keeps args")

-- normalize: allowlisted plain navigation command.
local _, split_name = cody._normalize_ex_command("split")
assert_eq(split_name, "split", "split allowed")

-- normalize: the built-in netrw file-tree commands are allowlisted.
local _, lex_name = cody._normalize_ex_command("Lexplore")
assert_eq(lex_name, "Lexplore", "Lexplore (file tree) allowed")
local _, exp_name = cody._normalize_ex_command("Explore src")
assert_eq(exp_name, "Explore", "Explore allowed (with a path arg)")

-- normalize: rejects non-allowlisted commands (recursion / arbitrary code).
assert_error_contains(function()
  cody._normalize_ex_command("CodyDo edit this line")
end, "allowlist", "CodyDo not allowlisted")
assert_error_contains(function()
  cody._normalize_ex_command("lua os.execute('x')")
end, "allowlist", "lua not allowlisted")

-- normalize: file-writing/opening commands are NOT in the default allowlist
-- (they could write/read arbitrary paths).
assert_error_contains(function()
  cody._normalize_ex_command("write /tmp/exfil")
end, "allowlist", "write not allowlisted by default")
assert_error_contains(function()
  cody._normalize_ex_command("tabnew /etc/passwd")
end, "allowlist", "tabnew not allowlisted by default")

-- normalize: rejects shell escape, the ! variant, and command chaining.
assert_error_contains(function()
  cody._normalize_ex_command("!rm -rf /")
end, "control characters", "bang/shell-escape rejected")
assert_error_contains(function()
  cody._normalize_ex_command("split | only")
end, "control characters", "pipe chaining rejected")

-- normalize: empty input.
assert_error_contains(function()
  cody._normalize_ex_command("")
end, "non-empty", "empty rejected")

-- normalize: a configured allowlist replaces the default set.
cody.setup({ commands_allowlist = { "MyCmd" } })
local _, custom_name = cody._normalize_ex_command("MyCmd arg")
assert_eq(custom_name, "MyCmd", "custom allowlist accepts")
assert_error_contains(function()
  cody._normalize_ex_command("CodyTranscript")
end, "allowlist", "custom allowlist replaces default")
cody.setup({}) -- restore defaults

-- set_config: numbers and booleans are coerced; unknown / non-live keys rejected.
local height = cody.set_config("feedback_height", "30")
assert_true(height.value == 30, "feedback_height coerced to number")
local flag = cody.set_config("show_assistant_messages", "false")
assert_true(flag.value == false, "boolean coerced")
assert_error_contains(function()
  cody.set_config("enable_shell", "true")
end, "non-live", "env-only key rejected")
assert_error_contains(function()
  cody.set_config("commands_confirm", "false")
end, "non-live", "confirm-guard toggle not live-settable")
assert_error_contains(function()
  cody.set_config("feedback_height", "abc")
end, "number", "bad number rejected")
assert_error_contains(function()
  cody.set_config("not_a_key", "1")
end, "non-live", "unknown key rejected")

-- handler: command execution is ON by default once setup() runs, so a
-- non-allowlisted command is rejected by the allowlist, NOT the disabled guard.
cody.setup({})
do
  local ok, err = pcall(cody._handlers.editor_command, { command = "DefinitelyNotAllowed" })
  assert_true(not ok, "expected an error")
  assert_true(not tostring(err):find("disabled", 1, true), "command tool should be enabled by default after setup({})")
  assert_true(tostring(err):find("allowlist", 1, true), "expected an allowlist rejection")
end

-- handler: refuses when command execution is explicitly disabled.
cody.setup({ enable_commands = false })
assert_error_contains(function()
  cody._handlers.editor_command({ command = "CodyTranscript" })
end, "disabled", "handler disabled guard")

print("command_handler_spec: ok")
