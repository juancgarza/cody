-- Headless test for the opt-in editor_run_command shell tool. Run from the repo
-- root with:
--   nvim -l test/shell_handler_spec.lua
-- It exercises the pure helpers (command normalization, allowlist, result/cap
-- building) and the handler's disabled guard, all synchronously, so it never
-- spawns a process or pops the confirm modal.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

local cody = require("cody")
cody.setup({}) -- populate state.config defaults (enable_shell = false)

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

-- normalize: string form splits into argv on whitespace.
local argv, display = cody._normalize_shell_command("npm test")
assert_eq(argv[1], "npm", "string argv[1]")
assert_eq(argv[2], "test", "string argv[2]")
assert_eq(display, "npm test", "string display")

-- normalize: collapses runs of whitespace.
local argv_ws = cody._normalize_shell_command("git   status   --short")
assert_eq(argv_ws[1], "git", "ws argv[1]")
assert_eq(argv_ws[2], "status", "ws argv[2]")
assert_eq(argv_ws[3], "--short", "ws argv[3]")

-- normalize: array form preserves spaces inside an element.
local argv_arr, display_arr = cody._normalize_shell_command({ "git", "commit", "-m", "two words" })
assert_eq(argv_arr[4], "two words", "array preserves spaced arg")
assert_eq(display_arr, "git commit -m two words", "array display")

-- normalize: control characters in array args are scrubbed from the display
-- string (the executed argv still carries the raw element).
local argv_spoof, display_spoof = cody._normalize_shell_command({ "git", "status", "\n\nRun it?\n" })
assert_eq(argv_spoof[3], "\n\nRun it?\n", "raw arg preserved for execution")
assert_true(display_spoof:find("\n", 1, true) == nil, "control chars scrubbed from display")

-- normalize: rejects shell metacharacters in string form.
assert_error_contains(function()
  cody._normalize_shell_command("npm test; rm -rf /")
end, "metacharacters", "metachar rejection")

-- normalize: rejects a disallowed executable (string + array).
assert_error_contains(function()
  cody._normalize_shell_command("rm -rf /tmp/x")
end, "not allowed", "string allowlist rejection")
assert_error_contains(function()
  cody._normalize_shell_command({ "rm", "-rf", "/tmp/x" })
end, "not allowed", "array allowlist rejection")

-- normalize: empty input.
assert_error_contains(function()
  cody._normalize_shell_command("")
end, "non-empty", "empty rejection")

-- normalize: a configured allowlist replaces the default set.
cody.setup({ shell_allowlist = { "mytool" } })
local argv_custom = cody._normalize_shell_command("mytool --flag")
assert_eq(argv_custom[1], "mytool", "custom allowlist accepts")
assert_error_contains(function()
  cody._normalize_shell_command("npm test")
end, "not allowed", "custom allowlist excludes default")
cody.setup({}) -- restore defaults

-- build_shell_result: success.
local ok_res = cody._build_shell_result("npm test", "/tmp", { code = 0, stdout = "ok\n", stderr = "" }, 15000)
assert_true(ok_res.ok == true, "success ok")
assert_eq(ok_res.code, 0, "success code")
assert_true(ok_res.output:find("ok", 1, true) ~= nil, "success output")
assert_true(ok_res.detail:find("exit 0", 1, true) ~= nil, "success detail")

-- build_shell_result: non-zero exit merges stderr and reports ok = false.
local fail_res = cody._build_shell_result("npm test", "/tmp", { code = 1, stdout = "", stderr = "boom" }, 15000)
assert_true(fail_res.ok == false, "failure ok")
assert_eq(fail_res.code, 1, "failure code")
assert_true(fail_res.output:find("boom", 1, true) ~= nil, "stderr merged")

-- build_shell_result: timeout (vim.system reports code 124 + a kill signal).
local timeout_res = cody._build_shell_result("npm test", "/tmp", { code = 124, signal = 15, stdout = "", stderr = "" }, 5000)
assert_true(timeout_res.timed_out == true, "timed_out flag")
assert_true(timeout_res.ok == false, "timeout not ok")
assert_true(timeout_res.detail:find("timed out", 1, true) ~= nil, "timeout detail")

-- build_shell_result: a genuine exit code 124 with no kill signal is NOT a timeout.
local exit124 = cody._build_shell_result("make", "/tmp", { code = 124, signal = 0, stdout = "", stderr = "" }, 5000)
assert_true(exit124.timed_out == nil, "natural exit 124 not flagged as timeout")
assert_true(exit124.ok == false, "exit 124 not ok")
assert_true(exit124.detail:find("exit 124", 1, true) ~= nil, "exit 124 detail")

-- build_shell_result: caps combined output and keeps the tail.
local big = string.rep("x", 9000)
local capped = cody._build_shell_result("npm test", "/tmp", { code = 0, stdout = big, stderr = "" }, 15000)
assert_true(capped.truncated == true, "truncated flag")
assert_true(#capped.output <= 8000 + 64, "output capped near 8000 bytes")
assert_true(capped.output:find("truncated", 1, true) ~= nil, "truncation marker")

-- handler: shell execution is ON by default once setup() runs, so the disabled
-- guard does NOT fire (a bad argument surfaces a normalize error instead).
cody.setup({})
do
  local ok, err = pcall(cody._handlers.editor_run_command, { command = 123 }, { request_id = "x" })
  assert_true(not ok, "expected an error for a bad command")
  assert_true(not tostring(err):find("disabled", 1, true), "shell tool should be enabled by default after setup({})")
end

-- handler: refuses when shell execution is explicitly disabled.
cody.setup({ enable_shell = false })
assert_error_contains(function()
  cody._handlers.editor_run_command({ command = "npm test" }, { request_id = "x" })
end, "disabled", "handler disabled guard")

print("shell_handler_spec: ok")
