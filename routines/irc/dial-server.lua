--[[
/config/ mounts ROM-like data from the user, only editable by user action
/persist/ mounts disk-like data, we can read/write freely in here
-- /secret/ is like /config/, but for credentials - encrypted, slow, & secure
/state/ is like RAM (volatile & local to us) - keep track of stuff here
-- /export/ is built by us, to expose functionality and data to other components
specific to irc-app:
/irc-modem/dial is a Function provided by the user from an irc-dialer driver
]]--

local configName = input.network
local config = ctx.chroot("config", "networks", configName)
local state = ctx.mkdirp("state", "networks", configName)
local persist = ctx.mkdirp("persist", "networks", configName)

-- Check for existing wire connection
local status = ctx.read(state, "status")
ctx.log("Network", configName, "status is", status)
if status == "Ready" or status == "Pending" then
  ctx.log("Network", configName, "status is already", status)
  return
end

-- Mark that we're present, now that we're alone
-- Avoids racing to do this before we do too much network :)
ctx.store(state, "status", "Pending")

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
      ctx.bind(state, "wire", wire)
      ctx.store(state, "status", status)
      ctx.startRoutine("maintain-wire", {network=configName})
      return
    else
      -- ctx.clunk(wire)
    end
  end
end

-- There is no live wire. Let's see if we can dial out.
ctx.log("Dialing new IRC wire for", configName)
ctx.store(state, "status", "Dialing")
local wireUri = ctx.invoke("irc-modem", "dial", config)

-- If we can't, there's nothing else to do. Bail.
if not wireUri then
  ctx.log("WARN: Failed to dial network", configName)
  ctx.store(state, "status", "Failed: Dial didn't work")
  return
elseif string.sub(wireUri, 1, 4) == "Err!" then
  ctx.log("WARN: Failed to dial network", configName, "--", wireUri)
  ctx.store(state, "status", "Failed: Dial "..wireUri)
  return
end

-- Clean out all the wire-specific persistent state
ctx.log("Clearing connection state for", configName)
ctx.unlink(persist, "wire-checkpoint")
ctx.unlink(persist, "umodes")
ctx.unlink(persist, "current-nick")

-- Reset all the channels
ctx.mkdirp(persist, "channels")
local chans = ctx.enumerate(persist, "channels")
for _, chan in ipairs(chans) do
  ctx.unlink(persist, "channels", chan.name, "membership")
  ctx.unlink(persist, "channels", chan.name, "modes")
  ctx.store(persist, "channels", chan.name, "is-joined", "no")
end

-- Import the wire and boot the connection
ctx.log("Dialing new IRC wire:", wireUri)
local wire = ctx.import(wireUri)
if wire == nil then
  ctx.log("Failed to dial", configName)
  ctx.store(state, "status", "Failed: Dialed, no answer")
else
  ctx.log("Dialed", configName, ":)")
  ctx.store(persist, "wire-uri", wireUri)
  ctx.bind(state, "wire", wire)
  ctx.startRoutine("maintain-wire", {network=configName})
end
