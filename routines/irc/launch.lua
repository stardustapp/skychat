-- IRC Application launch script
-- Ensures that all configured networks have live connections
-- Leverages dial-server to establish new connections
-- Runs maintain-wire to sync connections into the app

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
  -- TODO: if there's a live wire, we want to auto-recover it either way.
  if ctx.read("config", "networks", network, "auto-connect") == "no" then
    return
  end

  -- we do want to fix that. let's fix that.
  ctx.log("Auto-connecting network", network)
  ctx.startRoutine("dial-server", {network=network})
end

-- main loop
while true do
  -- check all configured networks
  local configs = ctx.enumerate("config", "networks")
  for _, config in ipairs(configs) do
    checkNetwork(config.name)
  end

  -- wait a bit before checking again
  ctx.sleep(30)
end
