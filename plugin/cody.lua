if vim.g.loaded_cody_realtime == 1 then
  return
end

vim.g.loaded_cody_realtime = 1

vim.api.nvim_create_user_command("CodyStart", function()
  require("cody").start()
end, {})

vim.api.nvim_create_user_command("CodyStop", function()
  require("cody").stop()
end, {})

vim.api.nvim_create_user_command("CodyDo", function(opts)
  require("cody").do_text(opts.args)
end, { nargs = "+" })

vim.api.nvim_create_user_command("CodyCapabilities", function(opts)
  require("cody").capabilities_report(opts.args)
end, {
  nargs = "?",
  complete = function()
    return { "json" }
  end,
})

vim.api.nvim_create_user_command("CodyFeedback", function()
  require("cody").feedback_toggle()
end, {})

vim.api.nvim_create_user_command("CodyFeedbackOpen", function()
  require("cody").feedback_open()
end, {})

vim.api.nvim_create_user_command("CodyFeedbackClose", function()
  require("cody").feedback_close()
end, {})

vim.api.nvim_create_user_command("CodyFeedbackClear", function()
  require("cody").feedback_clear()
end, {})

vim.api.nvim_create_user_command("CodyTranscript", function()
  require("cody").transcript()
end, {})

vim.api.nvim_create_user_command("CodySet", function(opts)
  require("cody").set_config_command(opts.args)
end, { nargs = "+" })

vim.api.nvim_create_user_command("CodyInstall", function(opts)
  require("cody").install_suggest(opts.args)
end, {
  nargs = "?",
  complete = function()
    local ok, install = pcall(require, "cody.install")
    if not ok then
      return { "json" }
    end
    return install.complete()
  end,
})

vim.api.nvim_create_user_command("CodyStartTsLsp", function(opts)
  require("cody").start_ts_lsp({ force = opts.bang })
end, { bang = true })

vim.api.nvim_create_user_command("CodyVoiceStart", function()
  require("cody").voice_start()
end, {})

vim.api.nvim_create_user_command("CodyVoiceSession", function()
  require("cody").voice_session_start()
end, {})

vim.api.nvim_create_user_command("CodyVoicePress", function()
  require("cody").voice_press()
end, {})

vim.api.nvim_create_user_command("CodyVoiceRelease", function()
  require("cody").voice_release()
end, {})

vim.api.nvim_create_user_command("CodyVoiceStop", function()
  require("cody").voice_stop()
end, {})

vim.api.nvim_create_user_command("CodyTtsStatus", function()
  require("cody").tts_status()
end, {})

vim.api.nvim_create_user_command("CodyTtsSmoke", function(opts)
  require("cody").tts_smoke(opts.args)
end, { nargs = "*" })
