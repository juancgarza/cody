-- Cody provider install planning (Milestone 2).
--
-- This module explains how missing providers could be installed, but it never
-- writes to the user's plugin configuration and never installs plugins itself.

local M = {}

local MANAGER_SPECS = {
  {
    id = "lazy",
    name = "lazy.nvim",
    module = "lazy",
    command = "Lazy",
    docs = "https://lazy.folke.io",
  },
}

local function json_encode(value)
  if vim.json and vim.json.encode then
    return vim.json.encode(value)
  end
  return vim.fn.json_encode(value)
end

local function notify(message, level)
  local function emit()
    vim.notify(message, level or vim.log.levels.INFO, { title = "Cody" })
  end

  if vim.schedule then
    vim.schedule(emit)
  else
    emit()
  end
end

local function quote(value)
  return string.format("%q", value)
end

local function render_scalar(value)
  local kind = type(value)
  if kind == "string" then
    return quote(value)
  end
  if kind == "boolean" or kind == "number" then
    return tostring(value)
  end
  return quote(tostring(value))
end

local function render_dependency(dep)
  if type(dep) == "string" then
    return quote(dep)
  end

  if type(dep) ~= "table" or type(dep.repo) ~= "string" then
    return quote(tostring(dep))
  end

  local fields = { quote(dep.repo) }
  for _, key in ipairs({ "branch", "tag", "version", "build", "event", "cmd", "name" }) do
    if dep[key] ~= nil then
      fields[#fields + 1] = key .. " = " .. render_scalar(dep[key])
    end
  end
  return "{ " .. table.concat(fields, ", ") .. " }"
end

local function has_dependencies(install)
  return type(install.dependencies) == "table" and #install.dependencies > 0
end

local function render_lazy_spec(install)
  local lines = {
    "{",
    "  " .. quote(install.repo) .. ",",
  }

  for _, key in ipairs({ "version", "build", "event", "priority", "lazy" }) do
    if install[key] ~= nil then
      lines[#lines + 1] = "  " .. key .. " = " .. render_scalar(install[key]) .. ","
    end
  end

  if has_dependencies(install) then
    lines[#lines + 1] = "  dependencies = {"
    for _, dep in ipairs(install.dependencies) do
      lines[#lines + 1] = "    " .. render_dependency(dep) .. ","
    end
    lines[#lines + 1] = "  },"
  end

  if install.opts then
    lines[#lines + 1] = "  opts = " .. install.opts .. ","
  end

  lines[#lines + 1] = "}"
  return lines
end

local function render_generic_install(install)
  local lines = {
    "Repository: " .. install.repo,
  }

  if has_dependencies(install) then
    lines[#lines + 1] = "Dependencies:"
    for _, dep in ipairs(install.dependencies) do
      if type(dep) == "table" and dep.repo then
        lines[#lines + 1] = "  - " .. dep.repo
      else
        lines[#lines + 1] = "  - " .. tostring(dep)
      end
    end
  end

  if install.build then
    lines[#lines + 1] = "Build: " .. install.build
  end
  if install.opts then
    lines[#lines + 1] = "Setup opts: " .. install.opts
  end

  return lines
end

local function render_spec(install, manager)
  if manager and manager.id == "lazy" then
    return render_lazy_spec(install)
  end
  return render_generic_install(install)
end

local function public_manager(manager)
  if not manager then
    return nil
  end
  return {
    id = manager.id,
    name = manager.name,
    docs = manager.docs,
    available = true,
  }
end

local function command_exists(command)
  return vim.fn and vim.fn.exists and vim.fn.exists(":" .. command) == 2
end

local function detect_manager_spec()
  for _, manager in ipairs(MANAGER_SPECS) do
    if manager.module and package.loaded[manager.module] then
      return manager
    end
    if manager.command and command_exists(manager.command) then
      return manager
    end
    if manager.module then
      local ok = pcall(require, manager.module)
      if ok then
        return manager
      end
    end
  end

  return nil
end

local function detect_capabilities(opts)
  if opts and opts.capabilities then
    return opts.capabilities
  end

  local capabilities = require("cody.capabilities")
  return capabilities.detect(opts)
end

--- Detect the supported package manager, if one is active.
---@return table|nil
function M.detect_manager()
  return public_manager(detect_manager_spec())
end

--- Render an install spec for a manager. Public for tests and future bridge use.
---@param install CodyInstallSpec
---@param manager? table
---@return string[]
function M.render_spec(install, manager)
  return render_spec(install, manager)
end

--- Build a data-only install plan.
---@param opts? { bufnr?: integer, capabilities?: CodyCapability[] }
---@return table
function M.plan(opts)
  opts = opts or {}
  local manager = public_manager(detect_manager_spec())
  local plan = {
    manager = manager,
    suggestions = {},
    available = {},
    unsupported = {},
  }

  for _, cap in ipairs(detect_capabilities(opts)) do
    if cap.install then
      if cap.status == "missing" then
        plan.suggestions[#plan.suggestions + 1] = cap
      else
        plan.available[#plan.available + 1] = cap
      end
    elseif cap.status == "missing" then
      plan.unsupported[#plan.unsupported + 1] = cap
    end
  end

  return plan
end

--- Machine-readable install plan payload.
---@param opts? { bufnr?: integer, capabilities?: CodyCapability[] }
---@return string
function M.plan_json(opts)
  return json_encode(M.plan(opts))
end

local function append_spec_block(lines, cap, manager)
  if manager and manager.id == "lazy" then
    lines[#lines + 1] = "Paste this lazy.nvim spec into your plugin spec list after reviewing it:"
    lines[#lines + 1] = "```lua"
    for _, line in ipairs(render_spec(cap.install, manager)) do
      lines[#lines + 1] = line
    end
    lines[#lines + 1] = "```"
    lines[#lines + 1] = "After pasting, run :Lazy sync."
  else
    lines[#lines + 1] = "No supported package manager detected. Install with your package manager:"
    for _, line in ipairs(render_spec(cap.install, nil)) do
      lines[#lines + 1] = line
    end
  end

  if cap.install.setup_hint then
    lines[#lines + 1] = "Setup: " .. cap.install.setup_hint
  end
  if cap.install.note then
    lines[#lines + 1] = "Note: " .. cap.install.note
  end
end

local function report_lines(plan)
  local lines = {
    "# Cody install plan",
    "No files will be modified. Specs are suggestions to review before pasting.",
    "",
  }

  if plan.manager then
    lines[#lines + 1] = "Detected manager: " .. plan.manager.name .. " (" .. plan.manager.docs .. ")"
  else
    lines[#lines + 1] = "Detected manager: none supported (lazy.nvim not detected)"
  end
  lines[#lines + 1] = ""

  lines[#lines + 1] = "## Missing installable providers"
  if #plan.suggestions == 0 then
    lines[#lines + 1] = "  (none)"
  else
    for _, cap in ipairs(plan.suggestions) do
      lines[#lines + 1] = "### " .. cap.provider
      lines[#lines + 1] = "Status: " .. cap.status .. "  Source: " .. cap.source
      append_spec_block(lines, cap, plan.manager)
      lines[#lines + 1] = ""
    end
  end

  lines[#lines + 1] = ""
  lines[#lines + 1] = "## Already present installable providers"
  if #plan.available == 0 then
    lines[#lines + 1] = "  (none)"
  else
    for _, cap in ipairs(plan.available) do
      lines[#lines + 1] = "  - " .. cap.provider .. " (" .. cap.status .. ")"
    end
  end

  if #plan.unsupported > 0 then
    lines[#lines + 1] = ""
    lines[#lines + 1] = "## Missing without install metadata"
    for _, cap in ipairs(plan.unsupported) do
      lines[#lines + 1] = "  - " .. cap.provider .. " (" .. cap.id .. ")"
    end
  end

  return lines
end

local function open_float(lines, title)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "markdown"
  vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = buf, nowait = true, silent = true })

  local longest = 0
  for _, line in ipairs(lines) do
    longest = math.max(longest, vim.fn.strdisplaywidth(line))
  end

  local available_width = math.max((vim.o.columns or 80) - 4, 20)
  local available_height = math.max((vim.o.lines or 24) - 4, 1)
  local width = math.min(110, math.max(longest + 2, 50), available_width)
  local height = math.min(#lines, available_height)

  vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    style = "minimal",
    border = "rounded",
    title = title or " Cody install ",
    width = width,
    height = height,
    row = math.floor(((vim.o.lines or 24) - height) / 2),
    col = math.floor(((vim.o.columns or 80) - width) / 2),
  })
end

--- Open the human-readable install plan in a floating scratch buffer.
---@param opts? { bufnr?: integer, capabilities?: CodyCapability[] }
function M.report(opts)
  open_float(report_lines(M.plan(opts)), " Cody install ")
end

local function normalize(value)
  return string.lower(value or "")
end

local function dedupe_caps(caps)
  local seen = {}
  local out = {}
  for _, cap in ipairs(caps) do
    if not seen[cap.id] then
      seen[cap.id] = true
      out[#out + 1] = cap
    end
  end
  return out
end

local function installable_caps(opts)
  local caps = {}
  for _, cap in ipairs(detect_capabilities(opts)) do
    if cap.install then
      caps[#caps + 1] = cap
    end
  end
  return caps
end

--- Resolve a provider query by provider name or capability id.
---@param query string
---@param opts? { capabilities?: CodyCapability[] }
---@return CodyCapability|nil, string|nil, CodyCapability[]|nil
function M.resolve_provider(query, opts)
  local needle = normalize(query)
  if needle == "" then
    return nil, "empty", nil
  end

  local caps = installable_caps(opts)
  local exact = {}
  for _, cap in ipairs(caps) do
    if normalize(cap.provider) == needle or normalize(cap.id) == needle then
      exact[#exact + 1] = cap
    end
  end
  exact = dedupe_caps(exact)
  if #exact == 1 then
    return exact[1], nil, nil
  end
  if #exact > 1 then
    return nil, "ambiguous", exact
  end

  local prefix = {}
  for _, cap in ipairs(caps) do
    local provider = normalize(cap.provider)
    local id = normalize(cap.id)
    if provider:sub(1, #needle) == needle or id:sub(1, #needle) == needle then
      prefix[#prefix + 1] = cap
    end
  end
  prefix = dedupe_caps(prefix)
  if #prefix == 1 then
    return prefix[1], nil, nil
  end
  if #prefix > 1 then
    return nil, "ambiguous", prefix
  end

  return nil, "unknown", nil
end

function M.complete()
  local items = { "json" }
  local ok, caps = pcall(installable_caps, {})
  if not ok then
    return items
  end

  for _, cap in ipairs(caps) do
    items[#items + 1] = cap.provider
  end
  return items
end

local function clipboard_text(cap, manager)
  return table.concat(render_spec(cap.install, manager), "\n")
end

local function copy_to_register(text)
  local ok = pcall(vim.fn.setreg, "+", text)
  if ok then
    return "+"
  end

  pcall(vim.fn.setreg, '"', text)
  return '"'
end

local function open_prepared_spec(cap, manager)
  local lines = {
    "# Cody install spec: " .. cap.provider,
    "No files were modified.",
    "",
  }
  append_spec_block(lines, cap, manager)
  open_float(lines, " Cody install ")
end

--- Confirm and prepare one provider install spec.
---@param query string
---@param opts? { capabilities?: CodyCapability[] }
---@return boolean prepared
function M.prepare(query, opts)
  opts = opts or {}
  local cap, err, matches = M.resolve_provider(query, opts)
  if not cap then
    if err == "ambiguous" then
      local names = {}
      for _, match in ipairs(matches or {}) do
        names[#names + 1] = match.provider
      end
      notify("Ambiguous provider for :CodyInstall " .. query .. ": " .. table.concat(names, ", "), vim.log.levels.WARN)
    else
      notify("Usage: :CodyInstall [json|provider]", vim.log.levels.ERROR)
    end
    M.report(opts)
    return false
  end

  if cap.status ~= "missing" then
    notify(cap.provider .. " is already available (status: " .. cap.status .. ") - nothing to install")
    return false
  end

  local choice = vim.fn.confirm(
    "Prepare install spec for " .. cap.provider .. "?\n(this does NOT modify your config - it copies the spec to your clipboard)",
    "&Yes\n&No",
    2
  )
  if choice ~= 1 then
    return false
  end

  local manager = M.detect_manager()
  local register = copy_to_register(clipboard_text(cap, manager))
  if manager and manager.id == "lazy" then
    notify("Copied " .. cap.provider .. " lazy.nvim spec to register " .. register .. ". Paste it into your plugin specs after reviewing.")
  else
    notify("Copied " .. cap.provider .. " install instructions to register " .. register .. ". Install with your package manager after reviewing.")
  end
  open_prepared_spec(cap, manager)
  return true
end

return M
