local M = {}

local JS_TS_FILETYPES = {
  javascript = true,
  javascriptreact = true,
  typescript = true,
  typescriptreact = true,
}

local JS_TS_EXTENSIONS = {
  js = true,
  jsx = true,
  mjs = true,
  cjs = true,
  ts = true,
  tsx = true,
  mts = true,
  cts = true,
}

local ROOT_MARKERS = {
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  ".git",
}

local function notify(message, level)
  vim.schedule(function()
    vim.notify(message, level or vim.log.levels.INFO, { title = "Cody" })
  end)
end

local function plugin_root()
  local source = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(source, ":p:h:h:h")
end

local function find_typescript_language_server()
  local local_server = plugin_root() .. "/node_modules/.bin/typescript-language-server"
  if vim.fn.executable(local_server) == 1 then
    return local_server
  end

  local global_server = vim.fn.exepath("typescript-language-server")
  if global_server ~= "" then
    return global_server
  end

  return nil
end

local function buffer_is_js_ts(bufnr)
  local filetype = vim.bo[bufnr].filetype
  if JS_TS_FILETYPES[filetype] then
    return true
  end

  local name = vim.api.nvim_buf_get_name(bufnr)
  local ext = vim.fn.fnamemodify(name, ":e")
  return JS_TS_EXTENSIONS[ext] == true
end

local function root_dir(bufnr)
  local name = vim.api.nvim_buf_get_name(bufnr)
  local start = name ~= "" and vim.fs.dirname(name) or vim.loop.cwd()
  local marker = vim.fs.find(ROOT_MARKERS, {
    path = start,
    upward = true,
  })[1]

  if marker then
    return vim.fs.dirname(marker)
  end

  return vim.loop.cwd()
end

function M.start_ts(opts)
  opts = opts or {}
  local bufnr = opts.bufnr or vim.api.nvim_get_current_buf()

  if not (vim.lsp and vim.lsp.start) then
    error("Neovim built-in LSP client is not available")
  end

  if not opts.force and not buffer_is_js_ts(bufnr) then
    error("current buffer is not a JavaScript/TypeScript buffer; use :CodyStartTsLsp! to force")
  end

  local existing = vim.lsp.get_clients({
    bufnr = bufnr,
    name = "cody-ts-lsp",
  })
  if #existing > 0 then
    notify("TypeScript LSP is already attached to this buffer")
    return existing[1].id
  end

  local server = find_typescript_language_server()
  if not server then
    error("typescript-language-server was not found. Run npm install in the Cody repo, or install it globally.")
  end

  local root = root_dir(bufnr)
  local client_id = vim.lsp.start({
    name = "cody-ts-lsp",
    cmd = { server, "--stdio" },
    root_dir = root,
    filetypes = {
      "javascript",
      "javascriptreact",
      "typescript",
      "typescriptreact",
    },
    init_options = {
      hostInfo = "cody",
    },
    single_file_support = true,
  }, {
    bufnr = bufnr,
  })

  if not client_id then
    error("failed to start TypeScript LSP")
  end

  notify("Started TypeScript LSP for " .. vim.fn.fnamemodify(root, ":~:."))
  return client_id
end

return M
