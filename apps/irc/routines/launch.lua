-- IRC Application launch script
-- Ensures that all configured networks have live connections
-- Leverages dial-server to establish new connections
-- Runs maintain-wire to sync connections into the app

local netConfigsSub = ctx.subscribeTree("config", "networks", 2)
local wireConfigs = ctx.chroot("persist", "wires")

-- Verifies that the network state is as desired, makes it so
function checkNetwork(network)

  -- read the current state
  local status = ctx.read("state", "networks", network, "status")
  ctx.log("Network", network, "status is", status)

  -- if it's healthy or attempting to be healthy, let it be
  if status == "Ready" or status == "Pending" or status == "Dialing" or status == "Sleeping" then
    return
  end

  -- sure, it's not healthy, but do we want to fix that?
  if netConfigsSub:read("latest", network, "auto-connect") == "no" then
    if wireConfigs:read(network, "wire-uri") == "" then
      ctx.log("Skipping disabled network", network)
      return
    end
  end

  -- we do want to fix that. let's fix that.
  ctx.log("Auto-connecting network", network)
  -- TODO: rename routine to 'setup-wire'
  ctx.startRoutine("dial-server", {network=network})
end

-- main loop
while true do
  -- wait up until timeoutSecs for something to happen
  local notifs = ctx.poll({
    ["netConfigs"] = netConfigsSub,
  }, 60)

  -- check all configured networks
  local configs = netConfigsSub:enumerate("latest")
  for _, config in ipairs(configs) do
    checkNetwork(config.name)
  end
end
