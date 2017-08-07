--[[
/config/ mounts ROM-like data from the user, only editable by user action
/persist/ mounts disk-like data, we can read/write freely in here
/secret/ is like /config/, but for credentials - encrypted, slow, & secure
/state/ is like RAM (volatile & local to us) - keep track of stuff here
/export/ is built by us, to expose functionality and data to other components
/dial is a bare function provided by the user from an irc-dialer driver
]]--

function ensureWire(configName)
  local config = ctx.mkdirp("config", "networks", configName)
  local state = ctx.mkdirp("state", "networks", configName)
  local persist = ctx.mkdirp("persist", "networks", configName)

  -- Check for existing wire connection
  local status = ctx.read(state, "status")
  ctx.log("Network", configName, "status is", status)
  if status == "Ready" or status == "Pending" then
    ctx.log("Network", configName, "status is already", status)
    return
  end

  -- Reconnect to existing wire if any
  local wireUri = ctx.read(persist, "wire-uri")
  if wireUri ~= "" then
    ctx.log("Attempting to recover wire for", configName, "from", wireUri)
    local wire = ctx.import(wireUri)
    if wire then

      -- Verify status before reusing the wire
      local status = ctx.read(wire, "state")
      ctx.log("Found wire for", configName, "with status", status)
      if status == "Ready" or status == "Pending" then
        ctx.store(state, "wire", wire)
        ctx.store(state, "status", status)
        ctx.startRoutine("maintain-wire", {network=configName})
        return
      else
        -- ctx.clunk(wire)
      end
    end
  end

  -- Start a new wire, if enabled
  if ctx.read(config, "auto-connect") ~= "no" then
    ctx.log("Dialing new IRC wire for", configName)
    local wireUri = ctx.invoke("session", "drivers", "irc-dialer", "dial", config)
    ctx.store(persist, "wire-uri", wireUri)
    ctx.unlink(persist, "wire-checkpoint")

    local wire = ctx.import(wireUri)
    ctx.log("Dialed", configName, ":)")

    ctx.store(state, "wire", wire)
    ctx.store(state, "status", "Pending")
    ctx.startRoutine("maintain-wire", {network=configName})
  end
end

-- actually check all configured networks
local configs = ctx.enumerate("config", "networks")
for _, config in ipairs(configs) do
  local status, err = pcall(ensureWire, config.name)
  if status then
    ctx.log("Ensured wire for", config.name)
  else
    ctx.log("Failed to ensure wire for", config.name, "-", err)
  end
end
