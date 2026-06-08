-- Cody capability model (Milestone 1).
--
-- Detects what the current editor can already do — native Neovim, the LSP
-- client(s) attached to the current buffer, picker plugins, and AI/edit plugins
-- — and reports it. Detection is read-only and never calls GPT, never installs
-- anything, and never force-loads a lazy plugin.
--
-- The registry produced by `detect()` is a plain, JSON-serializable list so it
-- can be sent to the Node Realtime bridge unchanged in a later milestone.

local M = {}

---@class CodyCapability
---@field id          string      -- stable snake_case unique key, namespaced by source
---@field source      string      -- "native" | "lsp" | "picker" | "ai_edit"
---@field provider    string      -- concrete provider, e.g. "neovim", "lsp:lua_ls", "telescope.nvim"
---@field action      string      -- normalized verb (navigate|edit|search|rename|code_action|...)
---@field description string      -- one-line, human- and (future) model-facing
---@field available   boolean     -- usable right now (quick gate for the future GPT tool list)
---@field status      string      -- "available" | "installed_not_loaded" | "missing"
---@field invoke      table       -- how Cody *would* call it later (data only in M1; never executed)
---@field tool_schema table|nil   -- RESERVED placeholder for future RealtimeToolDefinition mapping
---@field detail      string|nil  -- optional human note
---@field install     CodyInstallSpec|nil -- optional provider install metadata (data only; never executed here)

---@class CodyInstallDependency
---@field repo   string
---@field branch string|nil

---@class CodyInstallSpec
---@field repo         string
---@field dependencies (string|CodyInstallDependency)[]|nil
---@field build        string|nil
---@field version      string|boolean|nil
---@field event        string|nil
---@field lazy         boolean|nil
---@field priority     integer|nil
---@field opts         string|nil -- rendered lazy.nvim opts literal, e.g. "{ picker = { enabled = true } }"
---@field setup_hint   string|nil
---@field note         string|nil

local function json_encode(value)
  if vim.json and vim.json.encode then
    return vim.json.encode(value)
  end
  return vim.fn.json_encode(value)
end

-- Native Neovim primitives are guaranteed on the supported runtime, so they are
-- declared statically rather than probed.
local function detect_native()
  return {
    {
      id = "native_go_to_line",
      source = "native",
      provider = "neovim",
      action = "navigate",
      description = "Jump the cursor to a 1-indexed line",
      available = true,
      status = "available",
      invoke = { kind = "native_api", api = "nvim_win_set_cursor" },
      tool_schema = nil,
    },
    {
      id = "native_go_to_file",
      source = "native",
      provider = "neovim",
      action = "navigate",
      description = "Open a file in the active window",
      available = true,
      status = "available",
      invoke = { kind = "ex", ex = "edit" },
      tool_schema = nil,
    },
    {
      id = "native_list_buffers",
      source = "native",
      provider = "neovim",
      action = "navigate",
      description = "List and switch buffers",
      available = true,
      status = "available",
      invoke = { kind = "ex", ex = "buffers" },
      tool_schema = nil,
    },
    {
      id = "native_window_split",
      source = "native",
      provider = "neovim",
      action = "navigate",
      description = "Split the current window",
      available = true,
      status = "available",
      invoke = { kind = "ex", ex = "split" },
      tool_schema = nil,
    },
    {
      id = "native_quickfix",
      source = "native",
      provider = "neovim",
      action = "search",
      description = "Open the quickfix list",
      available = true,
      status = "available",
      invoke = { kind = "ex", ex = "copen" },
      tool_schema = nil,
    },
    {
      id = "native_edit_buffer",
      source = "native",
      provider = "neovim",
      action = "edit",
      description = "Edit lines in the current buffer",
      available = true,
      status = "available",
      invoke = { kind = "native_api", api = "nvim_buf_set_lines" },
      tool_schema = nil,
    },
  }
end

-- Maps an LSP server_capabilities key to the capability it provides. The value
-- in server_capabilities may be `true` or a config table — both mean supported,
-- so callers must use a truthiness check (never `== true`).
local LSP_MATRIX = {
  { key = "renameProvider", id = "lsp_rename", action = "rename", description = "Rename the symbol under the cursor via LSP", method = "textDocument/rename" },
  { key = "codeActionProvider", id = "lsp_code_action", action = "code_action", description = "Open LSP code actions and quick fixes at the cursor", method = "textDocument/codeAction" },
  { key = "referencesProvider", id = "lsp_references", action = "references", description = "Find references for the symbol under the cursor via LSP", method = "textDocument/references" },
  { key = "definitionProvider", id = "lsp_definition", action = "definition", description = "Go to the definition of the symbol under the cursor via LSP", method = "textDocument/definition" },
  { key = "documentSymbolProvider", id = "lsp_doc_symbols", action = "document_symbols", description = "List document symbols via LSP", method = "textDocument/documentSymbol" },
}

-- LSP capability is a property of the server attached to the current buffer, so
-- detection is buffer-scoped. A global query would falsely advertise rename or
-- code actions in buffers where no server is attached.
local function detect_lsp(bufnr)
  if not (vim.lsp and vim.lsp.get_clients) then
    return {}
  end
  bufnr = bufnr or vim.api.nvim_get_current_buf()

  local found = {} -- id -> capability (de-dupes across multiple attached clients)
  for _, client in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
    local caps = client.server_capabilities or {}
    for _, entry in ipairs(LSP_MATRIX) do
      if caps[entry.key] and not found[entry.id] then
        found[entry.id] = {
          id = entry.id,
          source = "lsp",
          provider = "lsp:" .. client.name,
          action = entry.action,
          description = entry.description,
          available = true,
          status = "available",
          invoke = { kind = "lsp", method = entry.method },
          tool_schema = nil,
        }
      end
    end
  end

  local list = {}
  for _, entry in ipairs(LSP_MATRIX) do
    if found[entry.id] then
      list[#list + 1] = found[entry.id]
    end
  end
  return list
end

-- Lazy-safe detection ladder. Never calls require(), which would force a lazy
-- plugin to load and mutate the user's session.
--   "available"            -> usable right now (loaded / feature enabled)
--   "installed_not_loaded" -> present but not yet loaded (e.g. lazy.nvim command stub)
--   "missing"              -> not installed
local function probe(spec)
  -- 1. usable right now?
  if spec.ready then
    if spec.ready() then
      return "available"
    end
  else
    if spec.module and package.loaded[spec.module] then
      return "available"
    end
    if spec.global and rawget(_G, spec.global) ~= nil then
      return "available"
    end
  end

  -- 2. installed but not (yet) usable?
  if spec.module and package.loaded[spec.module] then
    return "installed_not_loaded"
  end
  if spec.command and vim.fn.exists(":" .. spec.command) == 2 then
    return "installed_not_loaded"
  end

  return "missing"
end

local PLUGIN_SPECS = {
  {
    id = "picker_telescope",
    source = "picker",
    provider = "telescope.nvim",
    action = "search",
    description = "Fuzzy find files, grep, and LSP results (Telescope)",
    module = "telescope",
    command = "Telescope",
    invoke = { kind = "lua", module = "telescope.builtin", fn = "find_files" },
    install = {
      repo = "nvim-telescope/telescope.nvim",
      version = "*",
      dependencies = { "nvim-lua/plenary.nvim" },
      note = "Upstream also recommends telescope-fzf-native.nvim for faster sorting; review before pasting.",
    },
  },
  {
    id = "picker_fzf_lua",
    source = "picker",
    provider = "fzf-lua",
    action = "search",
    description = "Fuzzy find files, grep, and LSP results (fzf-lua)",
    module = "fzf-lua",
    command = "FzfLua",
    invoke = { kind = "lua", module = "fzf-lua", fn = "files" },
    install = {
      repo = "ibhagwan/fzf-lua",
      dependencies = { "nvim-tree/nvim-web-devicons" },
      opts = "{}",
      note = "Icon dependency is optional; mini.icons is the documented alternative.",
    },
  },
  {
    id = "picker_snacks",
    source = "picker",
    provider = "snacks.nvim",
    action = "search",
    description = "Fuzzy find files, grep, and LSP results (snacks picker)",
    module = "snacks",
    -- The picker is an opt-in sub-feature; the package can be loaded with the
    -- picker disabled, so check Snacks.picker specifically.
    ready = function()
      return type(rawget(_G, "Snacks")) == "table" and _G.Snacks.picker ~= nil
    end,
    invoke = { kind = "lua", module = "snacks", fn = "picker" },
    install = {
      repo = "folke/snacks.nvim",
      priority = 1000,
      lazy = false,
      opts = "{ picker = { enabled = true } }",
      setup_hint = "snacks.nvim features are opt-in; picker must be enabled in opts.",
    },
  },
  {
    id = "picker_mini_pick",
    source = "picker",
    provider = "mini.pick",
    action = "search",
    description = "Fuzzy find files and buffers (mini.pick)",
    module = "mini.pick",
    global = "MiniPick",
    command = "Pick",
    invoke = { kind = "lua", module = "mini.pick", fn = "builtin" },
    install = {
      repo = "nvim-mini/mini.pick",
      version = false,
      opts = "{}",
      setup_hint = "mini.pick needs setup(); lazy.nvim will call setup when opts is present.",
      note = "mini.pick moved from the old echasnovski namespace to nvim-mini.",
    },
  },
  {
    id = "ai_codecompanion",
    source = "ai_edit",
    provider = "codecompanion.nvim",
    action = "ai_edit",
    description = "AI-assisted edits and chat (CodeCompanion)",
    module = "codecompanion",
    command = "CodeCompanion",
    invoke = { kind = "command", command = "CodeCompanion" },
    install = {
      repo = "olimorris/codecompanion.nvim",
      version = "^19.0.0",
      opts = "{}",
      dependencies = {
        "nvim-lua/plenary.nvim",
        "nvim-treesitter/nvim-treesitter",
      },
      note = "Upstream recommends pinning to a release and running :checkhealth codecompanion.",
    },
  },
  {
    id = "ai_avante",
    source = "ai_edit",
    provider = "avante.nvim",
    action = "ai_edit",
    description = "AI-assisted edits and chat (Avante)",
    module = "avante",
    command = "AvanteAsk",
    invoke = { kind = "command", command = "AvanteAsk" },
    install = {
      repo = "yetone/avante.nvim",
      build = "make",
      event = "VeryLazy",
      version = false,
      opts = "{}",
      dependencies = {
        "nvim-lua/plenary.nvim",
        "MunifTanjim/nui.nvim",
      },
      note = "Avante has provider, picker, input, image, and render-markdown options; review upstream docs before pasting.",
    },
  },
  {
    id = "ai_copilot_chat",
    source = "ai_edit",
    provider = "CopilotChat.nvim",
    action = "ai_edit",
    description = "AI chat over your code (Copilot Chat)",
    module = "CopilotChat",
    command = "CopilotChat",
    invoke = { kind = "command", command = "CopilotChat" },
    install = {
      repo = "CopilotC-Nvim/CopilotChat.nvim",
      build = "make tiktoken",
      opts = "{}",
      dependencies = {
        { repo = "nvim-lua/plenary.nvim", branch = "master" },
      },
      note = "Requires GitHub Copilot Chat access/auth; build step installs optional tiktoken support.",
    },
  },
}

local function detect_plugins()
  local list = {}
  for _, spec in ipairs(PLUGIN_SPECS) do
    local status = probe(spec)
    list[#list + 1] = {
      id = spec.id,
      source = spec.source,
      provider = spec.provider,
      action = spec.action,
      description = spec.description,
      available = status == "available",
      status = status,
      invoke = spec.invoke,
      tool_schema = nil,
      detail = status == "installed_not_loaded" and "installed, not loaded yet" or nil,
      install = spec.install,
    }
  end
  return list
end

--- Detect all editor capabilities.
---@param opts? { bufnr?: integer }
---@return CodyCapability[]
function M.detect(opts)
  opts = opts or {}
  local caps = {}
  vim.list_extend(caps, detect_native())
  vim.list_extend(caps, detect_lsp(opts.bufnr))
  vim.list_extend(caps, detect_plugins())
  return caps
end

--- Machine-readable payload (the exact shape the Node bridge will receive later).
---@param opts? { bufnr?: integer }
---@return string
function M.to_json(opts)
  return json_encode(M.detect(opts))
end

--- Trim capabilities to the lean shape needed by the Node Realtime router.
---@param opts? { bufnr?: integer }
---@return table[]
function M.to_bridge(opts)
  local out = {}
  for _, cap in ipairs(M.detect(opts)) do
    out[#out + 1] = {
      id = cap.id,
      source = cap.source,
      provider = cap.provider,
      action = cap.action,
      description = cap.description,
      available = cap.available,
      status = cap.status,
      invoke = cap.invoke,
      tool_schema = cap.tool_schema,
      install_repo = (cap.status == "missing" and cap.install) and cap.install.repo or nil,
    }
  end
  return out
end

local SOURCE_ORDER = { "native", "lsp", "picker", "ai_edit" }

--- Capabilities grouped by source, in display order.
---@param opts? { bufnr?: integer }
---@return table<string, CodyCapability[]>
function M.grouped(opts)
  local by_source = {}
  for _, src in ipairs(SOURCE_ORDER) do
    by_source[src] = {}
  end
  for _, cap in ipairs(M.detect(opts)) do
    local bucket = by_source[cap.source]
    if bucket then
      bucket[#bucket + 1] = cap
    end
  end
  return by_source
end

local SOURCE_TITLES = {
  native = "Native Neovim",
  lsp = "LSP (current buffer)",
  picker = "Pickers",
  ai_edit = "AI / edit plugins",
}

local STATUS_MARK = {
  available = "[x]",
  installed_not_loaded = "[~]",
  missing = "[ ]",
}

local function report_lines(grouped)
  local lines = {
    "# Cody capabilities",
    "Legend: [x] available   [~] installed, not loaded   [ ] missing",
    "",
  }

  for _, src in ipairs(SOURCE_ORDER) do
    lines[#lines + 1] = "## " .. (SOURCE_TITLES[src] or src)
    local caps = grouped[src] or {}
    if #caps == 0 then
      lines[#lines + 1] = src == "lsp"
          and "  (no LSP client with these capabilities attached to this buffer)"
        or "  (none)"
    else
      for _, cap in ipairs(caps) do
        local mark = STATUS_MARK[cap.status] or "[?]"
        local line = string.format("  %s %-20s %s", mark, cap.id, cap.description)
        if src == "lsp" then
          line = line .. "  [" .. cap.provider .. "]"
        elseif cap.status ~= "available" then
          line = line .. "  (" .. cap.status .. ")"
        end
        lines[#lines + 1] = line
      end
    end
    lines[#lines + 1] = ""
  end

  return lines
end

--- Open the human-readable capability report in a floating scratch buffer.
---@param opts? { bufnr?: integer }
function M.report(opts)
  local lines = report_lines(M.grouped(opts))

  local buf = vim.api.nvim_create_buf(false, true) -- unlisted, scratch
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "markdown"
  vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = buf, nowait = true, silent = true })

  local longest = 0
  for _, line in ipairs(lines) do
    longest = math.max(longest, vim.fn.strdisplaywidth(line))
  end

  local width = math.min(90, math.max(longest + 2, 40), vim.o.columns - 4)
  local height = math.min(#lines, vim.o.lines - 4)

  vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    style = "minimal",
    border = "rounded",
    title = " Cody ",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
  })
end

return M
