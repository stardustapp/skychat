-- Slack Application launch script
-- Ensures that all configured teams have live connections
-- Leverages dial-session to establish new connections
-- Runs maintain-wire to sync connections into the app

-- Verifies that the team's connection state is as desired, makes it so
function checkTeam(team)

  -- read the current state
  local status = ctx.read("state", "teams", team, "status")
  ctx.log("Team", team, "status is", status)

  -- if it's healthy or attempting to be healthy, let it be
  if status == "Ready" or status == "Pending" or status == "Dialing" then
    return
  end

  -- sure, it's not healthy, but do we want to fix that?
  -- TODO: if there's a live wire, we want to auto-recover it either way.
  if ctx.read("config", "teams", team, "auto-connect") == "no" then
    return
  end

  -- we do want to fix that. let's fix that.
  ctx.log("Auto-connecting team", team)
  ctx.startRoutine("dial-session", {team=team})
end

-- main loop
while true do
  -- check all configured teams
  local configs = ctx.enumerate("config", "teams")
  for _, config in ipairs(configs) do
    checkTeam(config.name)
  end

  -- wait a bit before checking again
  ctx.sleep(15000)
end