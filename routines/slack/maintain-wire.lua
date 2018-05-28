ctx.log("I'm here to maintain", input.team,
  "and chew bubblegum, and I'm all out of bubblegum")

local config = ctx.mkdirp("config", "teams", input.team)
local state = ctx.mkdirp("state", "teams", input.team)
local persist = ctx.mkdirp("persist", "teams", input.team)
local wire = ctx.mkdirp(state, "wire") -- TODO: should not be a mkdirp

-- Queue an outbound message for transmission to server
function sendMessage(target, body)
  ctx.invoke(wire, "send-message", {
      target=target,
      body=body,
    })
end

-- Helper to verify the wire isn't dead
function wireIsHealthy()
  local status = ctx.read(wire, "state")
  if status == "Pending" or status == "Ready" then
    return true
  end

  ctx.store(state, "status", "Failed: Wire was state "..status.." at "..ctx.timestamp())
  ctx.unlink(persist, "wire-uri")
  ctx.log("Cutting ties with wire - status was", status)
  return false
end

-- Pass a partitioned log context and an entry with 'timestamp' field, at minimum
-- NOT thread-safe - only write logs from one routine!
function writeToLog(log, entry)
  local partitionId = string.sub(entry.timestamp, 1, 10)

  if not log.setup then
    ctx.log("Setting up log", log.root)

    -- seed the log with this partition if it's all new
    if ctx.read(log.root, "horizon") == "" then
      ctx.store(log.root, "horizon", partitionId)
      ctx.store(log.root, "latest", partitionId)
    end
    log.setup = true
  end

  local partition = log.parts[partitionId]
  local isNewPart = false
  if not partition then
    ctx.log("Setting up log part", log.root, partitionId)

    -- seed the individual partition if it's new
    if ctx.read(log.root, partitionId, "horizon") == "" then
      local partRoot = ctx.mkdirp(log.root, partitionId)
      ctx.log("Creating new partition", partitionId, "for log", log.root)
      ctx.store(partRoot, "horizon", 0)
      ctx.store(partRoot, "latest", -1)

      if ctx.read(log.root, "latest") < partitionId then
        isNewPart = true
      end
    end

    -- set up inmem partition state
    partition = {
      root    = ctx.mkdirp(log.root, partitionId),
      horizon = tonumber(ctx.read(log.root, partitionId, "horizon")),
      latest  = tonumber(ctx.read(log.root, partitionId, "latest")) or -1,
    }
    log.parts[partitionId] = partition
  end

  -- store using next ID from partition
  local nextId = ""..(partition.latest + 1)
  ctx.store(partition.root, nextId, entry)
  ctx.store(partition.root, "latest", nextId)
  partition.latest = nextId
  ctx.log("Wrote message", nextId, "into", partitionId, "for", log.root)

  -- update log to use new partition, if it was new
  if isNewPart then
    ctx.store(log.root, "latest", partitionId)
  end

  -- return the composite message id
  return partitionId.."/"..nextId
end

-- Restore checkpoint from stored state
local savedCheckpoint = ctx.read(persist, "wire-checkpoint")
local checkpoint = tonumber(savedCheckpoint) or -1
ctx.log("Resuming after wire checkpoint", checkpoint)

-- Create some basic folders
local channelsCtx = ctx.mkdirp(persist, "channels")
local groupsCtx = ctx.mkdirp(persist, "groups")
local directsCtx  = ctx.mkdirp(persist, "directs")
local serverLog   = {
  root    = ctx.mkdirp(persist, "server-log"),
  parts   = {},
}

-- Helper to assemble a public channel state
local channelCache = {}
function getChannel(name)
  local table = channelCache[name]
  if not table then
    table = {
      root    = ctx.mkdirp(channelsCtx, name),
      log     = {
        root  = ctx.mkdirp(channelsCtx, name, "log"),
        parts = {},
      },
      members = ctx.mkdirp(channelsCtx, name, "membership"),
      topic   = ctx.mkdirp(channelsCtx, name, "topic"),
    }
    channelCache[name] = table
  end
  return table
end

-- Helper to assemble a private group state
local groupCache = {}
function getGroup(name)
  local table = groupCache[name]
  if not table then
    table = {
      root    = ctx.mkdirp(channelsCtx, name),
      log     = {
        root  = ctx.mkdirp(channelsCtx, name, "log"),
        parts = {},
      },
      members = ctx.mkdirp(channelsCtx, name, "membership"),
      topic   = ctx.mkdirp(channelsCtx, name, "topic"),
    }
    groupCache[name] = table
  end
  return table
end

-- Helper to assemble a direct message state
local directCache = {}
function getDirect(name)
  local table = directCache[name]
  if not table then
    -- TODO: other user's state should clear when wire changes over
    table = {
      root    = ctx.mkdirp(queriesCtx, name),
      log     = {
        root  = ctx.mkdirp(queriesCtx, name, "log"),
        parts = {},
      },
    }
    directCache[name] = table
  end
  return table
end

function writeToServerLog(msg)
  writeToLog(serverLog, msg)
  return true
end

-- Lookup table for slack-dialer 'type' handlers
local handlers = {
  dialer = function(msg)
    return writeToServerLog({
        timestamp = msg.timestamp,
        source = "system",
        text = msg.params.log,
      })
  end,
}

-- Main loop
local healthyWire = true
local pingCounter = 0
while healthyWire do

  local latest = tonumber(ctx.read(wire, "history-latest"))

  -- Break if...
  -- Fully processed an unhealthy wire?
  if not healthyWire and latest == checkpoint then break end
  -- Wire host went away? Can't fully process :(
  if latest == nil then break end

  -- Process any/all new content
  while latest > checkpoint do
    checkpoint = checkpoint + 1

    local event = ctx.readDir(wire, "history", checkpoint)
    ctx.log("New wire event", event.type)

    if event.type == nil then
      -- when does this happen?
      ctx.log("Nil type on event:", event)

    else

      local handler = handlers[event.type]
      if type(handler) ~= "function" then
        error("Slack event "..event.type.." not handled - wire sequence #"..checkpoint)
      end

      if handler(event) == true then
        -- only checkpoint when handler says to
        ctx.store(persist, "wire-checkpoint", checkpoint)
      end

    end
  end

  -- Ping / check health every minute
  pingCounter = pingCounter + 1
  if pingCounter > 240 then
    --TODO: what's the ping story?
    healthyWire = wireIsHealthy()
    pingCounter = 1
  end

  -- Sleep a sec
  ctx.sleep(250)
end

if ctx.read(state, "status") == "Ready" then
  ctx.store(state, "status", "Completed at "..ctx.timestamp())
end
