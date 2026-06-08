package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

local caps = {}
local calls = {}

_G.vim = {
  lsp = {
    buf = {
      rename = function(new_name)
        calls.rename = new_name
      end,
      code_action = function()
        calls.code_action = true
      end,
      references = function()
        calls.references = true
      end,
      definition = function()
        calls.definition = true
      end,
      document_symbol = function()
        calls.document_symbol = true
      end,
    },
  },
  cmd = function(command)
    calls.command = command
  end,
  fn = {
    escape = function(value)
      return value
    end,
  },
}

package.loaded["cody.capabilities"] = {
  detect = function()
    return caps
  end,
}

local adapter = require("cody.adapter")

local function reset(next_caps)
  caps = next_caps
  calls = {}
end

local function assert_error_contains(fn, needle)
  local ok, err = pcall(fn)
  assert(not ok, "expected call to fail")
  assert(tostring(err):find(needle, 1, true), "expected error to contain " .. needle .. ", got " .. tostring(err))
end

reset({
  {
    id = "lsp_rename",
    provider = "lsp:lua_ls",
    action = "rename",
    available = true,
    status = "available",
    invoke = { kind = "lsp", method = "textDocument/rename" },
  },
})
local rename_result = adapter.invoke("lsp_rename", { new_name = "next_name" })
assert(calls.rename == "next_name")
assert(rename_result.provider == "lsp:lua_ls")
assert(rename_result.detail:find("dispatched LSP rename", 1, true))

reset({
  {
    id = "picker_fzf_lua",
    provider = "fzf-lua",
    action = "search",
    available = false,
    status = "installed_not_loaded",
    invoke = { kind = "lua", module = "fzf-lua", fn = "files" },
  },
})
assert_error_contains(function()
  adapter.invoke("picker_fzf_lua", {})
end, "is not available")

package.loaded["fake.picker"] = {
  find_files = function(opts)
    calls.picker_mode = "files"
    calls.picker_opts = opts
  end,
  live_grep = function(opts)
    calls.picker_mode = "grep"
    calls.picker_opts = opts
  end,
}
reset({
  {
    id = "picker_telescope",
    provider = "telescope.nvim",
    action = "search",
    available = true,
    status = "available",
    invoke = { kind = "lua", module = "fake.picker", fn = "builtin" },
  },
})
adapter.invoke("picker_telescope", { mode = "files", query = "adapter" })
assert(calls.picker_mode == "files")
assert(calls.picker_opts.default_text == "adapter")

adapter.invoke("picker_telescope", { mode = "grep", query = "auth token" })
assert(calls.picker_mode == "grep")
assert(calls.picker_opts.default_text == "auth token")

reset({
  {
    id = "ai_codecompanion",
    provider = "codecompanion.nvim",
    action = "ai_edit",
    available = true,
    status = "available",
    invoke = { kind = "command", command = "CodeCompanion" },
  },
})
adapter.invoke("ai_codecompanion", { instruction = "fix nil handling" })
assert(calls.command == "CodeCompanion fix nil handling")

assert_error_contains(function()
  adapter.invoke("missing_id", {})
end, "unknown capability")

print("adapter_spec.lua: ok")
