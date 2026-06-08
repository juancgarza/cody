local M = {}

local state = {
  job_id = nil,
  next_message_id = 1,
  config = {},
  feedback = {
    bufnr = nil,
    winid = nil,
    phase = "idle",
    intent = "",
    transcript = "",
    action = "",
    result = "",
    assistant = "",
    conversation = {},
    events = {},
  },
}

local function truncate_message(message, max_width)
  message = tostring(message or "")
  message = message:gsub("[%z\1-\31]", " ")
  max_width = max_width or 120

  if #message <= max_width then
    return message
  end

  return message:sub(1, max_width - 3) .. "..."
end

local function clean_panel_text(message)
  return tostring(message or ""):gsub("[%z\1-\31]", " "):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
end

local function show_status(message)
  vim.schedule(function()
    local max_width = math.max(20, math.min(70, (vim.o.columns or 80) - 10))
    vim.api.nvim_echo({ { "Cody: " .. truncate_message(message, max_width), "ModeMsg" } }, false, {})
  end)
end

local function notify(message, level)
  vim.schedule(function()
    vim.notify(truncate_message(message, 240), level or vim.log.levels.INFO, { title = "Cody" })
  end)
end

local function plugin_root()
  local source = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(source, ":p:h:h:h")
end

local function json_encode(value)
  if vim.json and vim.json.encode then
    return vim.json.encode(value)
  end
  return vim.fn.json_encode(value)
end

local function json_decode(value)
  if vim.json and vim.json.decode then
    return vim.json.decode(value)
  end
  return vim.fn.json_decode(value)
end

local function split_lines(text)
  if text == "" then
    return { "" }
  end
  return vim.split(text, "\n", { plain = true })
end

local function configured_number(name, fallback)
  local value = tonumber(state.config[name])
  if value and value > 0 then
    return value
  end
  return fallback
end

local function clamp(value, min_value, max_value)
  value = tonumber(value)
  if not value then
    return min_value
  end
  return math.max(min_value, math.min(max_value, value))
end

local function list_limit(values, limit)
  local out = {}
  for i, value in ipairs(values) do
    if i > limit then
      break
    end
    out[#out + 1] = value
  end
  return out
end

local function normalize_text(value)
  return tostring(value or ""):lower():gsub("[^%w]+", "")
end

local function range_payload(start_line, start_column, end_line, end_column)
  return {
    start_line = start_line,
    start_column = start_column,
    end_line = end_line,
    end_column = end_column,
  }
end

local function capability_snapshot(capabilities)
  local available = {}
  local unavailable = {}

  for _, cap in ipairs(capabilities or {}) do
    local row = cap.id or cap.provider or cap.action
    if row then
      if cap.available then
        available[#available + 1] = row
      else
        unavailable[#unavailable + 1] = row
      end
    end
  end

  table.sort(available)
  table.sort(unavailable)

  return {
    available = available,
    unavailable = unavailable,
  }
end

local LSP_CAPABILITY_KEYS = {
  { key = "renameProvider", label = "rename" },
  { key = "codeActionProvider", label = "code_action" },
  { key = "referencesProvider", label = "references" },
  { key = "definitionProvider", label = "definition" },
  { key = "documentSymbolProvider", label = "document_symbols" },
  { key = "completionProvider", label = "completion" },
  { key = "hoverProvider", label = "hover" },
}

local function collect_lsp_clients(bufnr)
  if not (vim.lsp and vim.lsp.get_clients) then
    return {}
  end

  local clients = {}
  for _, client in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
    local caps = client.server_capabilities or {}
    local labels = {}
    for _, entry in ipairs(LSP_CAPABILITY_KEYS) do
      if caps[entry.key] then
        labels[#labels + 1] = entry.label
      end
    end
    clients[#clients + 1] = {
      id = client.id,
      name = client.name,
      capabilities = labels,
    }
  end

  return clients
end

local function severity_name(value)
  if not (vim.diagnostic and vim.diagnostic.severity) then
    return value
  end

  local severity = vim.diagnostic.severity
  if value == severity.ERROR then
    return "error"
  elseif value == severity.WARN then
    return "warning"
  elseif value == severity.INFO then
    return "info"
  elseif value == severity.HINT then
    return "hint"
  end
  return value
end

local function diagnostic_payload(diagnostic, file)
  local line = (diagnostic.lnum or 0) + 1
  local column = (diagnostic.col or 0) + 1
  return {
    file = file,
    line = line,
    column = column,
    end_line = diagnostic.end_lnum and diagnostic.end_lnum + 1 or line,
    end_column = diagnostic.end_col and diagnostic.end_col + 1 or column,
    severity = severity_name(diagnostic.severity),
    source = diagnostic.source,
    code = diagnostic.code,
    message = diagnostic.message or "",
  }
end

local function collect_diagnostics(bufnr, cursor, file)
  if not (vim.diagnostic and vim.diagnostic.get) then
    return {
      near_cursor = {},
      current_file = {},
    }
  end

  local diagnostics = {}
  for _, diagnostic in ipairs(vim.diagnostic.get(bufnr)) do
    diagnostics[#diagnostics + 1] = diagnostic_payload(diagnostic, file)
  end

  table.sort(diagnostics, function(a, b)
    if a.line == b.line then
      return a.column < b.column
    end
    return a.line < b.line
  end)

  local near = {}
  for _, diagnostic in ipairs(diagnostics) do
    if math.abs(diagnostic.line - cursor[1]) <= 8 then
      near[#near + 1] = diagnostic
    end
  end

  table.sort(near, function(a, b)
    local a_distance = math.abs(a.line - cursor[1])
    local b_distance = math.abs(b.line - cursor[1])
    if a_distance == b_distance then
      return a.column < b.column
    end
    return a_distance < b_distance
  end)

  return {
    near_cursor = list_limit(near, 8),
    current_file = list_limit(diagnostics, 20),
  }
end

local function collect_selection(bufnr)
  local mode = vim.fn.mode()
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then
    return nil
  end

  local start_pos = vim.fn.getpos("'<")
  local end_pos = vim.fn.getpos("'>")
  if start_pos[2] <= 0 or end_pos[2] <= 0 then
    return nil
  end

  local start_line = start_pos[2]
  local start_column = start_pos[3]
  local end_line = end_pos[2]
  local end_column = end_pos[3] + 1

  if end_line < start_line or (end_line == start_line and end_column < start_column) then
    start_line, end_line = end_line, start_line
    start_column, end_column = end_column, start_column
  end

  local line_count = vim.api.nvim_buf_line_count(bufnr)
  start_line = clamp(start_line, 1, line_count)
  end_line = clamp(end_line, 1, line_count)

  local start_text = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, start_line, false)[1] or ""
  local end_text = vim.api.nvim_buf_get_lines(bufnr, end_line - 1, end_line, false)[1] or ""
  start_column = clamp(start_column, 1, #start_text + 1)
  end_column = clamp(end_column, 1, #end_text + 1)

  local lines = vim.api.nvim_buf_get_text(
    bufnr,
    start_line - 1,
    math.max(start_column - 1, 0),
    end_line - 1,
    math.max(end_column - 1, 0),
    {}
  )

  return {
    mode = mode,
    range = range_payload(start_line, start_column, end_line, end_column),
    text = table.concat(lines, "\n"),
    line_count = #lines,
  }
end

local function collect_current_buffer(bufnr, cursor)
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  local max_lines = configured_number("context_max_lines", 2000)
  local max_bytes = configured_number("context_max_bytes", 240000)
  local start_line = 1
  local end_line = line_count

  if line_count > max_lines then
    local half = math.floor(max_lines / 2)
    start_line = clamp(cursor[1] - half, 1, math.max(1, line_count - max_lines + 1))
    end_line = math.min(line_count, start_line + max_lines - 1)
  end

  local raw_lines = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, end_line, false)
  local total_bytes = 0
  for _, line in ipairs(raw_lines) do
    total_bytes = total_bytes + #line + 1
  end

  while #raw_lines > 1 and total_bytes > max_bytes do
    local remove_from_start = (cursor[1] - start_line) > (end_line - cursor[1])
    local removed
    if remove_from_start then
      removed = table.remove(raw_lines, 1) or ""
      start_line = start_line + 1
    else
      removed = table.remove(raw_lines) or ""
      end_line = end_line - 1
    end
    total_bytes = total_bytes - #removed - 1
  end

  local lines = {}
  for index, text in ipairs(raw_lines) do
    local line_number = start_line + index - 1
    local row = {
      line = line_number,
      text = text,
    }
    if line_number == cursor[1] then
      row.cursor = true
      row.text_with_cursor = text:sub(1, cursor[2]) .. "<CURSOR>" .. text:sub(cursor[2] + 1)
    end
    lines[#lines + 1] = row
  end

  return {
    bufnr = bufnr,
    name = vim.api.nvim_buf_get_name(bufnr),
    relative_name = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(bufnr), ":."),
    line_count = line_count,
    start_line = start_line,
    end_line = end_line,
    truncated = start_line > 1 or end_line < line_count,
    omitted_lines = (start_line - 1) + (line_count - end_line),
    max_lines = max_lines,
    max_bytes = max_bytes,
    lines = lines,
  }
end

local function collect_window()
  return {
    winid = vim.api.nvim_get_current_win(),
    tabpage = vim.api.nvim_get_current_tabpage(),
    mode = vim.fn.mode(),
  }
end

local function ensure_modifiable(bufnr)
  if vim.bo[bufnr].modifiable then
    return
  end

  local name = vim.api.nvim_buf_get_name(bufnr)
  if name == "" then
    name = "[No Name]"
  else
    name = vim.fn.fnamemodify(name, ":.")
  end

  local buftype = vim.bo[bufnr].buftype
  local detail = buftype ~= "" and (" (" .. buftype .. " buffer)") or ""
  error("current buffer is not modifiable: " .. name .. detail .. ". Switch to a writable file buffer or close the Cody report with q.")
end

local function collect_context(capabilities)
  local bufnr = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  local start_line = math.max(1, cursor[1] - 20)
  local end_line = math.min(line_count, cursor[1] + 20)
  local file = vim.api.nvim_buf_get_name(bufnr)
  local surrounding_lines = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, end_line, false)
  local current_line = vim.api.nvim_buf_get_lines(bufnr, cursor[1] - 1, cursor[1], false)[1] or ""
  local column = cursor[2] + 1
  local line_before_cursor = current_line:sub(1, cursor[2])
  local line_after_cursor = current_line:sub(column)
  local current_line_with_cursor = line_before_cursor .. "<CURSOR>" .. line_after_cursor
  local cursor_word = vim.fn.expand("<cword>")
  local cursor_char = current_line:sub(column, column)

  return {
    cwd = vim.loop.cwd(),
    file = file,
    relative_file = vim.fn.fnamemodify(file, ":."),
    filetype = vim.bo[bufnr].filetype,
    cursor = {
      line = cursor[1],
      column = column,
    },
    line_count = line_count,
    current_line = current_line,
    current_line_with_cursor = current_line_with_cursor,
    cursor_word = cursor_word,
    cursor_char = cursor_char,
    line_before_cursor = line_before_cursor,
    line_after_cursor = line_after_cursor,
    surrounding = {
      start_line = start_line,
      end_line = end_line,
      lines = surrounding_lines,
    },
    selection = collect_selection(bufnr),
    diagnostics = collect_diagnostics(bufnr, cursor, file),
    lsp_clients = collect_lsp_clients(bufnr),
    cody_capabilities = capability_snapshot(capabilities or {}),
    current_buffer = collect_current_buffer(bufnr, cursor),
    window = collect_window(),
  }
end

local function collect_capabilities()
  local ok, capabilities = pcall(require, "cody.capabilities")
  if not ok then
    notify("Failed to load capabilities: " .. tostring(capabilities), vim.log.levels.ERROR)
    return {}
  end

  local ok_bridge, rows = pcall(capabilities.to_bridge)
  if not ok_bridge then
    notify("Capability detection failed: " .. tostring(rows), vim.log.levels.ERROR)
    return {}
  end

  return rows
end

local function send(message)
  if not state.job_id then
    M.start()
  end

  if not state.job_id then
    notify("Could not start Realtime bridge", vim.log.levels.ERROR)
    return
  end

  vim.fn.chansend(state.job_id, json_encode(message) .. "\n")
end

local function next_id()
  local id = "nvim-" .. state.next_message_id
  state.next_message_id = state.next_message_id + 1
  return id
end

local function find_cursor_symbol(bufnr)
  local cursor = vim.api.nvim_win_get_cursor(0)
  local line = vim.api.nvim_buf_get_lines(bufnr, cursor[1] - 1, cursor[1], false)[1] or ""
  local cursor_column = cursor[2] + 1
  local init = 1

  while init <= #line do
    local start_column, end_column = line:find("[%w_]+", init)
    if not start_column then
      break
    end
    if cursor_column >= start_column and cursor_column <= end_column + 1 then
      return {
        symbol = line:sub(start_column, end_column),
        range = range_payload(cursor[1], start_column, cursor[1], end_column + 1),
      }
    end
    init = end_column + 1
  end

  return nil
end

local function locate_payload(fields)
  fields.ok = (fields.confidence or 0) > 0
  return fields
end

local function file_payload(bufnr)
  local file = vim.api.nvim_buf_get_name(bufnr)
  return file, vim.fn.fnamemodify(file, ":.")
end

local function fuzzy_score(path, query)
  local lower_path = tostring(path or ""):lower()
  local lower_query = tostring(query or ""):lower()
  local compact_path = normalize_text(path)
  local compact_query = normalize_text(query)

  if lower_path == lower_query then
    return 1.0
  end
  if compact_path == compact_query then
    return 0.95
  end
  if lower_path:find(lower_query, 1, true) then
    return 0.85
  end
  if compact_query ~= "" and compact_path:find(compact_query, 1, true) then
    return 0.75
  end

  local matched = 0
  for token in lower_query:gmatch("%w+") do
    if lower_path:find(token, 1, true) then
      matched = matched + 1
    else
      return 0
    end
  end

  return matched > 0 and 0.55 or 0
end

local function workspace_files(cwd)
  if vim.fn.executable("rg") == 1 then
    local lines = vim.fn.systemlist({ "rg", "--files", cwd })
    if vim.v.shell_error == 0 and type(lines) == "table" then
      return lines
    end
  end

  local files = {}
  for _, path in ipairs(vim.fn.globpath(cwd, "**/*", false, true)) do
    if vim.fn.filereadable(path) == 1 then
      files[#files + 1] = vim.fn.fnamemodify(path, ":.")
    end
  end
  return files
end

local function current_scope_from_treesitter(bufnr)
  if not (vim.treesitter and vim.treesitter.get_node) then
    return nil
  end

  local ok, node = pcall(vim.treesitter.get_node, { bufnr = bufnr })
  if not ok or not node then
    return nil
  end

  local scope_types = {
    function_declaration = true,
    function_definition = true,
    function_item = true,
    function_statement = true,
    method_declaration = true,
    method_definition = true,
    method = true,
    arrow_function = true,
    class_declaration = true,
    class_definition = true,
    class = true,
  }

  while node do
    local node_type = node:type()
    if scope_types[node_type] then
      local start_row, start_col, end_row, end_col = node:range()
      return {
        symbol = node_type,
        range = range_payload(start_row + 1, start_col + 1, end_row + 1, end_col + 1),
        confidence = 0.86,
        reason = "tree-sitter enclosing scope",
      }
    end
    node = node:parent()
  end

  return nil
end

local function current_scope_from_lines(bufnr)
  local cursor = vim.api.nvim_win_get_cursor(0)
  local patterns = {
    "^%s*local%s+function%s+([%w_%.:]+)",
    "^%s*function%s+([%w_%.:]+)",
    "^%s*export%s+function%s+([%w_]+)",
    "^%s*function%s+([%w_]+)",
    "^%s*def%s+([%w_]+)",
    "^%s*class%s+([%w_]+)",
  }

  for line_number = cursor[1], 1, -1 do
    local line = vim.api.nvim_buf_get_lines(bufnr, line_number - 1, line_number, false)[1] or ""
    for _, pattern in ipairs(patterns) do
      local name = line:match(pattern)
      if name then
        return {
          symbol = name,
          range = range_payload(line_number, 1, line_number, #line + 1),
          confidence = 0.45,
          reason = "nearest scope-looking line",
        }
      end
    end
  end

  return nil
end

local handlers = {}

handlers.editor_get_context = function()
  local capabilities = collect_capabilities()
  return collect_context(capabilities)
end

handlers.editor_go_to_line = function(args)
  local bufnr = vim.api.nvim_get_current_buf()
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  local requested_line = tonumber(args.line)

  if not requested_line then
    error("line must be a number")
  end

  local line = math.max(1, math.min(line_count, requested_line))
  vim.api.nvim_win_set_cursor(0, { line, 0 })
  vim.cmd("normal! zz")

  return {
    ok = true,
    file = vim.api.nvim_buf_get_name(bufnr),
    line = line,
  }
end

handlers.editor_go_to_file = function(args)
  local requested_path = args.path
  if type(requested_path) ~= "string" or requested_path == "" then
    error("path must be a non-empty string")
  end

  local path = requested_path
  if vim.fn.filereadable(path) ~= 1 then
    local from_cwd = vim.fn.fnamemodify(vim.loop.cwd() .. "/" .. requested_path, ":p")
    if vim.fn.filereadable(from_cwd) == 1 then
      path = from_cwd
    else
      local found = vim.fn.findfile(requested_path, ".;")
      if found ~= "" then
        path = found
      end
    end
  end

  if vim.fn.filereadable(path) ~= 1 then
    error("file not found: " .. requested_path)
  end

  vim.cmd.edit(vim.fn.fnameescape(path))

  return {
    ok = true,
    file = vim.api.nvim_buf_get_name(0),
  }
end

handlers.editor_get_buffer_slice = function(args)
  local bufnr = vim.api.nvim_get_current_buf()
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  local start_line = math.max(1, tonumber(args.start_line) or 1)
  local end_line = math.min(line_count, tonumber(args.end_line) or start_line)

  return {
    file = vim.api.nvim_buf_get_name(bufnr),
    start_line = start_line,
    end_line = end_line,
    lines = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, end_line, false),
  }
end

handlers.editor_replace_line = function(args)
  local bufnr = vim.api.nvim_get_current_buf()
  ensure_modifiable(bufnr)

  local cursor = vim.api.nvim_win_get_cursor(0)
  local line = tonumber(args.line) or cursor[1]
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  local replacement = args.text

  if type(replacement) ~= "string" then
    error("text must be a string")
  end

  line = math.max(1, math.min(line_count, line))
  vim.api.nvim_buf_set_lines(bufnr, line - 1, line, false, split_lines(replacement))
  vim.api.nvim_win_set_cursor(0, { line, 0 })

  return {
    ok = true,
    file = vim.api.nvim_buf_get_name(bufnr),
    line = line,
  }
end

handlers.editor_replace_range = function(args)
  local bufnr = vim.api.nvim_get_current_buf()
  ensure_modifiable(bufnr)

  local start_line = tonumber(args.start_line)
  local start_column = tonumber(args.start_column)
  local end_line = tonumber(args.end_line)
  local end_column = tonumber(args.end_column)
  local text = args.text

  if not start_line or not start_column or not end_line or not end_column then
    error("start_line, start_column, end_line, and end_column are required")
  end
  if type(text) ~= "string" then
    error("text must be a string")
  end

  local line_count = vim.api.nvim_buf_line_count(bufnr)
  start_line = clamp(start_line, 1, line_count)
  end_line = clamp(end_line, 1, line_count)

  if end_line < start_line then
    error("end_line must be greater than or equal to start_line")
  end

  local start_text = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, start_line, false)[1] or ""
  local end_text = vim.api.nvim_buf_get_lines(bufnr, end_line - 1, end_line, false)[1] or ""
  start_column = clamp(start_column, 1, #start_text + 1)
  end_column = clamp(end_column, 1, #end_text + 1)

  if end_line == start_line and end_column < start_column then
    error("end_column must be greater than or equal to start_column")
  end

  vim.api.nvim_buf_set_text(
    bufnr,
    start_line - 1,
    start_column - 1,
    end_line - 1,
    end_column - 1,
    split_lines(text)
  )

  return {
    ok = true,
    file = vim.api.nvim_buf_get_name(bufnr),
    start_line = start_line,
    end_line = end_line,
  }
end

handlers.editor_insert_at_cursor = function(args)
  local bufnr = vim.api.nvim_get_current_buf()
  ensure_modifiable(bufnr)

  if type(args.text) ~= "string" then
    error("text must be a string")
  end

  vim.api.nvim_put(split_lines(args.text), "c", true, true)

  return {
    ok = true,
    file = vim.api.nvim_buf_get_name(bufnr),
    cursor = collect_context().cursor,
  }
end

handlers.editor_locate_cursor_symbol = function()
  local bufnr = vim.api.nvim_get_current_buf()
  local file, relative_file = file_payload(bufnr)
  local symbol = find_cursor_symbol(bufnr)

  if not symbol then
    return locate_payload({
      file = file,
      relative_file = relative_file,
      confidence = 0,
      reason = "no symbol under cursor",
    })
  end

  return locate_payload({
    file = file,
    relative_file = relative_file,
    range = symbol.range,
    symbol = symbol.symbol,
    confidence = 0.92,
    reason = "token under cursor",
  })
end

handlers.editor_locate_current_function = function()
  local bufnr = vim.api.nvim_get_current_buf()
  local file, relative_file = file_payload(bufnr)
  local scope = current_scope_from_treesitter(bufnr) or current_scope_from_lines(bufnr)

  if not scope then
    return locate_payload({
      file = file,
      relative_file = relative_file,
      confidence = 0,
      reason = "no enclosing function or class found",
    })
  end

  scope.file = file
  scope.relative_file = relative_file
  return locate_payload(scope)
end

handlers.editor_locate_text = function(args)
  local query = args.query
  if type(query) ~= "string" or query == "" then
    error("query must be a non-empty string")
  end

  local scope = args.scope == "workspace" and "workspace" or "current_buffer"
  local max_results = clamp(args.max_results or 10, 1, 20)
  local bufnr = vim.api.nvim_get_current_buf()
  local cwd = vim.loop.cwd()
  local matches = {}

  if scope == "workspace" and vim.fn.executable("rg") == 1 then
    local lines = vim.fn.systemlist({ "rg", "--line-number", "--column", "--fixed-strings", "--", query, cwd })
    if type(lines) == "table" then
      for _, row in ipairs(lines) do
        if #matches >= max_results then
          break
        end
        local path, line, column, text = row:match("^(.-):(%d+):(%d+):(.*)$")
        if path then
          matches[#matches + 1] = {
            file = path,
            relative_file = vim.fn.fnamemodify(path, ":."),
            range = range_payload(tonumber(line), tonumber(column), tonumber(line), tonumber(column) + #query),
            text = text,
            confidence = 0.86,
            reason = "literal workspace match",
          }
        end
      end
    end
  else
    local file, relative_file = file_payload(bufnr)
    local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
    for line_number, line in ipairs(lines) do
      local start_column = line:find(query, 1, true)
      while start_column do
        matches[#matches + 1] = {
          file = file,
          relative_file = relative_file,
          range = range_payload(line_number, start_column, line_number, start_column + #query),
          text = line,
          confidence = 0.9,
          reason = "literal buffer match",
        }
        if #matches >= max_results then
          break
        end
        start_column = line:find(query, start_column + #query, true)
      end
      if #matches >= max_results then
        break
      end
    end
  end

  return locate_payload({
    query = query,
    scope = scope,
    matches = matches,
    file = matches[1] and matches[1].file or nil,
    relative_file = matches[1] and matches[1].relative_file or nil,
    range = matches[1] and matches[1].range or nil,
    confidence = matches[1] and matches[1].confidence or 0,
    reason = matches[1] and matches[1].reason or "no text match found",
  })
end

handlers.editor_locate_file = function(args)
  local query = args.query
  if type(query) ~= "string" or query == "" then
    error("query must be a non-empty string")
  end

  local max_results = clamp(args.max_results or 10, 1, 20)
  local cwd = vim.loop.cwd()
  local candidates = {}

  for _, path in ipairs(workspace_files(cwd)) do
    local score = fuzzy_score(path, query)
    if score > 0 then
      local absolute = path
      if not absolute:match("^/") then
        absolute = vim.fn.fnamemodify(cwd .. "/" .. path, ":p")
      end
      candidates[#candidates + 1] = {
        file = absolute,
        relative_file = vim.fn.fnamemodify(absolute, ":."),
        confidence = score,
        reason = "fuzzy file match",
      }
    end
  end

  table.sort(candidates, function(a, b)
    if a.confidence == b.confidence then
      return #a.relative_file < #b.relative_file
    end
    return a.confidence > b.confidence
  end)

  candidates = list_limit(candidates, max_results)

  return locate_payload({
    query = query,
    matches = candidates,
    file = candidates[1] and candidates[1].file or nil,
    relative_file = candidates[1] and candidates[1].relative_file or nil,
    confidence = candidates[1] and candidates[1].confidence or 0,
    reason = candidates[1] and candidates[1].reason or "no file match found",
  })
end

handlers.editor_locate_diagnostic = function(args)
  local bufnr = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local file, relative_file = file_payload(bufnr)
  local diagnostics = collect_diagnostics(bufnr, cursor, file).current_file
  local query = type(args.query) == "string" and args.query:lower() or nil
  local best
  local best_score = -1

  for _, diagnostic in ipairs(diagnostics) do
    local score
    if query and query ~= "" then
      local haystack = table.concat({
        tostring(diagnostic.message or ""),
        tostring(diagnostic.source or ""),
        tostring(diagnostic.code or ""),
      }, " "):lower()
      score = haystack:find(query, 1, true) and 1000 - math.abs(diagnostic.line - cursor[1]) or -1
    else
      score = 1000 - math.abs(diagnostic.line - cursor[1])
    end

    if score > best_score then
      best = diagnostic
      best_score = score
    end
  end

  if not best or best_score < 0 then
    return locate_payload({
      file = file,
      relative_file = relative_file,
      query = query,
      confidence = 0,
      reason = "no diagnostic found",
    })
  end

  return locate_payload({
    file = file,
    relative_file = relative_file,
    query = query,
    diagnostic = best,
    range = range_payload(best.line, best.column, best.end_line or best.line, best.end_column or best.column),
    symbol = best.message,
    confidence = query and 0.88 or 0.82,
    reason = query and "matching diagnostic" or "nearest diagnostic",
  })
end

handlers.cody_stop_voice_session = function()
  M.voice_stop()

  return {
    ok = true,
    detail = "stopped voice session",
  }
end

local function feedback_enabled()
  return state.config.feedback_panel ~= false
end

local function feedback_auto_open()
  return state.config.feedback_auto_open ~= false
end

local function feedback_buf_valid()
  return state.feedback.bufnr and vim.api.nvim_buf_is_valid(state.feedback.bufnr)
end

local function feedback_win_valid()
  return state.feedback.winid and vim.api.nvim_win_is_valid(state.feedback.winid)
end

local function feedback_ensure_buf()
  if feedback_buf_valid() then
    return state.feedback.bufnr
  end

  local bufnr = vim.api.nvim_create_buf(false, true)
  state.feedback.bufnr = bufnr
  vim.bo[bufnr].buftype = "nofile"
  vim.bo[bufnr].bufhidden = "hide"
  vim.bo[bufnr].swapfile = false
  vim.bo[bufnr].filetype = "cody-feedback"
  vim.keymap.set("n", "q", function()
    M.feedback_close()
  end, { buffer = bufnr, nowait = true, silent = true })
  return bufnr
end

local function feedback_dimensions()
  local columns = vim.o.columns or 80
  local lines = vim.o.lines or 24
  local width = math.min(configured_number("feedback_width", 96), math.max(30, columns - 4))
  local height = math.min(configured_number("feedback_height", 16), math.max(8, lines - 4))
  return width, height, math.max(0, lines - height - 3), math.max(0, columns - width - 2)
end

local function feedback_open()
  if not feedback_enabled() then
    return
  end
  if feedback_win_valid() then
    return
  end

  local bufnr = feedback_ensure_buf()
  local width, height, row, col = feedback_dimensions()
  state.feedback.winid = vim.api.nvim_open_win(bufnr, false, {
    relative = "editor",
    style = "minimal",
    border = "rounded",
    title = " Cody ",
    width = width,
    height = height,
    row = row,
    col = col,
    focusable = false,
    zindex = 45,
  })
  vim.wo[state.feedback.winid].wrap = false
end

local function feedback_event_line(kind, message)
  local timestamp = os.date("%H:%M:%S")
  return string.format("%s  %-10s %s", timestamp, kind, truncate_message(message, 140))
end

local function feedback_push_event(kind, message)
  local events = state.feedback.events
  events[#events + 1] = feedback_event_line(kind, message)
  local max_events = configured_number("feedback_max_events", 80)
  while #events > max_events do
    table.remove(events, 1)
  end
end

local function feedback_trim_text(message)
  local text = clean_panel_text(message)
  local max_chars = configured_number("feedback_message_max_chars", 4000)
  if #text <= max_chars then
    return text
  end
  return text:sub(1, max_chars - 3) .. "..."
end

local function feedback_push_conversation(role, message)
  local text = feedback_trim_text(message)
  if text == "" then
    return
  end

  local conversation = state.feedback.conversation
  local last = conversation[#conversation]
  if last and last.role == role and last.text == text then
    return
  end

  conversation[#conversation + 1] = {
    role = role,
    text = text,
  }

  local max_items = configured_number("feedback_conversation_items", 12)
  while #conversation > max_items do
    table.remove(conversation, 1)
  end
end

local function feedback_wrap_text(prefix, text, width)
  text = feedback_trim_text(text)
  local continuation = string.rep(" ", #prefix)
  local first_limit = math.max(12, width - #prefix)
  local next_limit = math.max(12, width - #continuation)
  local out = {}
  local line = ""
  local line_prefix = prefix
  local limit = first_limit

  local function flush()
    if line ~= "" then
      out[#out + 1] = line_prefix .. line
      line = ""
      line_prefix = continuation
      limit = next_limit
    end
  end

  for word in text:gmatch("%S+") do
    while #word > limit do
      if line ~= "" then
        flush()
      end
      out[#out + 1] = line_prefix .. word:sub(1, limit)
      word = word:sub(limit + 1)
      line_prefix = continuation
      limit = next_limit
    end

    local candidate = line == "" and word or (line .. " " .. word)
    if #candidate > limit then
      flush()
      line = word
    else
      line = candidate
    end
  end

  flush()
  if #out == 0 then
    out[1] = prefix .. "-"
  end
  return out
end

local function feedback_format_args(args)
  if type(args) ~= "table" then
    return ""
  end

  local ok, encoded = pcall(json_encode, args)
  if not ok then
    return ""
  end

  return " " .. truncate_message(encoded, 120)
end

local function feedback_render()
  if not feedback_enabled() or not feedback_buf_valid() then
    return
  end

  local width, height = feedback_dimensions()
  local lines = {
    "Cody: " .. (state.feedback.phase ~= "" and state.feedback.phase or "idle"),
    "Intent: " .. (state.feedback.intent ~= "" and state.feedback.intent or "-"),
    "Transcript: " .. (state.feedback.transcript ~= "" and state.feedback.transcript or "-"),
    "Action: " .. (state.feedback.action ~= "" and state.feedback.action or "-"),
    "Result: " .. (state.feedback.result ~= "" and state.feedback.result or "-"),
  }

  local conversation = vim.deepcopy(state.feedback.conversation)
  local last = conversation[#conversation]
  if state.feedback.assistant ~= "" and not (last and last.role == "Cody" and last.text == state.feedback.assistant) then
    conversation[#conversation + 1] = {
      role = "Cody",
      text = state.feedback.assistant,
    }
  end

  lines[#lines + 1] = ""
  lines[#lines + 1] = "Conversation"

  local recent_count = math.min(configured_number("feedback_recent_lines", 4), #state.feedback.events)
  local conversation_slots = math.max(3, height - #lines - recent_count - 3)
  local conversation_lines = {}
  for _, item in ipairs(conversation) do
    local prefix = item.role == "You" and "You: " or "Cody: "
    vim.list_extend(conversation_lines, feedback_wrap_text(prefix, item.text, width - 2))
  end

  if #conversation_lines == 0 then
    lines[#lines + 1] = "-"
  else
    local first_line = math.max(1, #conversation_lines - conversation_slots + 1)
    for i = first_line, #conversation_lines do
      lines[#lines + 1] = conversation_lines[i]
    end
  end

  lines[#lines + 1] = ""
  lines[#lines + 1] = "Recent"

  local event_slots = math.max(1, height - #lines)
  local first_event = math.max(1, #state.feedback.events - math.min(event_slots, recent_count) + 1)
  for i = first_event, #state.feedback.events do
    lines[#lines + 1] = state.feedback.events[i]
  end

  for i, line in ipairs(lines) do
    lines[i] = truncate_message(line, width - 2)
  end

  local bufnr = feedback_ensure_buf()
  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modifiable = false
end

local function feedback_record(event)
  if not feedback_enabled() or type(event) ~= "table" then
    return
  end

  local kind = event.kind or "status"
  local message = event.message or event.detail or event.phase or event.name or ""

  if kind == "phase" then
    state.feedback.phase = event.phase or message
    feedback_push_event("phase", table.concat(vim.tbl_filter(function(value)
      return value and value ~= ""
    end, { event.phase, event.detail }), ": "))
  elseif kind == "intent" then
    state.feedback.intent = truncate_message(message, 220)
    state.feedback.transcript = ""
    state.feedback.action = ""
    state.feedback.result = ""
    state.feedback.assistant = ""
    feedback_push_conversation("You", message)
    feedback_push_event("intent", message)
  elseif kind == "transcript" then
    if event.final then
      state.feedback.transcript = truncate_message(message, 220)
    else
      state.feedback.transcript = truncate_message(state.feedback.transcript .. message, 220)
    end
    feedback_push_event(event.final and "transcript" or "hearing", message)
  elseif kind == "action" then
    state.feedback.action = truncate_message((event.name or "tool") .. feedback_format_args(event.arguments), 220)
    feedback_push_event("action", state.feedback.action)
  elseif kind == "result" then
    local prefix = event.ok == false and "failed" or "ok"
    local name = event.name and (event.name .. ": ") or ""
    state.feedback.result = truncate_message(prefix .. " " .. name .. message, 220)
    feedback_push_event("result", state.feedback.result)
  elseif kind == "message" then
    if event.append then
      state.feedback.assistant = feedback_trim_text(state.feedback.assistant .. message)
      if event.final then
        feedback_push_conversation("Cody", state.feedback.assistant)
        feedback_push_event("message", state.feedback.assistant)
      end
    else
      state.feedback.assistant = feedback_trim_text(message)
      feedback_push_conversation("Cody", message)
      feedback_push_event("message", message)
    end
  else
    feedback_push_event(kind, message)
  end

  if feedback_auto_open() then
    feedback_open()
  end
  feedback_render()
end

local function feedback_status(message)
  if not feedback_enabled() then
    return
  end

  feedback_push_event("status", message)
  if feedback_auto_open() then
    feedback_open()
  end
  feedback_render()
end

-- Emits the tool_result for a finished tool call and refreshes editor context on
-- success. Factored out so async handlers (e.g. editor_run_command) can call it
-- from a vim.system callback instead of returning inline.
local function send_tool_result(message, ok, result)
  if ok and type(result) == "table" and result.detail then
    show_status(result.detail)
  end

  send({
    type = "tool_result",
    request_id = message.request_id,
    ok = ok,
    output = ok and result or tostring(result),
  })

  if ok then
    local capabilities = collect_capabilities()
    send({
      type = "editor_context",
      context = collect_context(capabilities),
    })
    send({
      type = "capabilities",
      capabilities = capabilities,
    })
  end
end

local function handle_tool_call(message)
  local handler = handlers[message.name]
  local ok, result
  if handler then
    ok, result = pcall(handler, message.arguments or {}, message)
  else
    ok, result = pcall(function()
      return require("cody.adapter").invoke(message.name, message.arguments or {})
    end)
  end

  -- An async handler returns this sentinel and takes ownership of sending its own
  -- tool_result later (via send_tool_result) when the underlying job finishes.
  if ok and type(result) == "table" and result.__async then
    return
  end

  send_tool_result(message, ok, result)
end

-- ── editor_run_command (opt-in shell tool) ──────────────────────────────────
-- Off by default and gated three ways: the bridge only advertises the tool when
-- CODY_ENABLE_SHELL is set, this handler refuses unless enable_shell = true, and
-- every command is checked against an allowlist (and confirmed) before running.

local DEFAULT_SHELL_ALLOWLIST = {
  npm = true, npx = true, pnpm = true, yarn = true, node = true,
  git = true, cargo = true, rustc = true, make = true, go = true,
  python = true, python3 = true, pytest = true, ruff = true,
  rg = true, fd = true, ls = true, cat = true, echo = true,
  tsc = true, eslint = true, prettier = true, lua = true, luarocks = true,
}

local function shell_allowlist()
  local configured = state.config.shell_allowlist
  if type(configured) == "table" then
    local set = {}
    for _, name in ipairs(configured) do
      set[name] = true
    end
    return set
  end
  return DEFAULT_SHELL_ALLOWLIST
end

local function allowlist_display(set)
  local names = {}
  for name in pairs(set) do
    names[#names + 1] = name
  end
  table.sort(names)
  return table.concat(names, " ")
end

-- Turns the model-supplied command (string or argv list) into an argv list plus a
-- human-readable display string. Raises (caught by handle_tool_call -> ok=false)
-- on empty input, shell metacharacters in string form, or a disallowed executable.
local function normalize_shell_command(command)
  local argv
  if type(command) == "table" then
    argv = {}
    for _, part in ipairs(command) do
      if type(part) ~= "string" then
        error("each command element must be a string")
      end
      argv[#argv + 1] = part
    end
  elseif type(command) == "string" and command:match("%S") then
    if command:find("[;&|`$<>\n]") then
      error("shell metacharacters are not allowed; pass an argv array for complex commands")
    end
    argv = vim.split(command, "%s+", { trimempty = true })
  else
    error("command must be a non-empty string or argv array")
  end

  if #argv == 0 then
    error("command must include an executable")
  end

  local set = shell_allowlist()
  local head = vim.fn.fnamemodify(argv[1], ":t")
  if not set[head] then
    error(
      "command not allowed by Cody shell allowlist: " .. head
        .. ". Allowed: " .. allowlist_display(set)
        .. ". Override with shell_allowlist in require('cody').setup(...)."
    )
  end

  -- Scrub control characters so a crafted argv (e.g. embedded newlines) cannot
  -- spoof the confirm modal text; the executed value is always the argv list.
  local display = (table.concat(argv, " ")):gsub("[%z\1-\31]", " ")
  return argv, display
end

-- Builds the tool result from a vim.system completion object, capping combined
-- stdout+stderr (the full value is sent to the model, so an unbounded command
-- could otherwise flood the context).
local function build_shell_result(display, cwd, obj, timeout)
  local stdout = obj.stdout or ""
  local stderr = obj.stderr or ""
  local code = obj.code or -1
  -- vim.system reports code 124 on timeout, but kills with a signal; a command
  -- that genuinely exits 124 has no signal, so don't misreport it as a timeout.
  local timed_out = code == 124 and (obj.signal or 0) ~= 0

  local combined = stdout
  if stderr ~= "" then
    combined = combined ~= "" and (combined .. "\n" .. stderr) or stderr
  end

  local cap = configured_number("shell_output_max_bytes", 8000)
  local truncated = false
  if #combined > cap then
    combined = "...[truncated " .. (#combined - cap) .. " bytes]...\n" .. combined:sub(-cap)
    truncated = true
  end

  local detail
  if timed_out then
    detail = string.format("command timed out after %dms: %s", timeout, display)
  else
    detail = string.format("ran command (exit %d): %s", code, display)
  end

  return {
    ok = code == 0 and not timed_out,
    code = code,
    timed_out = timed_out or nil,
    output = combined,
    truncated = truncated or nil,
    command = display,
    cwd = cwd,
    detail = detail,
  }
end

handlers.editor_run_command = function(args, message)
  if state.config.enable_shell ~= true then
    error("editor_run_command is disabled. Set enable_shell = true in require('cody').setup(...) and restart Cody (:CodyStop then :CodyStart).")
  end

  local argv, display = normalize_shell_command(args.command)

  local cwd = args.cwd
  if type(cwd) ~= "string" or cwd == "" then
    cwd = vim.loop.cwd()
  end

  local timeout = clamp(args.timeout_ms or configured_number("shell_timeout_ms", 15000), 1000, 120000)

  if state.config.shell_skip_confirm ~= true then
    local prompt = "Cody wants to run:\n  " .. display .. "\nin " .. cwd .. "\n\nRun it?"
    if vim.fn.confirm(prompt, "&Yes\n&No", 2) ~= 1 then
      error("user declined command: " .. display)
    end
  end

  local launched, err = pcall(vim.system, argv, { cwd = cwd, text = true, timeout = timeout }, function(obj)
    vim.schedule(function()
      send_tool_result(message, true, build_shell_result(display, cwd, obj, timeout))
    end)
  end)
  if not launched then
    error("failed to start command: " .. tostring(err))
  end

  return { __async = true }
end

-- Test hooks (consumed by test/shell_handler_spec.lua).
M._handlers = handlers
M._normalize_shell_command = normalize_shell_command
M._build_shell_result = build_shell_result

-- ── editor_command (opt-in Ex-command tool) ─────────────────────────────────
-- Off by default; gated like the shell tool. Only allowlisted command names run,
-- and ! / | / control characters are rejected, so :!, :lua, and chaining cannot
-- be reached. Use :CodySet (which is allowlisted) to change live config keys.

local DEFAULT_COMMAND_ALLOWLIST = {
  CodyTranscript = true, CodyFeedback = true, CodyFeedbackOpen = true,
  CodyFeedbackClose = true, CodyFeedbackClear = true, CodyCapabilities = true,
  CodyVoiceStop = true, CodyTtsStatus = true, CodySet = true, CodyStartTsLsp = true,
  split = true, vsplit = true, only = true, close = true, redraw = true, wincmd = true,
  noh = true, nohlsearch = true, messages = true, tabclose = true, tabonly = true,
  -- Built-in netrw file explorer (the "file tree"). These browse the filesystem,
  -- which is the point of a file tree; they do not write.
  Explore = true, Lexplore = true, Sexplore = true, Vexplore = true,
  Texplore = true, Hexplore = true, Rexplore = true,
}
-- NOTE: file-writing/opening commands (write, w, update, edit, tabnew, read) are
-- deliberately NOT in the default set — with a path argument they write the
-- buffer to / read an arbitrary file. Add them via commands_allowlist only if you
-- accept that and ideally with commands_confirm = true.

local function command_allowlist()
  local configured = state.config.commands_allowlist
  if type(configured) == "table" then
    local set = {}
    for _, name in ipairs(configured) do
      set[name] = true
    end
    return set
  end
  return DEFAULT_COMMAND_ALLOWLIST
end

-- Strips a leading colon/whitespace, rejects dangerous syntax, and checks the
-- command name against the allowlist. Returns the cleaned command and its name;
-- raises (caught by handle_tool_call -> ok=false) on anything not allowed.
local function normalize_ex_command(command)
  if type(command) ~= "string" or not command:match("%S") then
    error("command must be a non-empty string")
  end

  local cleaned = command:gsub("^%s*:?%s*", "")
  if cleaned:find("[!|]") or cleaned:find("[%z\1-\31]") then
    error("'!', '|', and control characters are not allowed in editor commands")
  end

  local name = cleaned:match("^(%a[%w_]*)")
  if not name then
    error("could not parse a command name from: " .. command)
  end

  local set = command_allowlist()
  if not set[name] then
    error(
      "command not allowed by Cody command allowlist: " .. name
        .. ". Allowed: " .. allowlist_display(set)
        .. ". Override with commands_allowlist in require('cody').setup(...)."
    )
  end

  return cleaned, name
end

handlers.editor_command = function(args)
  if state.config.enable_commands ~= true then
    error("editor_command is disabled. Set enable_commands = true in require('cody').setup(...) and restart Cody (:CodyStop then :CodyStart).")
  end

  local cleaned, name = normalize_ex_command(args.command)

  if state.config.commands_confirm == true then
    if vim.fn.confirm("Cody wants to run:\n  :" .. cleaned .. "\n\nRun it?", "&Yes\n&No", 2) ~= 1 then
      error("user declined command: :" .. cleaned)
    end
  end

  local ran, res = pcall(vim.api.nvim_exec2, cleaned, { output = true })
  if not ran then
    error("command failed: " .. tostring(res))
  end

  local output = (type(res) == "table" and res.output) or ""
  local cap = configured_number("command_output_max_bytes", 4000)
  local truncated = false
  if #output > cap then
    output = "...[truncated " .. (#output - cap) .. " bytes]...\n" .. output:sub(-cap)
    truncated = true
  end

  return {
    ok = true,
    command = cleaned,
    output = output ~= "" and output or nil,
    truncated = truncated or nil,
    detail = "ran :" .. name,
  }
end

M._normalize_ex_command = normalize_ex_command

local function handle_bridge_message(message)
  if message.type == "status" then
    show_status(message.message)
    feedback_status(message.message)
  elseif message.type == "error" then
    notify(message.message, vim.log.levels.ERROR)
    feedback_record({
      kind = "phase",
      phase = "failed",
      detail = message.message,
    })
  elseif message.type == "assistant_delta" then
    feedback_record({
      kind = "message",
      message = message.delta,
      append = true,
      final = false,
    })
    if state.config.show_deltas then
      vim.api.nvim_echo({ { message.delta, "Comment" } }, false, {})
    end
  elseif message.type == "assistant_message" then
    if state.feedback.assistant ~= feedback_trim_text(message.message) then
      feedback_record({
        kind = "message",
        message = message.message,
      })
    end
    if state.config.show_assistant_messages then
      show_status(message.message)
    end
  elseif message.type == "feedback" then
    feedback_record(message.event)
  elseif message.type == "tool_call" then
    vim.schedule(function()
      handle_tool_call(message)
    end)
  end
end

local function on_stdout(_, data)
  for _, line in ipairs(data) do
    if line and line ~= "" then
      local ok, decoded = pcall(json_decode, line)
      if ok then
        handle_bridge_message(decoded)
      else
        notify("Invalid bridge JSON: " .. line, vim.log.levels.ERROR)
      end
    end
  end
end

local function on_stderr(_, data)
  for _, line in ipairs(data) do
    if line and line ~= "" then
      notify(line, vim.log.levels.WARN)
    end
  end
end

function M.setup(config)
  state.config = config or {}
  if state.config.show_assistant_messages == nil then
    state.config.show_assistant_messages = true
  end
  if state.config.feedback_panel == nil then
    state.config.feedback_panel = true
  end
  if state.config.feedback_auto_open == nil then
    state.config.feedback_auto_open = true
  end
  -- Shell + Ex-command tools default ON (set these false to disable). The handler
  -- still refuses unless setup() ran, so a bare plugin load with no setup() stays
  -- off as a safety floor.
  if state.config.enable_shell == nil then
    state.config.enable_shell = true
  end
  if state.config.enable_commands == nil then
    state.config.enable_commands = true
  end
  -- Skip the shell per-command confirm by default (hands-free voice). Set
  -- shell_skip_confirm = false to restore the prompt before every shell command.
  if state.config.shell_skip_confirm == nil then
    state.config.shell_skip_confirm = true
  end
  if state.config.tts_enabled == nil then
    state.config.tts_enabled = false
  end
  if state.config.tts_provider == nil then
    state.config.tts_provider = "elevenlabs"
  end
  if state.config.tts_speak_phases == nil then
    state.config.tts_speak_phases = false
  end
  for _, key in ipairs({ "tts_speak_actions", "tts_speak_results", "tts_speak_messages" }) do
    if state.config[key] == nil then
      state.config[key] = true
    end
  end
  if state.config.tts_message_max_chars == nil then
    state.config.tts_message_max_chars = 160
  end
  if
    state.config.quick_commands ~= nil
    and state.config.quick_commands ~= "fallback"
    and state.config.quick_commands ~= "always"
    and state.config.quick_commands ~= "off"
  then
    notify("Invalid quick_commands value; using fallback", vim.log.levels.WARN)
    state.config.quick_commands = "fallback"
  end
end

function M.feedback_open()
  feedback_open()
  feedback_render()
end

function M.feedback_close()
  if feedback_win_valid() then
    vim.api.nvim_win_close(state.feedback.winid, true)
  end
  state.feedback.winid = nil
end

function M.feedback_toggle()
  if feedback_win_valid() then
    M.feedback_close()
  else
    M.feedback_open()
  end
end

function M.feedback_clear()
  state.feedback.phase = "idle"
  state.feedback.intent = ""
  state.feedback.transcript = ""
  state.feedback.action = ""
  state.feedback.result = ""
  state.feedback.assistant = ""
  state.feedback.conversation = {}
  state.feedback.events = {}
  feedback_render()
end

-- Builds the full, untruncated transcript as display lines. Pure so it can be
-- unit-tested without opening a window. Multi-line messages are kept intact and
-- continuation lines are indented under the role prefix.
local function transcript_lines(conversation, assistant)
  local items = vim.deepcopy(conversation or {})
  local last = items[#items]
  if assistant and assistant ~= "" and not (last and last.role == "Cody" and last.text == assistant) then
    items[#items + 1] = { role = "Cody", text = assistant }
  end

  local lines = { "# Cody transcript  (q to close)", "" }
  if #items == 0 then
    lines[#lines + 1] = "(no messages yet)"
    return lines
  end

  for _, item in ipairs(items) do
    local prefix = item.role == "You" and "You: " or "Cody: "
    local segments = vim.split(item.text or "", "\n", { plain = true })
    for i, segment in ipairs(segments) do
      if i == 1 then
        lines[#lines + 1] = prefix .. segment
      else
        lines[#lines + 1] = string.rep(" ", #prefix) .. segment
      end
    end
    lines[#lines + 1] = ""
  end
  return lines
end

M._transcript_lines = transcript_lines

-- Opens the full conversation in a scrollable, focusable float (unlike the live
-- HUD panel, which is focusable = false and only shows the tail that fits).
function M.transcript()
  local lines = transcript_lines(state.feedback.conversation, state.feedback.assistant)

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "markdown"
  vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = buf, nowait = true, silent = true })

  local width = math.min(100, math.max(40, vim.o.columns - 8))
  local height = math.min(math.max(10, #lines), math.max(10, vim.o.lines - 6))
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    style = "minimal",
    border = "rounded",
    title = " Cody transcript ",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
  })
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true
  vim.wo[win].cursorline = true
  -- Land on the latest message so streaming output is visible immediately.
  vim.api.nvim_win_set_cursor(win, { #lines, 0 })
end

-- Live-applicable config keys settable via :CodySet (and editor_command). They
-- are read on the next render/tool call, so they take effect without a restart —
-- unlike env-derived flags (enable_shell, enable_commands, tts_*) which are
-- captured at :CodyStart.
local LIVE_CONFIG_KEYS = {
  feedback_height = "number",
  feedback_width = "number",
  feedback_recent_lines = "number",
  feedback_conversation_items = "number",
  context_max_lines = "number",
  context_max_bytes = "number",
  show_assistant_messages = "boolean",
  -- Security-guard toggles (shell_skip_confirm, commands_confirm) are intentionally
  -- NOT live-settable, so an allowlisted :CodySet cannot relax the confirm gate at
  -- runtime; set them in setup() at startup only.
}

local function coerce_config_value(kind, raw)
  if kind == "number" then
    local n = tonumber(raw)
    if not n then
      error("expected a number, got: " .. tostring(raw))
    end
    return n
  end
  if kind == "boolean" then
    local v = tostring(raw):lower()
    if v == "true" or v == "1" or v == "on" or v == "yes" then
      return true
    end
    if v == "false" or v == "0" or v == "off" or v == "no" then
      return false
    end
    error("expected true/false, got: " .. tostring(raw))
  end
  return raw
end

local function live_config_keys_display()
  local names = {}
  for key in pairs(LIVE_CONFIG_KEYS) do
    names[#names + 1] = key
  end
  table.sort(names)
  return table.concat(names, " ")
end

--- Set a single live-applicable config key. Returns a result table (used by the
--- :CodySet command for its status line).
function M.set_config(key, value)
  if type(key) ~= "string" or key == "" then
    error("usage: CodySet <key> <value>")
  end
  local kind = LIVE_CONFIG_KEYS[key]
  if not kind then
    error("unknown or non-live setting: " .. key .. ". Settable live: " .. live_config_keys_display())
  end

  state.config = state.config or {}
  state.config[key] = coerce_config_value(kind, value)
  feedback_render()

  return {
    ok = true,
    key = key,
    value = state.config[key],
    detail = string.format("set %s = %s", key, tostring(state.config[key])),
  }
end

function M.set_config_command(arg)
  local key, value = tostring(arg or ""):match("^%s*(%S+)%s+(.-)%s*$")
  if not key then
    notify("usage: CodySet <key> <value>", vim.log.levels.ERROR)
    return
  end
  local ok, result = pcall(M.set_config, key, value)
  if ok then
    show_status(result.detail)
  else
    notify(tostring(result), vim.log.levels.ERROR)
  end
end

local function env_bool(value, default)
  if value == nil then
    value = default
  end
  return value and "1" or "0"
end

-- Builds the environment passed to the Node bridge. Neovim merges this with the
-- parent environment, so shell-provided keys like OPENAI_API_KEY and
-- ELEVENLABS_API_KEY are inherited automatically. We only set the ElevenLabs
-- voice/model here when configured in Lua, so we never clobber a shell value
-- with an empty string.
local function build_job_env(config)
  config = config or {}
  local env = {
    CODY_QUICK_COMMANDS = config.quick_commands or "fallback",
    CODY_ENABLE_SHELL = env_bool(config.enable_shell, false),
    CODY_ENABLE_COMMANDS = env_bool(config.enable_commands, false),
    CODY_TTS_ENABLED = env_bool(config.tts_enabled, false),
    CODY_TTS_PROVIDER = config.tts_provider or "elevenlabs",
    CODY_TTS_SPEAK_PHASES = env_bool(config.tts_speak_phases, false),
    CODY_TTS_SPEAK_ACTIONS = env_bool(config.tts_speak_actions, true),
    CODY_TTS_SPEAK_RESULTS = env_bool(config.tts_speak_results, true),
    CODY_TTS_SPEAK_MESSAGES = env_bool(config.tts_speak_messages, true),
    CODY_TTS_MESSAGE_MAX_CHARS = tostring(config.tts_message_max_chars or 160),
  }

  if type(config.tts_voice_id) == "string" and config.tts_voice_id ~= "" then
    env.ELEVENLABS_VOICE_ID = config.tts_voice_id
  end
  if type(config.tts_model_id) == "string" and config.tts_model_id ~= "" then
    env.ELEVENLABS_MODEL_ID = config.tts_model_id
  end
  if type(config.tts_request_timeout_ms) == "number" and config.tts_request_timeout_ms > 0 then
    env.CODY_TTS_REQUEST_TIMEOUT_MS = tostring(math.floor(config.tts_request_timeout_ms))
  end

  return env
end

function M._build_job_env(config)
  return build_job_env(config)
end

function M.start()
  if state.job_id then
    return
  end

  local root = plugin_root()
  local dist_entry = root .. "/dist/cli.js"
  local command

  if state.config.command then
    command = state.config.command
  elseif vim.fn.filereadable(dist_entry) == 1 then
    command = { "node", dist_entry }
  else
    command = { "npm", "run", "--silent", "dev" }
  end

  state.job_id = vim.fn.jobstart(command, {
    cwd = root,
    env = build_job_env(state.config),
    stdin = "pipe",
    stdout_buffered = false,
    stderr_buffered = false,
    on_stdout = on_stdout,
    on_stderr = on_stderr,
    on_exit = function(_, code)
      state.job_id = nil
      notify("Realtime bridge exited with code " .. code, code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR)
    end,
  })

  if state.job_id <= 0 then
    state.job_id = nil
    notify("Failed to start Realtime bridge", vim.log.levels.ERROR)
    return
  end

  local capabilities = collect_capabilities()
  send({
    type = "editor_context",
    context = collect_context(capabilities),
  })
  send({
    type = "capabilities",
    capabilities = capabilities,
  })
end

function M.stop()
  if not state.job_id then
    return
  end

  send({ type = "shutdown" })
  vim.fn.jobstop(state.job_id)
  state.job_id = nil
end

function M.do_text(text)
  if type(text) ~= "string" or text == "" then
    notify("Usage: :CodyDo <instruction>", vim.log.levels.ERROR)
    return
  end

  local capabilities = collect_capabilities()
  local context = collect_context(capabilities)
  send({
    type = "text_command",
    id = next_id(),
    text = text,
    context = context,
    capabilities = capabilities,
  })
end

function M.capabilities_report(arg)
  local ok, capabilities = pcall(require, "cody.capabilities")
  if not ok then
    notify("Failed to load capabilities: " .. tostring(capabilities), vim.log.levels.ERROR)
    return
  end

  if arg == "json" then
    local ok_json, payload = pcall(capabilities.to_json)
    if not ok_json then
      notify("Capability detection failed: " .. tostring(payload), vim.log.levels.ERROR)
      return
    end
    vim.api.nvim_echo({ { payload, "Normal" } }, false, {})
    return
  end

  local ok_report, err = pcall(capabilities.report)
  if not ok_report then
    notify("Capability detection failed: " .. tostring(err), vim.log.levels.ERROR)
  end
end

function M.install_suggest(arg)
  local ok, install = pcall(require, "cody.install")
  if not ok then
    notify("Failed to load install planner: " .. tostring(install), vim.log.levels.ERROR)
    return
  end

  arg = arg or ""
  if arg == "json" then
    local ok_json, payload = pcall(install.plan_json)
    if not ok_json then
      notify("Install planning failed: " .. tostring(payload), vim.log.levels.ERROR)
      return
    end
    vim.api.nvim_echo({ { payload, "Normal" } }, false, {})
    return
  end

  if arg ~= "" then
    local ok_prepare, err = pcall(install.prepare, arg)
    if not ok_prepare then
      notify("Install planning failed: " .. tostring(err), vim.log.levels.ERROR)
    end
    return
  end

  local ok_report, err = pcall(install.report)
  if not ok_report then
    notify("Install planning failed: " .. tostring(err), vim.log.levels.ERROR)
  end
end

function M.start_ts_lsp(opts)
  local ok, lsp = pcall(require, "cody.lsp")
  if not ok then
    notify("Failed to load LSP helper: " .. tostring(lsp), vim.log.levels.ERROR)
    return
  end

  local ok_start, err = pcall(lsp.start_ts, opts or {})
  if not ok_start then
    notify("TypeScript LSP failed: " .. tostring(err), vim.log.levels.ERROR)
  end
end

function M.voice_start()
  local capabilities = collect_capabilities()
  local context = collect_context(capabilities)
  send({
    type = "voice_start",
    id = next_id(),
    context = context,
    capabilities = capabilities,
  })
end

function M.voice_session_start()
  local capabilities = collect_capabilities()
  local context = collect_context(capabilities)
  send({
    type = "voice_session_start",
    id = next_id(),
    context = context,
    capabilities = capabilities,
  })
end

function M.voice_press()
  local capabilities = collect_capabilities()
  local context = collect_context(capabilities)
  send({
    type = "voice_press",
    id = next_id(),
    context = context,
    capabilities = capabilities,
  })
end

function M.voice_release()
  local capabilities = collect_capabilities()
  local context = collect_context(capabilities)
  send({
    type = "voice_release",
    id = next_id(),
    context = context,
    capabilities = capabilities,
  })
end

function M.voice_stop()
  local capabilities = collect_capabilities()
  local context = collect_context(capabilities)
  send({
    type = "voice_stop",
    id = next_id(),
    context = context,
    capabilities = capabilities,
  })
end

function M.tts_status()
  send({
    type = "tts_status",
    id = next_id(),
  })
end

function M.tts_smoke(text)
  send({
    type = "tts_smoke",
    id = next_id(),
    text = text,
  })
end

return M
