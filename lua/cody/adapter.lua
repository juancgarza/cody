local M = {}

local LSP_METHODS = {
  ["textDocument/rename"] = {
    detail = "dispatched LSP rename",
    call = function(args)
      local new_name = args.new_name
      if type(new_name) ~= "string" or new_name == "" then
        error("new_name must be a non-empty string")
      end
      vim.lsp.buf.rename(new_name)
    end,
  },
  ["textDocument/codeAction"] = {
    detail = "opened LSP code action menu",
    call = function()
      vim.lsp.buf.code_action()
    end,
  },
  ["textDocument/references"] = {
    detail = "requested LSP references",
    call = function()
      vim.lsp.buf.references()
    end,
  },
  ["textDocument/definition"] = {
    detail = "requested LSP definition",
    call = function()
      vim.lsp.buf.definition()
    end,
  },
  ["textDocument/documentSymbol"] = {
    detail = "requested LSP document symbols",
    call = function()
      vim.lsp.buf.document_symbol()
    end,
  },
}

local function find_capability(id)
  local capabilities = require("cody.capabilities")
  for _, cap in ipairs(capabilities.detect()) do
    if cap.id == id then
      return cap
    end
  end
  return nil
end

local function picker_opts(cap, args)
  local query = args.query
  if type(query) ~= "string" or query == "" then
    return {}
  end

  if cap.provider == "telescope.nvim" then
    return { default_text = query }
  end
  if cap.provider == "fzf-lua" then
    return { query = query }
  end
  if cap.provider == "snacks.nvim" then
    return { pattern = query }
  end

  return { query = query }
end

local PICKER_FUNCTIONS = {
  ["telescope.nvim"] = {
    files = "find_files",
    grep = "live_grep",
    symbols = "lsp_document_symbols",
  },
  ["fzf-lua"] = {
    files = "files",
    grep = "live_grep",
    symbols = "lsp_document_symbols",
  },
  ["snacks.nvim"] = {
    files = "files",
    grep = "grep",
    symbols = "lsp_symbols",
  },
  ["mini.pick"] = {
    files = "files",
    grep = "grep_live",
    symbols = "lsp",
  },
}

local function picker_mode(args)
  local mode = args.mode
  if mode == nil or mode == "" then
    return "files"
  end
  if mode == "files" or mode == "grep" or mode == "symbols" then
    return mode
  end
  error("unsupported picker mode: " .. tostring(mode))
end

local function picker_target(mod, cap, invoke, args)
  local mode = picker_mode(args)
  local provider_functions = PICKER_FUNCTIONS[cap.provider] or {}
  local fn = provider_functions[mode] or invoke.fn

  if type(fn) ~= "string" or fn == "" then
    error("picker function is not configured for mode: " .. mode)
  end

  if cap.provider == "mini.pick" or cap.provider == "snacks.nvim" then
    local container = mod[invoke.fn]
    if type(container) ~= "table" then
      error(cap.provider .. " picker table is not available")
    end
    return container[fn], mode
  end

  return mod[fn], mode
end

local function call_lsp(invoke, args)
  local method = LSP_METHODS[invoke.method]
  if not method then
    error("unsupported LSP method: " .. tostring(invoke.method))
  end
  method.call(args)
  return method.detail
end

local function call_lua(cap, invoke, args)
  if type(invoke.module) ~= "string" or invoke.module == "" then
    error("lua invoke.module must be a non-empty string")
  end
  if type(invoke.fn) ~= "string" or invoke.fn == "" then
    error("lua invoke.fn must be a non-empty string")
  end

  local mod = require(invoke.module)
  local target, mode = picker_target(mod, cap, invoke, args)
  local opts = picker_opts(cap, args)

  if type(target) == "function" then
    target(opts)
    return "opened " .. mode .. " picker"
  end

  if type(target) == "table" then
    if type(target.files) == "function" then
      target.files(opts)
      return "opened picker"
    end
    if type(target.find_files) == "function" then
      target.find_files(opts)
      return "opened picker"
    end
    if type(target.grep) == "function" then
      target.grep(opts)
      return "opened picker"
    end
  end

  error("lua target is not callable for picker mode: " .. tostring(mode))
end

local function escape_command_arg(value)
  if vim.fn and vim.fn.escape then
    return vim.fn.escape(value, "\\|\"")
  end
  return value:gsub("\\", "\\\\"):gsub("|", "\\|"):gsub('"', '\\"')
end

local function call_command(invoke, args)
  if type(invoke.command) ~= "string" or invoke.command == "" then
    error("command invoke.command must be a non-empty string")
  end

  local instruction = args.instruction
  if type(instruction) == "string" and instruction ~= "" then
    vim.cmd(invoke.command .. " " .. escape_command_arg(instruction))
  else
    vim.cmd(invoke.command)
  end

  return "dispatched AI/edit command"
end

local function call_ex(invoke)
  if type(invoke.ex) ~= "string" or invoke.ex == "" then
    error("ex invoke.ex must be a non-empty string")
  end

  vim.cmd(invoke.ex)
  return "dispatched Ex command"
end

local function dispatch(cap, args)
  local invoke = cap.invoke or {}
  local kind = invoke.kind

  if kind == "lsp" then
    return call_lsp(invoke, args)
  end
  if kind == "lua" then
    return call_lua(cap, invoke, args)
  end
  if kind == "command" then
    return call_command(invoke, args)
  end
  if kind == "ex" then
    return call_ex(invoke)
  end

  error("unsupported capability invoke kind: " .. tostring(kind))
end

function M.invoke(id, args)
  if type(id) ~= "string" or id == "" then
    error("capability id must be a non-empty string")
  end

  local cap = find_capability(id)
  if not cap then
    error("unknown capability: " .. id)
  end
  if cap.available ~= true then
    error(cap.provider .. " is not available (" .. cap.status .. ")")
  end

  local detail = dispatch(cap, args or {})
  return {
    ok = true,
    provider = cap.provider,
    action = cap.action,
    detail = detail .. " (" .. cap.provider .. ")",
  }
end

return M
