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
local persist = ctx.chroot("persist", "networks", configName)
local wireCfg = ctx.chroot("persist", "wires", configName)

-- Check for existing wire connection
local status = state:read("status")
ctx.log("Network", configName, "status is", status)
if status == "Ready" or status == "Pending" then
  ctx.log("Network", configName, "status is already", status)
  return
end

-- Mark that we're present, now that we're alone
-- Avoids racing to do this before we do too much network :)
state:store("status", "Pending")

-- Reconnect to existing wire if any
local wireUri = wireCfg:read("wire-uri")
if wireUri ~= "" then
  ctx.log("Attempting to recover wire for", configName, "from", wireUri)
  local wire = ctx.import(wireUri)
  if wire then

    -- Verify status before reusing the wire
    local status = wire:read("state")
    if status ~= "" then
      ctx.log("Found wire for", configName, "with status", status)
      -- process the wire even if it's dead, to catch final msgs
      state:bind("wire", wire)
      state:store("status", status)
      ctx.startRoutine("maintain-wire", {network=configName})
      return
    else
      ctx.log("Wire for", configName, "came up dead, trashing it")
      wireCfg:unlink()
    end
  end
end

-- bail now if we don't want to make a new connection
if config:read("auto-connect") == "no" then
  state:store("status", "Disabled")
  return
end

-- There is no live wire. Let's see if we can dial out.
ctx.log("Dialing new IRC wire for", configName)
state:store("status", "Dialing")
local wireUri = ctx.invoke("irc-modem", "dial", config):read()

-- If we can't, there's nothing else to do. Bail.
if not wireUri then
  ctx.log("WARN: Failed to dial network", configName)
  state:store("status", "Failed: Dial didn't work")
  return
elseif string.sub(wireUri, 1, 4) == "Err!" then
  -- commit this message to the log
  -- we don't know how to write logs, so have maintain-wire do it
  ctx.log("WARN: Failed to dial network", configName, "--", wireUri)
  ctx.startRoutine("maintain-wire", {network=configName, dialError=wireUri})

  -- force some waiting before letting the connection be retried
  -- TODO: instead of sleeping, do time math (+backoff) in launch.lua
  state:store("status", "Sleeping")
  ctx.sleep(10*60)
  state:store("status", "Failed: Dial "..wireUri)
  return
end

-- Clean out all the wire-specific persistent state
ctx.log("Clearing connection state for", configName)
persist:unlink("umodes")
persist:unlink("current-nick")

-- Reset all the channels
local channels = persist:mkdirp("channels")
local chans = channels:enumerate()
for _, chan in ipairs(chans) do
  channels:unlink(chan.name, "membership")
  channels:unlink(chan.name, "modes")
  channels:store(chan.name, "is-joined", "no")
end

-- Import the wire and boot the connection
ctx.log("Dialing new IRC wire:", wireUri)
local wireRef = ctx.import(wireUri)
if wireRef == nil then
  -- TODO: when would this happen?
  ctx.log("Somehow failed to dial", configName)
  state:store("status", "Failed: Dialed, no answer")
else
  ctx.log("Dialed", configName, ":)")
  wireCfg:store({
    ["wire-uri"] = wireUri,
  })
  state:bind("wire", wireRef)
  ctx.startRoutine("maintain-wire", {network=configName})
end
