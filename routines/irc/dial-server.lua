--[[
/config/ mounts ROM-like data from the user, only editable by user action
/persist/ mounts disk-like data, we can read/write freely in here
/secret/ is like /config/, but for credentials - encrypted, slow, & secure
/state/ is like RAM (volatile & local to us) - keep track of stuff here
/export/ is built by us, to expose functionality and data to other components
specific to irc-app:
/dial is a Function provided by the user from an irc-dialer driver
]]--

local configName = input.network
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

-- There is no live wire. Time to commit.
ctx.store(state, "status", "Pending")

-- Before we connect, let's clean out all the wire-specific persistent state
ctx.log("Clearing connection state for", configName)
ctx.unlink(persist, "wire-checkpoint")
ctx.unlink(persist, "umodes")
ctx.unlink(persist, "current-nick")

ctx.mkdirp(persist, "channels")
local chans = ctx.enumerate(persist, "channels")
for _, chan in ipairs(chans) do
  ctx.unlink(persist, "channels", chan.name, "membership")
  ctx.unlink(persist, "channels", chan.name, "modes")
  ctx.store(persist, "channels", chan.name, "is-joined", "no")
end

-- Dial a new IRC wire and store it
ctx.log("Dialing new IRC wire for", configName)
ctx.store(state, "status", "Dialing")
local wireUri = ctx.invoke("session", "drivers", "irc-dialer", "dial", config)
ctx.store(persist, "wire-uri", wireUri)

-- Import the wire and boot the connection
local wire = ctx.import(wireUri)
ctx.log("Dialed", configName, ":)")
ctx.store(state, "wire", wire)
ctx.startRoutine("maintain-wire", {network=configName})
